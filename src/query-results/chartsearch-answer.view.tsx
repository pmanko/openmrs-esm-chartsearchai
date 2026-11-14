import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, InlineLoading } from '@carbon/react';
import { useConfig, useStore } from '@openmrs/esm-framework';
import { chatPatientChartStream, type AiSearchResponse } from '../api/chartsearchai';
import AiReasoningDisclosure from '../components/ai-reasoning-disclosure.component';
import AiResponsePanel from '../components/ai-response-panel.component';
import ModelPicker from '../components/model-picker.component';
import { type ChartSearchAiConfig } from '../config-schema';
import { useHubProfileDiscovery } from '../hooks/hub-profile-discovery';
import { refreshSystemProvider, useSystemProviderDiscovery } from '../hooks/system-provider-discovery';
import { isAwaitingAnswer, isTerminal } from '../hooks/turn-phase';
import {
  applyTurnEnvelope,
  interruptAnswerValidation,
  interruptGroundingChecks,
  interruptInDepth,
  isCheckPendingOnAnswerDone,
  isUnsettledBundledSafetyCheck,
  stripPreviewCitations,
  type ChatMessage,
  type TurnEnvelope,
} from '../hooks/useChartSearchAi';
import { type OmnibarViewProps } from '../omnibar-contract/types';
import { chatSessionStore } from '../store/chat-session.store';
import { answerLimitsOf, NO_ANSWER_LIMITS } from '../utils/answer-limits';
import { useChartSearchOffer } from './chartsearch-offer';
import styles from './chartsearch-answer.scss';

function createPendingAssistantMessage(id: string, question: string): ChatMessage {
  return {
    id,
    question,
    answer: '',
    references: [],
    reasoning: '',
    preliminaryReasoning: '',
    phase: 'answering',
    error: null,
    ...NO_ANSWER_LIMITS,
  };
}

/**
 * Omnibar Query Results must never echo free-text server error prose (which can quote the query
 * or chart data); keep structured client (`chartsearchai:*`) and problem codes only.
 */
function sanitizeOmnibarErrorCode(code: string): string {
  return /^(chartsearchai:[a-z0-9-]+|[a-z0-9]+(?:_[a-z0-9]+)*)$/.test(code) ? code : 'provider_failure';
}

export type ChartSearchAnswerViewProps = OmnibarViewProps;

const ChartSearchAnswerView: React.FC<ChartSearchAnswerViewProps> = ({
  query,
  context,
  reportState,
  hints,
  submitted,
  signal,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const config = useConfig<ChartSearchAiConfig>();
  const systemProvider = useSystemProviderDiscovery();
  const { selectedProfileId, profileDiscoveryStatus, profileExplicitlySelected } = useStore(chatSessionStore);
  const lastTurnProfileRef = useRef<string | null>(null);
  useHubProfileDiscovery(systemProvider.providerId);

  const patientUuid = context.scope === 'patient' ? context.patientUuid : undefined;
  const trimmedQuestion = query.trim();
  const showReasoning = config?.showReasoning !== false;

  const [message, setMessage] = useState<ChatMessage | null>(null);
  const [hasRequested, setHasRequested] = useState(Boolean(submitted));
  const [attempt, setAttempt] = useState(0);

  const shouldOffer = useChartSearchOffer(trimmedQuestion, patientUuid, hints, context.command?.id === 'ask');

  const abortRef = useRef<AbortController | null>(null);
  const turnSeqRef = useRef(0);
  const msgCounterRef = useRef(0);
  const pendingSafetyRef = useRef<Pick<AiSearchResponse, 'safetyStatus' | 'safetyCheck'> | null>(null);
  const systemProviderIdRef = useRef<string | null>(systemProvider.providerId);
  systemProviderIdRef.current = systemProvider.providerId;
  const providerUnavailableRef = useRef(false);

  const abortInFlight = useCallback(() => {
    turnSeqRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    pendingSafetyRef.current = null;
  }, []);

  useEffect(() => {
    if (!signal) return undefined;
    const onHostAbort = () => {
      abortInFlight();
    };
    if (signal.aborted) {
      abortInFlight();
      return undefined;
    }
    signal.addEventListener('abort', onHostAbort);
    return () => signal.removeEventListener('abort', onHostAbort);
  }, [signal, abortInFlight]);

  useEffect(() => {
    setMessage(null);
    setHasRequested(Boolean(submitted));
    setAttempt(0);
    lastTurnProfileRef.current = null;
  }, [patientUuid, trimmedQuestion, submitted]);

  const providerResolved = systemProvider.status !== 'loading';
  const providerExplicitlyUnavailable = systemProvider.status === 'unavailable' && Boolean(systemProvider.providerId);
  providerUnavailableRef.current = providerExplicitlyUnavailable;

  const startTurn = useCallback(
    (targetPatientUuid: string, targetQuestion: string) => {
      if (signal?.aborted) return;

      abortInFlight();
      const seq = turnSeqRef.current;
      const controller = new AbortController();
      abortRef.current = controller;

      const storeState = chatSessionStore.getState();
      const providerId = systemProviderIdRef.current ?? storeState.selectedProviderId ?? undefined;
      const profileId =
        providerId === 'hub' && storeState.profileDiscoveryStatus === 'ready' && storeState.selectedProfileId
          ? storeState.selectedProfileId
          : undefined;
      lastTurnProfileRef.current = profileId ?? null;
      const capabilities = providerId ? storeState.providerCapabilities?.[providerId] : undefined;

      msgCounterRef.current += 1;
      const messageId = `omnibar-${seq}-${msgCounterRef.current}`;
      setMessage(createPendingAssistantMessage(messageId, targetQuestion));

      const updateIfCurrent = (updater: (prev: ChatMessage) => ChatMessage) => {
        if (turnSeqRef.current !== seq || controller.signal.aborted) return;
        setMessage((prev) => (prev ? updater(prev) : prev));
      };

      chatPatientChartStream(
        targetPatientUuid,
        null,
        targetQuestion,
        {
          onSession: () => {
            // Ephemeral query-results turns are intentionally stateless (`session: null`).
          },
          onPreliminary: (delta) => {
            updateIfCurrent((prev) => {
              if (!showReasoning || isTerminal(prev.phase) || prev.reasoning || prev.answer) return prev;
              return {
                ...prev,
                preliminaryReasoning: stripPreviewCitations((prev.preliminaryReasoning ?? '') + delta),
              };
            });
          },
          onReasoning: (delta) => {
            if (!showReasoning) return;
            updateIfCurrent((prev) => {
              if (isTerminal(prev.phase) || prev.answer) return prev;
              return {
                ...prev,
                preliminaryReasoning: '',
                reasoning: (prev.reasoning ?? '') + delta,
              };
            });
          },
          onToken: (delta) => {
            updateIfCurrent((prev) => {
              if (isTerminal(prev.phase)) return prev;
              return {
                ...prev,
                phase: 'answering',
                preliminaryReasoning: '',
                answer: prev.answer + delta,
              };
            });
          },
          onAnswerDone: (response) => {
            updateIfCurrent((prev) => {
              if (isTerminal(prev.phase)) return prev;
              const unsettled = isUnsettledBundledSafetyCheck(response);
              pendingSafetyRef.current = unsettled
                ? { safetyStatus: response.safetyStatus, safetyCheck: response.safetyCheck }
                : null;
              const effectiveResponse: TurnEnvelope = unsettled
                ? { ...response, safetyStatus: undefined, safetyCheck: undefined }
                : response;
              const nextPhase = isCheckPendingOnAnswerDone(response) ? 'checking' : 'settled';
              return {
                ...applyTurnEnvelope(prev, effectiveResponse, nextPhase),
                preliminaryReasoning: '',
                safetyCheckPending: unsettled,
              };
            });
          },
          onAnswerValidation: (response) => {
            updateIfCurrent((prev) => {
              if (isTerminal(prev.phase)) return prev;
              const nextPhase = prev.inDepth?.status === 'pending' ? 'in-depth' : 'settled';
              return applyTurnEnvelope(prev, response, nextPhase);
            });
          },
          onEvidenceUpdated: (response) => {
            updateIfCurrent((prev) => {
              if (isTerminal(prev.phase)) return prev;
              if (response.safetyStatus !== undefined || response.safetyCheck !== undefined) {
                pendingSafetyRef.current = null;
              }
              const nextPhase =
                prev.answerValidation?.status === 'checking'
                  ? 'checking'
                  : prev.inDepth?.status === 'pending'
                    ? 'in-depth'
                    : 'settled';
              return {
                ...applyTurnEnvelope(prev, response, nextPhase),
                ...(response.safetyStatus !== undefined || response.safetyCheck !== undefined
                  ? { safetyCheckPending: false }
                  : {}),
              };
            });
          },
          onInDepthPending: (payload) => {
            updateIfCurrent((prev) => {
              if (isTerminal(prev.phase)) return prev;
              return applyTurnEnvelope(
                prev,
                {
                  ...payload,
                  inDepth: payload.inDepth ?? { status: 'pending', answer: prev.inDepth?.answer ?? '' },
                },
                'in-depth',
              );
            });
          },
          onInDepthDone: (payload) => {
            updateIfCurrent((prev) => {
              if (isTerminal(prev.phase)) return prev;
              return applyTurnEnvelope(prev, payload, 'settled');
            });
          },
          onInDepthError: (payload) => {
            updateIfCurrent((prev) => {
              if (isTerminal(prev.phase)) return prev;
              return applyTurnEnvelope(prev, payload, 'settled');
            });
          },
          onDone: (response) => {
            updateIfCurrent((prev) => {
              const deferredSafety =
                prev.safetyCheckPending && !response.safetyStatus && !response.safetyCheck
                  ? pendingSafetyRef.current
                  : null;
              pendingSafetyRef.current = null;
              const final = applyTurnEnvelope(prev, { ...deferredSafety, ...response }, 'complete');
              return {
                ...final,
                preliminaryReasoning: '',
                answerValidation: interruptAnswerValidation(final.answerValidation),
                inDepth: interruptInDepth(final.inDepth),
                references: interruptGroundingChecks(final.references),
                safetyCheckPending: false,
              };
            });
          },
          onError: (errorCode) => {
            pendingSafetyRef.current = null;
            const safeCode = sanitizeOmnibarErrorCode(errorCode);
            updateIfCurrent((prev) => ({
              ...prev,
              phase: 'error',
              error: safeCode,
              preliminaryReasoning: '',
              answerValidation: interruptAnswerValidation(prev.answerValidation),
              inDepth: interruptInDepth(prev.inDepth),
              references: interruptGroundingChecks(prev.references),
              ...(prev.safetyCheckPending
                ? {
                    safetyStatus: 'unavailable' as const,
                    safetyCheck: { status: 'unavailable' as const, issues: ['execution_failed'] },
                    safetyCheckPending: false,
                  }
                : {}),
            }));
          },
        },
        controller,
        profileId,
        providerId,
        capabilities,
        { ephemeral: true },
      );
    },
    [abortInFlight, showReasoning, signal],
  );

  useEffect(() => {
    if (
      !hasRequested ||
      systemProvider.providerId !== 'hub' ||
      profileDiscoveryStatus !== 'ready' ||
      !profileExplicitlySelected ||
      !selectedProfileId ||
      lastTurnProfileRef.current === selectedProfileId
    ) {
      return;
    }
    setAttempt((n) => n + 1);
  }, [hasRequested, systemProvider.providerId, profileDiscoveryStatus, profileExplicitlySelected, selectedProfileId]);

  useEffect(() => {
    if (!shouldOffer || !patientUuid || !trimmedQuestion || !hasRequested || signal?.aborted || !providerResolved) {
      return undefined;
    }
    if (providerUnavailableRef.current) {
      return undefined;
    }
    startTurn(patientUuid, trimmedQuestion);
    return () => {
      abortInFlight();
    };
  }, [
    shouldOffer,
    patientUuid,
    trimmedQuestion,
    hasRequested,
    attempt,
    signal,
    providerResolved,
    startTurn,
    abortInFlight,
  ]);

  const wasUnavailableRef = useRef(false);
  useEffect(() => {
    const wasUnavailable = wasUnavailableRef.current;
    wasUnavailableRef.current = providerExplicitlyUnavailable;
    if (wasUnavailable && !providerExplicitlyUnavailable && hasRequested && !message) {
      setAttempt((n) => n + 1);
    }
  }, [providerExplicitlyUnavailable, hasRequested, message]);

  useEffect(() => {
    reportState(!shouldOffer ? 'empty' : providerExplicitlyUnavailable && !message ? 'unavailable' : 'ready');
  }, [shouldOffer, providerExplicitlyUnavailable, message, reportState]);

  const requestTurn = useCallback(() => {
    if (signal?.aborted) return;
    if (providerUnavailableRef.current) {
      refreshSystemProvider();
    }
    setHasRequested(true);
    setAttempt((n) => n + 1);
  }, [signal]);

  if (!shouldOffer || !patientUuid) {
    return null;
  }

  const awaitingFirstToken = Boolean(message && isAwaitingAnswer(message.phase) && !message.answer && !message.error);
  const showPanel = Boolean(message && (!awaitingFirstToken || message.answer || message.error));
  const isStreamingReasoning = Boolean(message && isAwaitingAnswer(message.phase) && !message.answer && !message.error);

  return (
    <section aria-labelledby={headingId} className={styles.section}>
      <div className={styles.headerRow}>
        <h3 id={headingId} className={styles.heading}>
          {t('chartSearchHeading', 'ChartSearch')}
        </h3>
        <ModelPicker />
      </div>
      <p className={styles.question} dir="auto">
        {trimmedQuestion}
      </p>

      {providerExplicitlyUnavailable && !message ? (
        <div className={styles.unavailableBox} role="status">
          <p className={styles.unavailableTitle}>{t('providerUnavailable', 'Unavailable right now')}</p>
          {systemProvider.unavailableReason ? (
            <p className={styles.unavailableReason}>{systemProvider.unavailableReason}</p>
          ) : null}
          <Button kind="ghost" size="sm" onClick={requestTurn}>
            {t('tryAgain', 'Try again')}
          </Button>
        </div>
      ) : !hasRequested ? (
        <div className={styles.promptBox}>
          <p className={styles.note}>
            {t(
              'askChartSearchAgainNote',
              'ChartSearch answers from this chart using AI. It isn’t asked again when this page is reopened.',
            )}
          </p>
          <Button kind="secondary" size="sm" onClick={requestTurn}>
            {t('askChartSearchButton', 'Ask ChartSearch')}
          </Button>
        </div>
      ) : message ? (
        <div className={styles.answerBody}>
          {showReasoning && message.reasoning ? (
            <AiReasoningDisclosure reasoning={message.reasoning} isStreaming={isStreamingReasoning} />
          ) : null}

          {awaitingFirstToken ? (
            <div className={styles.loadingRow} role="status">
              <InlineLoading
                description={
                  message.preliminaryReasoning || t('preliminaryReasoning', 'Reviewing the most relevant records…')
                }
              />
            </div>
          ) : null}

          {showPanel ? (
            <AiResponsePanel
              answer={message.answer}
              references={message.references}
              safetyWarnings={message.safetyWarnings}
              {...answerLimitsOf(message)}
              error={message.error}
              phase={message.phase}
              safetyStatus={message.safetyStatus}
              safetyCheck={message.safetyCheck}
              blocks={message.blocks}
              confidence={message.confidence}
              answerValidation={message.answerValidation}
              inDepth={message.inDepth}
              auditLogId={message.auditLogId}
              resolvedModel={message.resolvedModel}
              patientUuid={patientUuid}
            />
          ) : null}

          {message.error ? (
            <div className={styles.retryRow}>
              <Button kind="ghost" size="sm" onClick={requestTurn}>
                {t('tryAgain', 'Try again')}
              </Button>
            </div>
          ) : null}

          {!message.error && message.answer ? (
            <p className={styles.disclaimer}>
              {t('aiDisclaimer', 'This answer is AI-generated and may not be accurate.')}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
};

export default ChartSearchAnswerView;
