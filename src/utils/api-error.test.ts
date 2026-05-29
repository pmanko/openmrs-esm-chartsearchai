import { describe, expect, it } from 'vitest';
import { extractApiError } from './api-error';

describe('extractApiError', () => {
  it('reads the backend error string from responseBody.error (openmrsFetch shape)', () => {
    // chartsearchai backend errorResponse() returns { error: "<message>" }.
    const err = Object.assign(new Error('Server responded with 503'), {
      responseBody: { error: "Failed to pre-load model 'gemma-4-e2b-it': HTTP 500: insufficient system resources" },
    });
    const info = extractApiError(err);
    expect(info.message).toContain('insufficient system resources');
    // Must NOT be the generic openmrsFetch .message — that's the whole bug.
    expect(info.message).not.toBe('Server responded with 503');
    expect(info.isResourceError).toBe(true);
  });

  it('flags LM Studio model_load_failed as a resource error', () => {
    const err = { responseBody: { error: 'model_load_failed: would overload your system' } };
    expect(extractApiError(err).isResourceError).toBe(true);
  });

  it('handles the nested {error:{message}} object shape', () => {
    const err = { responseBody: { error: { message: 'Not enough memory to load model' } } };
    const info = extractApiError(err);
    expect(info.message).toBe('Not enough memory to load model');
    expect(info.isResourceError).toBe(true);
  });

  it('does NOT flag a non-resource error as a resource error', () => {
    const err = Object.assign(new Error('boom'), {
      responseBody: { error: "Model 'bogus' is not in the active endpoint's /v1/models list." },
    });
    const info = extractApiError(err);
    expect(info.message).toContain('not in the active endpoint');
    expect(info.isResourceError).toBe(false);
  });

  it('falls back to err.message when there is no responseBody', () => {
    const info = extractApiError(new Error('network down'));
    expect(info.message).toBe('network down');
    expect(info.isResourceError).toBe(false);
  });

  it('returns a safe default for null/undefined', () => {
    expect(extractApiError(undefined).message).toBe('Request failed');
    expect(extractApiError(null).isResourceError).toBe(false);
  });
});
