import { TextEncoder, TextDecoder } from 'util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
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

  it('sends only the selected product profile as the inference override', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(mockStreamResponse(['event:turn_done\ndata: {"session":"sess-1"}\n\n']));

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, 'team-med-checked', 'turn-1', 'hub');
    await flushPromises();

    expect(sentBody()).toMatchObject({
      patient: 'uuid-1',
      question: 'q?',
      profile: 'team-med-checked',
      requestId: 'turn-1',
    });
    expect(sentBody()).not.toHaveProperty('endpointUrl');
    expect(sentBody()).not.toHaveProperty('modelName');
    expect(sentBody()).not.toHaveProperty('staged');
  });

  it('sends the selected provider in the request body', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(mockStreamResponse(['event:turn_done\ndata: {"session":"s"}\n\n']));

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, 'team-med-checked', 'turn-1', 'hub');
    await flushPromises();

    expect(sentBody()).toMatchObject({ provider: 'hub' });
  });

  it('sends bundled turns without a hub profile', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(mockStreamResponse(['event:turn_done\ndata: {"session":"s"}\n\n']));

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, undefined, 'turn-1', 'bundled');
    await flushPromises();

    expect(sentBody()).toMatchObject({ provider: 'bundled' });
    expect(sentBody()).not.toHaveProperty('profile');
  });

  it('rejects an empty hub profile instead of relying on a relay fallback', () => {
    const cb = makeCallbacks();
    fetchSpy = vi.spyOn(window, 'fetch');

    expect(() => chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, '', undefined, 'hub')).toThrow(
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

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, undefined, 'turn-1', 'bundled');
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
          'event:turn_done\ndata: {"session":"sess-1"}\n\n',
        ]),
      );

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, 'single-e4b-checked', undefined, 'hub');
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
          'event:answer_done\ndata: {"answer":"Direct answer","references":[],"messageId":"m1","model":"med-agent-team-high-validated","answerValidation":{"status":"checking","label":"Checking answer"},"inDepth":{"status":"pending","answer":""}}\n\n',
          'event:answer_validation\ndata: {"answer":"Direct answer checked","references":[],"messageId":"m1","model":"med-agent-team-high-validated","answerValidation":{"status":"edited","label":"Updated after check","originalAnswer":"Direct answer [1]","originalReferences":[{"index":1,"resourceType":"Observation"}]}}\n\n',
          'event:indepth_pending\ndata: {"messageId":"m1","inDepth":{"status":"pending","answer":""}}\n\n',
          'event:indepth_done\ndata: {"inDepth":{"status":"complete","answer":"- background","reviewDraft":"- rejected [1]","reviewReferences":[{"index":1,"resourceType":"Observation"}]}}\n\n',
          'event:turn_done\ndata: {"session":"sess-1","messageId":"m1","provider":"hub"}\n\n',
        ]),
      );

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, 'team-med-checked', undefined, 'hub');
    await flushPromises();

    expect(sentBody()).toMatchObject({ profile: 'team-med-checked' });
    expect(cb.onAnswerDone).toHaveBeenCalledWith(
      expect.objectContaining({
        answer: 'Direct answer',
        resolvedModel: 'med-agent-team-high-validated',
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

  // ── canonical turn lifecycle wire (turn_started / turn_done / turn_error) ──

  it('finalizes on turn_done and preserves the staged answer', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse([
          'event:answer_done\ndata: {"answer":"Direct answer","references":[],"messageId":"m1"}\n\n',
          'event:turn_done\ndata: {"session":"sess-1","messageId":"m1","provider":"hub"}\n\n',
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
          'event:turn_done\ndata: {"session":"sess-42","messageId":"m1","provider":"hub"}\n\n',
        ]),
      );

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, 'team-med-checked');
    await flushPromises();

    expect(cb.onSession).toHaveBeenCalledWith('sess-42');
    expect(cb.onError).not.toHaveBeenCalled();
  });
});
