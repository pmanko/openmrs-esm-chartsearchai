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

// ── chatPatientChartStream (SSE, per-request backend override) ─────────

describe('chatPatientChartStream', () => {
  let fetchSpy: MockInstance;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  function makeCallbacks() {
    return {
      onSession: vi.fn(),
      onThinking: vi.fn(),
      onToken: vi.fn(),
      onAnswerDone: vi.fn(),
      onAnswerValidation: vi.fn(),
      onInDepthPending: vi.fn(),
      onInDepthToken: vi.fn(),
      onInDepthDone: vi.fn(),
      onInDepthError: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    };
  }

  function sentBody(): Record<string, unknown> {
    return JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
  }

  it('includes the per-request backend override in the POST body when a backend is given', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(mockStreamResponse(['event:done\ndata: {"answer":"ok","references":[]}\n\n']));

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, {
      endpointUrl: 'http://hub/v1/chat/completions',
      modelName: 'med-agent-team',
      staged: false,
    });
    await flushPromises();

    expect(sentBody()).toMatchObject({
      patient: 'uuid-1',
      question: 'q?',
      endpointUrl: 'http://hub/v1/chat/completions',
      modelName: 'med-agent-team',
    });
  });

  it('omits the override fields when no backend is selected (server uses its config default)', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(mockStreamResponse(['event:done\ndata: {"answer":"ok","references":[]}\n\n']));

    chatPatientChartStream('uuid-1', null, 'q?', cb);
    await flushPromises();

    const body = sentBody();
    expect(body).not.toHaveProperty('endpointUrl');
    expect(body).not.toHaveProperty('modelName');
  });

  it("maps the done event's `model` field onto resolvedModel", async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse(['event:done\ndata: {"answer":"ok","references":[],"model":"med-agent-team"}\n\n']),
      );

    chatPatientChartStream('uuid-1', null, 'q?', cb);
    await flushPromises();

    expect(cb.onDone).toHaveBeenCalledWith(expect.objectContaining({ resolvedModel: 'med-agent-team' }));
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('parses optional thinking events before chat tokens', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse([
          'event:thinking\ndata: Checking the chart.\n\n',
          'event:token\ndata: Answer text.\n\n',
          'event:done\ndata: {"answer":"Answer text.","references":[]}\n\n',
        ]),
      );

    chatPatientChartStream('uuid-1', null, 'q?', cb);
    await flushPromises();

    expect(cb.onThinking).toHaveBeenCalledWith('Checking the chart.');
    expect(cb.onToken).toHaveBeenCalledWith('Answer text.');
    expect(cb.onDone).toHaveBeenCalledWith(expect.objectContaining({ answer: 'Answer text.' }));
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('parses staged answer and in-depth events before final done', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse([
          'event:token\ndata: Direct answer\n\n',
          'event:answer_done\ndata: {"answer":"Direct answer","references":[],"messageId":"m1","model":"med-agent-team-high-validated","answerValidation":{"status":"validating","label":"Checking answer"},"inDepth":{"status":"pending","answer":""}}\n\n',
          'event:answer_validation\ndata: {"answer":"Direct answer checked","references":[],"messageId":"m1","model":"med-agent-team-high-validated","answerValidation":{"status":"checked","label":"Checked"}}\n\n',
          'event:indepth_pending\ndata: {"messageId":"m1","inDepth":{"status":"pending","answer":""}}\n\n',
          'event:indepth_token\ndata: **In Depth**\ndata: - background\n\n',
          'event:indepth_done\ndata: {"status":"complete","answer":"- background"}\n\n',
          'event:done\ndata: {"answer":"Direct answer","references":[],"messageId":"m1","inDepth":{"status":"complete","answer":"- background"}}\n\n',
        ]),
      );

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, {
      endpointUrl: 'http://hub/v1/chat/completions',
      modelName: 'med-agent-team-high-validated',
      staged: true,
    });
    await flushPromises();

    expect(sentBody()).toMatchObject({ modelName: 'med-agent-team-high-validated', staged: 'true' });
    expect(cb.onAnswerDone).toHaveBeenCalledWith(
      expect.objectContaining({
        answer: 'Direct answer',
        resolvedModel: 'med-agent-team-high-validated',
        answerValidation: { status: 'validating', label: 'Checking answer' },
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
    expect(cb.onInDepthToken).toHaveBeenCalledWith('**In Depth**\n- background');
    expect(cb.onInDepthDone).toHaveBeenCalledWith({ status: 'complete', answer: '- background' });
    expect(cb.onDone).toHaveBeenCalledWith(
      expect.objectContaining({
        inDepth: { status: 'complete', answer: '- background' },
      }),
    );
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('requests staged flow when the caller marks the backend staged (capability, not name)', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(mockStreamResponse(['event:done\ndata: {"answer":"ok","references":[]}\n\n']));

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, {
      endpointUrl: 'http://hub/v1/chat/completions',
      modelName: 'single-12b-checked',
      staged: true,
    });
    await flushPromises();

    expect(sentBody()).toMatchObject({
      modelName: 'single-12b-checked',
      staged: 'true',
    });
  });

  it('does not request staged flow for an id that would match the old name-prefix guess but is marked unstaged', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(mockStreamResponse(['event:done\ndata: {"answer":"ok","references":[]}\n\n']));

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, {
      endpointUrl: 'http://hub/v1/chat/completions',
      modelName: 'single-12b-checked',
      staged: false,
    });
    await flushPromises();

    expect(sentBody()).not.toHaveProperty('staged');
  });
});
