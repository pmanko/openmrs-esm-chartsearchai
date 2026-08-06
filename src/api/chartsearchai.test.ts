import { TextEncoder, TextDecoder } from 'util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import conformance from '../conformance/dual-provider-conformance.v1.json';
import { chatPatientChartStream, SESSION_EXPIRED_ERROR_CODE } from './chartsearchai';

// Polyfill for jsdom
(globalThis as unknown as Record<string, unknown>).TextEncoder = TextEncoder;
(globalThis as unknown as Record<string, unknown>).TextDecoder = TextDecoder;

beforeAll(() => {
  (window as unknown as Record<string, unknown>).openmrsBase = '/openmrs';
  // jsdom may not define window.fetch; ensure it exists so we can mock it
  if (!window.fetch) {
    (window as unknown as Record<string, unknown>).fetch = () => Promise.reject(new Error('not mocked'));
  }
});

afterAll(() => {
  delete (window as unknown as Record<string, unknown>).openmrsBase;
});

/**
 * Helper: build a mock Response whose body has a getReader() that
 * yields the given chunks (strings) in order.
 */
function mockStreamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  let i = 0;

  const body = {
    getReader() {
      return {
        read() {
          if (i < chunks.length) {
            return Promise.resolve({ done: false, value: encoder.encode(chunks[i++]) });
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };

  const headers = new Map([['Content-Type', 'text/event-stream']]);

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers.get(name) ?? null },
    body,
    json: () => Promise.reject(new Error('no json')),
  } as unknown as Response;
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── chatPatientChartStream (SSE, product profile selection) ─────────

describe('chatPatientChartStream', () => {
  let fetchSpy: MockInstance;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  function makeCallbacks() {
    return {
      onSession: vi.fn(),
      onAnswerDone: vi.fn(),
      onAnswerValidation: vi.fn(),
      onEvidenceUpdated: vi.fn(),
      onInDepthPending: vi.fn(),
      onInDepthDone: vi.fn(),
      onInDepthError: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    };
  }

  function sentBody(): Record<string, unknown> {
    return JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
  }

  it.each(conformance.provider_lifecycle.filter((testCase) => testCase.expected === 'accept'))(
    'consumes the canonical lifecycle fixture $id',
    async (testCase) => {
      const cb = makeCallbacks();
      const payload: Record<string, string> = {
        turn_started: '{"session":"sess-1","messageId":"m1","provider":"hub"}',
        answer_done: '{"answer":"Answer.","references":[],"messageId":"m1"}',
        answer_validation:
          '{"answer":"Answer.","references":[],"messageId":"m1","answerValidation":{"status":"checked","label":"Checked"}}',
        indepth_pending: '{"messageId":"m1","inDepth":{"status":"pending","answer":""}}',
        indepth_done: '{"messageId":"m1","inDepth":{"status":"complete","answer":"Detail."}}',
        turn_done: '{"answer":"Answer.","references":[],"session":"sess-1","messageId":"m1","provider":"hub"}',
        turn_error: '{"problemCode":"provider_unavailable"}',
      };
      const chunks = testCase.events.map((event) => `event:${event}\ndata: ${payload[event]}\n\n`);
      fetchSpy = vi.spyOn(window, 'fetch').mockResolvedValueOnce(mockStreamResponse(chunks));

      chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, 'single-e4b-checked', 'hub');
      await flushPromises();

      if (testCase.events.includes('turn_error')) {
        expect(cb.onError).toHaveBeenCalledWith('provider_unavailable');
        expect(cb.onDone).not.toHaveBeenCalled();
      } else {
        expect(cb.onDone).toHaveBeenCalledOnce();
        expect(cb.onError).not.toHaveBeenCalled();
      }
      if (testCase.events.includes('answer_done')) {
        expect(cb.onAnswerDone).toHaveBeenCalledOnce();
      }
    },
  );

  it('rejects terminal success that omits the final answer envelope', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(mockStreamResponse(['event:turn_done\ndata: {"session":"sess-1"}\n\n']));

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, 'single-e4b-checked', 'hub');
    await flushPromises();

    expect(cb.onDone).not.toHaveBeenCalled();
    expect(cb.onError).toHaveBeenCalledWith('Failed to parse final response');
  });

  it('sends only the selected product profile as the inference override', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse(['event:turn_done\ndata: {"answer":"","references":[],"session":"sess-1"}\n\n']),
      );

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, 'team-med-checked', 'hub');
    await flushPromises();

    expect(sentBody()).toMatchObject({
      patient: 'uuid-1',
      question: 'q?',
      profile: 'team-med-checked',
    });
    expect(sentBody()).not.toHaveProperty('endpointUrl');
    expect(sentBody()).not.toHaveProperty('modelName');
    expect(sentBody()).not.toHaveProperty('staged');
  });

  it('sends the selected provider in the request body', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse(['event:turn_done\ndata: {"answer":"","references":[],"session":"s"}\n\n']),
      );

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, 'team-med-checked', 'hub');
    await flushPromises();

    expect(sentBody()).toMatchObject({ provider: 'hub' });
  });

  it('sends bundled turns without a hub profile', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse(['event:turn_done\ndata: {"answer":"","references":[],"session":"s"}\n\n']),
      );

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, undefined, 'bundled');
    await flushPromises();

    expect(sentBody()).toMatchObject({ provider: 'bundled' });
    expect(sentBody()).not.toHaveProperty('profile');
  });

  it('rejects an empty hub profile instead of relying on a relay fallback', () => {
    const cb = makeCallbacks();
    fetchSpy = vi.spyOn(window, 'fetch');

    expect(() => chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, '', 'hub')).toThrow(
      'A product profile is required',
    );
    expect(window.fetch).not.toHaveBeenCalled();
  });

  it('emits the localizable session-expired code for an authentication redirect', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi.spyOn(window, 'fetch').mockResolvedValueOnce({
      type: 'opaqueredirect',
      status: 0,
    } as Response);

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, undefined, 'bundled');
    await flushPromises();

    expect(cb.onError).toHaveBeenCalledWith(SESSION_EXPIRED_ERROR_CODE);
    expect(cb.onDone).not.toHaveBeenCalled();
  });

  it("maps the answer_done event's `model` field onto resolvedModel", async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse([
          'event:answer_done\ndata: {"answer":"ok","references":[],"model":"med-agent-team"}\n\n',
          'event:turn_done\ndata: {"answer":"ok","references":[],"model":"med-agent-team","session":"sess-1"}\n\n',
        ]),
      );

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, 'single-e4b-checked', 'hub');
    await flushPromises();

    expect(cb.onAnswerDone).toHaveBeenCalledWith(expect.objectContaining({ resolvedModel: 'med-agent-team' }));
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('parses staged answer and in-depth events before final done', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse([
          'event:answer_done\ndata: {"answer":"Direct answer","references":[],"messageId":"m1","model":"med-agent-team-high-validated","safetyStatus":"limited","safetyCheck":{"schema_version":"drug_safety.v1","status":"limited","package":{"id":"research-seed-v1","review_state":"proposed"},"issues":["source_not_clinically_approved"]},"answerValidation":{"status":"checking","label":"Checking answer"},"inDepth":{"status":"pending","answer":""}}\n\n',
          'event:answer_validation\ndata: {"answer":"Direct answer checked","references":[],"messageId":"m1","model":"med-agent-team-high-validated","answerValidation":{"status":"edited","label":"Updated after check","originalAnswer":"Direct answer [1]","originalReferences":[{"index":1,"resourceType":"Observation"}]}}\n\n',
          'event:indepth_pending\ndata: {"messageId":"m1","inDepth":{"status":"pending","answer":""}}\n\n',
          'event:indepth_done\ndata: {"inDepth":{"status":"complete","answer":"- background","reviewDraft":"- rejected [1]","reviewReferences":[{"index":1,"resourceType":"Observation"}]}}\n\n',
          'event:turn_done\ndata: {"answer":"Direct answer checked","references":[],"messageId":"m1","model":"med-agent-team-high-validated","provider":"hub","session":"sess-1","answerValidation":{"status":"edited","label":"Updated after check","originalAnswer":"Direct answer [1]","originalReferences":[{"index":1,"resourceType":"Observation"}]},"inDepth":{"status":"complete","answer":"- background","reviewDraft":"- rejected [1]","reviewReferences":[{"index":1,"resourceType":"Observation"}]}}\n\n',
        ]),
      );

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, 'team-med-checked', 'hub');
    await flushPromises();

    expect(sentBody()).toMatchObject({ profile: 'team-med-checked' });
    expect(cb.onAnswerDone).toHaveBeenCalledWith(
      expect.objectContaining({
        answer: 'Direct answer',
        resolvedModel: 'med-agent-team-high-validated',
        safetyStatus: 'limited',
        safetyCheck: {
          schema_version: 'drug_safety.v1',
          status: 'limited',
          package: { id: 'research-seed-v1', review_state: 'proposed' },
          issues: ['source_not_clinically_approved'],
        },
        answerValidation: { status: 'checking', label: 'Checking answer' },
        inDepth: { status: 'pending', answer: '' },
      }),
    );
    expect(cb.onAnswerValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        answer: 'Direct answer checked',
        answerValidation: {
          status: 'edited',
          label: 'Updated after check',
          originalAnswer: 'Direct answer [1]',
          originalReferences: [{ index: 1, resourceType: 'Observation' }],
        },
      }),
    );
    expect(cb.onInDepthPending).toHaveBeenCalledWith({
      messageId: 'm1',
      inDepth: { status: 'pending', answer: '' },
    });
    expect(cb.onInDepthDone).toHaveBeenCalledWith({
      inDepth: {
        status: 'complete',
        answer: '- background',
        reviewDraft: '- rejected [1]',
        reviewReferences: [{ index: 1, resourceType: 'Observation' }],
      },
    });
    expect(cb.onDone).toHaveBeenCalledWith(expect.objectContaining({ session: 'sess-1' }));
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('delivers final bundled evidence updates before the terminal marker', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse([
          'event:answer_done\ndata: {"answer":"A [1].","references":[{"index":1,"groundingStatus":"checking"}],"messageId":"m1"}\n\n',
          'event:evidence_updated\ndata: {"answer":"A [1].","references":[{"index":1,"resolutionStatus":"resolved","groundingStatus":"verified"}],"messageId":"m1"}\n\n',
          'event:turn_done\ndata: {"answer":"A [1].","references":[{"index":1,"resolutionStatus":"resolved","groundingStatus":"verified"}],"session":"sess-1","messageId":"m1","provider":"bundled"}\n\n',
        ]),
      );

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, undefined, 'bundled');
    await flushPromises();

    expect(cb.onEvidenceUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        references: [expect.objectContaining({ groundingStatus: 'verified' })],
      }),
    );
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('ignores lifecycle events after a terminal marker', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse([
          'event:turn_done\ndata: {"answer":"A","references":[],"session":"sess-1","messageId":"m1","provider":"bundled"}\n\n',
          'event:evidence_updated\ndata: {"references":[{"index":1,"groundingStatus":"verified"}]}\n\n',
          'event:indepth_pending\ndata: {"inDepth":{"status":"pending","answer":""}}\n\n',
        ]),
      );

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, undefined, 'bundled');
    await flushPromises();

    expect(cb.onDone).toHaveBeenCalledOnce();
    expect(cb.onEvidenceUpdated).not.toHaveBeenCalled();
    expect(cb.onInDepthPending).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('rejects the retired flat in-depth event wire', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse(['event:indepth_done\ndata: {"status":"complete","answer":"retired wire"}\n\n']),
      );

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, 'single-e4b-checked');
    await flushPromises();

    expect(cb.onInDepthDone).not.toHaveBeenCalled();
    expect(cb.onError).toHaveBeenCalledWith('Failed to parse in-depth response');
  });

  it('treats a malformed clinical event as terminal even if turn_done follows', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse([
          'event:answer_validation\ndata: {not-json}\n\n',
          'event:turn_done\ndata: {"answer":"must not replace error","references":[]}\n\n',
        ]),
      );

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, 'single-e4b-checked', 'hub');
    await flushPromises();

    expect(cb.onError).toHaveBeenCalledOnce();
    expect(cb.onError).toHaveBeenCalledWith('Failed to parse answer validation response');
    expect(cb.onDone).not.toHaveBeenCalled();
  });

  // ── canonical turn lifecycle wire (turn_started / turn_done / turn_error) ──

  it('finalizes on turn_done and preserves the staged answer', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse([
          'event:answer_done\ndata: {"answer":"Direct answer","references":[],"messageId":"m1"}\n\n',
          'event:turn_done\ndata: {"answer":"Direct answer","references":[],"session":"sess-1","messageId":"m1","provider":"hub"}\n\n',
        ]),
      );

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, 'team-med-checked');
    await flushPromises();

    expect(cb.onAnswerDone).toHaveBeenCalledWith(expect.objectContaining({ answer: 'Direct answer' }));
    expect(cb.onDone).toHaveBeenCalledWith(expect.objectContaining({ session: 'sess-1' }));
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('surfaces turn_error through onError with the problem code', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(mockStreamResponse(['event:turn_error\ndata: {"problemCode":"hub_not_configured"}\n\n']));

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, 'team-med-checked');
    await flushPromises();

    expect(cb.onError).toHaveBeenCalledWith(expect.stringContaining('hub_not_configured'));
    expect(cb.onDone).not.toHaveBeenCalled();
  });

  it('captures the conversation session from turn_started', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse([
          'event:turn_started\ndata: {"session":"sess-42","messageId":"m1","provider":"hub"}\n\n',
          'event:answer_done\ndata: {"answer":"A","references":[],"messageId":"m1"}\n\n',
          'event:turn_done\ndata: {"answer":"A","references":[],"session":"sess-42","messageId":"m1","provider":"hub"}\n\n',
        ]),
      );

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, 'team-med-checked');
    await flushPromises();

    expect(cb.onSession).toHaveBeenCalledWith('sess-42');
    expect(cb.onError).not.toHaveBeenCalled();
  });
});
