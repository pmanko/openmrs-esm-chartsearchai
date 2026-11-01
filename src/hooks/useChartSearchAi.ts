import { useCallback, useEffect, useRef } from 'react';
import { useConfig, useStore } from '@openmrs/esm-framework';
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
import { type ChartSearchAiConfig } from '../config-schema';
import { chatSessionStore, chatSessionUserGeneration, requestProviderFor } from '../store/chat-session.store';
import { refreshHubProfiles, useHubProfileDiscovery } from './hub-profile-discovery';
import {
  ANSWER_CHECK_INTERRUPTED_SUMMARY_CODE,
  ANSWER_NOT_SAVED_ERROR_CODE,
  IN_DEPTH_INTERRUPTED_ERROR_CODE,
  isAnswerSettled,
  isAwaitingAnswer as phaseIsAwaitingAnswer,
  isTerminal,
  NEW_CHAT_ERROR_CODE,
  PROFILE_REQUIRED_ERROR_CODE,
  PROFILES_LOADING_ERROR_CODE,
  PROFILES_UNAVAILABLE_ERROR_CODE,
  SELECTED_PROFILE_UNAVAILABLE_ERROR_CODE,
  type TurnPhase,
} from './turn-phase';
import { type MessageAnswerLimits, mergeDisclosure, NO_ANSWER_LIMITS } from '../utils/answer-limits';
import { citationStripPattern } from '../utils/safety-disclosure';

export {
  ANSWER_CHECK_INTERRUPTED_SUMMARY_CODE,
  ANSWER_NOT_SAVED_ERROR_CODE,
  IN_DEPTH_INTERRUPTED_ERROR_CODE,
  NEW_CHAT_ERROR_CODE,
  PROFILE_REQUIRED_ERROR_CODE,
  PROFILES_LOADING_ERROR_CODE,
  PROFILES_UNAVAILABLE_ERROR_CODE,
  SELECTED_PROFILE_UNAVAILABLE_ERROR_CODE,
};

export interface ChatMessage extends MessageAnswerLimits {
  id: string;
  question: string;
  answer: string;
  references: AiReference[];
  safetyWarnings?: AiSafetyWarning[];
  /** checked/limited/unavailable — present alongside safetyWarnings, even when it's empty. */
  safetyStatus?: AiSafetyStatus;
  /** Canonical safety result with package provenance and coverage limitations. */
  safetyCheck?: AiSafetyCheck;
  /** The medication-safety check was still running when the answer arrived; its result has not. */
  safetyCheckPending?: boolean;
  blocks?: AiBlock[];
  auditLogId?: number;
  /**
   * The turn's single lifecycle phase — the source of truth for composer behavior, section
   * rendering, and DOM signals. Mirrors the backend staged SSE events (see {@link TurnPhase}).
   */
  phase: TurnPhase;
  error: string | null;
  /** The profile named by a {@link SELECTED_PROFILE_UNAVAILABLE_ERROR_CODE} error: its label, or its id. */
  unavailableProfileLabel?: string;
  /** Model reasoning, streamed before the answer. KEPT once the answer completes — the chat
   *  bubble offers it behind a collapsed disclosure, so a reader who wants to know how the model
   *  got there has somewhere to go. Still never the answer: nothing in it was checked against the
   *  chart, and it can state things the answer does not. Stays '' when the `showReasoning` config
   *  is off — that switch is enforced here at ingestion, so nothing is held that will not be
   *  drawn; the bubble tests it again for a transcript that predates the flag being turned off. */
  reasoning?: string;
  /** Transient PRELIMINARY reasoning from the progressive-reasoning preview pass (server GP
   *  chartsearchai.progressiveReasoning.enabled): shown before {@link reasoning} on a slow host,
   *  and provisional — REPLACED the moment real reasoning or the answer arrives, and never
   *  persisted. Optional: only the streaming path sets it (always to '' first); it stays
   *  absent/empty when progressive reasoning is off, so non-streaming fixtures need not supply it. */
  preliminaryReasoning?: string;
  /**
   * The hub product profile that produced this answer. Surfaced as a subtle
   * per-response tag. Undefined for older rows or system notices.
   */
  resolvedModel?: string;
  /** Per-section check confidence (optional grade, note, or findings under the selected policy). */
  confidence?: AiConfidence;
  /** Answer check lifecycle for staged checked responses. */
  answerValidation?: AiAnswerValidation;
  /** Product-profile In-Depth state attached to this assistant turn. */
  inDepth?: AiInDepth;
}

interface UseChartSearchAiReturn {
  messages: ChatMessage[];
  /**
   * The latest turn is still producing or checking its direct answer ({@link TurnPhase}
   * `answering`/`checking`).
   * The composer disables on this — so a new question can be asked while the prior turn's in-depth is
   * still streaming in the background.
   */
  isAwaitingAnswer: boolean;
  isStartingSession: boolean;
  sessionError: string | null;
  submitQuestion: (patientUuid: string, question: string) => void;
  clearMessages: () => void;
  stopCurrent: () => void;
  /**
   * Close the current server-side session for this patient and open a
   * fresh one. Use for the "New chat" button.
   */
  startNewChatSession: (patientUuid: string, requestedProviderId?: string) => void;
}

function generateId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

const EMPTY_MESSAGES: ChatMessage[] = [];

/**
 * The turn still receiving events for each patient, kept at module scope rather than per hook
 * instance. A turn left `checking` when the panel closes keeps running into the shared store, so a
 * reopened panel must be able to stop it or preempt its trailing In-Depth; and a turn for one
 * patient must never block a question about another.
 */
interface InFlightTurn {
  controller: AbortController;
  messageId: string;
}
const inFlightByPatient = new Map<string, InFlightTurn>();

/** How many panels are open on each patient: only closing the last one may stop that patient's turn. */
const openPanelsByPatient = new Map<string, number>();

/** A New chat in flight, with the user generation that started it. */
interface PendingNewChat {
  promise: Promise<void>;
  generation: number;
}

/** A New chat in flight for a patient, shared by every panel on that patient. */
const pendingSessionByPatient = new Map<string, PendingNewChat>();

/** Whether a New chat is pending that this user started; the previous user's no longer blocks. */
function isPendingForThisUser(pending: PendingNewChat | null | undefined): boolean {
  return Boolean(pending && pending.generation === chatSessionUserGeneration());
}

/** Abort and forget the patient's in-flight turn; returns the message id it was producing. */
function releaseInFlight(patientUuid: string): string | null {
  const turn = inFlightByPatient.get(patientUuid);
  if (!turn) return null;
  turn.controller.abort();
  inFlightByPatient.delete(patientUuid);
  return turn.messageId;
}

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

function setNewChatPending(patientUuid: string, pending: boolean): void {
  const state = chatSessionStore.getState();
  chatSessionStore.setState({
    newChatPendingByPatient: { ...(state.newChatPendingByPatient ?? {}), [patientUuid]: pending },
  });
}

function setNewChatError(patientUuid: string, error: string | null): void {
  const state = chatSessionStore.getState();
  if ((state.newChatErrorByPatient?.[patientUuid] ?? null) === error) return;
  chatSessionStore.setState({
    newChatErrorByPatient: { ...(state.newChatErrorByPatient ?? {}), [patientUuid]: error },
  });
}

function setPatientProvider(patientUuid: string, providerId: string | null): void {
  const state = chatSessionStore.getState();
  chatSessionStore.setState({
    ...state,
    providerByPatient: { ...(state.providerByPatient ?? {}), [patientUuid]: providerId },
  });
}

/**
 * Map a hydration row from the server's chat-history endpoint to a
 * UI {@link ChatMessage}. Server stores user and assistant rows
 * separately (one per turn); the UI groups them as Q+A pairs anchored
 * on the user-message uuid as the row id.
 */
function hydrateMessages(history: ChatHistoryMessage[], provider?: string | null): ChatMessage[] {
  const out: ChatMessage[] = [];
  let pending: ChatMessage | null = null;
  for (const m of history) {
    if (m.role === 'user') {
      if (pending) {
        // Two consecutive user messages: the earlier question has no saved answer.
        out.push(unanswered(pending));
      }
      pending = {
        id: m.messageId,
        question: m.content,
        answer: '',
        reasoning: '',
        references: [],
        ...NO_ANSWER_LIMITS,
        auditLogId: undefined,
        phase: 'complete',
        error: null,
      };
    } else if (m.role === 'assistant') {
      if (pending && m.terminalState === 'turn_error' && m.problemCode === 'cancelled' && !m.content) {
        // Stopped before any answer: nothing to restore, so drop it as stopping it live does.
        pending = null;
        continue;
      }
      if (pending) {
        pending.answer = m.content;
        pending.blocks = m.blocks;
        pending.safetyWarnings = m.safetyWarnings;
        pending.safetyStatus = m.safetyStatus;
        pending.safetyCheck = m.safetyCheck;
        // A stopped bundled turn keeps the answer it had while its checks ran, whose safety result is
        // a bare `unavailable`; a finished bundled check always states its cause. So on a bundled
        // conversation that result means the check did not complete: say so, as stopping it live
        // does, rather than restore a result the panel reads as nothing to report.
        if (provider === 'bundled' && isUnsettledBundledSafetyCheck(m)) {
          pending.safetyStatus = 'unavailable';
          pending.safetyCheck = { status: 'unavailable', issues: ['execution_failed'] };
        }
        pending.confidence = m.confidence;
        pending.answerValidation = interruptAnswerValidation(m.answerValidation);
        pending.inDepth = interruptInDepth(normalizeInDepth(m.inDepth));
        pending.resolvedModel = m.resolvedModel ?? m.model;
        pending.references = interruptGroundingChecks(m.references ?? []);
        pending.auditLogId = m.auditLogId;
        // The persisted turn carries the answer-limit statements the stream published (#157).
        Object.assign(pending, mergeDisclosure(pending, m));
        if (m.terminalState === 'turn_error') {
          if (m.problemCode === 'cancelled') {
            pending.phase = 'complete';
            pending.error = null;
          } else {
            pending.phase = 'error';
            pending.error = m.problemCode ?? 'provider_failure';
          }
        }
        out.push(pending);
        pending = null;
      }
      // Orphan assistant row without a preceding user — ignore (UI has no
      // sane render for it); the row stays in the DB for audit purposes.
    }
    // 'system' rows are dropped — they belong to the LLM-prompt layer.
  }
  if (pending) {
    // The last question has no saved answer: it was interrupted, or the server is still on it and
    // this panel has no way back into that stream. Either way it is not a blank completed answer.
    out.push(unanswered(pending));
  }
  return out;
}

function unanswered(message: ChatMessage): ChatMessage {
  return { ...message, phase: 'error', error: ANSWER_NOT_SAVED_ERROR_CODE };
}

/** The panel draws its own In-Depth heading, so a model-written one is removed wherever it arrives. */
function normalizeInDepth(inDepth?: AiInDepth): AiInDepth | undefined {
  if (!inDepth?.answer) return inDepth;
  const answer = inDepth.answer.replace(/^\s*\*\*In ?Depth\*\*\s*/i, '').trimStart();
  return answer === inDepth.answer ? inDepth : { ...inDepth, answer };
}

function interruptInDepth(inDepth?: AiInDepth): AiInDepth | undefined {
  if (!inDepth || inDepth.status !== 'pending') return inDepth;
  return { ...inDepth, status: 'failed', error: IN_DEPTH_INTERRUPTED_ERROR_CODE };
}

function interruptAnswerValidation(
  validation?: AiSearchResponse['answerValidation'],
): AiSearchResponse['answerValidation'] | undefined {
  if (!validation || validation.status !== 'checking') return validation;
  return {
    ...validation,
    status: 'unavailable',
    label: undefined,
    summary: ANSWER_CHECK_INTERRUPTED_SUMMARY_CODE,
  };
}

/** A citation check a stopped turn will never finish is unchecked, not still checking. */
function interruptGroundingChecks(references: AiReference[]): AiReference[] {
  return references.some((ref) => ref.groundingStatus === 'checking')
    ? references.map((ref) => (ref.groundingStatus === 'checking' ? { ...ref, groundingStatus: 'unchecked' } : ref))
    : references;
}

function isUnsettledBundledSafetyCheck(
  response: Pick<AiSearchResponse, 'safetyCheck' | 'safetyStatus' | 'safetyWarnings'>,
): boolean {
  const status = response.safetyCheck?.status ?? response.safetyStatus;
  const issues = response.safetyCheck?.issues;
  const warnings = response.safetyCheck?.warnings ?? response.safetyWarnings;
  return (
    status === 'unavailable' &&
    (!Array.isArray(issues) || issues.length === 0) &&
    (!Array.isArray(warnings) || warnings.length === 0)
  );
}

function isCheckPendingOnAnswerDone(response: AiSearchResponse): boolean {
  return (
    response.answerValidation?.status === 'checking' ||
    response.references?.some((ref) => ref.groundingStatus === 'checking') === true ||
    isUnsettledBundledSafetyCheck(response)
  );
}

type TurnEnvelope = Partial<AiSearchResponse> & { messageId?: string; inDepth?: AiInDepth };

/**
 * Removes citation markers ([3], [1, 2], …) from the PREVIEW text only. The preview reasons over an
 * independently-numbered top-K chart, so its markers do not line up with the committed answer's
 * records and showing them would mislead. Applied to the whole accumulated preview rather than to
 * each frame, so a marker whose brackets arrive in different frames is still removed. Shares the
 * resolver's pattern, so marker syntax has one home, and does NOT trim: the preview accumulates
 * chunk by chunk and a trailing space must survive between them.
 */
function stripPreviewCitations(text: string): string {
  return text.replace(citationStripPattern(), '');
}

function applyTurnEnvelope(message: ChatMessage, payload: TurnEnvelope, phase: TurnPhase): ChatMessage {
  return {
    ...message,
    answer: payload.answer ?? message.answer,
    // Absence means this event has no reference update. An explicit array is authoritative even
    // when empty: answer validation may remove every draft citation when it edits the answer.
    references: Array.isArray(payload.references) ? payload.references : message.references,
    safetyWarnings: payload.safetyWarnings ?? message.safetyWarnings,
    safetyStatus: payload.safetyStatus ?? message.safetyStatus,
    safetyCheck: payload.safetyCheck ?? message.safetyCheck,
    safetyCheckPending: payload.safetyStatus || payload.safetyCheck ? false : message.safetyCheckPending,
    blocks: payload.blocks ?? message.blocks,
    confidence: payload.confidence ?? message.confidence,
    answerValidation: payload.answerValidation ?? message.answerValidation,
    inDepth: normalizeInDepth(payload.inDepth) ?? message.inDepth,
    auditLogId: payload.auditLogId ?? message.auditLogId,
    resolvedModel: payload.resolvedModel ?? message.resolvedModel,
    // Answer-limit statements accumulate across the turn's events: a later event that states
    // nothing about a measurement leaves an earlier statement standing.
    ...mergeDisclosure(message, payload),
    // Actual reasoning remains inspectable; only the provisional preview is cleared.
    preliminaryReasoning: phase === 'answering' ? message.preliminaryReasoning : '',
    phase,
  };
}

export function useChartSearchAi(patientUuid?: string): UseChartSearchAiReturn {
  const config = useConfig<ChartSearchAiConfig>();
  const sessionState = useStore(chatSessionStore);
  const { messagesByPatient, sessionUuidByPatient, newChatPendingByPatient, newChatErrorByPatient } = sessionState;
  const messages: ChatMessage[] = patientUuid ? (messagesByPatient[patientUuid] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES;
  const isMountedRef = useRef(true);
  const showReasoningRef = useRef(config.showReasoning);
  showReasoningRef.current = config.showReasoning;
  const isStartingSession = Boolean(patientUuid && newChatPendingByPatient?.[patientUuid]);
  const sessionError = (patientUuid && newChatErrorByPatient?.[patientUuid]) || null;
  // Whether a Hub question may be sent must not depend on the profile picker being mounted.
  useHubProfileDiscovery(requestProviderFor(sessionState, patientUuid));

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (config.showReasoning) return;
    const state = chatSessionStore.getState();
    const messagesByPatient = Object.fromEntries(
      Object.entries(state.messagesByPatient).map(([uuid, messages]) => [
        uuid,
        messages.map((message) =>
          message.reasoning || message.preliminaryReasoning
            ? { ...message, reasoning: '', preliminaryReasoning: '' }
            : message,
        ),
      ]),
    );
    chatSessionStore.setState({ messagesByPatient });
  }, [config.showReasoning]);

  // Hydrate on mount / patient change. With nothing server-side, or a failed read, the transcript is
  // left as it is and the first submit creates a fresh session.
  useEffect(() => {
    if (!patientUuid) return;
    const cachedProvider = chatSessionStore.getState().providerByPatient?.[patientUuid];
    if (cachedProvider) {
      chatSessionStore.setState({ selectedProviderId: cachedProvider });
    }
    if (messagesByPatient[patientUuid] && messagesByPatient[patientUuid].length > 0) {
      // Local cache already populated (e.g. user just submitted a turn);
      // skip the round-trip.
      return;
    }
    const controller = new AbortController();
    const sessionBeforeFetch = chatSessionStore.getState().sessionUuidByPatient[patientUuid];
    const generation = chatSessionUserGeneration();
    fetchChatHistory(patientUuid, controller)
      .then((response) => {
        if (!isMountedRef.current || controller.signal.aborted) return;
        // Read for the user signed in when it started; another user's history is not theirs.
        if (chatSessionUserGeneration() !== generation) return;
        // A submitted turn owns the transcript even before onSession arrives or when it reuses
        // the existing session. A late mount-time snapshot must not replace that live message
        // or change its provider; also reject snapshots from a superseded conversation.
        const currentState = chatSessionStore.getState();
        if (
          currentState.sessionUuidByPatient[patientUuid] !== sessionBeforeFetch ||
          (currentState.messagesByPatient[patientUuid]?.length ?? 0) > 0
        ) {
          return;
        }
        setSessionUuid(patientUuid, response.session ?? null);
        // The picker and per-patient provider map must reflect the provider bound to the restored
        // conversation. Otherwise switching patients and coming back would send the other patient's
        // provider with this patient's session and close the conversation.
        if (response.provider) {
          setPatientProvider(patientUuid, response.provider);
          chatSessionStore.setState({ selectedProviderId: response.provider });
        }
        const hydrated = hydrateMessages(response.messages ?? [], response.provider);
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
      releaseInFlight(patientUuid);
    }
  }, [patientUuid]);

  const stopCurrent = useCallback(() => {
    const stoppedId = patientUuid ? releaseInFlight(patientUuid) : null;
    if (stoppedId && patientUuid) {
      updateMessages(patientUuid, (prev) => {
        const idx = prev.findIndex((m) => m.id === stoppedId);
        if (idx === -1) return prev;
        const msg = prev[idx];
        if (isTerminal(msg.phase)) return prev;
        if (!msg.answer && !msg.reasoning) {
          return prev.filter((_, i) => i !== idx);
        }
        const updated = [...prev];
        updated[idx] = {
          ...msg,
          phase: 'complete',
          preliminaryReasoning: '',
          answerValidation: interruptAnswerValidation(msg.answerValidation),
          inDepth: interruptInDepth(msg.inDepth),
          references: interruptGroundingChecks(msg.references),
          // Stopped while the medication-safety check ran: say it did not complete, which the panel
          // draws, rather than leave no result, which reads like a check that found nothing. Only that
          // check: a turn stopped while only its citations were checked received no safety result.
          ...(msg.safetyCheckPending
            ? {
                safetyStatus: 'unavailable' as const,
                safetyCheck: { status: 'unavailable' as const, issues: ['execution_failed'] },
                safetyCheckPending: false,
              }
            : {}),
        };
        return updated;
      });
    }
  }, [patientUuid]);

  const startNewChatSession = useCallback((patientUuid: string, requestedProviderId?: string) => {
    if (isPendingForThisUser(pendingSessionByPatient.get(patientUuid))) return;
    const state = chatSessionStore.getState();
    const providerId =
      requestedProviderId ?? state.providerByPatient?.[patientUuid] ?? state.selectedProviderId ?? undefined;
    const generation = chatSessionUserGeneration();
    setNewChatPending(patientUuid, true);
    setNewChatError(patientUuid, null);
    const pending = startNewChat(patientUuid, providerId)
      .then((response) => {
        // A conversation started for the previous user is not the next user's to continue.
        if (chatSessionUserGeneration() !== generation) return;
        // The session and messages are shared state: a panel that closed while waiting still gets
        // the new session, or the next panel would reopen the old conversation.
        releaseInFlight(patientUuid);
        updateMessages(patientUuid, () => []);
        const resolvedProvider = response.provider ?? providerId ?? null;
        setSessionUuid(patientUuid, response.session ?? null);
        setPatientProvider(patientUuid, resolvedProvider);
        chatSessionStore.setState({ selectedProviderId: resolvedProvider });
      })
      .catch((err) => {
        console.warn('[useChartSearchAi] startNewChat failed', err);
        // Shared, like the pending flag, so every panel on the patient keeps its draft and says why.
        if (chatSessionUserGeneration() === generation) setNewChatError(patientUuid, NEW_CHAT_ERROR_CODE);
      })
      .finally(() => {
        if (pendingSessionByPatient.get(patientUuid)?.promise === pending) pendingSessionByPatient.delete(patientUuid);
        // Cleared whether or not this panel is still open: the flag locks every panel on the patient.
        if (chatSessionUserGeneration() === generation) setNewChatPending(patientUuid, false);
      });
    pendingSessionByPatient.set(patientUuid, { promise: pending, generation });
  }, []);

  const submitQuestion = useCallback(
    (patientUuid: string, question: string) => {
      // Only this patient's New chat holds the question: another patient's has no bearing on it.
      if (isPendingForThisUser(pendingSessionByPatient.get(patientUuid))) return;
      setNewChatError(patientUuid, null);
      const state = chatSessionStore.getState();
      const selectedProviderId = requestProviderFor(state, patientUuid) ?? undefined;
      const discoveryStatus = state.profileDiscoveryStatus;
      if (selectedProviderId === 'hub' && discoveryStatus !== 'ready') {
        const failedMessage: ChatMessage = {
          id: generateId(),
          question,
          answer: '',
          references: [],
          ...NO_ANSWER_LIMITS,
          auditLogId: undefined,
          phase: 'error',
          error: PROFILES_UNAVAILABLE_ERROR_CODE,
        };
        if (discoveryStatus === 'loading') {
          failedMessage.error = PROFILES_LOADING_ERROR_CODE;
        } else if (discoveryStatus === 'selection-unavailable') {
          // The Hub answered and no longer offers this pick: ask for another one, by name.
          failedMessage.error = SELECTED_PROFILE_UNAVAILABLE_ERROR_CODE;
          failedMessage.unavailableProfileLabel =
            state.hubProfiles?.find((profile) => profile.id === state.selectedProfileId)?.label ??
            state.selectedProfileId ??
            undefined;
        } else {
          // The Hub was unreachable: read it again so the next question can go through.
          refreshHubProfiles();
        }
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
          ...NO_ANSWER_LIMITS,
          auditLogId: undefined,
          phase: 'error',
          error: PROFILE_REQUIRED_ERROR_CODE,
        };
        updateMessages(patientUuid, (prev) => [...prev, failedMessage]);
        return;
      }
      const inFlightTurn = inFlightByPatient.get(patientUuid);
      if (inFlightTurn) {
        // A turn is still in flight for this patient. If its answer has NOT settled yet, don't
        // start a second answer generation: a conversation answers one question at a time. If the
        // answer HAS settled and only the background in-depth is trailing, PREEMPT it so this new
        // question starts immediately.
        // The turn's phase is the single source of truth: isAnswerSettled once validation landed.
        // A turn whose message is gone (the transcript was cleared) blocks nothing.
        const preemptedId = inFlightTurn.messageId;
        const inFlight = (chatSessionStore.getState().messagesByPatient[patientUuid] ?? []).find(
          (m) => m.id === preemptedId,
        );
        if (inFlight && !isAnswerSettled(inFlight.phase)) return;
        releaseInFlight(patientUuid);
        if (inFlight) {
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

      const newMessage: ChatMessage = {
        id: generateId(),
        question,
        answer: '',
        reasoning: '',
        references: [],
        safetyWarnings: [],
        ...NO_ANSWER_LIMITS,
        auditLogId: undefined,
        phase: 'answering',
        error: null,
      };

      updateMessages(patientUuid, (prev) => [...prev, newMessage]);
      const messageId = newMessage.id;
      inFlightByPatient.set(patientUuid, { controller: abortController, messageId });

      // One buffer per turn: the hook runs another patient's turn beside a checking one.
      let completedReasoning = '';
      const ownsInFlight = () => inFlightByPatient.get(patientUuid)?.controller === abortController;
      // A turn started for the previous user writes nothing into the next user's cleared state.
      const turnGeneration = chatSessionUserGeneration();
      const isCurrentRequest = () =>
        ownsInFlight() && !abortController.signal.aborted && chatSessionUserGeneration() === turnGeneration;
      const finishInFlight = () => {
        if (ownsInFlight()) inFlightByPatient.delete(patientUuid);
      };

      const done = (response: AiSearchResponse) => {
        const ownsSession = isCurrentRequest();
        // This writes to the shared store, so it does not depend on component-mounted state.
        // The terminal-phase guard below still prevents a decoded late event from replacing a
        // turn that the user stopped or that panel cleanup already settled.
        finishInFlight();
        updateMessages(patientUuid, (prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx === -1) return prev;
          // A done already in the last read chunk still arrives after abort(); a message the user
          // stopped (or that already failed) must not be replaced under them by the full answer.
          if (isTerminal(prev[idx].phase)) return prev;
          const updated = [...prev];
          const final = applyTurnEnvelope(updated[idx], response, 'complete');
          if (!config.useStreaming && showReasoningRef.current) final.reasoning = completedReasoning;
          updated[idx] = {
            ...final,
            answerValidation: interruptAnswerValidation(final.answerValidation),
            inDepth: interruptInDepth(final.inDepth),
          };
          return updated;
        });
        // `turn_done` carries the session uuid too: the conversation backend sends no session header.
        if (ownsSession && response.session) {
          setSessionUuid(patientUuid, response.session);
        }
      };

      const fail = (errMessage: string) => {
        if (errMessage === 'cancelled') {
          // An earlier request's cancellation arriving after the next question must not stop that one.
          if (isCurrentRequest()) stopCurrent();
          return;
        }
        // Not gated on isMountedRef: a genuine terminal error must still settle the shared store.
        // A turn already stopped by the user is terminal, though, and must not be changed afterwards.
        const failedCurrentTurn = isCurrentRequest();
        finishInFlight();
        if (failedCurrentTurn && selectedProviderId === 'hub') {
          // A Hub failure may mean the profile or the Hub went away: read `/models` again so the
          // next question is refused with the right reason instead of failing at the Hub.
          refreshHubProfiles();
        }
        console.error('[useChartSearchAi] Request failed:', errMessage);
        updateMessages(patientUuid, (prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx === -1) return prev;
          if (isTerminal(prev[idx].phase)) return prev;
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx],
            answerValidation: interruptAnswerValidation(updated[idx].answerValidation),
            inDepth: interruptInDepth(updated[idx].inDepth),
            references: interruptGroundingChecks(updated[idx].references),
            // As stopCurrent does: a safety check still running did not complete, which the panel draws.
            ...(updated[idx].safetyCheckPending
              ? {
                  safetyStatus: 'unavailable' as const,
                  safetyCheck: { status: 'unavailable' as const, issues: ['execution_failed'] },
                  safetyCheckPending: false,
                }
              : {}),
            error: errMessage,
            phase: 'error',
          };
          return updated;
        });
      };

      const answerDone = (response: AiSearchResponse) => {
        updateMessages(patientUuid, (prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx === -1) return prev;
          if (isTerminal(prev[idx].phase)) return prev;
          const updated = [...prev];
          const phase = isCheckPendingOnAnswerDone(response) ? 'checking' : 'settled';
          const effectiveResponse = isUnsettledBundledSafetyCheck(response)
            ? { ...response, safetyStatus: undefined, safetyCheck: undefined }
            : response;
          // Do NOT synthesize a pending inDepth here when the response omits one. A provider
          // that actually supports In-Depth (e.g. the hub) establishes its real pending state via
          // its own indepth_pending event; a provider with no In-Depth capability at all (e.g.
          // bundled) never sends one and never follows up — fabricating {status: 'pending'} for
          // it would show a "Preparing in-depth..." spinner that can never resolve.
          updated[idx] = {
            ...applyTurnEnvelope(updated[idx], effectiveResponse, phase),
            safetyCheckPending: effectiveResponse !== response,
          };
          if (!config.useStreaming && showReasoningRef.current) updated[idx].reasoning = completedReasoning;
          return updated;
        });
        if (isCurrentRequest() && response.session) {
          setSessionUuid(patientUuid, response.session);
        }
      };

      const answerValidation = (response: AiSearchResponse) => {
        // The answer + validation have landed; only in-depth remains. Moving to `settled` unlocks
        // the composer AND makes this turn preemptable (submitQuestion reads the phase).
        updateMessages(patientUuid, (prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx === -1) return prev;
          if (isTerminal(prev[idx].phase)) return prev;
          const updated = [...prev];
          updated[idx] = applyTurnEnvelope(updated[idx], response, 'settled');
          return updated;
        });
      };

      const evidenceUpdated = (response: AiSearchResponse) => {
        updateMessages(patientUuid, (prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx === -1 || isTerminal(prev[idx].phase)) return prev;
          const updated = [...prev];
          const nextPhase =
            updated[idx].phase === 'checking' && response.answerValidation?.status !== 'checking'
              ? 'settled'
              : updated[idx].phase;
          updated[idx] = applyTurnEnvelope(updated[idx], response, nextPhase);
          return updated;
        });
      };

      const inDepthPending = (payload: Partial<AiSearchResponse> & { messageId?: string; inDepth?: AiInDepth }) => {
        updateMessages(patientUuid, (prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx === -1) return prev;
          if (isTerminal(prev[idx].phase)) return prev;
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
        updateMessages(patientUuid, (prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx === -1) return prev;
          if (isTerminal(prev[idx].phase)) return prev;
          const updated = [...prev];
          updated[idx] = applyTurnEnvelope(updated[idx], payload, 'settled');
          return updated;
        });
      };

      const inDepthError = (payload: TurnEnvelope) => {
        updateMessages(patientUuid, (prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx === -1) return prev;
          if (isTerminal(prev[idx].phase)) return prev;
          const updated = [...prev];
          // The direct answer remains available; the terminal marker still closes the turn.
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
            'settled',
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
            // Token streaming from a provider that declares it (the bundled engine). Additive while the
            // turn is still answering; ignored once it settled or the user stopped it (both leave the
            // phase past 'answering'). `answer_done` then restates the whole answer, so a provider that
            // streams nothing (the hub) renders exactly as before.
            onToken: (chunk) => {
              if (!config.useStreaming) return;
              updateMessages(patientUuid, (prev) => {
                const idx = prev.findIndex((m) => m.id === messageId);
                if (idx === -1 || prev[idx].phase !== 'answering') return prev;
                const updated = [...prev];
                // The answer supersedes the provisional preview.
                updated[idx] = { ...updated[idx], answer: updated[idx].answer + chunk, preliminaryReasoning: '' };
                return updated;
              });
            },
            onPreliminary: (chunk) => {
              if (!config.useStreaming || !showReasoningRef.current || !isCurrentRequest()) return;
              updateMessages(patientUuid, (prev) => {
                const idx = prev.findIndex((m) => m.id === messageId);
                if (idx === -1 || prev[idx].phase !== 'answering') return prev;
                const updated = [...prev];
                updated[idx] = {
                  ...updated[idx],
                  preliminaryReasoning: stripPreviewCitations((updated[idx].preliminaryReasoning ?? '') + chunk),
                };
                return updated;
              });
            },
            onReasoning: (chunk) => {
              if (!showReasoningRef.current || !isCurrentRequest()) return;
              if (!config.useStreaming) {
                completedReasoning += chunk;
                return;
              }
              updateMessages(patientUuid, (prev) => {
                const idx = prev.findIndex((m) => m.id === messageId);
                if (idx === -1 || prev[idx].phase !== 'answering') return prev;
                const updated = [...prev];
                // Committed reasoning REPLACES the preview rather than continuing it.
                updated[idx] = {
                  ...updated[idx],
                  reasoning: (updated[idx].reasoning ?? '') + chunk,
                  preliminaryReasoning: '',
                };
                return updated;
              });
            },
            onSession: (uuid) => {
              if (!isCurrentRequest()) return;
              // Defense in depth alongside the hydration-time provider sync: if the backend
              // returns a DIFFERENT session than the one this turn was sent with, it silently
              // started a new conversation (e.g. a provider mismatch the backend correctly
              // refuses to write into the old one — see ConversationServiceImpl.openOrCreate).
              // The old conversation's turns must not stay visible glued to this one.
              if (sessionUuid && uuid && uuid !== sessionUuid) {
                updateMessages(patientUuid, (prev) => prev.filter((m) => m.id === messageId));
              }
              setSessionUuid(patientUuid, uuid);
              if (selectedProviderId) {
                setPatientProvider(patientUuid, selectedProviderId);
              }
            },
            onTurnStarted: (meta) => {
              if (!isCurrentRequest()) return;
              if (meta.provider) {
                setPatientProvider(patientUuid, meta.provider);
              }
            },
            onAnswerDone: answerDone,
            onAnswerValidation: answerValidation,
            onEvidenceUpdated: evidenceUpdated,
            onInDepthPending: inDepthPending,
            onInDepthDone: inDepthDone,
            onInDepthError: inDepthError,
            onDone: done,
            onError: fail,
          },
          abortController,
          selectedProfileId,
          selectedProviderId,
          selectedProviderId ? state.providerCapabilities?.[selectedProviderId] : undefined,
        );
      } catch {
        // The client throws only for a Hub request without a profile, which the guard above
        // already refuses; report it with the same code rather than an untranslated message.
        finishInFlight();
        fail(PROFILE_REQUIRED_ERROR_CODE);
      }
    },
    [sessionUuidByPatient, config.useStreaming, stopCurrent],
  );

  useEffect(() => {
    // The message store outlives this panel. Use the same terminal transition as the Stop action so
    // closing the panel cannot leave an empty `answering` message that disables the next panel instance,
    // while letting a turn whose answer is already on screen (`checking`) finish its safety/grounding pass.
    if (!patientUuid) return;
    openPanelsByPatient.set(patientUuid, (openPanelsByPatient.get(patientUuid) ?? 0) + 1);
    return () => {
      const stillOpen = (openPanelsByPatient.get(patientUuid) ?? 1) - 1;
      openPanelsByPatient.set(patientUuid, stillOpen);
      if (stillOpen > 0) return;
      const inFlightId = inFlightByPatient.get(patientUuid)?.messageId;
      if (inFlightId) {
        const inFlight = (chatSessionStore.getState().messagesByPatient[patientUuid] ?? []).find(
          (m) => m.id === inFlightId,
        );
        if (inFlight?.phase === 'checking') {
          return;
        }
      }
      stopCurrent();
    };
  }, [patientUuid, stopCurrent]);

  // Only the last message can ever be in flight; a new turn either blocks (answer not yet settled)
  // or preempts the trailing in-depth, so checking just the tail is sound. The composer locks only
  // while the direct answer is being produced or checked (answering/checking) — a settled answer unlocks it
  // even while In-Depth or terminal settlement is still pending.
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const isAwaitingAnswer = isStartingSession || (lastMessage ? phaseIsAwaitingAnswer(lastMessage.phase) : false);

  return {
    messages,
    isAwaitingAnswer,
    isStartingSession,
    sessionError,
    submitQuestion,
    clearMessages,
    stopCurrent,
    startNewChatSession,
  };
}
