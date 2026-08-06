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
  type AiSafetyCheck,
  type AiSafetyReferencePackage,
  type AiSafetyStatus,
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
  /** checked/limited/unavailable — surfaced even when safetyWarnings is empty, so a clean check
   *  is never visually indistinguishable from one that could not run. */
  safetyStatus?: AiSafetyStatus;
  /** Canonical safety result; explains package approval and coverage limitations. */
  safetyCheck?: AiSafetyCheck;
  blocks?: AiBlock[];
  auditLogId?: number;
  error: string | null;
  /** The turn's lifecycle phase — drives which parts of the answer render (see {@link TurnPhase}). */
  phase: TurnPhase;
  patientUuid: string;
  /** Hub product profile that produced this answer; shown as a subtle faded tag. */
  resolvedModel?: string;
  /** Per-section check confidence (checked hub profiles); rendered as green/yellow/red chips. */
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

/**
 * Maps a safety status to a Carbon Tag. Every completed status stays visible so a clean check is
 * distinguishable from a missing check, and limited/unavailable results cannot look complete.
 */
function safetyStatusTag(status: AiSafetyStatus, t: Translate): { tagType: 'green' | 'gray'; label: string } {
  switch (status) {
    case 'checked':
      return { tagType: 'green', label: t('safetyChecked', 'Checked') };
    case 'limited':
      return { tagType: 'gray', label: t('safetyLimited', 'Limited safety check') };
    case 'unavailable':
      return { tagType: 'gray', label: t('safetyUnavailable', 'Safety check unavailable') };
  }
}

function safetyIssueText(issue: string, t: Translate): string {
  switch (issue) {
    case 'source_not_clinically_approved':
      return t(
        'safetySourceNotApproved',
        'The configured research source is not clinically approved for deterministic warnings.',
      );
    case 'cross_reactivity_not_clinically_approved':
      return t('safetyCrossReactivityNotApproved', 'The cross-reactivity rules are not clinically approved.');
    case 'source_unavailable':
      return t('safetySourceUnavailable', 'No medication-safety reference source was available.');
    case 'source_data_invalid':
      return t('safetySourceDataInvalid', 'The medication-safety reference data could not be read safely.');
    case 'source_data_partially_invalid':
      return t(
        'safetySourceDataPartiallyInvalid',
        'Some medication-safety reference records were invalid and ignored.',
      );
    case 'source_package_identity_incomplete':
      return t(
        'safetySourcePackageIdentityIncomplete',
        'The medication-safety rule package is missing required source identity information.',
      );
    case 'source_retired':
      return t('safetySourceRetired', 'The configured medication-safety source has been retired.');
    case 'cross_reactivity_source_unavailable':
      return t('safetyCrossReactivitySourceUnavailable', 'No cross-reactivity reference source was available.');
    case 'cross_reactivity_data_invalid':
      return t('safetyCrossReactivityDataInvalid', 'The cross-reactivity reference data could not be read safely.');
    case 'cross_reactivity_data_partially_invalid':
      return t(
        'safetyCrossReactivityDataPartiallyInvalid',
        'Some cross-reactivity reference records were invalid and ignored.',
      );
    case 'cross_reactivity_package_identity_incomplete':
      return t(
        'safetyCrossReactivityPackageIdentityIncomplete',
        'The cross-reactivity rule package is missing required source identity information.',
      );
    case 'cross_reactivity_source_retired':
      return t('safetyCrossReactivitySourceRetired', 'The configured cross-reactivity source has been retired.');
    case 'patient_context_unavailable':
      return t('safetyPatientContextUnavailable', 'The patient context needed for this check was unavailable.');
    case 'mapping_incomplete':
      return t('safetyMappingIncomplete', 'Not every active medication could be mapped to the reference source.');
    case 'exposure_incomplete':
      return t(
        'safetyExposureIncomplete',
        'Medication, allergy, or condition context may be incomplete for this check.',
      );
    case 'check_scope_limited':
      return t('safetyScopeLimited', 'Only part of the configured medication-safety check ran.');
    case 'execution_failed':
      return t('safetyExecutionFailed', 'The medication-safety check did not complete.');
    default:
      return issue.replaceAll('_', ' ');
  }
}

function safetyPackageProvenance(source?: AiSafetyReferencePackage): string | undefined {
  const provenance = source?.provenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return undefined;
  }
  const record = provenance as Record<string, unknown>;
  const values = ['source', 'dataset', 'origin']
    .map((key) => record[key])
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map((value) => value.trim());
  const unique = Array.from(new Set(values));
  return unique.length > 0 ? unique.join(' / ') : undefined;
}

function stripCitations(answer: string): string {
  return answer.replace(/\s?\[\d+(?:\s*,\s*\d+)*\]/g, '').trim();
}

function evidenceTitle(ref: AiReference): string {
  if ((ref.title ?? '').trim()) {
    return ref.title!.trim();
  }
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
  const sourceWithoutDate = source.replace(/^\s*\(\d{4}-\d{2}-\d{2}\)\s*/, '').trim();
  const showSource = Boolean(source && source !== title && sourceWithoutDate !== title);
  const grounding = isDrugReference(refItem) ? referenceTag(t) : groundedTag(refItem, t);
  return (
    <div className={styles.evidenceCard}>
      <div className={styles.evidenceMeta}>{meta}</div>
      <div className={styles.evidenceBadges}>
        {refItem.resolutionStatus === 'resolved' && (
          <span title={t('sourceFoundTitle', 'Citation resolved to this source record.')}>
            <Tag type="blue" size="sm">
              {t('sourceFound', 'Source found')}
            </Tag>
          </span>
        )}
        {refItem.resolutionStatus === 'unresolved' && (
          <span title={t('sourceMissingTitle', 'Citation did not resolve to a source record.')}>
            <Tag type="red" size="sm">
              {t('sourceMissing', 'Source missing')}
            </Tag>
          </span>
        )}
        {grounding && (
          <span title={grounding.title}>
            <Tag type={grounding.type} size="sm">
              {grounding.text}
            </Tag>
          </span>
        )}
      </div>
      {url ? (
        <a className={styles.evidenceLink} href={url} onClick={(e) => handleReferenceNavigate(e, url, refItem)}>
          {title}
        </a>
      ) : (
        <div className={styles.evidenceTitleText}>{title}</div>
      )}
      {showSource && <div className={styles.evidenceSource}>{source}</div>}
      {refItem.resourceUuid && (
        <div className={styles.evidenceUuid}>
          {t('sourceUuid', 'UUID')}: {refItem.resourceUuid}
        </div>
      )}
      {refItem.usage && refItem.usage.length > 0 && (
        <div className={styles.evidenceUuid}>
          {t('usedIn', 'Used in')}: {[...new Set(refItem.usage.map((item) => item.location))].join(', ')}
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
  checking: 'Checking answer',
  checked: 'Checked',
  edited: 'Updated after check',
  needs_review: 'Needs review',
  unavailable: 'Check unavailable',
};

const inDepthValidation = (validation: AiInDepth['validation']): AiAnswerValidation | undefined => {
  const status = validation?.status;
  if (!status || !validationLabelFallback[status]) {
    return undefined;
  }
  return {
    status,
    label: validationLabelFallback[status],
    summary: typeof validation.summary === 'string' ? validation.summary : undefined,
  };
};

const AnswerValidationBadge: React.FC<{ validation: AiAnswerValidation }> = ({ validation }) => {
  const className = styles[`answerValidation_${validation.status}`] ?? styles.answerValidation_unavailable;
  return (
    <span className={`${styles.answerValidation} ${className}`}>
      {validation.label || validationLabelFallback[validation.status] || 'Check unavailable'}
    </span>
  );
};

const AnswerValidationSummary: React.FC<{ validation?: AiAnswerValidation }> = ({ validation }) => {
  const { t } = useTranslation();
  const summary = validation?.summary?.trim();
  const status = validation?.status;
  if (!summary || !status) {
    return null;
  }
  const className = styles[`answerValidationSummary_${status}`] ?? styles.answerValidationSummary_unavailable;
  const heading =
    status === 'edited'
      ? t('answerCheckChanges', 'What changed')
      : status === 'needs_review'
        ? t('answerCheckReviewReason', 'Why review is needed')
        : status === 'checking' || status === 'unavailable'
          ? t('answerCheckStatus', 'Check status')
          : t('answerCheckSummary', 'Check summary');
  return (
    <div
      className={`${styles.answerValidationSummary} ${className}`}
      data-testid="answer-validation-summary"
      role="note"
    >
      <div className={styles.answerValidationSummaryHeading}>{heading}</div>
      <div className={styles.answerValidationSummaryBody}>{summary}</div>
    </div>
  );
};

/** One answer section. A low-confidence flag adds a prominent warning but never hides reviewable output. */
const ConfidenceSection: React.FC<{
  label: string;
  body: string;
  section?: AiConfidenceSection;
  answerValidation?: AiAnswerValidation;
  references: AiReference[];
  patientUuid: string;
}> = ({ label, body, section, answerValidation, references, patientUuid }) => {
  const { t } = useTranslation();
  if (!body) {
    return null;
  }
  const level = section?.level ?? 'green';
  const note = section?.note ?? '';
  const rendered = <MarkdownAnswer answer={body} references={references} patientUuid={patientUuid} />;
  const originalAnswer = answerValidation?.originalAnswer?.trim();
  const originalReferences = answerValidation?.originalReferences ?? [];
  const originalBlocks = answerValidation?.originalBlocks ?? [];
  const hasOriginalReferenceArtifact = answerValidation?.originalReferences !== undefined;
  const showOriginalAnswer = Boolean(
    originalAnswer && (originalAnswer !== body.trim() || originalBlocks.length > 0 || hasOriginalReferenceArtifact),
  );
  const originalWasEdited = answerValidation?.status === 'edited';
  return (
    <div className={styles.csec} data-testid={`section-${label.replace(/\s+/g, '-').toLowerCase()}`}>
      <div className={styles.ctitle}>
        {label} {answerValidation && <AnswerValidationBadge validation={answerValidation} />}{' '}
        {section && <ConfidenceChip level={level} />}
      </div>
      <AnswerValidationSummary validation={answerValidation} />
      {level === 'red' ? (
        <>
          {note && <div className={`${styles.caveat} ${styles.caveatRed}`}>{note}</div>}
          <div className={styles.ans}>{rendered}</div>
        </>
      ) : level === 'yellow' ? (
        <>
          <div className={styles.ans}>{rendered}</div>
          {note && (
            <details className={styles.collapse}>
              <summary>{t('showReviewNote', 'Show review note')}</summary>
              <div className={`${styles.caveat} ${styles.caveatYellow}`}>{note}</div>
            </details>
          )}
        </>
      ) : (
        <div className={styles.ans}>{rendered}</div>
      )}
      {showOriginalAnswer && (
        <details open className={`${styles.reviewDraft} ${originalWasEdited ? styles.reviewDraftEdited : ''}`.trim()}>
          <summary>{t('originalModelAnswer', 'Original model answer')}</summary>
          <div
            className={`${styles.reviewDraftNotice} ${
              originalWasEdited ? styles.reviewDraftNoticeEdited : styles.reviewDraftNoticeRejected
            }`}
          >
            {originalWasEdited
              ? t(
                  'originalModelAnswerNotice',
                  'This answer or its supporting citations was changed by the answer check. The checked answer above is the current result.',
                )
              : t(
                  'originalModelAnswerNeedsReviewNotice',
                  'This was the model output before checking. The current answer above remains flagged for review.',
                )}
          </div>
          <div className={styles.reviewDraftBody}>
            <MarkdownAnswer answer={originalAnswer ?? ''} references={originalReferences} patientUuid={patientUuid} />
            {originalBlocks.map((block, idx) =>
              block.kind === 'table' ? (
                <AiTableBlockView
                  key={`original-block-${idx}`}
                  block={block}
                  references={originalReferences}
                  patientUuid={patientUuid}
                />
              ) : null,
            )}
          </div>
        </details>
      )}
    </div>
  );
};

const InDepthReviewDraft: React.FC<{
  draft?: string;
  references?: AiReference[];
  patientUuid: string;
}> = ({ draft, references, patientUuid }) => {
  const { t } = useTranslation();
  if (!draft?.trim()) {
    return null;
  }
  return (
    <details className={styles.reviewDraft}>
      <summary>{t('removedInDepthClaims', 'Removed In-Depth claims')}</summary>
      <div className={`${styles.reviewDraftNotice} ${styles.reviewDraftNoticeRejected}`}>
        {t(
          'removedInDepthClaimsNotice',
          'These model-generated claims were removed or withheld by checks. They are shown only for manual review and are not part of the final clinical response.',
        )}
      </div>
      <div className={styles.reviewDraftBody}>
        <MarkdownAnswer answer={draft} references={references ?? []} patientUuid={patientUuid} />
      </div>
    </details>
  );
};
const AiResponsePanel: React.FC<AiResponsePanelProps> = ({
  answer,
  references,
  safetyWarnings,
  safetyStatus,
  safetyCheck,
  blocks,
  auditLogId,
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
  const evidence = references.filter(
    (ref) =>
      Boolean((ref.title ?? '').trim()) ||
      Boolean((ref.sourceText ?? '').trim()) ||
      ref.resolutionStatus === 'unresolved',
  );
  const shownEvidence = evidence.slice(0, 5);
  const overflowEvidence = evidence.slice(5);

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
          {/* Wrapper exposes the staged in-depth status to the DOM (pending | complete | failed |
              needs_review) so
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
              {(inDepth.status === 'failed' || inDepth.status === 'needs_review') && (
                <div className={styles.csec} data-testid="section-in-depth">
                  <div className={styles.ctitle}>
                    In Depth{' '}
                    {inDepth.status === 'needs_review' && (
                      <span className={`${styles.answerValidation} ${styles.answerValidation_needs_review}`}>
                        {t('inDepthNeedsReview', 'Needs review')}
                      </span>
                    )}
                  </div>
                  {inDepth.status === 'needs_review' && (
                    <AnswerValidationSummary validation={inDepthValidation(inDepth.validation)} />
                  )}
                  <div
                    className={`${styles.caveat} ${
                      inDepth.status === 'needs_review' ? styles.caveatRed : styles.caveatYellow
                    }`}
                  >
                    {inDepth.error ??
                      (inDepth.status === 'needs_review'
                        ? t(
                            'inDepthWithheld',
                            'In-Depth was withheld because its claims did not pass the chart and temporal checks.',
                          )
                        : t('inDepthFailed', 'In-Depth could not be completed.'))}
                  </div>
                  <InDepthReviewDraft
                    draft={inDepth.reviewDraft}
                    references={inDepth.reviewReferences}
                    patientUuid={patientUuid}
                  />
                </div>
              )}
              {inDepth.status === 'complete' && inDepth.answer && (
                <>
                  <ConfidenceSection
                    label="In Depth"
                    body={inDepth.answer}
                    section={confidence?.in_depth}
                    answerValidation={inDepthValidation(inDepth.validation)}
                    references={references}
                    patientUuid={patientUuid}
                  />
                  <InDepthReviewDraft
                    draft={inDepth.reviewDraft}
                    references={inDepth.reviewReferences}
                    patientUuid={patientUuid}
                  />
                </>
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
        <details className={styles.referencesSection}>
          <summary className={styles.referencesLabel}>{t('citationDetails', 'Citation details')}</summary>
          <div className={styles.referencesList}>
            {references.map((ref) => {
              if ((ref.sourceText ?? '').trim()) {
                const diagnostics = [`[${ref.index}]`, ref.sourceId, ref.resolutionStatus, ref.groundingStatus]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <code key={ref.index} className={styles.referenceTagInert}>
                    {diagnostics}
                  </code>
                );
              }
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
        </details>
      )}

      {evidence.length > 0 && (
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

      {(() => {
        const effectiveStatus = safetyCheck?.status ?? safetyStatus;
        const statusTag = effectiveStatus ? safetyStatusTag(effectiveStatus, t) : null;
        const hasWarnings = Boolean(safetyWarnings && safetyWarnings.length > 0);
        const issues = Array.from(new Set(safetyCheck?.issues ?? [])).map((issue) => safetyIssueText(issue, t));
        const medicationPackage = safetyCheck?.package;
        const relationshipPackage = medicationPackage?.cross_reactivity;
        const sourceRows = [
          {
            label: t('safetyMedicationRulesSource', 'Medication rules'),
            source: medicationPackage,
          },
          {
            label: t('safetyCrossReactivityRulesSource', 'Cross-reactivity rules'),
            source: relationshipPackage,
          },
        ].filter(({ source }) => Boolean(source?.id?.trim()));
        const hasSafetyDetails = issues.length > 0 || sourceRows.length > 0;
        if (effectiveStatus === 'checked' && !hasWarnings && !hasSafetyDetails) {
          return null;
        }
        if (!statusTag && !hasWarnings && !hasSafetyDetails) {
          return null;
        }
        return (
          // No live-region role: the panel already sits inside the chat history's
          // role="log" aria-live="polite", which announces this content in order. An
          // assertive role="alert" here would preempt the answer it annotates.
          <div
            className={`${styles.safetyWarningsSection} ${
              hasWarnings
                ? styles.safetyWarnings_flagged
                : effectiveStatus === 'checked'
                  ? styles.safetyWarnings_checked
                  : effectiveStatus === 'limited'
                    ? styles.safetyWarnings_limited
                    : styles.safetyWarnings_unavailable
            }`}
            data-testid="ai-response-safety"
            role="note"
          >
            <span className={styles.safetyWarningsLabel}>{t('safetyChecks', 'Safety checks')}:</span>
            <div className={styles.safetyWarningsList}>
              {statusTag && (
                <span className={styles.safetyWarningItem}>
                  <Tag type={statusTag.tagType} size="sm" className={styles.safetyWarningBadge}>
                    {statusTag.label}
                  </Tag>
                </span>
              )}
              {safetyWarnings?.map((warning, i) => {
                const { tagType, label } = safetyWarningTag(warning.type, t);
                const detail = warning.detail.trim();
                const drug = warning.drug.trim();
                const warningText =
                  drug && !detail.toLocaleLowerCase().startsWith(drug.toLocaleLowerCase())
                    ? `${drug}: ${detail}`
                    : detail;
                return (
                  <span key={`${warning.type}-${warning.drug}-${i}`} className={styles.safetyWarningItem}>
                    <Tag type={tagType} size="sm" className={styles.safetyWarningBadge}>
                      {label}
                    </Tag>
                    <span className={styles.safetyWarningText}>{warningText}</span>
                  </span>
                );
              })}
            </div>
            {hasSafetyDetails && (
              <div className={styles.safetyCheckSummary} data-testid="safety-check-summary">
                <div className={styles.safetyCheckSummaryHeading}>
                  {t('safetyCheckDetails', 'Medication safety details')}
                </div>
                {issues.length > 0 && (
                  <ul className={styles.safetyCheckIssueList}>
                    {issues.map((issue, index) => (
                      <li key={`${issue}-${index}`}>{issue}</li>
                    ))}
                  </ul>
                )}
                {sourceRows.length > 0 && (
                  <dl className={styles.safetyCheckSources}>
                    {sourceRows.map(({ label, source }) => {
                      const sourceId = source?.id?.trim();
                      const sourceVersion = source?.version?.trim();
                      const reviewState = source?.review_state?.trim();
                      const provenance = safetyPackageProvenance(source);
                      return (
                        <div className={styles.safetyCheckSourceRow} key={label}>
                          <dt>{label}</dt>
                          <dd>
                            {sourceId}
                            {sourceVersion ? ` (${sourceVersion})` : ''}
                            {reviewState ? ` - ${reviewState.replaceAll('_', ' ')}` : ''}
                            {provenance && (
                              <span className={styles.safetyCheckProvenance}>
                                {t('safetyRulesSource', 'Source')}: {provenance}
                              </span>
                            )}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {answer && isTerminal(phase) && (
        <div className={styles.actionsRow}>
          <div className={styles.actionsLeft}>
            {auditLogId ? (
              <AiFeedback key={auditLogId} auditLogId={auditLogId} onComplete={onFeedbackComplete} />
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
