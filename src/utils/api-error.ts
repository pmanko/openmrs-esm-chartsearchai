/**
 * Extract a human-readable message from a failed chartsearchai API call and
 * flag whether it's a model *resource* (memory) failure.
 *
 * `openmrsFetch` throws an error carrying the parsed error body on
 * `responseBody`. The chartsearchai backend's `errorResponse(message)` returns
 * `{ "error": "<message>" }`, so the real reason (e.g. LM Studio's "insufficient
 * system resources" text bubbled up from `POST /api/v1/models/load`) lives at
 * `err.responseBody.error` — NOT on `err.message`, which is the generic
 * "Server responded with 503" string. Reading only `err.message` is why the
 * picker previously showed an opaque "failed to switch" instead of the real
 * cause.
 */
export interface ApiErrorInfo {
  /** Backend error text when present, else the thrown error's message. */
  message: string;
  /** True when the failure is a model load / memory resource problem. */
  isResourceError: boolean;
}

/**
 * Matches LM Studio's model-load resource failures (it refuses to load when a
 * model would overcommit memory — it does not auto-evict explicitly-loaded
 * models to make room). Kept broad on purpose: the same condition surfaces with
 * slightly different wording across LM Studio versions and the OpenAI-compat vs
 * native load paths.
 */
const RESOURCE_ERROR_PATTERN =
  /insufficient (system )?resources|model_load_failed|out of memory|not enough (memory|ram|resources)|overload|failed to load (the )?(llm|model)/i;

export function extractApiError(err: unknown): ApiErrorInfo {
  const anyErr = err as { responseBody?: { error?: unknown }; message?: unknown } | null | undefined;

  let backendMsg: string | undefined;
  const rbError = anyErr?.responseBody?.error;
  if (typeof rbError === 'string') {
    backendMsg = rbError;
  } else if (rbError && typeof rbError === 'object') {
    const nested = (rbError as { message?: unknown }).message;
    if (typeof nested === 'string') {
      backendMsg = nested;
    }
  }

  const fallback = typeof anyErr?.message === 'string' ? anyErr.message : undefined;
  const message = backendMsg ?? fallback ?? 'Request failed';

  return { message, isResourceError: RESOURCE_ERROR_PATTERN.test(message) };
}
