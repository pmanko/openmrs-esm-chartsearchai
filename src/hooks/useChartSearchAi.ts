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
  questionId: string;
  /**
   * The turn's single lifecycle phase — the source of truth for composer behavior, section
   * rendering, and DOM signals. Mirrors the backend staged SSE events (see {@link TurnPhase}).
   */
  phase: TurnPhase;
  error: string | null;
  /**
   * The backend model that produced this answer (the per-request override the
   * picker selected, or the config default). Surfaced as a subtle per-response
   * tag. Undefined for older rows / system notices.
   */
  resolvedModel?: string;
  /** Per-section validator confidence (green/yellow/red + note); validated hub tiers only. */
  confidence?: AiConfidence;
  /** Answer check lifecycle for staged validated responses. */
  answerValidation?: AiAnswerValidation;
  /** Staged team In-Depth state attached to this assistant turn. */
  inDepth?: AiInDepth;
}

interface UseChartSearchAiReturn {
  messages: ChatMessage[];
  /**
   * The latest turn is still producing its direct answer ({@link TurnPhase} `answering`/`validating`).
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
        questionId: '',
        phase: 'complete',
        error: null,
      };
    } else if (m.role === 'assistant') {
      if (pending) {
        pending.answer = m.content;
        pending.blocks = m.blocks;
        pending.safetyWarnings = m.safetyWarnings;
        pending.confidence = m.confidence;
        pending.answerValidation = m.answerValidation;
        pending.inDepth = m.inDepth;
        pending.references = m.references ?? [];
        pending.questionId = m.messageId;
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
        updated[idx] = { ...msg, phase: 'complete' };
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
            // Keep whatever in-depth arrived so far, marked complete (no perpetual spinner).
            updated[idx] = {
              ...msg,
              phase: 'complete',
              inDepth: msg.inDepth ? { ...msg.inDepth, status: 'complete' } : msg.inDepth,
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
        questionId: '',
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
          updated[idx] = {
            ...updated[idx],
            answer: response.answer,
            references: response.references,
            safetyWarnings: response.safetyWarnings ?? [],
            blocks: response.blocks,
            confidence: response.confidence,
            answerValidation: response.answerValidation,
            inDepth: response.inDepth,
            questionId: response.messageId ?? response.questionId ?? '',
            resolvedModel: response.resolvedModel,
            phase: 'complete',
          };
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
          updated[idx] = { ...updated[idx], error: errMessage, phase: 'error' };
          return updated;
        });
      };

      const answerDone = (response: AiSearchResponse) => {
        if (!isMountedRef.current) return;
        updateMessages(patientUuid, (prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx === -1) return prev;
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx],
            answer: response.answer,
            references: response.references,
            safetyWarnings: response.safetyWarnings ?? [],
            blocks: response.blocks,
            confidence: response.confidence,
            answerValidation: response.answerValidation,
            inDepth: response.inDepth ?? { status: 'pending', answer: '' },
            questionId: response.messageId ?? response.questionId ?? '',
            resolvedModel: response.resolvedModel,
            // Only enter the `validating` phase when a validation check is actually coming (the hub
            // marks the answer_done with answerValidation.status === 'validating'). With no validator
            // configured, no answer_validation event follows — settle immediately so the composer
            // unlocks and there is no phantom "checking answer" state.
            phase: response.answerValidation?.status === 'validating' ? 'validating' : 'settled',
          };
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
          updated[idx] = {
            ...updated[idx],
            answer: response.answer,
            references: response.references,
            safetyWarnings: response.safetyWarnings ?? [],
            blocks: response.blocks,
            confidence: response.confidence,
            answerValidation: response.answerValidation,
            phase: 'settled',
            questionId: response.messageId ?? response.questionId ?? updated[idx].questionId,
            resolvedModel: response.resolvedModel ?? updated[idx].resolvedModel,
          };
          return updated;
        });
      };

      const inDepthPending = (payload: { messageId?: string; inDepth?: AiInDepth }) => {
        if (!isMountedRef.current) return;
        updateMessages(patientUuid, (prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx === -1) return prev;
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx],
            questionId: payload.messageId ?? updated[idx].questionId,
            // in-depth is now generating in the background (delivered whole on indepth_done — the hub
            // does not token-stream). The composer is already unlocked; a new question preempts it.
            phase: 'in-depth',
            inDepth: payload.inDepth ?? { status: 'pending', answer: updated[idx].inDepth?.answer ?? '' },
          };
          return updated;
        });
      };

      const inDepthDone = (inDepth: AiInDepth) => {
        if (!isMountedRef.current) return;
        updateMessages(patientUuid, (prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx === -1) return prev;
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx],
            phase: 'complete',
            inDepth: { ...inDepth, answer: stripInDepthHeader(inDepth.answer ?? '') },
          };
          return updated;
        });
      };

      const inDepthError = (inDepth: AiInDepth) => {
        if (!isMountedRef.current) return;
        updateMessages(patientUuid, (prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx === -1) return prev;
          const updated = [...prev];
          // The direct answer is still available; only the background in-depth failed → terminal.
          updated[idx] = {
            ...updated[idx],
            phase: 'complete',
            inDepth: inDepth.status === 'failed' ? inDepth : { ...inDepth, status: 'failed' },
          };
          return updated;
        });
      };

      const sessionUuid = sessionUuidByPatient[patientUuid] ?? null;
      // The picker's per-session selection (null = config default). Read at
      // submit time so the most recent pick applies to this request only.
      const selectedBackend = chatSessionStore.getState().selectedBackend;

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
          selectedBackend,
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
  // while the direct answer is being produced (answering/validating) — a settled answer unlocks it
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
