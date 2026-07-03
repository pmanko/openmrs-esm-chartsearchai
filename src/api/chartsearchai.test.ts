import { TextEncoder, TextDecoder } from 'util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';
import { openmrsFetch } from '@openmrs/esm-framework';
import {
  chatPatientChartStream,
  searchPatientChart,
  searchPatientChartStream,
  SESSION_EXPIRED_ERROR_CODE,
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
      onReferences: vi.fn(),
      onGrounded: vi.fn(),
      onThinking: vi.fn(),
    };
  }

  it('parses a references event and delivers the citations to onReferences', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse([
          'event:references\ndata: {"references":[{"index":2,"resourceType":"condition","resourceUuid":"uuid-7","date":"2022-11-13"}]}\n\n',
          'event:token\ndata: Has it [2]\n\n',
          'event:done\ndata: {"answer":"Has it [2]","references":[{"index":2,"resourceType":"condition","resourceUuid":"uuid-7","date":"2022-11-13","grounded":true}]}\n\n',
        ]),
      );

    callStream(cb);
    await flushPromises();

    // Early (pre-grounding) citations arrive without a grounding verdict.
    expect(cb.onReferences).toHaveBeenCalledWith([
      { index: 2, resourceType: 'condition', resourceUuid: 'uuid-7', date: '2022-11-13' },
    ]);
    expect(cb.onDone).toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('delivers an empty references event as an empty array', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse([
          'event:references\ndata: {"references":[]}\n\n',
          'event:done\ndata: {"answer":"No record.","references":[]}\n\n',
        ]),
      );

    callStream(cb);
    await flushPromises();

    expect(cb.onReferences).toHaveBeenCalledWith([]);
  });

  it('ignores a malformed references event without erroring the stream', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse([
          'event:references\ndata: {bad json}\n\n',
          'event:done\ndata: {"answer":"a","references":[]}\n\n',
        ]),
      );

    callStream(cb);
    await flushPromises();

    // `done` is authoritative — a broken early event must not call onReferences or onError.
    expect(cb.onReferences).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
    expect(cb.onDone).toHaveBeenCalled();
  });

  it('parses thinking events and delivers the reasoning chunks to onThinking', async () => {
    // The server streams the model's chain-of-thought before the answer so the UI can show
    // live progress instead of a dead spinner during the (long, CPU-bound) reasoning phase.
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse([
          'event:thinking\ndata: The query asks about medications. \n\n',
          'event:thinking\ndata: Records [1] and [3] are drug orders.\n\n',
          'event:token\ndata: Aspirin [1]\n\n',
          'event:done\ndata: {"answer":"Aspirin [1]","references":[]}\n\n',
        ]),
      );

    callStream(cb);
    await flushPromises();

    expect(cb.onThinking).toHaveBeenNthCalledWith(1, 'The query asks about medications. ');
    expect(cb.onThinking).toHaveBeenNthCalledWith(2, 'Records [1] and [3] are drug orders.');
    expect(cb.onDone).toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('parses a trailing grounded event after done and delivers the verdicts to onGrounded', async () => {
    // chartsearchai.grounding.async=true: done arrives with verdict-less references, then a
    // trailing grounded event re-sends them with verdicts once Tier-2 verification finishes.
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse([
          'event:token\ndata: Has it [2]\n\n',
          'event:done\ndata: {"answer":"Has it [2]","references":[{"index":2,"resourceType":"condition","resourceUuid":"uuid-7","date":"2022-11-13"}],"questionId":"q-9"}\n\n',
          'event:grounded\ndata: {"references":[{"index":2,"resourceType":"condition","resourceUuid":"uuid-7","date":"2022-11-13","grounded":true}],"questionId":"q-9"}\n\n',
        ]),
      );

    callStream(cb);
    await flushPromises();

    expect(cb.onDone).toHaveBeenCalled();
    expect(cb.onGrounded).toHaveBeenCalledWith([
      { index: 2, resourceType: 'condition', resourceUuid: 'uuid-7', date: '2022-11-13', grounded: true },
    ]);
    // done must have been delivered before the verdicts.
    expect(cb.onDone.mock.invocationCallOrder[0]).toBeLessThan(cb.onGrounded.mock.invocationCallOrder[0]);
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('ignores a malformed grounded event without erroring the finished stream', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        mockStreamResponse([
          'event:done\ndata: {"answer":"a","references":[]}\n\n',
          'event:grounded\ndata: {bad json}\n\n',
        ]),
      );

    callStream(cb);
    await flushPromises();

    // The answer is already complete; broken verdicts just leave citations unverified.
    expect(cb.onGrounded).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
    expect(cb.onDone).toHaveBeenCalled();
  });

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

  // A bare (non-JSON) 500 on the SSE endpoint is OpenMRS's expired-session login redirect failing
  // with "sendRedirect() after the response has been committed" (the stream already committed the
  // response), not a controller error — controller errors are always JSON. Surface it as expiry.
  it('treats a non-JSON 500 as session expiry (sendRedirect-after-commit)', async () => {
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

    expect(cb.onError).toHaveBeenCalledWith(SESSION_EXPIRED_ERROR_CODE);
  });

  // Guards the bodyError-first ordering: a genuine controller 500 (JSON body) must surface its own
  // message, NOT be masked as session expiry — only the bare/no-body 500 is the committed-redirect case.
  it('surfaces a JSON 500 error verbatim rather than as session expiry', async () => {
    const cb = makeCallbacks();
    const resp = {
      ok: false,
      status: 500,
      body: null,
      json: () => Promise.resolve({ error: 'Internal error' }),
    } as unknown as Response;
    fetchSpy = vi.spyOn(window, 'fetch').mockResolvedValueOnce(resp);

    callStream(cb);
    await flushPromises();

    expect(cb.onError).toHaveBeenCalledWith('Internal error');
  });

  it('treats a non-JSON 401 as session expiry', async () => {
    const cb = makeCallbacks();
    const resp = {
      ok: false,
      status: 401,
      body: null,
      json: () => Promise.reject(new Error('no body')),
    } as unknown as Response;
    fetchSpy = vi.spyOn(window, 'fetch').mockResolvedValueOnce(resp);

    callStream(cb);
    await flushPromises();

    expect(cb.onError).toHaveBeenCalledWith(SESSION_EXPIRED_ERROR_CODE);
  });

  it('still reports a generic server error for a non-auth status with no JSON body', async () => {
    const cb = makeCallbacks();
    const resp = {
      ok: false,
      status: 400,
      body: null,
      json: () => Promise.reject(new Error('no body')),
    } as unknown as Response;
    fetchSpy = vi.spyOn(window, 'fetch').mockResolvedValueOnce(resp);

    callStream(cb);
    await flushPromises();

    expect(cb.onError).toHaveBeenCalledWith('Server error: 400');
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

    expect(cb.onError).toHaveBeenCalledWith(SESSION_EXPIRED_ERROR_CODE);
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

  it('requests staged flow for dynamic product answer model ids', async () => {
    const cb = makeCallbacks();
    fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(mockStreamResponse(['event:done\ndata: {"answer":"ok","references":[]}\n\n']));

    chatPatientChartStream('uuid-1', null, 'q?', cb, undefined, {
      endpointUrl: 'http://hub/v1/chat/completions',
      modelName: 'answer:gemma-4-12b@synthesis-date-output-contract~enforce',
    });
    await flushPromises();

    expect(sentBody()).toMatchObject({
      modelName: 'answer:gemma-4-12b@synthesis-date-output-contract~enforce',
      staged: 'true',
    });
  });
});
