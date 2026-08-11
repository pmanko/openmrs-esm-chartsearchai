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
  /**
   * Citation grounding verdict from the backend: true = the cited record
   * supports the claim, false = it does not, null/absent = unverified
   * (grounding disabled or could not run). Render null as "unverified",
   * never as "verified".
   */
  grounded?: boolean | null;
}

/**
 * A non-blocking drug-safety advisory raised by the backend's post-answer validator
 * (only when the optional drug-reference feature is enabled). It annotates the answer
 * — it never alters it. Rendered as a chip below the answer.
 */
export interface AiSafetyWarning {
  /** 'overdose' | 'interaction' | 'contraindication' */
  type: string;
  /** the reference drug the warning is about */
  drug: string;
  /** human-readable detail, e.g. "interacts with active order warfarin" */
  detail: string;
}

export interface AiSearchResponse {
  answer: string;
  references: AiReference[];
  /** Empty/absent unless the optional drug-reference feature is enabled on the server. */
  safetyWarnings?: AiSafetyWarning[];
  questionId?: string;
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
    /**
     * Early citations, emitted by the server the moment the answer's references are
     * known — before the (slower) grounding pass attaches verdicts. Lets the UI show
     * the citations immediately as unverified; the {@code done} event then re-sends
     * the same references with their grounding verdicts. Optional and best-effort: a
     * missing or malformed event is ignored, since {@code done} is authoritative.
     */
    onReferences?: (references: AiReference[]) => void;
    /**
     * Trailing grounding verdicts, emitted only when the server runs with
     * {@code chartsearchai.grounding.async=true}: in that mode {@code done} arrives as soon
     * as the answer is complete (its references carry no verdicts) and this event re-sends
     * the same references with their {@code grounded} verdicts once the (slower) Tier-2
     * verification finishes. Best-effort like {@code onReferences}: when the server runs in
     * classic mode the event never arrives and {@code done}'s references are already final;
     * a malformed payload just leaves citations rendered as unverified.
     */
    onGrounded?: (references: AiReference[]) => void;
    /**
     * Live reasoning ("thinking") chunks, streamed by the server before the answer so the
     * UI can show progress and the model's rationale instead of a dead spinner during the
     * reasoning phase. Scratchpad only — render distinctly (subdued, transient), never as
     * the answer.
     */
    onThinking?: (chunk: string) => void;
    /**
     * Preliminary reasoning chunks from the optional progressive-reasoning preview pass (server
     * GP {@code chartsearchai.progressiveReasoning.enabled}). Streamed before {@code onThinking}
     * over only the top-K focused chart, so the UI can show reasoning almost immediately on a
     * slow host. It is provisional and can be wrong until the committed full-chart reasoning
     * arrives — render it distinctly (subdued/labelled as an in-progress preview, not the answer)
     * and REPLACE it the moment the first {@code onThinking} (or {@code onToken}) chunk arrives.
     * Never fires when the server GP is off.
     */
    onPreliminary?: (chunk: string) => void;
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
        callbacks.onError(SESSION_EXPIRED_ERROR_CODE);
        return;
      }

      if (!response.ok) {
        let bodyError: string | null = null;
        try {
          const body = await response.json();
          if (body?.error) {
            bodyError = body.error;
          }
        } catch {
          // non-JSON body (a bare container/auth response, not a controller error)
        }
        if (bodyError) {
          // The controller always serializes its errors as JSON, so a parseable error is a genuine
          // server-side failure — surface it verbatim.
          callbacks.onError(bodyError);
        } else if (response.status >= 500 || response.status === 401 || response.status === 403) {
          // No JSON body means this came from OpenMRS's auth/session layer, not the controller:
          // a 401/403, or a 500 that is really "sendRedirect() after the response was committed"
          // (the SSE stream commits the response, so the expired-session login redirect can't fire
          // and surfaces as a bare HTML 500). Treat all of these as session expiry — the same
          // actionable cause as the 302 handled above — rather than a cryptic "Server error: 500".
          callbacks.onError(SESSION_EXPIRED_ERROR_CODE);
        } else {
          callbacks.onError(`Server error: ${response.status}`);
        }
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
        } else if (eventType === 'thinking') {
          callbacks.onThinking?.(data);
        } else if (eventType === 'preliminary') {
          callbacks.onPreliminary?.(data);
        } else if (eventType === 'references') {
          // Pre-grounding citations: best-effort, so a malformed payload is ignored rather
          // than failing the stream — the authoritative references arrive with `done`.
          try {
            const parsed = JSON.parse(data);
            callbacks.onReferences?.(parsed.references ?? []);
          } catch {
            // ignore; `done` is authoritative
          }
        } else if (eventType === 'grounded') {
          // Post-done verdicts (async grounding). Best-effort: a malformed payload leaves
          // the citations unverified rather than erroring an already-complete answer.
          try {
            const parsed = JSON.parse(data);
            callbacks.onGrounded?.(parsed.references ?? []);
          } catch {
            // ignore; citations simply stay unverified
          }
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
