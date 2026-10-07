import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, InlineLoading, Tag } from '@carbon/react';
import { Copy } from '@carbon/react/icons';
import {
  type AiAnswerLimits,
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
import { compactChips, notInTheAnswer, rewordedInTheAnswer } from '../utils/compact-chips';
import {
  citationStripPattern,
  isReferenceData,
  type ReferenceKind,
  referenceKind,
  resolveFindingSeverities,
} from '../utils/safety-disclosure';
import AiFeedback from './ai-feedback.component';
import AiTableBlockView from './ai-table-block.component';
import MarkdownAnswer from './ai-markdown-answer.component';
import {
  buildReferenceUrl,
  handleReferenceNavigate,
  type Translate,
  notGroundedTitle,
  misattributedTitle,
  referenceTitle,
  renderTextWithCitations,
} from './citation-chip.component';
import { isAwaitingAnswer, isTerminal, type TurnPhase } from '../hooks/turn-phase';
import styles from './ai-response-panel.scss';

/**
 * The answer-limit measurements come in as {@link AiAnswerLimits}, so their semantics are
 * stated once on the wire type rather than restated here. Two readings this panel implements
 * and must keep: an empty array renders NOTHING (the check named none, which is not a
 * certificate that the other citations are sound), and a null renders nothing either (no
 * measurement was stated, which is not a completeness claim).
 */
interface AiResponsePanelProps extends AiAnswerLimits {
  answer: string;
  references: AiReference[];
  safetyWarnings?: AiSafetyWarning[];
  /** checked/limited/unavailable. Limited and unavailable remain visible with no warnings;
   *  checked-clean may stay quiet, so inability to run is never mistaken for a clean check. */
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

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An ended order's date as the panel may show it, or null where it must show none.
 *
 * The backend converts every date in UTC, so its `yyyy-MM-dd` can be a day off the local one, and
 * the panel shows it verbatim: never parsed into a `Date`, which would shift it again by the
 * viewer's own offset. Anything but that one shape is withheld rather than trimmed, so nothing more
 * exact than a calendar day reaches the screen.
 */
function calendarDay(value: unknown): string | null {
  return typeof value === 'string' && CALENDAR_DAY.test(value) ? value : null;
}

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
        : notGroundedTitle(t),
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

/**
 * Badge for a reference-data citation: reference data, not a grounded/ungrounded patient
 * record, so it gets its own neutral purple "Reference" tag rather than a grounding verdict.
 * Returns the shared {@link GroundedTag} shape so the badge renderer treats it uniformly.
 */
function referenceTag(ref: AiReference, t: Translate): GroundedTag {
  return {
    type: 'purple',
    text: t('reference', 'Reference'),
    title: referenceTitle(ref, t),
  };
}

/**
 * The label for a reference-group citation, keyed on the same classification the predicate uses
 * so the two cannot disagree. `other` is reachable and deliberately neutral: a citation whose
 * `group` is `reference` but whose type this client predates must not be called a drug
 * reference, which would tell a clinician it came from a drug's reference entry.
 */
const REFERENCE_KIND_LABEL: Record<ReferenceKind, (t: Translate) => string> = {
  safety_finding: (t) => t('safetyFindingLabel', 'Safety finding'),
  drug_reference: (t) => t('drugReferenceLabel', 'Drug reference'),
  drug_class_note: (t) => t('drugClassNoteLabel', 'Drug class note'),
  // Only for a `reference`-group type this client predates — never for one the module knows.
  other: (t) => t('referenceMaterialLabel', 'Reference material'),
};

function referenceLabel(ref: AiReference, t: Translate): string {
  return REFERENCE_KIND_LABEL[referenceKind(ref)](t);
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
 * Maps a stated safety status to a Carbon Tag. Limited and unavailable results remain visible;
 * checked-clean stays quiet when no warnings or source details need disclosure.
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
  if (issue.startsWith('named_drug_unresolved:')) {
    const medication = issue.slice('named_drug_unresolved:'.length).trim();
    if (medication && medication !== 'resolution_failed') {
      return t(
        'safetyNamedDrugUnresolved',
        'The medication “{{medication}}” could not be matched to the configured reference source.',
      ).replace('{{medication}}', medication);
    }
    return t(
      'safetyDrugResolutionFailed',
      'A named medication could not be matched to the configured reference source.',
    );
  }
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
  return answer.replace(citationStripPattern(), '').trim();
}

/** Whether a chip is drawn apart from the findings about the drug asked about — the box's split. */
function isApartFromTheDrugAsked(warning: AiSafetyWarning): boolean {
  return warning.aboutAnotherOfHerMedications === true || warning.aboutADrugOtherThanTheOneProposed === true;
}

/**
 * The cited findings a record the module attached is the source of, from `attachedFor` — only
 * where the module says it attached the record, and only indexes naming a `safety_finding` among
 * this answer's citations, so a malformed or dangling value draws no tag rather than one pointing
 * at a finding the clinician cannot find.
 */
function attachedForOf(ref: AiReference, citedFindings: ReadonlySet<number>): number[] {
  if (ref.attachedByTheModule !== true || !Array.isArray(ref.attachedFor)) return [];
  return ref.attachedFor.filter((index): index is number => Number.isInteger(index) && citedFindings.has(index));
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

type CitationDecorations = NonNullable<React.ComponentProps<typeof MarkdownAnswer>['decorations']>;

const EvidenceCard: React.FC<{
  refItem: AiReference;
  patientUuid: string;
  t: Translate;
  decorations: CitationDecorations;
}> = ({ refItem, patientUuid, t, decorations }) => {
  const url = buildReferenceUrl(refItem, patientUuid, decorations.misattributed?.has(refItem.index) ?? false);
  const title = evidenceTitle(refItem);
  const meta = [`[${refItem.index}]`, refItem.resourceType, refItem.date].filter(Boolean).join(' · ');
  const source = (refItem.sourceText ?? '').trim();
  const sourceWithoutDate = source.replace(/^\s*\(\d{4}-\d{2}-\d{2}\)\s*/, '').trim();
  const showSource = Boolean(source && source !== title && sourceWithoutDate !== title);
  const grounding = isReferenceData(refItem) ? referenceTag(refItem, t) : groundedTag(refItem, t);
  return (
    <div className={styles.evidenceCard}>
      <div className={styles.evidenceMeta}>{meta}</div>
      <div className={styles.evidenceBadges}>
        {renderTextWithCitations(`[${refItem.index}]`, {
          references: [refItem],
          patientUuid,
          t,
          misattributed: decorations.misattributed ?? new Set(),
          severities: decorations.severities ?? new Map(),
          qualified: decorations.qualified ?? new Set(),
          badged: new Set(),
          noted: new Set(),
        })}
      </div>
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
      {refItem.source && (
        <div className={styles.evidenceUuid}>
          {t('sourceDataset', 'Source')}: {refItem.source}
        </div>
      )}
      {(refItem.withheldInteractions ?? 0) > 0 && (
        <div className={styles.evidenceUuid}>
          {t(
            'sourceSubset',
            'This source shows a relevant subset; {{count}} additional interactions are not shown.',
          ).replace('{{count}}', String(refItem.withheldInteractions))}
        </div>
      )}
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
  decorations?: CitationDecorations;
}> = ({ label, body, section, answerValidation, references, patientUuid, decorations }) => {
  const { t } = useTranslation();
  if (!body) {
    return null;
  }
  const level = section?.level ?? 'green';
  const note = section?.note ?? '';
  const rendered = (
    <MarkdownAnswer answer={body} references={references} patientUuid={patientUuid} decorations={decorations} />
  );
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
  misattributedOrderCitations,
  unstatedFindingSeverities,
  orderStopDates,
  unfoundedFindingSeverities,
  unfaithfullyRenderedCitations,
  cautionLedOverWithholding,
  interactionClaimPairs,
  unsupportedEndedOrderClaims,
  unstatedSignificanceQualifiers,
  answeredByTheModule,
  findingsStatedByTheModule,
  asksWhetherSheHasTakenADrug,
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
  // Upstream's citation rendering keys off a loading flag; in the phase model the answer is
  // still arriving while the turn awaits its answer.
  const isLoading = isAwaitingAnswer(phase);

  // Array.isArray, not `?? []`: a non-iterable value here would throw inside this memo, and a
  // string would iterate its characters and silently match nothing.
  const misattributed = useMemo(
    () => new Set(Array.isArray(misattributedOrderCitations) ? misattributedOrderCitations : []),
    [misattributedOrderCitations],
  );

  // Citation index → the day that cited prescription stopped. Array.isArray for the reason
  // `misattributed` gives; an entry is kept only where its date reads as one calendar day.
  const stopDates = useMemo(() => {
    const byCitation = new Map<number, string>();
    for (const entry of Array.isArray(orderStopDates) ? orderStopDates : []) {
      const day = calendarDay(entry?.stopDate);
      if (typeof entry?.citation === 'number' && day) byCitation.set(entry.citation, day);
    }
    return byCitation;
  }, [orderStopDates]);

  // The indexes of this answer's safety-finding citations: what an attached record's `attachedFor`
  // may name, and the only findings a "source of" tag may point a clinician at.
  const citedFindings = useMemo(
    () =>
      new Set(
        (Array.isArray(references) ? references : [])
          .filter((ref) => ref && referenceKind(ref) === 'safety_finding')
          .map((ref) => ref.index),
      ),
    [references],
  );

  const severities = useMemo(
    () => resolveFindingSeverities(answer, references, safetyWarnings ?? [], unstatedFindingSeverities),
    [answer, references, safetyWarnings, unstatedFindingSeverities],
  );

  const qualified = useMemo(
    () =>
      new Set<number>(
        (Array.isArray(unstatedSignificanceQualifiers) ? unstatedSignificanceQualifiers : []).filter((index) =>
          Number.isInteger(index),
        ),
      ),
    [unstatedSignificanceQualifiers],
  );

  const handleCopy = useCallback(() => {
    navigator.clipboard?.writeText(stripCitations(answer));
  }, [answer]);

  // The chips drawn in the safety box: every one but those the answer already states (backend ADR
  // Decision 124 — on a question asking only for her allergies the answer names the conflicting
  // order and quotes the chip). A chip stated there is not drawn again beside the list the
  // clinician asked for. The full list still feeds everything that reads a finding rather than
  // draws one.
  const shownSafetyWarnings = useMemo(
    () => (safetyWarnings ?? []).filter((warning) => warning.statedInTheAnswer !== true),
    [safetyWarnings],
  );

  // The chips the answer cites and every fidelity check clears, drawn on one line with their detail
  // behind a toggle rather than repeating the answer's paragraph beside it — see compactChips for
  // what qualifies. Computed over EVERY chip, drawn or not, so a chip the safety box leaves out
  // still counts against a shared key. Never while streaming: the checks have not run yet.
  const compactWarnings = useMemo(() => {
    if (isLoading) return new Map<AiSafetyWarning, number[]>();
    const all = safetyWarnings ?? [];
    const positions = compactChips(answer, references, all, {
      misattributedOrderCitations,
      unstatedFindingSeverities,
      unfoundedFindingSeverities,
      unfaithfullyRenderedCitations,
      cautionLedOverWithholding,
      interactionClaimPairs,
      answeredByTheModule,
      findingsStatedByTheModule,
    });
    return new Map([...positions].map(([position, indexes]) => [all[position], indexes]));
  }, [
    isLoading,
    answer,
    references,
    safetyWarnings,
    misattributedOrderCitations,
    unstatedFindingSeverities,
    unfoundedFindingSeverities,
    unfaithfullyRenderedCitations,
    cautionLedOverWithholding,
    interactionClaimPairs,
    answeredByTheModule,
    findingsStatedByTheModule,
  ]);
  // The chips the answer does not cite that are about the drug proposed against a drug the question
  // only lists, drawn on one line marked as not in the answer — see notInTheAnswer. Never while
  // streaming, as compactWarnings.
  const absentWarnings = useMemo(() => {
    if (isLoading) return new Set<AiSafetyWarning>();
    const all = safetyWarnings ?? [];
    return new Set([...notInTheAnswer(answer, references, all)].map((position) => all[position]));
  }, [isLoading, answer, references, safetyWarnings]);
  // The cited chips whose finding the answer reworded and nothing else flagged, drawn on one line
  // that says so — see rewordedInTheAnswer. They do not count towards collapsing the box, so the
  // tag is seen. Never while streaming.
  const rewordedWarnings = useMemo(() => {
    if (isLoading) return new Map<AiSafetyWarning, number[]>();
    const all = safetyWarnings ?? [];
    const positions = rewordedInTheAnswer(answer, references, all, {
      misattributedOrderCitations,
      unstatedFindingSeverities,
      unfoundedFindingSeverities,
      unfaithfullyRenderedCitations,
      cautionLedOverWithholding,
      interactionClaimPairs,
    });
    return new Map([...positions].map(([position, indexes]) => [all[position], indexes]));
  }, [
    isLoading,
    answer,
    references,
    safetyWarnings,
    misattributedOrderCitations,
    unstatedFindingSeverities,
    unfoundedFindingSeverities,
    unfaithfullyRenderedCitations,
    cautionLedOverWithholding,
    interactionClaimPairs,
  ]);
  const [expandedWarnings, setExpandedWarnings] = useState<Set<AiSafetyWarning>>(() => new Set());

  // The whole safety box collapses to a summary line only where EVERY chip it draws qualifies for
  // the one-line form. One chip that does not keeps the box open: that is the finding a clinician
  // must not have to go looking for, and the box is where an answer that dropped or softened one
  // still shows it.  A chip about another of her medications than the drug the answer is about
  // (backend aboutAnotherOfHerMedications), or about any drug other than the one the question
  // proposes (backend aboutADrugOtherThanTheOneProposed), is drawn apart from those, behind a line
  // of its own: still in the box and one click away, but it neither keeps the box open nor sits
  // among the findings about that drug. Only `true` moves a chip; `false` is no claim it is about
  // the drug in question.
  // A question asking whether she has ever taken a drug (backend asksWhetherSheHasTakenADrug,
  // ADR Decision 156) draws every chip apart: they are about that drug's place in her chart, not
  // a reading of the question.
  const historyQuestion = asksWhetherSheHasTakenADrug === true;
  const mainWarnings = useMemo(
    () => (historyQuestion ? [] : shownSafetyWarnings.filter((warning) => !isApartFromTheDrugAsked(warning))),
    [shownSafetyWarnings, historyQuestion],
  );
  const otherWarnings = useMemo(
    () =>
      historyQuestion ? shownSafetyWarnings : shownSafetyWarnings.filter((warning) => isApartFromTheDrugAsked(warning)),
    [shownSafetyWarnings, historyQuestion],
  );
  // The line says the patient takes them only where every chip behind it is one of her own
  // prescriptions.
  const otherWarningsAreHerMedications = otherWarnings.every(
    (warning) => warning.aboutAnotherOfHerMedications === true,
  );
  const safetyBoxCollapsible = mainWarnings.length > 0 && mainWarnings.every((warning) => compactWarnings.has(warning));
  const [safetyBoxOpen, setSafetyBoxOpen] = useState(false);
  const [otherMedicationsOpen, setOtherMedicationsOpen] = useState(false);
  const toggleWarning = useCallback((warning: AiSafetyWarning) => {
    setExpandedWarnings((previous) => {
      const next = new Set(previous);
      if (next.has(warning)) next.delete(warning);
      else next.add(warning);
      return next;
    });
  }, []);

  // What a chip about an ended order is about. The backend asks for exactly this reading: such a
  // chip is about giving the drug again, not about two medications the patient takes now.
  const endedOrderTitle = t(
    'aboutAnEndedOrderTitle',
    'The chart records this drug only as an order no longer in force, so the finding is about what giving it again would mean — not about a medication the patient is taking now.',
  );
  // Said of both ended-order dates: the backend converts them in UTC.
  const utcDayTitle = t(
    'utcCalendarDayTitle',
    'The date is a calendar day in UTC, so it can be a day off the local date.',
  );

  // The API layer emits a code (not display text) for session expiry so the wording can be
  // localized here; every other error is already a human-readable string from the server or
  // browser.
  const displayError =
    error === SESSION_EXPIRED_ERROR_CODE
      ? t('sessionExpired', 'Your session has expired. Please log in again.')
      : error;

  const effectiveStatus = safetyCheck?.status ?? safetyStatus;
  const statusTag = effectiveStatus ? safetyStatusTag(effectiveStatus, t) : null;
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

  // One chip as the safety box draws it, in either of its two lists.
  const renderWarning = (warning: AiSafetyWarning, i: number) => {
    const { tagType, label } = safetyWarningTag(warning.type, t);
    const endedOn = calendarDay(warning.endedOrderStopDate);
    const absent = !compactWarnings.has(warning) && absentWarnings.has(warning);
    const reworded = !compactWarnings.has(warning) && rewordedWarnings.has(warning);
    const compact = compactWarnings.has(warning) || absent || reworded;
    const collapsed = compact && !expandedWarnings.has(warning);
    const partners = Array.isArray(warning.namedPartners)
      ? warning.namedPartners.filter((partner) => typeof partner === 'string' && partner.trim())
      : [];
    const severity = typeof warning.severity === 'string' && warning.severity.trim() ? warning.severity : null;
    // The one-line form names the partner from namedPartners. A chip carrying none — a finding
    // relating two drugs the question names — says who it is with only in its detail's lead,
    // "<drug> interacts with <partner>, also named in the question — <note>", so the line takes
    // that lead rather than dropping it.
    const dash = typeof warning.detail === 'string' ? warning.detail.indexOf(' — ') : -1;
    const oneLineSubject = partners.length === 0 && dash > 0 ? warning.detail.slice(0, dash) : warning.drug;
    return (
      <span key={`${warning.type}-${warning.drug}-${i}`} className={styles.safetyWarningItem}>
        <Tag type={tagType} size="sm" className={styles.safetyWarningBadge}>
          {label}
        </Tag>
        <span className={styles.safetyWarningText}>
          {collapsed ? (
            <>
              {oneLineSubject}
              {partners.length > 0 && ` — ${partners.join(', ')}`}
              {severity && ` (${severity})`}
            </>
          ) : (
            <>
              {warning.drug && !warning.detail.toLocaleLowerCase().startsWith(warning.drug.toLocaleLowerCase())
                ? `${warning.drug}: ${warning.detail}`
                : warning.detail}
            </>
          )}
          {compact && (
            <>
              {' '}
              {reworded ? (
                <span
                  className={styles.statedInAnswerTag}
                  title={t(
                    'rewordedInTheAnswerTitle',
                    'The answer cites this finding at {{markers}} and reworded it: it reproduces the record and then says something different inside the same sentence. Open the detail to compare it with the record’s own words.',
                    { markers: (rewordedWarnings.get(warning) ?? []).map((index) => `[${index}]`).join(', ') },
                  )}
                >
                  {t('rewordedInTheAnswer', 'Reworded in the answer, compare')}
                </span>
              ) : absent ? (
                <span
                  className={styles.statedInAnswerTag}
                  title={t(
                    'notInTheAnswerTitle',
                    'The answer does not mention this finding. It relates the drug asked about to another drug the question names; open the detail to read it in full.',
                  )}
                >
                  {t('notInTheAnswer', 'Not in the answer')}
                </span>
              ) : (compactWarnings.get(warning) ?? []).length === 0 ? (
                <span
                  className={styles.statedInAnswerTag}
                  title={t(
                    'statedAboveByTheModuleTitle',
                    'The module states this finding after the answer; open the detail to read it in full.',
                  )}
                >
                  {t('statedAboveByTheModule', 'Stated above')}
                </span>
              ) : (
                <span
                  className={styles.statedInAnswerTag}
                  title={
                    answeredByTheModule === true
                      ? t(
                          'seeMarkerInTheModulesAnswerTitle',
                          'The answer states this finding briefly at that marker; open the detail to read it in full.',
                        )
                      : t(
                          'seeMarkerInTheAnswerTitle',
                          'The answer cites this finding at that marker, and no check of how it was rendered named it, so its detail is collapsed rather than repeated. The answer may still word it differently, leave part of it out or leave out its rating, which this line states; open the detail to read the finding in full.',
                        )
                  }
                >
                  {t('seeMarkerInTheAnswer', 'See {{markers}} in the answer', {
                    markers: (compactWarnings.get(warning) ?? []).map((index) => `[${index}]`).join(', '),
                  })}
                </span>
              )}{' '}
              <button
                type="button"
                className={styles.detailsToggle}
                aria-expanded={!collapsed}
                onClick={() => toggleWarning(warning)}
              >
                {collapsed ? t('showDetails', 'Show details') : t('hideDetails', 'Hide details')}
              </button>
            </>
          )}
          {/* A contraindication's words are the same whether the patient takes this drug or a
            question proposed it ("The patient has a recorded allergy to Lidocaine."), so this key is
            the only thing saying she is already on a drug her records contraindicate — named by her
            own order, never by `drug`. Not on an interaction chip, whose words already say "active
            order", and not behind the other-medications line, which already says it. Only `true` is
            drawn: `false` does not say the patient is off the drug. */}
          {(() => {
            if (
              warning.aboutACurrentMedication !== true ||
              warning.type !== 'contraindication' ||
              warning.aboutAnotherOfHerMedications === true
            ) {
              return null;
            }
            const orders = (Array.isArray(warning.currentMedicationOrders) ? warning.currentMedicationOrders : [])
              .map((order) => (typeof order?.orderDisplay === 'string' ? order.orderDisplay.trim() : ''))
              .filter(Boolean);
            return (
              <>
                {' '}
                <span
                  className={styles.currentMedicationTag}
                  title={t(
                    'alreadyPrescribedTitle',
                    'The patient has an active order for this drug, so this finding is about a medication already prescribed, not one being proposed. The drug shown is the substance the module matched that order to, which the order itself may name differently — a brand name, for example.',
                  )}
                >
                  {orders.length > 0
                    ? t('alreadyPrescribedOrders', 'Already prescribed: {{orders}}', { orders: orders.join(', ') })
                    : t('alreadyPrescribed', 'Already prescribed')}
                </span>
              </>
            );
          })()}
          {/* The chip's words are also the same whether the chart holds this drug only as
            an ended order or a question proposed it. A mark of its own, not the tag
            above: the backend keeps the two referents apart. Only `true` is drawn —
            `false` does not say the drug is current. */}
          {warning.aboutAnEndedOrder === true && (
            <>
              {' '}
              <span
                className={styles.endedOrderTag}
                title={endedOn ? `${endedOrderTitle} ${utcDayTitle}` : endedOrderTitle}
              >
                {endedOn
                  ? t('aboutAnEndedOrderOn', 'About an order no longer in force, ended {{stopDate}}', {
                      stopDate: endedOn,
                    })
                  : t('aboutAnEndedOrder', 'About an order no longer in force')}
              </span>
            </>
          )}
        </span>
      </span>
    );
  };

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
            <MarkdownAnswer
              answer={answer}
              references={references}
              patientUuid={patientUuid}
              decorations={{ misattributed, severities, qualified }}
            />
          )}
          {isLoading && <InlineLoading className={styles.streamingIndicator} />}
        </div>
      )}
      {sections && (
        <div className={styles.answerSection}>
          <ConfidenceSection
            label={t('answerSection', 'Answer')}
            body={sections.answerBody}
            decorations={{ misattributed, severities, qualified }}
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
                  <div className={styles.ctitle}>{t('inDepthSection', 'In Depth')}</div>
                  {inDepth.answer ? (
                    <div className={styles.ans}>
                      <MarkdownAnswer answer={inDepth.answer} references={references} patientUuid={patientUuid} />
                    </div>
                  ) : (
                    <InlineLoading
                      className={styles.streamingIndicator}
                      description={t('preparingInDepth', 'Preparing in-depth...')}
                    />
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
                    label={t('inDepthSection', 'In Depth')}
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
              label={t('inDepthSection', 'In Depth')}
              body={sections.inDepthBody}
              section={confidence?.in_depth}
              references={references}
              patientUuid={patientUuid}
            />
          )}
        </div>
      )}

      {/* An order the answer says has ended that no record it was built from says so (backend ADR
              Decision 135). Said under the answer rather than inside it: the key names drugs, not the
              sentence, and a second reading of which sentence claims which drug is the backend's to make.
              Only a non-empty list of names is drawn, and never while streaming. */}
      {(() => {
        if (isLoading || !Array.isArray(unsupportedEndedOrderClaims)) return null;
        const drugs = unsupportedEndedOrderClaims.filter(
          (name): name is string => typeof name === 'string' && name.trim().length > 0,
        );
        if (drugs.length === 0) return null;
        return (
          <div className={styles.answerSection}>
            <p
              className={styles.unsupportedClaimNote}
              title={t(
                'unsupportedEndedOrderClaimTitle',
                'The answer says this order is no longer in force, but none of the records the answer was built from marks it that way. Check the patient’s medication list before relying on it.',
              )}
            >
              {t(
                'unsupportedEndedOrderClaim',
                'No record says the {{drugs}} order has ended — the answer states it without one.',
                {
                  drugs: drugs.join(', '),
                  count: drugs.length,
                  defaultValue_other:
                    'No record says the {{drugs}} orders have ended — the answer states it without one.',
                },
              )}
            </p>
          </div>
        );
      })()}

      {(isTerminal(phase) || Boolean(inDepth)) &&
        blocks?.map((block, idx) =>
          block.kind === 'table' ? (
            <AiTableBlockView
              key={`block-${idx}`}
              block={block}
              references={references}
              patientUuid={patientUuid}
              decorations={{ misattributed, severities, qualified }}
            />
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
              const isMisattributed = misattributed.has(ref.index);
              const url = buildReferenceUrl(ref, patientUuid, isMisattributed);
              const referenceData = isReferenceData(ref);
              const typeLabel = referenceData ? referenceLabel(ref, t) : ref.resourceType;
              // Only append the date when there is one — an allergy and a safety finding carry
              // none, and "— null" was reaching the screen.
              const label = `[${ref.index}] ${typeLabel}${ref.date ? ` — ${ref.date}` : ''}`;
              const g = referenceData ? referenceTag(ref, t) : groundedTag(ref, t);
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
              // Where the cited record's content came from, on hover over the citation itself:
              // provenance a clinician may want, not a line every drug-reference citation needs.
              // Keyed on the value, never the group: a reference-group record may carry none, and
              // the module's own finding does not.
              const source = typeof ref.source === 'string' && ref.source.trim() ? ref.source.trim() : null;
              const sourceTitle = source ? t('referenceSourceHover', 'Source: {{source}}', { source }) : undefined;
              const link = url ? (
                <a
                  className={styles.referenceTag}
                  href={url}
                  title={sourceTitle}
                  onClick={(e) => handleReferenceNavigate(e, url, ref)}
                >
                  {label}
                </a>
              ) : (
                <span
                  className={isMisattributed ? styles.referenceTagMisattributed : styles.referenceTagInert}
                  title={sourceTitle}
                >
                  {label}
                </span>
              );
              const stopDate = stopDates.get(ref.index);
              const sourceOf = attachedForOf(ref, citedFindings);
              return (
                <span key={ref.index} className={styles.referenceItem}>
                  {(ref.sourceText ?? '').trim() && (
                    <code className={styles.referenceTagInert}>
                      {[`[${ref.index}]`, ref.sourceId, ref.resolutionStatus, ref.groundingStatus]
                        .filter(Boolean)
                        .join(' · ')}
                    </code>
                  )}
                  {link}
                  {/* When this cited prescription stopped: the answer can say an order ended
                      without saying when. Beside the record's own date, never in its place — the
                      two are different facts. No entry draws nothing, and is no claim the order
                      is current. */}
                  {stopDate && (
                    <span
                      className={styles.orderStopDateTag}
                      title={`${t('orderStopDateTitle', 'The date this prescription stopped being in force — not the record’s own date shown beside it.')} ${utcDayTitle}`}
                    >
                      {t('orderStopDate', 'Stopped {{stopDate}}', { stopDate })}
                    </span>
                  )}
                  {/* withheldInteractions is not drawn: the partners a drug-reference record leaves out
                      are mostly drugs this patient is not on, and the safety check reads every one of
                      them regardless, so a count here read as an incomplete check that was not. */}
                  {isMisattributed && (
                    <span className={styles.misattributedTag} title={misattributedTitle(t)}>
                      {t('notTheOrderNamed', 'Not the order named')}
                    </span>
                  )}
                  {/* An attached citation IS the chart record a cited safety finding fired on — the
                      recorded allergy or condition whose match raised it — so the answer's prose
                      carries no [N] marker for it, and this chip is the only place it appears. The
                      tag says what the record is to the answer: the source of the cited findings it
                      backs (`attachedFor`), never who attached it, which a clinician cannot act on.
                      Nothing where the response names no finding for it. */}
                  {sourceOf.length > 0 && (
                    <span
                      className={styles.attachedTag}
                      title={t(
                        'sourceOfFindingsTitle',
                        'The chart record the cited safety finding is based on. The answer has no marker for it, since it cites the finding; opening it goes to the record.',
                      )}
                    >
                      {t('sourceOfFindings', 'source of {{citations}}', {
                        citations: sourceOf.map((index) => `[${index}]`).join(', '),
                      })}
                    </span>
                  )}
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
              <EvidenceCard
                key={`evidence-${ref.index}`}
                refItem={ref}
                patientUuid={patientUuid}
                t={t}
                decorations={{ misattributed, severities, qualified }}
              />
            ))}
          </div>
          {overflowEvidence.length > 0 && (
            <details className={styles.evidenceMore}>
              <summary>{t('showAllEvidence', 'show all evidence')}</summary>
              <div className={styles.evidenceGrid}>
                {overflowEvidence.map((ref) => (
                  <EvidenceCard
                    key={`evidence-more-${ref.index}`}
                    refItem={ref}
                    patientUuid={patientUuid}
                    t={t}
                    decorations={{ misattributed, severities, qualified }}
                  />
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {(shownSafetyWarnings.length > 0 || (effectiveStatus && effectiveStatus !== 'checked') || hasSafetyDetails) && (
        // No live-region role: the panel already sits inside the chat history's
        // role="log" aria-live="polite", which announces this content in order. An
        // assertive role="alert" here would preempt the answer it annotates.
        // Red only where the box holds a finding about the drug in question. A box holding nothing
        // but chips about her OTHER medications (backend aboutAnotherOfHerMedications) is drawn
        // neutral: those findings are real, and one click away, but not a warning about what was asked.
        <div
          data-testid="ai-response-safety"
          className={
            mainWarnings.length === 0
              ? `${styles.safetyWarningsSection} ${styles.safetyWarningsSectionNeutral}`
              : `${styles.safetyWarningsSection} ${styles.safetyWarnings_flagged}`
          }
        >
          <span className={styles.safetyWarningsLabel}>
            {t('safetyChecks', 'Answer safety check')}:
            {statusTag && (
              <Tag type={statusTag.tagType} size="sm">
                {statusTag.label}
              </Tag>
            )}
            {safetyBoxCollapsible && (
              <>
                {' '}
                <span className={styles.safetyWarningsSummary}>
                  {t('safetyChecksCitedInTheAnswer', '{{count}} finding, cited in the answer', {
                    count: mainWarnings.length,
                    defaultValue_other: '{{count}} findings, each cited in the answer',
                  })}
                </span>{' '}
                <button
                  type="button"
                  className={styles.detailsToggle}
                  aria-expanded={safetyBoxOpen}
                  onClick={() => setSafetyBoxOpen((open) => !open)}
                >
                  {safetyBoxOpen
                    ? t('hideSafetyChecks', 'Hide safety checks')
                    : t('showSafetyChecks', 'Show safety checks')}
                </button>
              </>
            )}
          </span>
          {mainWarnings.length > 0 && (!safetyBoxCollapsible || safetyBoxOpen) && (
            <div className={styles.safetyWarningsList}>{mainWarnings.map(renderWarning)}</div>
          )}
          {otherWarnings.length > 0 && (
            <>
              <span className={styles.otherMedicationsLine}>
                {historyQuestion
                  ? t('historyQuestionFindings', '{{count}} finding about this patient’s medications', {
                      count: otherWarnings.length,
                      defaultValue_other: '{{count}} findings about this patient’s medications',
                    })
                  : otherWarningsAreHerMedications
                    ? t('otherMedicationFindings', '{{count}} finding about another of this patient’s medications', {
                        count: otherWarnings.length,
                        defaultValue_other: '{{count}} findings about other medications this patient takes',
                      })
                    : t('notAboutTheDrugAsked', '{{count}} finding not about the drug asked about', {
                        count: otherWarnings.length,
                        defaultValue_other: '{{count}} findings not about the drug asked about',
                      })}{' '}
                <button
                  type="button"
                  className={styles.detailsToggle}
                  aria-expanded={otherMedicationsOpen}
                  onClick={() => setOtherMedicationsOpen((open) => !open)}
                >
                  {otherMedicationsOpen ? t('hideDetails', 'Hide details') : t('showDetails', 'Show details')}
                </button>
              </span>
              {otherMedicationsOpen && (
                <div className={styles.safetyWarningsList}>{otherWarnings.map(renderWarning)}</div>
              )}
            </>
          )}
        </div>
      )}

      {hasSafetyDetails && (
        <div className={styles.safetyCheckSummary} data-testid="safety-check-summary">
          <div className={styles.safetyCheckSummaryHeading}>{t('safetyCheckDetails', 'Medication safety details')}</div>
          {issues.length > 0 && (
            <ul className={styles.safetyCheckIssueList}>
              {issues.map((issue, index) => (
                <li key={index}>{issue}</li>
              ))}
            </ul>
          )}
          {sourceRows.length > 0 && (
            <dl className={styles.safetyCheckSources}>
              {sourceRows.map(({ label, source }) => {
                const provenance = safetyPackageProvenance(source);
                return (
                  <div className={styles.safetyCheckSourceRow} key={label}>
                    <dt>{label}</dt>
                    <dd>
                      {source?.id}
                      {source?.version ? ` (${source.version})` : ''}
                      {source?.review_state ? ` - ${source.review_state.replaceAll('_', ' ')}` : ''}
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
