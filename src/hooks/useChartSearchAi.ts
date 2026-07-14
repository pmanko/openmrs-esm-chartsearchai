import { useCallback, useEffect, useRef } from 'react';
import { useStore } from '@openmrs/esm-framework';
import {
  type AiBlock,
  type AiAnswerValidation,
  type AiConfidence,
  type AiInDepth,
  type AiReference,
  type AiSafetyWarning,
  type AiSearchResponse,
  type ChatHistoryMessage,
  chatPatientChartStream,
  fetchChatHistory,
  startNewChat,
} from '../api/chartsearchai';
import { chatSessionStore } from '../store/chat-session.store';
import { type TurnPhase, isAwaitingAnswer as phaseIsAwaitingAnswer, isAnswerSettled, isTerminal } from './turn-phase';

export interface ChatMessage {
  id: string;
  question: string;
  answer: string;
  references: AiReference[];
  safetyWarnings?: AiSafetyWarning[];
  blocks?: AiBlock[];
  auditLogId?: number;
  /**
   * The turn's single lifecycle phase — the source of truth for composer behavior, section
   * rendering, and DOM signals. Mirrors the backend staged SSE events (see {@link TurnPhase}).
   */
  phase: TurnPhase;
  error: string | null;
  /**
   * The hub product profile that produced this answer. Surfaced as a subtle
   * per-response tag. Undefined for older rows or system notices.
   */
  resolvedModel?: string;
  /** Per-section validator confidence (green/yellow/red + note); validated hub tiers only. */
  confidence?: AiConfidence;
  /** Answer check lifecycle for staged validated responses. */
  answerValidation?: AiAnswerValidation;
  /** Product-profile In-Depth state attached to this assistant turn. */
  inDepth?: AiInDepth;
}

interface UseChartSearchAiReturn {
  messages: ChatMessage[];
  /**
   * The latest turn is still producing or checking its direct answer ({@link TurnPhase} `answering`/`checking`).
   * The composer disables on this — so a new question can be asked while the prior turn's in-depth is
   * still streaming in the background.
   */
  isAwaitingAnswer: boolean;
  submitQuestion: (patientUuid: string, question: string) => void;
  clearMessages: () => void;
  stopCurrent: () => void;
  /**
   * Close the current server-side session for this patient and open a
   * fresh one. Use for the "New chat" button.
   */
  startNewChatSession: (patientUuid: string) => void;
}

function generateId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

const EMPTY_MESSAGES: ChatMessage[] = [];

function updateMessages(patientUuid: string, updater: (prev: ChatMessage[]) => ChatMessage[]): void {
  const current = chatSessionStore.getState().messagesByPatient;
  const prev = current[patientUuid] ?? EMPTY_MESSAGES;
  const next = updater(prev);
  if (next === prev) return;
  chatSessionStore.setState({ ...chatSessionStore.getState(), messagesByPatient: { ...current, [patientUuid]: next } });
}

function setSessionUuid(patientUuid: string, uuid: string | null): void {
  const state = chatSessionStore.getState();
  chatSessionStore.setState({
    ...state,
    sessionUuidByPatient: { ...state.sessionUuidByPatient, [patientUuid]: uuid },
  });
}

/**
 * Map a hydration row from the server's chat-history endpoint to a
 * UI {@link ChatMessage}. Server stores user and assistant rows
 * separately (one per turn); the UI groups them as Q+A pairs anchored
 * on the user-message uuid as the row id.
 */
function hydrateMessages(history: ChatHistoryMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let pending: ChatMessage | null = null;
  for (const m of history) {
    if (m.role === 'user') {
      if (pending) {
        // Two consecutive user messages — push the prior with empty answer.
        // This is unusual (LLM call failed) but the UI must remain coherent.
        out.push(pending);
      }
      pending = {
        id: m.messageId,
        question: m.content,
        answer: '',
        references: [],
        auditLogId: undefined,
        phase: 'complete',
        error: null,
      };
    } else if (m.role === 'assistant') {
      if (pending) {
        pending.answer = m.content;
        pending.blocks = m.blocks;
        pending.safetyWarnings = m.safetyWarnings;
        pending.confidence = m.confidence;
        pending.answerValidation = interruptAnswerValidation(m.answerValidation);
        pending.inDepth = interruptInDepth(m.inDepth);
        pending.references = m.references ?? [];
        pending.auditLogId = m.auditLogId;
        out.push(pending);
        pending = null;
      }
      // Orphan assistant row without a preceding user — ignore (UI has no
      // sane render for it); the row stays in the DB for audit purposes.
    }
    // 'system' rows are dropped — they belong to the LLM-prompt layer.
  }
  if (pending) {
    out.push(pending);
  }
  return out;
}

function stripInDepthHeader(text: string): string {
  return text.replace(/^\s*\*\*In ?Depth\*\*\s*/i, '').trimStart();
}

function interruptInDepth(inDepth?: AiInDepth): AiInDepth | undefined {
  if (!inDepth || inDepth.status !== 'pending') return inDepth;
  return { ...inDepth, status: 'failed', error: 'In-Depth was interrupted.' };
}

function interruptAnswerValidation(
  validation?: AiSearchResponse['answerValidation'],
): AiSearchResponse['answerValidation'] | undefined {
  if (!validation || validation.status !== 'checking') return validation;
  return {
    ...validation,
    status: 'unavailable',
    label: 'Check unavailable',
    summary: 'The answer check was interrupted before completion.',
  };
}

type TurnEnvelope = Partial<AiSearchResponse> & { messageId?: string; inDepth?: AiInDepth };

function applyTurnEnvelope(message: ChatMessage, payload: TurnEnvelope, phase: TurnPhase): ChatMessage {
  return {
    ...message,
    answer: payload.answer ?? message.answer,
    references: payload.references ?? message.references,
    safetyWarnings: payload.safetyWarnings ?? message.safetyWarnings,
    blocks: payload.blocks ?? message.blocks,
    confidence: payload.confidence ?? message.confidence,
    answerValidation: payload.answerValidation ?? message.answerValidation,
    inDepth: payload.inDepth ?? message.inDepth,
    auditLogId: payload.auditLogId ?? message.auditLogId,
    resolvedModel: payload.resolvedModel ?? message.resolvedModel,
    phase,
  };
}

export function useChartSearchAi(patientUuid?: string): UseChartSearchAiReturn {
  const { messagesByPatient, sessionUuidByPatient } = useStore(chatSessionStore);
  const messages: ChatMessage[] = patientUuid ? (messagesByPatient[patientUuid] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES;
  const abortControllerRef = useRef<AbortController | null>(null);
  const inFlightMessageIdRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Hydrate on mount / patient change. Cleared if the patient has nothing
  // server-side OR if hydration fails — in either case we start blank and
  // the first submit creates a fresh session.
  useEffect(() => {
    if (!patientUuid) return;
    if (messagesByPatient[patientUuid] && messagesByPatient[patientUuid].length > 0) {
      // Local cache already populated (e.g. user just submitted a turn);
      // skip the round-trip.
      return;
    }
    const controller = new AbortController();
    fetchChatHistory(patientUuid, controller)
      .then((response) => {
        if (!isMountedRef.current || controller.signal.aborted) return;
        setSessionUuid(patientUuid, response.session ?? null);
        const hydrated = hydrateMessages(response.messages ?? []);
        if (hydrated.length > 0) {
          updateMessages(patientUuid, () => hydrated);
        }
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        console.warn('[useChartSearchAi] hydrate failed; starting empty', err);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientUuid]);

  const clearMessages = useCallback(() => {
    if (patientUuid) {
      updateMessages(patientUuid, () => []);
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    inFlightMessageIdRef.current = null;
  }, [patientUuid]);

  const stopCurrent = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    const stoppedId = inFlightMessageIdRef.current;
    inFlightMessageIdRef.current = null;
    if (stoppedId && patientUuid) {
      updateMessages(patientUuid, (prev) => {
        const idx = prev.findIndex((m) => m.id === stoppedId);
        if (idx === -1) return prev;
        const msg = prev[idx];
        if (isTerminal(msg.phase)) return prev;
        if (!msg.answer) {
          return prev.filter((_, i) => i !== idx);
        }
        const updated = [...prev];
        updated[idx] = {
          ...msg,
          phase: 'complete',
          answerValidation: interruptAnswerValidation(msg.answerValidation),
          inDepth: interruptInDepth(msg.inDepth),
        };
        return updated;
      });
    }
  }, [patientUuid]);

  const startNewChatSession = useCallback((patientUuid: string) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    inFlightMessageIdRef.current = null;
    updateMessages(patientUuid, () => []);
    setSessionUuid(patientUuid, null);
    startNewChat(patientUuid)
      .then((response) => {
        if (!isMountedRef.current) return;
        setSessionUuid(patientUuid, response.session ?? null);
      })
      .catch((err) => {
        console.warn('[useChartSearchAi] startNewChat failed', err);
      });
  }, []);

  const submitQuestion = useCallback(
    (patientUuid: string, question: string) => {
      const discoveryStatus = chatSessionStore.getState().profileDiscoveryStatus;
      if (discoveryStatus !== 'ready') {
        const error =
          discoveryStatus === 'loading'
            ? 'AI profiles are still loading. Try again in a moment.'
            : 'AI profiles are unavailable. Check the med-agent-hub connection.';
        const failedMessage: ChatMessage = {
          id: generateId(),
          question,
          answer: '',
          references: [],
          auditLogId: undefined,
          phase: 'error',
          error,
        };
        updateMessages(patientUuid, (prev) => [...prev, failedMessage]);
        return;
      }
      if (abortControllerRef.current) {
        // A turn is still in flight. If its answer has NOT settled yet, don't start a second
        // answer generation (one at a time — this is what keeps the server's getLastOrdinal()
        // path single-flight and race-free). If the answer HAS settled and only the background
        // in-depth is trailing, PREEMPT it so this new question starts immediately. The turn's
        // phase is the single source of truth: isAnswerSettled once validation has landed.
        const preemptedId = inFlightMessageIdRef.current;
        const inFlight = preemptedId
          ? (chatSessionStore.getState().messagesByPatient[patientUuid] ?? []).find((m) => m.id === preemptedId)
          : undefined;
        if (!inFlight || !isAnswerSettled(inFlight.phase)) return;
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
        inFlightMessageIdRef.current = null;
        if (preemptedId) {
          updateMessages(patientUuid, (prev) => {
            const idx = prev.findIndex((m) => m.id === preemptedId);
            if (idx === -1) return prev;
            const msg = prev[idx];
            if (isTerminal(msg.phase)) return prev;
            const updated = [...prev];
            // Keep any received content, but report that the phase was interrupted.
            updated[idx] = {
              ...msg,
              phase: 'complete',
              answerValidation: interruptAnswerValidation(msg.answerValidation),
              inDepth: interruptInDepth(msg.inDepth),
            };
            return updated;
          });
        }
      }

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const newMessage: ChatMessage = {
        id: generateId(),
        question,
        answer: '',
        references: [],
        auditLogId: undefined,
        phase: 'answering',
        error: null,
      };

      updateMessages(patientUuid, (prev) => [...prev, newMessage]);
      const messageId = newMessage.id;
      inFlightMessageIdRef.current = messageId;

      const done = (response: AiSearchResponse) => {
        if (!isMountedRef.current) return;
        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null;
        }
        if (inFlightMessageIdRef.current === messageId) {
          inFlightMessageIdRef.current = null;
        }
        updateMessages(patientUuid, (prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx === -1) return prev;
          const updated = [...prev];
          updated[idx] = applyTurnEnvelope(updated[idx], response, 'complete');
          return updated;
        });
        // Belt-and-braces: the X-ChartSearchAi-Session header captures the
        // session uuid first, but the `done` event also carries it for
        // sync clients that can't read response headers.
        if (response.session) {
          setSessionUuid(patientUuid, response.session);
        }
      };

      const fail = (errMessage: string) => {
        if (!isMountedRef.current) return;
        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null;
        }
        if (inFlightMessageIdRef.current === messageId) {
          inFlightMessageIdRef.current = null;
        }
        console.error('[useChartSearchAi] Request failed:', errMessage);
        updateMessages(patientUuid, (prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx === -1) return prev;
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx],
            answerValidation: interruptAnswerValidation(updated[idx].answerValidation),
            error: errMessage,
            phase: 'error',
          };
          return updated;
        });
      };

      const answerDone = (response: AiSearchResponse) => {
        if (!isMountedRef.current) return;
        updateMessages(patientUuid, (prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx === -1) return prev;
          const updated = [...prev];
          const phase = response.answerValidation?.status === 'checking' ? 'checking' : 'settled';
          updated[idx] = applyTurnEnvelope(
            updated[idx],
            { ...response, inDepth: response.inDepth ?? { status: 'pending', answer: '' } },
            phase,
          );
          return updated;
        });
        if (response.session) {
          setSessionUuid(patientUuid, response.session);
        }
      };

      const answerValidation = (response: AiSearchResponse) => {
        if (!isMountedRef.current) return;
        // The answer + validation have landed; only in-depth remains. Moving to `settled` unlocks
        // the composer AND makes this turn preemptable (submitQuestion reads the phase).
        updateMessages(patientUuid, (prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx === -1) return prev;
          const updated = [...prev];
          updated[idx] = applyTurnEnvelope(updated[idx], response, 'settled');
          return updated;
        });
      };

      const inDepthPending = (payload: Partial<AiSearchResponse> & { messageId?: string; inDepth?: AiInDepth }) => {
        if (!isMountedRef.current) return;
        updateMessages(patientUuid, (prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx === -1) return prev;
          const updated = [...prev];
          updated[idx] = applyTurnEnvelope(
            updated[idx],
            {
              ...payload,
              inDepth: payload.inDepth ?? { status: 'pending', answer: updated[idx].inDepth?.answer ?? '' },
            },
            'in-depth',
          );
          return updated;
        });
      };

      const inDepthDone = (payload: TurnEnvelope) => {
        if (!isMountedRef.current) return;
        updateMessages(patientUuid, (prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx === -1) return prev;
          const updated = [...prev];
          const inDepth = payload.inDepth;
          updated[idx] = applyTurnEnvelope(
            updated[idx],
            inDepth
              ? { ...payload, inDepth: { ...inDepth, answer: stripInDepthHeader(inDepth.answer ?? '') } }
              : payload,
            'complete',
          );
          return updated;
        });
      };

      const inDepthError = (payload: TurnEnvelope) => {
        if (!isMountedRef.current) return;
        updateMessages(patientUuid, (prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx === -1) return prev;
          const updated = [...prev];
          // The direct answer is still available; only the background in-depth failed → terminal.
          const inDepth = payload.inDepth;
          updated[idx] = applyTurnEnvelope(
            updated[idx],
            inDepth
              ? {
                  ...payload,
                  inDepth:
                    inDepth.status === 'failed' || inDepth.status === 'needs_review'
                      ? inDepth
                      : { ...inDepth, status: 'failed' },
                }
              : payload,
            'complete',
          );
          return updated;
        });
      };

      const sessionUuid = sessionUuidByPatient[patientUuid] ?? null;
      // Read the latest hub product-profile selection at submit time.
      const selectedProfileId = chatSessionStore.getState().selectedProfileId;

      try {
        // Multi-turn streaming: chat history is reconstructed server-side
        // from the session uuid; we only send the new question.
        chatPatientChartStream(
          patientUuid,
          sessionUuid,
          question,
          {
            onSession: (uuid) => {
              setSessionUuid(patientUuid, uuid);
            },
            onAnswerDone: answerDone,
            onAnswerValidation: answerValidation,
            onInDepthPending: inDepthPending,
            onInDepthDone: inDepthDone,
            onInDepthError: inDepthError,
            onDone: done,
            onError: fail,
          },
          abortController,
          selectedProfileId,
        );
      } catch (err) {
        abortControllerRef.current = null;
        inFlightMessageIdRef.current = null;
        fail(err instanceof Error ? err.message : 'An unknown error occurred');
      }
    },
    [sessionUuidByPatient],
  );

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  // Only the last message can ever be in flight; a new turn either blocks (answer not yet settled)
  // or preempts the trailing in-depth, so checking just the tail is sound. The composer locks only
  // while the direct answer is being produced or checked (answering/checking) — a settled answer unlocks it
  // even while in-depth still streams.
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const isAwaitingAnswer = lastMessage ? phaseIsAwaitingAnswer(lastMessage.phase) : false;

  return {
    messages,
    isAwaitingAnswer,
    submitQuestion,
    clearMessages,
    stopCurrent,
    startNewChatSession,
  };
}
