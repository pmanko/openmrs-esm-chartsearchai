import { useCallback, useEffect, useRef } from 'react';
import { useStore } from '@openmrs/esm-framework';
import {
  type AiBlock,
  type AiAnswerValidation,
  type AiConfidence,
  type AiInDepth,
  type AiReference,
  type AiSafetyCheck,
  type AiSafetyStatus,
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
  /** checked/limited/unavailable — present alongside safetyWarnings, even when it's empty. */
  safetyStatus?: AiSafetyStatus;
  /** Canonical safety result with package provenance and coverage limitations. */
  safetyCheck?: AiSafetyCheck;
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
  /** Per-section check confidence (green/yellow/red + note); checked hub profiles only. */
  confidence?: AiConfidence;
  /** Answer check lifecycle for staged checked responses. */
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
        pending.safetyStatus = m.safetyStatus;
        pending.safetyCheck = m.safetyCheck;
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
    safetyStatus: payload.safetyStatus ?? message.safetyStatus,
    safetyCheck: payload.safetyCheck ?? message.safetyCheck,
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
    const sessionBeforeFetch = chatSessionStore.getState().sessionUuidByPatient[patientUuid];
    fetchChatHistory(patientUuid, controller)
      .then((response) => {
        if (!isMountedRef.current || controller.signal.aborted) return;
        // This is a mount-time snapshot fetch, not a live subscription — a real turn's own
        // onSession can complete and correct the session while this fetch is still in flight
        // (it started from a stale hydrated session, e.g. right after a provider switch). Only
        // apply the response if nothing has updated the session since this fetch began; a real
        // turn's result always wins over a late, now-outdated snapshot.
        if (chatSessionStore.getState().sessionUuidByPatient[patientUuid] !== sessionBeforeFetch) {
          return;
        }
        setSessionUuid(patientUuid, response.session ?? null);
        // The picker's displayed value (selectedProviderId) is otherwise never written except by
        // an explicit user click — nothing previously synced it to the conversation actually
        // restored here. Left alone, a reload could show one provider's conversation while the
        // picker still displayed a stale different one, so the next question would carry the
        // wrong provider id alongside this (now-mismatched) session — and since the backend
        // correctly closes/creates a new conversation on that mismatch, the UI would silently
        // start a second conversation without ever visibly separating it from the first.
        if (response.provider) {
          chatSessionStore.setState({ selectedProviderId: response.provider });
        }
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
    const providerId = chatSessionStore.getState().selectedProviderId ?? undefined;
    startNewChat(patientUuid, providerId)
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
      const state = chatSessionStore.getState();
      const selectedProviderId = state.selectedProviderId ?? undefined;
      const discoveryStatus = state.profileDiscoveryStatus;
      if (selectedProviderId === 'hub' && discoveryStatus !== 'ready') {
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
      const selectedProfileId = selectedProviderId === 'hub' ? (state.selectedProfileId ?? undefined) : undefined;
      if (selectedProviderId === 'hub' && !selectedProfileId) {
        const failedMessage: ChatMessage = {
          id: generateId(),
          question,
          answer: '',
          references: [],
          auditLogId: undefined,
          phase: 'error',
          error: 'No AI profile is selected. Refresh the available profiles and try again.',
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
            inDepth: interruptInDepth(updated[idx].inDepth),
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
          // Do NOT synthesize a pending inDepth here when the response omits one. A provider
          // that actually supports In-Depth (e.g. the hub) establishes its real pending state via
          // its own indepth_pending event; a provider with no In-Depth capability at all (e.g.
          // bundled) never sends one and never follows up — fabricating {status: 'pending'} for
          // it would show a "Preparing in-depth..." spinner that can never resolve.
          updated[idx] = applyTurnEnvelope(updated[idx], response, phase);
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
      // Null means "no explicit selection" — the backend applies its configured
      // default provider, never a silent cross-provider fallback.
      try {
        // Multi-turn streaming: chat history is reconstructed server-side
        // from the session uuid; we only send the new question.
        chatPatientChartStream(
          patientUuid,
          sessionUuid,
          question,
          {
            onSession: (uuid) => {
              // Defense in depth alongside the hydration-time provider sync: if the backend
              // returns a DIFFERENT session than the one this turn was sent with, it silently
              // started a new conversation (e.g. a provider mismatch the backend correctly
              // refuses to write into the old one — see ConversationServiceImpl.openOrCreate).
              // The old conversation's turns must not stay visible glued to this one.
              if (sessionUuid && uuid && uuid !== sessionUuid) {
                updateMessages(patientUuid, (prev) => prev.filter((m) => m.id === messageId));
              }
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
          messageId,
          selectedProviderId,
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
