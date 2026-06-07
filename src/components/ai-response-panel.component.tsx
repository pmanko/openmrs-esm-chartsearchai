import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, InlineLoading } from '@carbon/react';
import { Copy } from '@carbon/react/icons';
import { type AiBlock, type AiConfidence, type AiConfidenceSection, type AiReference } from '../api/chartsearchai';
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

/** Solid confidence pill matching the validate dashboard's chip (label + color per level). */
const CONF: Record<string, [string, string]> = {
  green: ['High confidence', '#196c2e'],
  yellow: ['Medium confidence', '#9e6a03'],
  red: ['Low confidence', '#8b1a1a'],
};

const IN_DEPTH_RE = /\*\*In ?Depth\*\*/i;

/**
 * Split the hub's combined answer body (`**Answer**` … `**In Depth**` …) into its two
 * sections, stripping the redundant markdown header from each — the confidence chip is the
 * section heading now. If there's no In-Depth marker, the whole body is the Answer section.
 */
function splitSections(answer: string): { answerBody: string; inDepthBody: string | null } {
  const stripAnswerHeader = (s: string) => s.replace(/^\s*\*\*Answer\*\*\s*/i, '').trim();
  const m = answer.match(IN_DEPTH_RE);
  if (!m || m.index === undefined) {
    return { answerBody: stripAnswerHeader(answer), inDepthBody: null };
  }
  return {
    answerBody: stripAnswerHeader(answer.slice(0, m.index)),
    inDepthBody: answer.slice(m.index + m[0].length).replace(/^\s*/, '').trim() || null,
  };
}

const ConfidenceChip: React.FC<{ level: string }> = ({ level }) => {
  const [label, color] = CONF[level] ?? ['Unrated', '#30363d'];
  return (
    <span className={styles.cchip} style={{ background: color }}>
      {label}
    </span>
  );
};

/**
 * One answer section (Answer / In-Depth) with the validate dashboard's confidence inversion
 * (scripts/validate-dashboard.py confSection):
 *   red    → show the validator note as a caveat, COLLAPSE the message behind "show <section>"
 *   yellow → show the message, collapse the note behind "show review note"
 *   green  → show the message, no caveat
 */
const ConfidenceSection: React.FC<{
  label: string;
  body: string;
  section?: AiConfidenceSection;
  references: AiReference[];
  patientUuid: string;
}> = ({ label, body, section, references, patientUuid }) => {
  if (!body) {
    return null;
  }
  const level = section?.level ?? 'green';
  const note = section?.note ?? '';
  const rendered = <MarkdownAnswer answer={body} references={references} patientUuid={patientUuid} />;
  return (
    <div className={styles.csec} data-testid={`section-${label.replace(/\s+/g, '-').toLowerCase()}`}>
      <div className={styles.ctitle}>
        {label} <ConfidenceChip level={level} />
      </div>
      {level === 'red' ? (
        <>
          {note && <div className={`${styles.caveat} ${styles.caveatRed}`}>{note}</div>}
          <details className={styles.collapse}>
            <summary>show {label.toLowerCase()}</summary>
            <div className={styles.ans}>{rendered}</div>
          </details>
        </>
      ) : level === 'yellow' ? (
        <>
          <div className={styles.ans}>{rendered}</div>
          {note && (
            <details className={styles.collapse}>
              <summary>show review note</summary>
              <div className={`${styles.caveat} ${styles.caveatYellow}`}>{note}</div>
            </details>
          )}
        </>
      ) : (
        <div className={styles.ans}>{rendered}</div>
      )}
    </div>
  );
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

  // Per-section confidence view only once the answer is complete and the backend sent
  // confidence (validated hub tiers). While streaming, or for single models / the parity
  // lane (no confidence), render the whole answer plainly.
  const showSections = Boolean(answer) && !isLoading && Boolean(confidence);
  const sections = showSections && confidence ? splitSections(answer) : null;

  return (
    <div className={styles.responseContainer}>
      {answer && !showSections && (
        <div className={styles.answerSection}>
          {isLoading ? (
            <p className={styles.answerText}>{answer}</p>
          ) : (
            <MarkdownAnswer answer={answer} references={references} patientUuid={patientUuid} />
          )}
          {isLoading && <InlineLoading className={styles.streamingIndicator} />}
        </div>
      )}
      {sections && confidence && (
        <div className={styles.answerSection}>
          <ConfidenceSection
            label="Answer"
            body={sections.answerBody}
            section={confidence.answer}
            references={references}
            patientUuid={patientUuid}
          />
          {sections.inDepthBody && (
            <ConfidenceSection
              label="In Depth"
              body={sections.inDepthBody}
              section={confidence.in_depth}
              references={references}
              patientUuid={patientUuid}
            />
          )}
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
