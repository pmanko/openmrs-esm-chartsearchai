import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, InlineLoading, Tag } from '@carbon/react';
import { Copy } from '@carbon/react/icons';
import {
  type AiAnswerValidation,
  type AiBlock,
  type AiConfidence,
  type AiConfidenceSection,
  type AiInDepth,
  type AiReference,
  type AiSafetyWarning,
  SESSION_EXPIRED_ERROR_CODE,
} from '../api/chartsearchai';
import AiFeedback from './ai-feedback.component';
import AiTableBlockView from './ai-table-block.component';
import MarkdownAnswer from './ai-markdown-answer.component';
import { buildReferenceUrl, handleReferenceNavigate, isDrugReference } from './citation-chip.component';
import { type TurnPhase, isTerminal } from '../hooks/turn-phase';
import styles from './ai-response-panel.scss';

interface AiResponsePanelProps {
  answer: string;
  references: AiReference[];
  safetyWarnings?: AiSafetyWarning[];
  blocks?: AiBlock[];
  questionId: string;
  error: string | null;
  /** The turn's lifecycle phase — drives which parts of the answer render (see {@link TurnPhase}). */
  phase: TurnPhase;
  patientUuid: string;
  /** Hub product profile that produced this answer; shown as a subtle faded tag. */
  resolvedModel?: string;
  /** Per-section validator confidence (validated hub tiers); rendered as green/yellow/red chips. */
  confidence?: AiConfidence;
  /** Staged answer check lifecycle; rendered as the primary Answer badge when present. */
  answerValidation?: AiAnswerValidation;
  /** Staged team In-Depth state. */
  inDepth?: AiInDepth;
  onFeedbackComplete?: () => void;
}

type Translate = (key: string, fallback: string) => string;

interface GroundedTag {
  type: 'green' | 'red' | 'purple' | 'blue';
  text: string;
  title: string;
}

/**
 * Maps a citation's grounding verdict to a translated badge, or null when no
 * badge should show. null/undefined (unverified) returns null so an unverified
 * citation is never rendered as "verified".
 *
 * The {@code t(...)} calls use string-literal keys (not variables) so the
 * i18next-parser can statically extract them; a dynamic {@code t(key)} would be
 * dropped from translations/en.json by the `extract-translations` check.
 */
function groundedTag(ref: AiReference, t: Translate): GroundedTag | null {
  if (ref.groundingStatus === 'checking') {
    return {
      type: 'blue',
      text: t('groundingChecking', 'Checking'),
      title: t('groundingCheckingTitle', 'Source resolved; support check is still running.'),
    };
  }
  if (ref.grounded === true || ref.groundingStatus === 'verified') {
    const sourceSet = ref.groundingScope === 'source_set';
    return {
      type: 'green',
      text: t('grounded', 'Verified'),
      title: sourceSet
        ? t('groundedSourceSetTitle', 'Supports this claim together with the other cited records.')
        : t('groundedTitle', 'Supported by the cited record.'),
    };
  }
  if (ref.grounded === false || ref.groundingStatus === 'unsupported') {
    const sourceSet = ref.groundingScope === 'source_set';
    return {
      type: 'red',
      text: t('notGrounded', 'Unsupported'),
      title: sourceSet
        ? t(
            'notGroundedSourceSetTitle',
            'This cited source set may not support the associated claim — verify against the chart.',
          )
        : t('notGroundedTitle', 'The cited record may not support this statement — verify against the chart.'),
    };
  }
  if (ref.groundingStatus === 'mixed') {
    return {
      type: 'red',
      text: t('groundingMixed', 'Mixed support'),
      title: t(
        'groundingMixedTitle',
        'This record supports some associated claims but not others — inspect the evidence details.',
      ),
    };
  }
  return null;
}

/** The tooltip shared by the drug-reference chip and its inline citation: one wording, one i18n key. */
function drugReferenceTitle(t: Translate): string {
  return t('drugReferenceCitation', 'Clinical reference data — not this patient’s record.');
}

/**
 * Badge for a drug-reference citation: reference data, not a grounded/ungrounded patient
 * record, so it gets its own neutral purple "Reference" tag rather than a grounding verdict.
 * Returns the shared {@link GroundedTag} shape so the badge renderer treats it uniformly.
 */
function referenceTag(t: Translate): GroundedTag {
  return {
    type: 'purple',
    text: t('reference', 'Reference'),
    title: drugReferenceTitle(t),
  };
}

/**
 * Maps a safety-warning type to a Carbon Tag colour and a translated label.
 * Overdose and contraindication are the higher-severity reds; an interaction is
 * magenta. Unknown types fall back to a neutral red so a warning is never dropped.
 */
function safetyWarningTag(type: string, t: Translate): { tagType: 'red' | 'magenta'; label: string } {
  switch (type) {
    case 'overdose':
      return { tagType: 'red', label: t('safetyOverdose', 'Dose') };
    case 'contraindication':
      return { tagType: 'red', label: t('safetyContraindication', 'Contraindication') };
    case 'interaction':
      return { tagType: 'magenta', label: t('safetyInteraction', 'Interaction') };
    default:
      return { tagType: 'red', label: t('safetyWarning', 'Safety') };
  }
}
function stripCitations(answer: string): string {
  return answer.replace(/\s?\[\d+(?:\s*,\s*\d+)*\]/g, '').trim();
}

function evidenceTitle(ref: AiReference): string {
  const text = (ref.sourceText ?? '').replace(/^\s*\(\d{4}-\d{2}-\d{2}\)\s*/, '').trim();
  if (text) {
    return text.length > 88 ? `${text.slice(0, 85)}...` : text;
  }
  return `${ref.resourceType || 'Record'} ${ref.index}`;
}

const EvidenceCard: React.FC<{ refItem: AiReference; patientUuid: string; t: Translate }> = ({
  refItem,
  patientUuid,
  t,
}) => {
  const url = buildReferenceUrl(refItem, patientUuid);
  const title = evidenceTitle(refItem);
  const meta = [`[${refItem.index}]`, refItem.resourceType, refItem.date].filter(Boolean).join(' · ');
  const source = (refItem.sourceText ?? '').trim();
  return (
    <div className={styles.evidenceCard}>
      <div className={styles.evidenceMeta}>{meta}</div>
      {url ? (
        <a className={styles.evidenceLink} href={url} onClick={(e) => handleReferenceNavigate(e, url, refItem)}>
          {title}
        </a>
      ) : (
        <div className={styles.evidenceTitleText}>{title}</div>
      )}
      {source && <div className={styles.evidenceSource}>{source}</div>}
      {refItem.resourceUuid && (
        <div className={styles.evidenceUuid}>
          {t('sourceUuid', 'UUID')}: {refItem.resourceUuid}
        </div>
      )}
    </div>
  );
};

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
    inDepthBody:
      answer
        .slice(m.index + m[0].length)
        .replace(/^\s*/, '')
        .trim() || null,
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

const validationLabelFallback: Record<string, string> = {
  validating: 'Checking answer',
  checked: 'Checked',
  edited: 'Updated after check',
  needs_review: 'Needs review',
  unavailable: 'Check unavailable',
};

const AnswerValidationBadge: React.FC<{ validation: AiAnswerValidation }> = ({ validation }) => {
  const className = styles[`answerValidation_${validation.status}`] ?? styles.answerValidation_unavailable;
  return (
    <span className={`${styles.answerValidation} ${className}`} title={validation.summary ?? ''}>
      {validation.label || validationLabelFallback[validation.status] || 'Check unavailable'}
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
  answerValidation?: AiAnswerValidation;
  references: AiReference[];
  patientUuid: string;
}> = ({ label, body, section, answerValidation, references, patientUuid }) => {
  if (!body) {
    return null;
  }
  const level = section?.level ?? 'green';
  const note = section?.note ?? '';
  const rendered = <MarkdownAnswer answer={body} references={references} patientUuid={patientUuid} />;
  return (
    <div className={styles.csec} data-testid={`section-${label.replace(/\s+/g, '-').toLowerCase()}`}>
      <div className={styles.ctitle}>
        {label} {answerValidation && <AnswerValidationBadge validation={answerValidation} />}{' '}
        {section && <ConfidenceChip level={level} />}
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
      {answerValidation?.status === 'edited' && answerValidation.originalAnswer && (
        <details className={styles.collapse}>
          <summary>view original</summary>
          <div className={`${styles.caveat} ${styles.caveatYellow}`}>
            <MarkdownAnswer
              answer={answerValidation.originalAnswer}
              references={references}
              patientUuid={patientUuid}
            />
          </div>
        </details>
      )}
    </div>
  );
};
const AiResponsePanel: React.FC<AiResponsePanelProps> = ({
  answer,
  references,
  safetyWarnings,
  blocks,
  questionId,
  error,
  phase,
  patientUuid,
  resolvedModel,
  confidence,
  answerValidation,
  inDepth,
  onFeedbackComplete,
}) => {
  const { t } = useTranslation();

  const handleCopy = useCallback(() => {
    navigator.clipboard?.writeText(stripCitations(answer));
  }, [answer]);

  // The API layer emits a code (not display text) for session expiry so the wording can be localized
  // here; every other error is already a human-readable string from the server or browser.
  const displayError =
    error === SESSION_EXPIRED_ERROR_CODE
      ? t('sessionExpired', 'Your session has expired. Please log in again.')
      : error;

  if (error && !answer) {
    return (
      <div className={styles.errorContainer} role="alert">
        <p className={styles.errorText}>{displayError}</p>
      </div>
    );
  }

  // Older combined responses split after completion. Product-profile responses split as soon
  // as the direct answer is complete, while the In-Depth section remains pending.
  const showSections =
    Boolean(answer) && (Boolean(inDepth) || Boolean(answerValidation) || (isTerminal(phase) && Boolean(confidence)));
  const sections = showSections ? splitSections(answer) : null;
  const resolvedEvidence = references.filter((ref) => Boolean((ref.sourceText ?? '').trim()));
  const shownEvidence = resolvedEvidence.slice(0, 5);
  const overflowEvidence = resolvedEvidence.slice(5);

  return (
    // data-turn-phase exposes the whole turn's lifecycle to the DOM so behavior is observable
    // (cheap verification / e2e) rather than inferred from timing.
    <div className={styles.responseContainer} data-turn-phase={phase}>
      {answer && !showSections && (
        <div className={styles.answerSection}>
          {phase === 'answering' ? (
            <p className={styles.answerText}>{answer}</p>
          ) : (
            <MarkdownAnswer answer={answer} references={references} patientUuid={patientUuid} />
          )}
          {phase === 'answering' && <InlineLoading className={styles.streamingIndicator} />}
        </div>
      )}
      {sections && (
        <div className={styles.answerSection}>
          <ConfidenceSection
            label="Answer"
            body={sections.answerBody}
            section={confidence?.answer}
            answerValidation={answerValidation}
            references={references}
            patientUuid={patientUuid}
          />
          {/* Wrapper exposes the staged in-depth status to the DOM (pending | complete | failed) so
              it is observable — the three inner renderings otherwise share one testid and can't be
              told apart. display:contents keeps layout identical. */}
          {inDepth && (
            <div style={{ display: 'contents' }} data-indepth-status={inDepth.status}>
              {inDepth.status === 'pending' && (
                <div className={styles.csec} data-testid="section-in-depth">
                  <div className={styles.ctitle}>In Depth</div>
                  {inDepth.answer ? (
                    <div className={styles.ans}>
                      <MarkdownAnswer answer={inDepth.answer} references={references} patientUuid={patientUuid} />
                    </div>
                  ) : (
                    <InlineLoading className={styles.streamingIndicator} description="Preparing in-depth..." />
                  )}
                </div>
              )}
              {inDepth.status === 'failed' && (
                <div className={styles.csec} data-testid="section-in-depth">
                  <div className={styles.ctitle}>In Depth</div>
                  <div className={`${styles.caveat} ${styles.caveatYellow}`}>
                    {inDepth.error ?? 'In-Depth could not be completed.'}
                  </div>
                </div>
              )}
              {inDepth.status === 'complete' && inDepth.answer && (
                <ConfidenceSection
                  label="In Depth"
                  body={inDepth.answer}
                  section={confidence?.in_depth}
                  references={references}
                  patientUuid={patientUuid}
                />
              )}
            </div>
          )}
          {!inDepth && sections.inDepthBody && (
            <ConfidenceSection
              label="In Depth"
              body={sections.inDepthBody}
              section={confidence?.in_depth}
              references={references}
              patientUuid={patientUuid}
            />
          )}
        </div>
      )}

      {(isTerminal(phase) || Boolean(inDepth)) &&
        blocks?.map((block, idx) =>
          block.kind === 'table' ? (
            <AiTableBlockView key={`block-${idx}`} block={block} references={references} patientUuid={patientUuid} />
          ) : null,
        )}

      {error && answer && (
        <div className={styles.errorContainer} role="alert">
          <p className={styles.errorText}>
            {t('streamInterrupted', 'Response interrupted:')} {displayError}
          </p>
        </div>
      )}

      {references.length > 0 && (
        <div className={styles.referencesSection}>
          <span className={styles.referencesLabel}>{t('references', 'References')}:</span>
          <div className={styles.referencesList}>
            {references.map((ref) => {
              const url = buildReferenceUrl(ref, patientUuid);
              const drugReference = isDrugReference(ref);
              const label = drugReference
                ? `[${ref.index}] ${t('drugReferenceLabel', 'Drug reference')}`
                : `[${ref.index}] ${ref.resourceType} — ${ref.date}`;
              const g = drugReference ? referenceTag(t) : groundedTag(ref, t);
              // Tooltip via a native-title wrapper rather than Tag's deprecated `title` prop.
              // Rendered as a sibling of the link (Carbon Tag is a <div>) so the metadata
              // badge is not nested in, or part of, the navigation click target.
              const badge = g ? (
                <span className={styles.groundedTag} title={g.title}>
                  <Tag type={g.type} size="sm">
                    {g.text}
                  </Tag>
                </span>
              ) : null;
              const link = url ? (
                <a className={styles.referenceTag} href={url} onClick={(e) => handleReferenceNavigate(e, url, ref)}>
                  {label}
                </a>
              ) : (
                <span className={styles.referenceTagInert}>{label}</span>
              );
              return (
                <span key={ref.index} className={styles.referenceItem}>
                  {link}
                  {badge}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {resolvedEvidence.length > 0 && (
        <div className={styles.evidenceSection}>
          <div className={styles.evidenceSectionTitle}>{t('evidenceUsed', 'Evidence Used')}</div>
          <div className={styles.evidenceGrid}>
            {shownEvidence.map((ref) => (
              <EvidenceCard key={`evidence-${ref.index}`} refItem={ref} patientUuid={patientUuid} t={t} />
            ))}
          </div>
          {overflowEvidence.length > 0 && (
            <details className={styles.evidenceMore}>
              <summary>{t('showAllEvidence', 'show all evidence')}</summary>
              <div className={styles.evidenceGrid}>
                {overflowEvidence.map((ref) => (
                  <EvidenceCard key={`evidence-more-${ref.index}`} refItem={ref} patientUuid={patientUuid} t={t} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {safetyWarnings && safetyWarnings.length > 0 && (
        // No live-region role: the panel already sits inside the chat history's
        // role="log" aria-live="polite", which announces this content in order. An
        // assertive role="alert" here would preempt the answer it annotates.
        <div className={styles.safetyWarningsSection} data-testid="ai-response-safety">
          <span className={styles.safetyWarningsLabel}>{t('safetyChecks', 'Safety checks')}:</span>
          <div className={styles.safetyWarningsList}>
            {safetyWarnings.map((warning, i) => {
              const { tagType, label } = safetyWarningTag(warning.type, t);
              return (
                <span key={`${warning.type}-${warning.drug}-${i}`} className={styles.safetyWarningItem}>
                  <Tag type={tagType} size="sm" className={styles.safetyWarningBadge}>
                    {label}
                  </Tag>
                  <span className={styles.safetyWarningText}>
                    {warning.type}:{warning.drug}: {warning.detail}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {answer && isTerminal(phase) && (
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
