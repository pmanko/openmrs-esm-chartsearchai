import { TextEncoder, TextDecoder } from 'util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';
import { openmrsFetch } from '@openmrs/esm-framework';
import {
  chatPatientChartStream,
  searchPatientChart,
  searchPatientChartStream,
  type AiSearchResponse,
} from './chartsearchai';

// Polyfill for jsdom
(globalThis as unknown as Record<string, unknown>).TextEncoder = TextEncoder;
(globalThis as unknown as Record<string, unknown>).TextDecoder = TextDecoder;

const mockOpenmrsFetch = openmrsFetch as Mock;

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

// ── searchPatientChart (sync) ──────────────────────────────────────────

describe('searchPatientChart', () => {
  it('sends a POST and returns data', async () => {
    const expected: AiSearchResponse = {
      answer: 'Test answer',
      references: [],
    };
    mockOpenmrsFetch.mockResolvedValueOnce({ data: expected });

    const result = await searchPatientChart('uuid-1', 'What happened?');

    expect(mockOpenmrsFetch).toHaveBeenCalledWith(
      '/ws/rest/v1/chartsearchai/search',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ patient: 'uuid-1', question: 'What happened?' }),
      }),
    );
    expect(result).toEqual(expected);
  });

  it('passes the abort signal through', async () => {
    mockOpenmrsFetch.mockResolvedValueOnce({ data: { answer: 'ok', references: [] } });
    const ac = new AbortController();

    await searchPatientChart('uuid-1', 'q', ac);

    expect(mockOpenmrsFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: ac.signal }));
  });
});

// ── searchPatientChartStream (SSE) ─────────────────────────────────────

describe('searchPatientChartStream', () => {
  let fetchSpy: MockInstance;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  function callStream(callbacks: { onToken: Mock; onDone: Mock; onError: Mock }) {
    searchPatientChartStream('uuid-1', 'question?', callbacks);
  }

  function makeCallbacks() {
    return {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    };
  }

  it('parses token events and delivers them to onToken', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse([
          'event:token\ndata: Hello\n\nevent:token\ndata:  world\n\n',
          'event:done\ndata: {"answer":"Hello world","references":[]}\n\n',
        ]),
      );

    callStream(cb);
    await flushPromises();

    expect(cb.onToken).toHaveBeenCalledWith('Hello');
    expect(cb.onToken).toHaveBeenCalledWith(' world');
    expect(cb.onDone).toHaveBeenCalledWith({
      answer: 'Hello world',
      references: [],
    });
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('concatenates multiple data: lines with newlines per SSE spec', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse([
          'event:token\ndata: line1\ndata: line2\ndata: line3\n\n',
          'event:done\ndata: {"answer":"a","references":[]}\n\n',
        ]),
      );

    callStream(cb);
    await flushPromises();

    expect(cb.onToken).toHaveBeenCalledWith('line1\nline2\nline3');
  });

  it('handles data split across chunks (partial buffer)', async () => {
    const cb = makeCallbacks();
    // Split "event:token\ndata: partial\n\n" across two chunks
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse([
          'event:tok',
          'en\ndata: partial\n\n',
          'event:done\ndata: {"answer":"p","references":[]}\n\n',
        ]),
      );

    callStream(cb);
    await flushPromises();

    expect(cb.onToken).toHaveBeenCalledWith('partial');
    expect(cb.onDone).toHaveBeenCalled();
  });

  it('strips only a single leading space from data field value', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse([
          'event:token\ndata:  two spaces\n\n',
          'event:done\ndata: {"answer":"","references":[]}\n\n',
        ]),
      );

    callStream(cb);
    await flushPromises();

    // "data:  two spaces" → strip first space → " two spaces"
    expect(cb.onToken).toHaveBeenCalledWith(' two spaces');
  });

  it('handles data field with no space after colon', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse(['event:token\ndata:noSpace\n\n', 'event:done\ndata:{"answer":"","references":[]}\n\n']),
      );

    callStream(cb);
    await flushPromises();

    expect(cb.onToken).toHaveBeenCalledWith('noSpace');
    expect(cb.onDone).toHaveBeenCalled();
  });

  it('dispatches error event from SSE stream', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(mockStreamResponse(['event:error\ndata: Something went wrong\n\n']));

    callStream(cb);
    await flushPromises();

    expect(cb.onError).toHaveBeenCalledWith('Something went wrong');
    expect(cb.onDone).not.toHaveBeenCalled();
  });

  it('calls onError when stream ends without done or error event', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi.spyOn(window, 'fetch').mockResolvedValueOnce(mockStreamResponse(['event:token\ndata: hello\n\n']));

    callStream(cb);
    await flushPromises();

    expect(cb.onToken).toHaveBeenCalledWith('hello');
    expect(cb.onError).toHaveBeenCalledWith('Stream ended unexpectedly without a response');
  });

  it('calls onError when done event contains invalid JSON', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(mockStreamResponse(['event:done\ndata: {not json}\n\n']));

    callStream(cb);
    await flushPromises();

    expect(cb.onError).toHaveBeenCalledWith('Failed to parse final response');
  });

  it('calls onError on non-OK HTTP status with JSON error body', async () => {
    const cb = makeCallbacks();
    const resp = {
      ok: false,
      status: 403,
      body: null,
      json: () => Promise.resolve({ error: 'Forbidden: missing privilege' }),
    } as unknown as Response;
    fetchSpy = vi.spyOn(window, 'fetch').mockResolvedValueOnce(resp);

    callStream(cb);
    await flushPromises();

    expect(cb.onError).toHaveBeenCalledWith('Forbidden: missing privilege');
  });

  it('calls onError on non-OK HTTP status without JSON body', async () => {
    const cb = makeCallbacks();
    const resp = {
      ok: false,
      status: 500,
      body: null,
      json: () => Promise.reject(new Error('no body')),
    } as unknown as Response;
    fetchSpy = vi.spyOn(window, 'fetch').mockResolvedValueOnce(resp);

    callStream(cb);
    await flushPromises();

    expect(cb.onError).toHaveBeenCalledWith('Server error: 500');
  });

  it('calls onError when streaming is not supported (no body)', async () => {
    const cb = makeCallbacks();
    const resp = {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: null,
    } as unknown as Response;
    fetchSpy = vi.spyOn(window, 'fetch').mockResolvedValueOnce(resp);

    callStream(cb);
    await flushPromises();

    expect(cb.onError).toHaveBeenCalledWith('Streaming not supported by this browser.');
  });

  it('calls onError with session expired message on redirect (302 to login)', async () => {
    const cb = makeCallbacks();
    const resp = {
      type: 'opaqueredirect',
      ok: false,
      status: 0,
      body: null,
    } as unknown as Response;
    fetchSpy = vi.spyOn(window, 'fetch').mockResolvedValueOnce(resp);

    callStream(cb);
    await flushPromises();

    expect(cb.onError).toHaveBeenCalledWith('Your session has expired. Please log in again.');
  });

  it('ignores blank lines that have no pending event (no false dispatch)', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse(['\n\n\nevent:token\ndata: hi\n\n', 'event:done\ndata: {"answer":"","references":[]}\n\n']),
      );

    callStream(cb);
    await flushPromises();

    expect(cb.onToken).toHaveBeenCalledTimes(1);
    expect(cb.onToken).toHaveBeenCalledWith('hi');
  });

  it('does not call onError when fetch is aborted', async () => {
    const cb = makeCallbacks();
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    fetchSpy = vi.spyOn(window, 'fetch').mockRejectedValueOnce(abortError);

    const ac = new AbortController();
    searchPatientChartStream('uuid-1', 'q', cb, ac);
    await flushPromises();

    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('calls onError on non-abort fetch failure', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi.spyOn(window, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));

    callStream(cb);
    await flushPromises();

    expect(cb.onError).toHaveBeenCalledWith('Failed to fetch');
  });

  it('dispatches pending event at end of stream (no trailing blank line)', async () => {
    const cb = makeCallbacks();
    // Stream ends with data but no trailing \n\n
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(mockStreamResponse(['event:done\ndata: {"answer":"a","references":[]}\n']));

    callStream(cb);
    await flushPromises();

    expect(cb.onDone).toHaveBeenCalledWith({
      answer: 'a',
      references: [],
    });
    expect(cb.onError).not.toHaveBeenCalled();
  });
});

// ── chatPatientChartStream (SSE, per-request backend override) ─────────

describe('chatPatientChartStream', () => {
  let fetchSpy: MockInstance;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  function makeCallbacks() {
    return {
      onSession: vi.fn(),
      onToken: vi.fn(),
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
});
