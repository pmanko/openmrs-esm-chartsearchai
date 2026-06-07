import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, InlineLoading } from '@carbon/react';
import { Copy } from '@carbon/react/icons';
import { type AiBlock, type AiConfidence, type AiReference } from '../api/chartsearchai';
import AiFeedback from './ai-feedback.component';
import AiTableBlockView from './ai-table-block.component';
import MarkdownAnswer from './ai-markdown-answer.component';
import { buildReferenceUrl, handleReferenceNavigate } from './citation-chip.component';
import styles from './ai-response-panel.scss';

interface AiResponsePanelProps {
  answer: string;
  references: AiReference[];
  blocks?: AiBlock[];
  questionId: string;
  error: string | null;
  isLoading: boolean;
  patientUuid: string;
  /** The backend model that produced this answer; shown as a subtle faded tag. */
  resolvedModel?: string;
  /** Per-section validator confidence (validated hub tiers); rendered as green/yellow/red chips. */
  confidence?: AiConfidence;
  onFeedbackComplete?: () => void;
}

function stripCitations(answer: string): string {
  return answer.replace(/\s?\[\d+(?:\s*,\s*\d+)*\]/g, '').trim();
}

/** Confidence level → label, mirroring the validation dashboard's tag wording. */
const CONFIDENCE_LABEL: Record<string, string> = {
  green: 'High confidence',
  yellow: 'Medium confidence',
  red: 'Low confidence',
};

const AiResponsePanel: React.FC<AiResponsePanelProps> = ({
  answer,
  references,
  blocks,
  questionId,
  error,
  isLoading,
  patientUuid,
  resolvedModel,
  confidence,
  onFeedbackComplete,
}) => {
  const { t } = useTranslation();

  const handleCopy = useCallback(() => {
    navigator.clipboard?.writeText(stripCitations(answer));
  }, [answer]);

  if (error && !answer) {
    return (
      <div className={styles.errorContainer} role="alert">
        <p className={styles.errorText}>{error}</p>
      </div>
    );
  }

  return (
    <div className={styles.responseContainer}>
      {!isLoading && confidence && (
        <div className={styles.confidenceRow} data-testid="confidence-row">
          {(
            [
              ['Answer', confidence.answer],
              ['In Depth', confidence.in_depth],
            ] as const
          )
            .filter(([, section]) => section?.level)
            .map(([label, section]) => (
              <span
                key={label}
                className={styles.confidenceChip}
                data-level={section!.level}
                title={section!.note || undefined}
              >
                <strong>{label}:</strong> {CONFIDENCE_LABEL[section!.level] ?? section!.level}
              </span>
            ))}
        </div>
      )}
      {answer && (
        <div className={styles.answerSection}>
          {isLoading ? (
            <p className={styles.answerText}>{answer}</p>
          ) : (
            <MarkdownAnswer answer={answer} references={references} patientUuid={patientUuid} />
          )}
          {isLoading && <InlineLoading className={styles.streamingIndicator} />}
        </div>
      )}

      {!isLoading &&
        blocks?.map((block, idx) =>
          block.kind === 'table' ? (
            <AiTableBlockView key={`block-${idx}`} block={block} references={references} patientUuid={patientUuid} />
          ) : null,
        )}

      {error && answer && (
        <div className={styles.errorContainer} role="alert">
          <p className={styles.errorText}>
            {t('streamInterrupted', 'Response interrupted:')} {error}
          </p>
        </div>
      )}

      {references.length > 0 && (
        <div className={styles.referencesSection}>
          <span className={styles.referencesLabel}>{t('references', 'References')}:</span>
          <div className={styles.referencesList}>
            {references.map((ref) => {
              const url = buildReferenceUrl(ref, patientUuid);
              const label = `[${ref.index}] ${ref.resourceType} — ${ref.date}`;
              return url ? (
                <a
                  key={ref.index}
                  className={styles.referenceTag}
                  href={url}
                  onClick={(e) => handleReferenceNavigate(e, url, ref)}
                >
                  {label}
                </a>
              ) : (
                <span key={ref.index} className={styles.referenceTagInert}>
                  {label}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {answer && !isLoading && (
        <div className={styles.actionsRow}>
          <div className={styles.actionsLeft}>
            {questionId ? (
              <AiFeedback key={questionId} questionId={questionId} onComplete={onFeedbackComplete} />
            ) : (
              <span />
            )}
            {resolvedModel && (
              <span
                className={styles.modelTag}
                title={t('answeredByModel', 'Answered by {{model}}', { model: resolvedModel })}
              >
                {resolvedModel}
              </span>
            )}
          </div>
          <IconButton kind="ghost" size="sm" label={t('copy', 'Copy')} align="left-bottom" onClick={handleCopy}>
            <Copy />
          </IconButton>
        </div>
      )}
    </div>
  );
};

export default AiResponsePanel;
