import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfig, usePatient } from '@openmrs/esm-framework';
import { Close, Microphone, MicrophoneFilled, Send, StopFilled } from '@carbon/react/icons';
import { InlineLoading } from '@carbon/react';
import { useChartSearchAi } from '../hooks/useChartSearchAi';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import { type ChartSearchAiConfig } from '../config-schema';
import AiResponsePanel from './ai-response-panel.component';
import styles from './ai-chat-content.scss';

interface AiChatContentProps {
  mode: 'floating' | 'workspace';
  onClose?: () => void;
  patientUuid?: string;
}

const AiChatContent: React.FC<AiChatContentProps> = ({ mode, onClose, patientUuid: patientUuidProp }) => {
  const { t } = useTranslation();
  const config = useConfig<ChartSearchAiConfig>();
  const { patient, isLoading: isPatientLoading } = usePatient();
  const patientUuid = patientUuidProp ?? patient?.id;

  const [question, setQuestion] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const historyAreaRef = useRef<HTMLDivElement>(null);

  const { messages, isAnyLoading, submitQuestion, stopCurrent } = useChartSearchAi(patientUuid);

  const questionRef = useRef(question);
  questionRef.current = question;

  const handleSpeechResult = useCallback(
    (transcript: string) => {
      const existing = questionRef.current.trimEnd();
      const fullQuestion = existing ? existing + ' ' + transcript : transcript;
      const trimmed = fullQuestion.trim();
      if (trimmed && patientUuid && !isAnyLoading) {
        submitQuestion(patientUuid, trimmed);
        setQuestion('');
      } else {
        setQuestion(fullQuestion);
      }
    },
    [patientUuid, isAnyLoading, submitQuestion],
  );

  const {
    isListening,
    isSupported: isSpeechSupported,
    error: speechError,
    startListening,
    stopListening,
    clearError: clearSpeechError,
  } = useSpeechRecognition(handleSpeechResult);

  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      const trimmedQuestion = question.trim();
      if (!trimmedQuestion || !patientUuid || isAnyLoading) return;
      clearSpeechError();
      submitQuestion(patientUuid, trimmedQuestion);
      setQuestion('');
    },
    [question, patientUuid, isAnyLoading, submitQuestion, clearSpeechError],
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handlePanelKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (mode !== 'floating') return;

      if (e.key === 'Escape') {
        onClose?.();
        return;
      }

      if (e.key !== 'Tab' || !rootRef.current) return;

      const focusable = rootRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [mode, onClose],
  );

  const prevMessagesLengthRef = useRef(0);
  useEffect(() => {
    if (messages.length > prevMessagesLengthRef.current && historyAreaRef.current) {
      historyAreaRef.current.scrollTop = historyAreaRef.current.scrollHeight;
    }
    prevMessagesLengthRef.current = messages.length;
  }, [messages.length]);

  // Re-scrolls per chunk and again when streaming ends — references/feedback mount in that final commit and grow the message past the viewport.
  // Tracks `reasoning` too: it streams before any answer text exists, so without it the live "Thinking..." scratchpad grows past the viewport and is clipped out of sight.
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const lastAnswer = lastMessage?.answer ?? '';
  const lastReasoning = lastMessage?.reasoning ?? '';
  // Track the preview text so the live preview scrolls into view (same reason as lastReasoning);
  // it is hidden once committed reasoning or the answer arrives.
  const lastPreliminary = lastMessage?.preliminaryReasoning ?? '';
  useEffect(() => {
    if (historyAreaRef.current) {
      historyAreaRef.current.scrollTop = historyAreaRef.current.scrollHeight;
    }
  }, [lastAnswer, lastReasoning, lastPreliminary, isAnyLoading]);

  const hasCompletedAnswer = messages.some((m) => !m.isLoading && m.answer);

  const prevIsAnyLoadingRef = useRef(false);
  useEffect(() => {
    if (prevIsAnyLoadingRef.current && !isAnyLoading) {
      inputRef.current?.focus();
    }
    prevIsAnyLoadingRef.current = isAnyLoading;
  }, [isAnyLoading]);

  const handleMicClick = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, stopListening, startListening]);

  const handleFeedbackComplete = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      className={`${styles.chatRoot} ${mode === 'floating' ? styles.chatRootFloating : styles.chatRootWorkspace}`}
      ref={rootRef}
      role={mode === 'floating' ? 'dialog' : undefined}
      aria-label={mode === 'floating' ? t('aiChartSearch', 'AI Chart Search') : undefined}
      onKeyDown={handlePanelKeyDown}
    >
      {mode === 'floating' && (
        <div className={styles.panelHeader}>
          <span className={styles.panelTitle}>
            <span className={styles.sparkle}>&#10024;</span>
            {t('aiChartSearch', 'AI Chart Search')}
          </span>
          <button className={styles.closeButton} onClick={onClose} aria-label={t('close', 'Close')} type="button">
            <Close size={16} />
          </button>
        </div>
      )}

      <div className={styles.historyArea} ref={historyAreaRef} role="log" aria-live="polite">
        {messages.length === 0 && !isPatientLoading && patientUuid && (
          <p className={styles.emptyState}>{t('askAiAboutPatient', 'Ask AI about this patient')}</p>
        )}

        {!isPatientLoading && !patientUuid && (
          <p className={styles.infoText}>{t('noPatientSelected', 'No patient selected')}</p>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={styles.messagePair}>
            <div className={styles.questionBubble}>{msg.question}</div>
            <div className={styles.answerBubble}>
              <AiResponsePanel
                answer={msg.answer}
                references={msg.references}
                safetyWarnings={msg.safetyWarnings}
                questionId={msg.questionId}
                error={msg.error}
                isLoading={msg.isLoading}
                patientUuid={patientUuid ?? ''}
                onFeedbackComplete={handleFeedbackComplete}
              />
              {msg.isLoading && !msg.answer && (
                <div>
                  <InlineLoading description={t('thinkingEllipsis', 'Thinking...')} />
                  {msg.reasoning && <p className={styles.liveReasoning}>{msg.reasoning}</p>}
                  {/* Provisional preview reasoning, shown only until the committed reasoning/answer
                      arrives (the hook then clears preliminaryReasoning). Labelled so a clinician
                      knows it may change. */}
                  {!msg.reasoning && msg.preliminaryReasoning && (
                    <p className={styles.preliminaryReasoning}>
                      <span className={styles.preliminaryLabel}>
                        {t('preliminaryReasoning', 'Reviewing the most relevant records…')}
                      </span>{' '}
                      {msg.preliminaryReasoning}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {hasCompletedAnswer && (
        <p className={styles.disclaimer}>
          {t(
            'aiDisclaimerText',
            "This response is AI-generated and may not be accurate. It is not a substitute for clinical judgment. Always verify against the patient's medical records.",
          )}
        </p>
      )}

      {speechError && (
        <p className={styles.speechError}>
          {speechError === 'not-allowed'
            ? t('microphonePermissionDenied', 'Microphone access was denied. Please allow microphone permissions.')
            : t('speechRecognitionError', 'Speech recognition failed. Please try again.')}
        </p>
      )}

      <form className={styles.inputArea} onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          className={styles.searchInput}
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder={config.aiSearchPlaceholder}
          maxLength={config.maxQuestionLength}
          disabled={isAnyLoading}
          autoFocus={mode === 'floating'}
        />
        {isSpeechSupported && !isAnyLoading && (
          <button
            className={`${styles.micButton} ${isListening ? styles.micButtonActive : ''}`}
            onClick={handleMicClick}
            aria-label={isListening ? t('stopListening', 'Stop listening') : t('voiceInput', 'Voice input')}
            title={isListening ? t('stopListening', 'Stop listening') : t('voiceInput', 'Voice input')}
            type="button"
            disabled={!patientUuid}
          >
            {isListening ? <MicrophoneFilled size={20} /> : <Microphone size={20} />}
          </button>
        )}
        {isAnyLoading ? (
          <button
            className={styles.actionButton}
            onClick={stopCurrent}
            aria-label={t('stop', 'Stop')}
            title={t('stop', 'Stop')}
            type="button"
          >
            <StopFilled size={20} />
          </button>
        ) : (
          <button
            className={styles.actionButton}
            type="submit"
            aria-label={t('send', 'Send')}
            title={t('send', 'Send')}
            disabled={!question.trim() || !patientUuid}
          >
            <Send size={20} />
          </button>
        )}
      </form>
    </div>
  );
};

export default AiChatContent;
