import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfig, usePatient } from '@openmrs/esm-framework';
import {
  Add,
  Close,
  Maximize,
  Microphone,
  MicrophoneFilled,
  Minimize,
  Renew,
  Send,
  StopFilled,
} from '@carbon/react/icons';
import { Button, IconButton, InlineLoading, InlineNotification } from '@carbon/react';
import { useChartSearchAi } from '../hooks/useChartSearchAi';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import { type ChartSearchAiConfig } from '../config-schema';
import AiResponsePanel from './ai-response-panel.component';
import ModelPicker from './model-picker.component';
import styles from './ai-chat-content.scss';

interface AiChatContentProps {
  mode: 'floating' | 'workspace';
  onClose?: () => void;
  patientUuid?: string;
  /** Floating mode only: whether the panel is maximized to full screen. */
  isExpanded?: boolean;
  /** Floating mode only: toggle the maximized state. When omitted, the maximize control is hidden. */
  onToggleExpand?: () => void;
}

const AiChatContent: React.FC<AiChatContentProps> = ({
  mode,
  onClose,
  patientUuid: patientUuidProp,
  isExpanded = false,
  onToggleExpand,
}) => {
  const { t } = useTranslation();
  const config = useConfig<ChartSearchAiConfig>();
  const { patient, isLoading: isPatientLoading } = usePatient();
  const patientUuid = patientUuidProp ?? patient?.id;

  const [question, setQuestion] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const historyAreaRef = useRef<HTMLDivElement>(null);

  const { messages, isAnyLoading, submitQuestion, stopCurrent, startNewChatSession, refreshClinicalContext } =
    useChartSearchAi(patientUuid);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

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
  const lastAnswer = messages.length > 0 ? messages[messages.length - 1].answer : '';
  useEffect(() => {
    if (historyAreaRef.current) {
      historyAreaRef.current.scrollTop = historyAreaRef.current.scrollHeight;
    }
  }, [lastAnswer, isAnyLoading]);

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

  const handleNewChat = useCallback(() => {
    if (!patientUuid) return;
    startNewChatSession(patientUuid);
    setRefreshNotice(null);
    setQuestion('');
    inputRef.current?.focus();
  }, [patientUuid, startNewChatSession]);

  const handleRefreshContext = useCallback(async () => {
    if (!patientUuid || isRefreshing) return;
    setIsRefreshing(true);
    setRefreshNotice(null);
    try {
      // On success the hook drops an in-thread system notice into the
      // conversation flow, so we don't raise the banner here. The banner is
      // reserved for the error case (a failed refresh has no in-thread row).
      await refreshClinicalContext(patientUuid);
    } catch {
      setRefreshNotice({
        kind: 'error',
        text: t('clinicalContextRefreshFailed', 'Could not refresh clinical context'),
      });
    } finally {
      setIsRefreshing(false);
    }
  }, [patientUuid, isRefreshing, refreshClinicalContext, t]);

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className={`${styles.chatRoot} ${mode === 'floating' ? styles.chatRootFloating : styles.chatRootWorkspace} ${
        mode === 'floating' && isExpanded ? styles.chatRootFloatingExpanded : ''
      }`}
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
          <span className={styles.panelHeaderActions}>
            <IconButton
              kind="ghost"
              size="sm"
              align="bottom"
              label={t('refreshClinicalContext', 'Refresh clinical context')}
              onClick={handleRefreshContext}
              disabled={!patientUuid || isRefreshing}
            >
              <Renew size={16} />
            </IconButton>
            <IconButton
              kind="ghost"
              size="sm"
              align="bottom"
              label={t('newChat', 'New chat')}
              onClick={handleNewChat}
              disabled={!patientUuid}
            >
              <Add size={16} />
            </IconButton>
            {onToggleExpand && (
              <IconButton
                kind="ghost"
                size="sm"
                align="bottom"
                label={isExpanded ? t('restore', 'Restore') : t('maximize', 'Maximize')}
                onClick={onToggleExpand}
              >
                {isExpanded ? <Minimize size={16} /> : <Maximize size={16} />}
              </IconButton>
            )}
            <IconButton kind="ghost" size="sm" align="bottom-end" label={t('close', 'Close')} onClick={onClose}>
              <Close size={16} />
            </IconButton>
          </span>
        </div>
      )}
      {mode === 'workspace' && (
        <div className={styles.workspaceActions}>
          <Button
            kind="ghost"
            size="sm"
            renderIcon={Renew}
            onClick={handleRefreshContext}
            disabled={!patientUuid || isRefreshing}
          >
            {t('refreshClinicalContext', 'Refresh clinical context')}
          </Button>
          <Button kind="ghost" size="sm" renderIcon={Add} onClick={handleNewChat} disabled={!patientUuid}>
            {t('newChat', 'New chat')}
          </Button>
        </div>
      )}

      <div className={styles.historyArea} ref={historyAreaRef} role="log" aria-live="polite">
        {messages.length === 0 && !isPatientLoading && patientUuid && (
          <p className={styles.emptyState}>{t('askAiAboutPatient', 'Ask AI about this patient')}</p>
        )}

        {!isPatientLoading && !patientUuid && (
          <p className={styles.infoText}>{t('noPatientSelected', 'No patient selected')}</p>
        )}

        {messages.map((msg) =>
          msg.kind === 'system' ? (
            // In-thread system notice (e.g. context refreshed) — a subtle
            // inline divider in the conversation flow, not a Q+A bubble.
            <div key={msg.id} className={styles.systemNotice} role="status">
              <span className={styles.systemNoticeText}>{msg.answer}</span>
            </div>
          ) : (
            <div key={msg.id} className={styles.messagePair}>
              <div className={styles.questionBubble}>{msg.question}</div>
              <div className={styles.answerBubble}>
                <AiResponsePanel
                  answer={msg.answer}
                  references={msg.references}
                  blocks={msg.blocks}
                  confidence={msg.confidence}
                  questionId={msg.questionId}
                  error={msg.error}
                  isLoading={msg.isLoading}
                  resolvedModel={msg.resolvedModel}
                  patientUuid={patientUuid ?? ''}
                  onFeedbackComplete={handleFeedbackComplete}
                />
                {msg.isLoading && !msg.answer && <InlineLoading description={t('thinkingEllipsis', 'Thinking...')} />}
              </div>
            </div>
          ),
        )}
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

      {refreshNotice && (
        <InlineNotification
          className={styles.refreshNotice}
          kind={refreshNotice.kind}
          lowContrast
          title={refreshNotice.text}
          onCloseButtonClick={() => setRefreshNotice(null)}
        />
      )}

      <div className={styles.modelPickerRow}>
        <ModelPicker />
      </div>

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
