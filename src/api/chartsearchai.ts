import { openmrsFetch, restBaseUrl } from '@openmrs/esm-framework';

const BASE_PATH = `${restBaseUrl}/chartsearchai`;

/**
 * Error code emitted via {@code onError} for every way an expired session surfaces on the SSE
 * endpoint: the 302 opaque redirect, a bare 401/403, and the committed-redirect 500. It is a stable
 * code, NOT a display string — user-facing text must be localized in a component (the translation
 * extractor only scans {@code *.component.tsx}). {@code AiResponsePanel} maps this to a translated message.
 */
export const SESSION_EXPIRED_ERROR_CODE = 'chartsearchai:session-expired';

export interface AiReference {
  index: number;
  resourceType: string;
  /**
   * OpenMRS UUID of the cited record (the backend serializes this field as `resourceUuid`).
   * Used to locate and highlight the record's row after navigating to its chart page.
   */
  resourceUuid: string;
  date: string;
  /** Resolved source record text, when supplied by the hub staged path. */
  sourceText?: string;
  /**
   * Citation grounding verdict from the backend: true = the cited record
   * supports the claim, false = it does not, null/absent = unverified
   * (grounding disabled or could not run). Render null as "unverified",
   * never as "verified".
   */
  grounded?: boolean | null;
  /**
   * Lifecycle/status for citation grounding. `checking` means the backend has resolved
   * the source record but final support verification is still running.
   */
  groundingStatus?: 'checking' | 'verified' | 'unsupported' | 'unchecked' | 'mixed';
  /** Whether support was evaluated from this record alone or a cited source set. */
  groundingScope?: 'record' | 'source_set';
  /** Citation indices evaluated together when groundingScope is source_set. */
  groundingGroup?: number[];
  /** Claim/path-level verdicts retained when one record is used more than once. */
  groundingChecks?: Array<{
    status: 'verified' | 'unsupported' | 'unchecked';
    claim: string;
    location: string;
    path?: string;
    source_indices: number[];
  }>;
}

/**
 * A non-blocking deterministic safety advisory emitted by med-agent-hub. It
 * annotates the answer and is rendered as a chip below it.
 */
export interface AiSafetyWarning {
  /** 'overdose' | 'interaction' | 'contraindication' */
  type: string;
  /** the reference drug the warning is about */
  drug: string;
  /** human-readable detail, e.g. "interacts with active order warfarin" */
  detail: string;
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

/** One section's validator confidence: a traffic-light level + an optional caveat note. */
export interface AiConfidenceSection {
  level: 'green' | 'yellow' | 'red';
  note?: string;
}

/**
 * Per-section confidence metadata emitted by the selected med-agent-hub profile.
 */
export interface AiConfidence {
  answer?: AiConfidenceSection;
  in_depth?: AiConfidenceSection;
}

export interface AiInDepth {
  status: 'pending' | 'complete' | 'failed';
  answer?: string;
  error?: string;
}

export type AiAnswerValidationStatus = 'validating' | 'checked' | 'edited' | 'needs_review' | 'unavailable';

export interface AiAnswerValidation {
  status: AiAnswerValidationStatus;
  label: string;
  summary?: string;
  issues?: unknown[];
  completedAt?: string;
  originalAnswer?: string;
}

export interface AiSearchResponse {
  answer: string;
  references: AiReference[];
  /** Deterministic safety advisories emitted by the selected hub profile. */
  safetyWarnings?: AiSafetyWarning[];
  blocks?: AiBlock[];
  questionId?: string;
  /** Server-side conversation handle. Present on chat responses only. */
  session?: string;
  /** Server-assigned uuid for the assistant message row. Present on chat responses only. */
  messageId?: string;
  /** Product profile id that produced this answer. */
  resolvedModel?: string;
  /** Per-section validator confidence (green/yellow/red + note) from the validated hub tiers. */
  confidence?: AiConfidence;
  /** Clinician-facing answer check lifecycle for staged validated responses. */
  answerValidation?: AiAnswerValidation;
  /** In-Depth analysis attached after the direct answer settles. */
  inDepth?: AiInDepth;
}

export interface ChatHistoryMessage {
  messageId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  references?: AiReference[];
  blocks?: AiBlock[];
  /** Deterministic safety advisories emitted by the selected hub profile. */
  safetyWarnings?: AiSafetyWarning[];
  confidence?: AiConfidence;
  answerValidation?: AiAnswerValidation;
  inDepth?: AiInDepth;
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
 * Streaming variant for multi-turn chat. SSE (Server-Sent Events) stream, parsed via raw
 * fetch instead of openmrsFetch because openmrsFetch consumes the response body to parse
 * it as JSON, which prevents streaming — we need direct access to response.body (the
 * ReadableStream). The staged endpoint emits answer/validation/in-depth boundary events:
 *   - sends an optional {@code session} uuid so the server can reuse the
 *     prior conversation thread
 *   - captures the server's {@code X-ChartSearchAi-Session} response header
 *     and surfaces it via {@code onSession} before the first content event arrives
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
    onAnswerDone?: (response: AiSearchResponse) => void;
    onAnswerValidation?: (response: AiSearchResponse) => void;
    onInDepthPending?: (payload: Partial<AiSearchResponse> & { messageId?: string; inDepth?: AiInDepth }) => void;
    onInDepthDone?: (inDepth: AiInDepth) => void;
    onInDepthError?: (inDepth: AiInDepth) => void;
    onDone: (response: AiSearchResponse) => void;
    onError: (error: string) => void;
  },
  abortController?: AbortController,
  profileId?: string | null,
): void {
  const url = `${window.openmrsBase}${BASE_PATH}/chat/stream`;
  const body: Record<string, string> = { patient: patientUuid, question };
  if (sessionUuid) {
    body.session = sessionUuid;
  }
  // Product profile selection is the only client-controlled inference input.
  // The Java relay owns the hub endpoint; med-agent-hub owns stage composition.
  if (profileId) {
    body.profile = profileId;
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
        if (eventType === 'answer_done') {
          try {
            const raw = JSON.parse(data) as AiSearchResponse & { model?: string };
            callbacks.onAnswerDone?.({ ...raw, resolvedModel: raw.resolvedModel ?? raw.model });
          } catch {
            callbacks.onError('Failed to parse staged answer response');
          }
        } else if (eventType === 'answer_validation') {
          try {
            const raw = JSON.parse(data) as AiSearchResponse & { model?: string };
            callbacks.onAnswerValidation?.({ ...raw, resolvedModel: raw.resolvedModel ?? raw.model });
          } catch {
            callbacks.onError('Failed to parse answer validation response');
          }
        } else if (eventType === 'indepth_pending') {
          try {
            callbacks.onInDepthPending?.(
              JSON.parse(data) as Partial<AiSearchResponse> & { messageId?: string; inDepth?: AiInDepth },
            );
          } catch {
            callbacks.onError('Failed to parse in-depth pending response');
          }
        } else if (eventType === 'indepth_done') {
          try {
            callbacks.onInDepthDone?.(JSON.parse(data) as AiInDepth);
          } catch {
            callbacks.onError('Failed to parse in-depth response');
          }
        } else if (eventType === 'indepth_error') {
          try {
            callbacks.onInDepthError?.(JSON.parse(data) as AiInDepth);
          } catch {
            callbacks.onError('Failed to parse in-depth error response');
          }
        } else if (eventType === 'done') {
          streamFinalized = true;
          try {
            const raw = JSON.parse(data) as AiSearchResponse & { model?: string };
            // The backend sends the resolved model as `model`; surface it as resolvedModel.
            callbacks.onDone({ ...raw, resolvedModel: raw.resolvedModel ?? raw.model });
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

export interface HubProfileMetadata {
  id: string;
  label: string;
  staged: boolean;
  validation: boolean;
  temporal_enforcement: 'off' | 'warn' | 'enforce' | string;
  available: boolean;
  default: boolean;
  selection_priority: number;
  topology: 'single' | 'team' | string;
  visibility: 'product' | 'internal' | 'experimental' | string;
  stages: string[];
  required_models: string[];
  context_window: number | null;
  exact_tokenizer: boolean;
  unavailable_reasons: string[];
}

export interface HubProfileListResponse {
  object: 'list' | string;
  data: HubProfileMetadata[];
}

/**
 * Relay med-agent-hub's authoritative profile metadata through ChartSearchAI.
 */
export async function fetchProfiles(abortController?: AbortController): Promise<HubProfileListResponse> {
  const response = await openmrsFetch(`${BASE_PATH}/models`, {
    signal: abortController?.signal,
  });
  return response.data as HubProfileListResponse;
}
