import { openmrsFetch, restBaseUrl } from '@openmrs/esm-framework';

const BASE_PATH = `${restBaseUrl}/chartsearchai`;

export interface AiReference {
  index: number;
  resourceType: string;
  resourceId: number;
  date: string;
}

export interface AiCell {
  text: string;
  refs?: number[];
}

export interface AiTableColumn {
  key: string;
  label: string;
}

export interface AiTableBlock {
  kind: 'table';
  title?: string;
  columns: AiTableColumn[];
  rows: Array<{ cells: Record<string, AiCell> }>;
}

export type AiBlock = AiTableBlock;

export interface AiSearchResponse {
  answer: string;
  references: AiReference[];
  blocks?: AiBlock[];
  questionId?: string;
  /** Server-side conversation handle. Present on chat responses only. */
  session?: string;
  /** Server-assigned uuid for the assistant message row. Present on chat responses only. */
  messageId?: string;
}

export interface ChatHistoryMessage {
  messageId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  blocks?: AiBlock[];
  createdAt: number;
}

export interface ChatHistoryResponse {
  session: string;
  messages: ChatHistoryMessage[];
}

export type FeedbackRating = 'positive' | 'negative';

export interface AiFeedback {
  questionId: string;
  rating: FeedbackRating;
  comment?: string;
}

export interface AiSearchError {
  error: string;
}

/**
 * Pre-warms the server-side LLM prompt cache for the given patient. Fire-and-forget;
 * fired when the chart is opened so the first AI query skips full prefill cost. Pass
 * an AbortSignal to cancel an in-flight warmup when the user navigates to a different
 * patient before the previous warmup finished.
 */
export function warmupPatient(patientUuid: string, signal?: AbortSignal): void {
  openmrsFetch(`${BASE_PATH}/warmup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patient: patientUuid }),
    signal,
  }).catch(() => {
    // ignore — the user does not depend on this completing, and aborts are expected on patient switch
  });
}

/**
 * Submits user feedback (thumbs up/down + optional comment) for an AI response.
 */
export async function submitFeedback(feedback: AiFeedback): Promise<void> {
  try {
    await openmrsFetch(`${BASE_PATH}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(feedback),
    });
  } catch (err) {
    console.error('[submitFeedback] Failed to submit feedback:', err);
    throw err;
  }
}

/**
 * Sends a synchronous AI search request.
 */
export async function searchPatientChart(
  patientUuid: string,
  question: string,
  abortController?: AbortController,
): Promise<AiSearchResponse> {
  const response = await openmrsFetch(`${BASE_PATH}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patient: patientUuid, question }),
    signal: abortController?.signal,
  });
  if (!response.data?.answer) {
    throw new Error('Unexpected response from server');
  }
  return response.data as AiSearchResponse;
}

/**
 * Opens an SSE (Server-Sent Events) stream for AI search.
 *
 * Uses raw fetch instead of openmrsFetch because openmrsFetch consumes
 * the response body to parse it as JSON, which prevents streaming.
 * We need direct access to response.body (the ReadableStream).
 */
export function searchPatientChartStream(
  patientUuid: string,
  question: string,
  callbacks: {
    onToken: (token: string) => void;
    onDone: (response: AiSearchResponse) => void;
    onError: (error: string) => void;
  },
  abortController?: AbortController,
): void {
  const url = `${window.openmrsBase}${BASE_PATH}/search/stream`;

  window
    .fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'Disable-WWW-Authenticate': 'true',
      },
      body: JSON.stringify({ patient: patientUuid, question }),
      credentials: 'include',
      redirect: 'manual',
      signal: abortController?.signal,
    })
    .then(async (response) => {
      if (response.type === 'opaqueredirect' || response.status === 0) {
        callbacks.onError('Your session has expired. Please log in again.');
        return;
      }

      if (!response.ok) {
        let message = `Server error: ${response.status}`;
        try {
          const body = await response.json();
          if (body?.error) {
            message = body.error;
          }
        } catch {
          // no JSON body
        }
        callbacks.onError(message);
        return;
      }

      const reader = response.body;

      if (!reader || typeof reader.getReader !== 'function') {
        callbacks.onError('Streaming not supported by this browser.');
        return;
      }

      const textDecoder = new TextDecoder();
      const streamReader = reader.getReader();
      let buffer = '';
      let eventType = '';
      let dataLines: string[] = [];
      let streamFinalized = false;

      function dispatchEvent() {
        if (dataLines.length === 0) {
          eventType = '';
          return;
        }
        const data = dataLines.join('\n');
        if (eventType === 'token') {
          callbacks.onToken(data);
        } else if (eventType === 'done') {
          streamFinalized = true;
          try {
            const parsed: AiSearchResponse = JSON.parse(data);
            callbacks.onDone(parsed);
          } catch {
            callbacks.onError('Failed to parse final response');
          }
        } else if (eventType === 'error') {
          streamFinalized = true;
          callbacks.onError(data);
        }
        eventType = '';
        dataLines = [];
      }

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await streamReader.read();
        if (done) break;

        buffer += textDecoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line === '') {
            dispatchEvent();
          } else if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const raw = line.slice(5);
            dataLines.push(raw.startsWith(' ') ? raw.slice(1) : raw);
          }
        }
      }

      // Process any remaining lines in the buffer (stream ended without trailing newline)
      if (buffer) {
        for (const line of buffer.split('\n')) {
          if (line === '') {
            dispatchEvent();
          } else if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const raw = line.slice(5);
            dataLines.push(raw.startsWith(' ') ? raw.slice(1) : raw);
          }
        }
      }

      // Flush any event accumulated in the loop but not yet dispatched
      dispatchEvent();

      if (!streamFinalized) {
        callbacks.onError('Stream ended unexpectedly without a response');
      }
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        callbacks.onError(err?.message ?? 'An unknown error occurred');
      }
    });
}

/**
 * Streaming variant for multi-turn chat. Same SSE shape as
 * {@link searchPatientChartStream} plus:
 *   - sends an optional {@code session} uuid so the server can reuse the
 *     prior conversation thread
 *   - captures the server's {@code X-ChartSearchAi-Session} response header
 *     and surfaces it via {@code onSession} before the first token arrives
 *
 * The server is the source of truth for conversation history — the client
 * sends only the new user message, not the rendered transcript.
 */
export function chatPatientChartStream(
  patientUuid: string,
  sessionUuid: string | null,
  question: string,
  callbacks: {
    onSession: (uuid: string) => void;
    onToken: (token: string) => void;
    onDone: (response: AiSearchResponse) => void;
    onError: (error: string) => void;
  },
  abortController?: AbortController,
): void {
  const url = `${window.openmrsBase}${BASE_PATH}/chat/stream`;
  const body: Record<string, string> = { patient: patientUuid, question };
  if (sessionUuid) {
    body.session = sessionUuid;
  }

  window
    .fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'Disable-WWW-Authenticate': 'true',
      },
      body: JSON.stringify(body),
      credentials: 'include',
      redirect: 'manual',
      signal: abortController?.signal,
    })
    .then(async (response) => {
      if (response.type === 'opaqueredirect' || response.status === 0) {
        callbacks.onError('Your session has expired. Please log in again.');
        return;
      }

      if (!response.ok) {
        let message = `Server error: ${response.status}`;
        try {
          const errBody = await response.json();
          if (errBody?.error) {
            message = errBody.error;
          }
        } catch {
          // no JSON body
        }
        callbacks.onError(message);
        return;
      }

      // Capture the session uuid the server pinned for this conversation
      // before we start consuming the stream — the client uses it to thread
      // subsequent posts onto the same conversation row.
      const sessionHeader = response.headers.get('X-ChartSearchAi-Session');
      if (sessionHeader) {
        callbacks.onSession(sessionHeader);
      }

      const reader = response.body;

      if (!reader || typeof reader.getReader !== 'function') {
        callbacks.onError('Streaming not supported by this browser.');
        return;
      }

      const textDecoder = new TextDecoder();
      const streamReader = reader.getReader();
      let buffer = '';
      let eventType = '';
      let dataLines: string[] = [];
      let streamFinalized = false;

      function dispatchEvent() {
        if (dataLines.length === 0) {
          eventType = '';
          return;
        }
        const data = dataLines.join('\n');
        if (eventType === 'token') {
          callbacks.onToken(data);
        } else if (eventType === 'done') {
          streamFinalized = true;
          try {
            const parsed: AiSearchResponse = JSON.parse(data);
            callbacks.onDone(parsed);
          } catch {
            callbacks.onError('Failed to parse final response');
          }
        } else if (eventType === 'error') {
          streamFinalized = true;
          callbacks.onError(data);
        }
        eventType = '';
        dataLines = [];
      }

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await streamReader.read();
        if (done) break;

        buffer += textDecoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line === '') {
            dispatchEvent();
          } else if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const raw = line.slice(5);
            dataLines.push(raw.startsWith(' ') ? raw.slice(1) : raw);
          }
        }
      }

      if (buffer) {
        for (const line of buffer.split('\n')) {
          if (line === '') {
            dispatchEvent();
          } else if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const raw = line.slice(5);
            dataLines.push(raw.startsWith(' ') ? raw.slice(1) : raw);
          }
        }
      }

      dispatchEvent();

      if (!streamFinalized) {
        callbacks.onError('Stream ended unexpectedly without a response');
      }
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        callbacks.onError(err?.message ?? 'An unknown error occurred');
      }
    });
}

/**
 * Hydrate the chat panel state on mount. Returns the active session
 * (creating one if none exists) and its full message list in chronological
 * order. Empty messages array on a freshly-created session.
 */
export async function fetchChatHistory(
  patientUuid: string,
  abortController?: AbortController,
): Promise<ChatHistoryResponse> {
  const response = await openmrsFetch(`${BASE_PATH}/chat?patient=${encodeURIComponent(patientUuid)}`, {
    signal: abortController?.signal,
  });
  return response.data as ChatHistoryResponse;
}

/**
 * Close the current active chat session for this (patient, user) pair
 * and open a fresh one. Returns the new session uuid.
 */
export async function startNewChat(
  patientUuid: string,
  abortController?: AbortController,
): Promise<ChatHistoryResponse> {
  const response = await openmrsFetch(`${BASE_PATH}/chat/new`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patient: patientUuid }),
    signal: abortController?.signal,
  });
  return response.data as ChatHistoryResponse;
}

export interface ModelEntry {
  /** Identifier passed to /v1/chat/completions; LM Studio v1 `key`. */
  id: string;
  /** Human-readable label. Defaults to `id` when the backend doesn't supply one. */
  displayName: string;
  /** "llm" | "embedding" — only "llm" entries reach the picker. */
  type: string;
  /** True when LM Studio reports the model is in memory; false otherwise. */
  loaded: boolean;
  /** Max context length per LM Studio; absent when unknown. */
  maxContextLength?: number;
}

export interface ModelListResponse {
  engine: 'remote' | 'local' | string;
  current: string | null;
  available: string[];
  endpointUrl?: string | null;
  /**
   * Backend probe outcome:
   *   "lm-studio"             — /api/v1/models returned the v1 shape; entries[] populated.
   *   "generic-openai-compat" — fell back to /v1/models; entries[] derived from IDs only.
   *   undefined / null        — legacy backend (PR #15 baseline) didn't supply the field.
   */
  provider?: 'lm-studio' | 'generic-openai-compat' | string | null;
  /** Per-entry richer info. Populated when the backend probe gave it; absent otherwise. */
  entries?: ModelEntry[];
}

/**
 * List the models the active remote endpoint serves, plus the current GP
 * selection. Returns {engine:'local', available:[]} when the backend is
 * running the local engine — the picker hides itself in that case.
 *
 * 503 from the server (local engine, misconfig) propagates as a thrown
 * error; the picker treats throw + empty list the same way (hidden).
 */
export async function fetchAvailableModels(abortController?: AbortController): Promise<ModelListResponse> {
  const response = await openmrsFetch(`${BASE_PATH}/models`, {
    signal: abortController?.signal,
  });
  return response.data as ModelListResponse;
}

/**
 * Switch the active model. The backend validates membership in the live
 * /v1/models list before writing the GP; an unknown id returns 400.
 */
export async function setCurrentModel(
  modelName: string,
  abortController?: AbortController,
): Promise<{ current: string }> {
  const response = await openmrsFetch(`${BASE_PATH}/model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelName }),
    signal: abortController?.signal,
  });
  return response.data as { current: string };
}

/**
 * Pre-load a model into LM Studio memory. Calls the backend's
 * POST /chartsearchai/model/load which routes through to LM Studio's
 * /api/v1/models/load. Blocks until the model is in memory (LM Studio's
 * load endpoint is synchronous; default 2-minute backend timeout).
 *
 * <p>Used by the picker when the user selects an entry whose `loaded`
 * flag is false — pays the load latency at pick-time (with a spinner)
 * rather than on the first chat turn (with an opaque pause).
 *
 * <p>503 when the active provider isn't LM Studio (backend returns
 * silently in that case; this resolves with `loaded: ""`). 400 for
 * blank input.
 */
export async function loadModel(modelName: string, abortController?: AbortController): Promise<{ loaded: string }> {
  const response = await openmrsFetch(`${BASE_PATH}/model/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelName }),
    signal: abortController?.signal,
  });
  return response.data as { loaded: string };
}
