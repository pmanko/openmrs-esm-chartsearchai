import { TextEncoder, TextDecoder } from 'util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { chatPatientChartStream } from './chartsearchai';

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
      .mockResolvedValueOnce(mockStreamResponse(['event:done\ndata: {"answer":"ok","references":[]}\n\n']));

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, 'team-med-checked');
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

  it('rejects an empty profile instead of relying on a relay fallback', () => {
    const cb = makeCallbacks();
    fetchSpy = vi.spyOn(window, 'fetch');

    expect(() => chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, '')).toThrow(
      'A product profile is required',
    );
    expect(window.fetch).not.toHaveBeenCalled();
  });

  it("maps the done event's `model` field onto resolvedModel", async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse(['event:done\ndata: {"answer":"ok","references":[],"model":"med-agent-team"}\n\n']),
      );

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, 'single-e4b-checked');
    await flushPromises();

    expect(cb.onDone).toHaveBeenCalledWith(expect.objectContaining({ resolvedModel: 'med-agent-team' }));
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('parses staged answer and in-depth events before final done', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse([
          'event:answer_done\ndata: {"answer":"Direct answer","references":[],"messageId":"m1","model":"med-agent-team-high-validated","answerValidation":{"status":"checking","label":"Checking answer"},"inDepth":{"status":"pending","answer":""}}\n\n',
          'event:answer_validation\ndata: {"answer":"Direct answer checked","references":[],"messageId":"m1","model":"med-agent-team-high-validated","answerValidation":{"status":"checked","label":"Checked"}}\n\n',
          'event:indepth_pending\ndata: {"messageId":"m1","inDepth":{"status":"pending","answer":""}}\n\n',
          'event:indepth_done\ndata: {"inDepth":{"status":"complete","answer":"- background"}}\n\n',
          'event:done\ndata: {"answer":"Direct answer","references":[],"messageId":"m1","inDepth":{"status":"complete","answer":"- background"}}\n\n',
        ]),
      );

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, 'team-med-checked');
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
        answerValidation: { status: 'checked', label: 'Checked' },
      }),
    );
    expect(cb.onInDepthPending).toHaveBeenCalledWith({
      messageId: 'm1',
      inDepth: { status: 'pending', answer: '' },
    });
    expect(cb.onInDepthDone).toHaveBeenCalledWith({
      inDepth: { status: 'complete', answer: '- background' },
    });
    expect(cb.onDone).toHaveBeenCalledWith(
      expect.objectContaining({
        inDepth: { status: 'complete', answer: '- background' },
      }),
    );
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
});
