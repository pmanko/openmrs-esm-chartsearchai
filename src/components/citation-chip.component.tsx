import React from 'react';
import { navigate } from '@openmrs/esm-framework';
import { type AiReference } from '../api/chartsearchai';
import { highlightReference } from '../utils/highlight-reference';
import {
  citationGroupPattern,
  parseCitationIndices,
  isReferenceData,
  type ReferenceKind,
  referenceKind,
  type SeverityTone,
  severityTone,
} from '../utils/safety-disclosure';
import styles from './ai-response-panel.scss';

const RESOURCE_TYPE_TO_CHART_PAGE: Record<string, string> = {
  obs: 'Results',
  order: 'Orders',
  drug_order: 'Orders',
  // The module injects `active_drug_order` for an active order the retrieved chart carries no
  // record of, but it is the patient's own order with a real Order uuid — chart group, and
  // navigable. Without this row it lands on the default tab; the backend README names this
  // client specifically as the one missing it.
  active_drug_order: 'Orders',
  allergy: 'Allergies',
  condition: 'Conditions',
  diagnosis: 'Visits',
  // `visit` and `encounter` alongside `diagnosis`, which was already here. Without them a
  // citation of an encounter and a citation of a diagnosis FROM that encounter landed on two
  // different tabs. Measured on the live server: "Summarise her recent visits and encounters
  // and any diagnoses" returned 113 chart citations, of which encounter x45 and visit x6 fell
  // through to the default tab — 51 of 113.
  visit: 'Visits',
  encounter: 'Visits',
  program: 'Programs',
  medication_dispense: 'Medications',
};

/** Whether `ref` is a record of one of the patient's ORDERS — any type whose chart page is Orders. */
export function isOrderRecord(ref: AiReference): boolean {
  return RESOURCE_TYPE_TO_CHART_PAGE[ref.resourceType?.toLowerCase()] === 'Orders';
}

/**
 * Where a citation's chip and inline marker navigate to, or null where they must not navigate.
 *
 * Unresolved citations have no source to navigate to. Reference data (a drug-reference entry,
 * a safety finding, a drug-class note) has no chart page at all. A MISATTRIBUTED citation has
 * one that would usually mislead: the record exists but is typically not the medication order
 * the sentence
 * names, so offering it invites the clinician to read an unrelated row as the evidence.
 *
 * "Typically", not "always" — the backend documents arrangements where such a citation "is
 * correct where it sits" (one captured by a bare *and* from a neighbouring clause), which is
 * why the marker and the tag are worded as a report rather than a verdict. Suppressing only the
 * link is deliberate and is what issue #26 asks for; the grounding verdict is left untouched
 * beside it, because this key must not override the other statements about a citation.
 */
export function buildReferenceUrl(ref: AiReference, patientUuid: string, misattributed: boolean): string | null {
  if (!patientUuid || misattributed || ref.resolutionStatus === 'unresolved' || isReferenceData(ref)) {
    return null;
  }
  // Optional-chained to match `isReferenceData`, which guards the same field one call earlier:
  // a reference missing it would otherwise throw here and unmount the whole answer panel.
  const chartPage = RESOURCE_TYPE_TO_CHART_PAGE[ref.resourceType?.toLowerCase()];
  return `${window.spaBase}/patient/${patientUuid}/chart/${encodeURIComponent(chartPage ?? 'Patient Summary')}`;
}

export function handleReferenceNavigate(e: React.MouseEvent, url: string, ref: AiReference) {
  e.preventDefault();
  navigate({ to: url });
  highlightReference(ref.resourceUuid, ref.date);
}

export type Translate = (key: string, fallback: string, options?: Record<string, unknown>) => string;

/**
 * The wording for a citation whose cited record does not support the claim. One home, because
 * it is shown on two surfaces — the chip's badge and the inline marker's tooltip — and a
 * clinician hovering the same citation in both places must not be told two different things.
 */
export function notGroundedTitle(t: Translate): string {
  return t('notGroundedTitle', 'The cited record may not support this statement — verify against the chart.');
}

/**
 * The wording for a citation that cannot be the drug order its sentence names.
 *
 * Says the EVIDENCE is in doubt, and stops there. It must not read as a verdict on the finding
 * in EITHER direction: not "this warning is bogus", which the backend calls a miscarriage of
 * the same kind as badging a correct citation Unsupported; and not "the finding is unaffected",
 * which this said until it was checked against the whole contract rather than half of it.
 *
 * Both halves are in the README. The finding "is deterministic and, on the reported answer,
 * clinically correct — it is the chart evidence attached to it that is wrong". But also:
 * "Responses are reachable in which this key and its neighbours disagree, and in each the
 * neighbour may be the one that is right" — the order-currency arm fires on the chart's
 * out-of-force mark, while the chip's own `OrderService` read is taken at a different instant,
 * so a chip can say "active order X" about an order this key says the citation cannot be. The
 * backend leaves that unresolved; a tooltip that resolves it is overclaiming whichever side it
 * picks. Shared by the inline marker and the chip.
 */
export function misattributedTitle(t: Translate): string {
  return t(
    'misattributedCitationTitle',
    'The module reports that this citation may not be the medication order this sentence names, so it is not offered as a link. This is a report about the citation, not a verdict on the safety finding.',
  );
}

/**
 * What each kind of module-supplied citation IS, shown on both surfaces that carry it — the
 * inline marker's tooltip and an opened reference panel — so a clinician reading the same
 * citation in two places is never told two different things.
 *
 * Split per kind like the panel's reference-label map. One wording used to serve
 * all of them, and it was written when the predicate above matched `drug_reference` alone:
 * *"Clinical reference data — not this patient’s record."* Widening the predicate to the whole
 * `reference` group carried that sentence onto the other two unchanged, and on the measured
 * payload it lands on `[349]` — a `contraindication:Clarithromycin` finding whose text is *"The
 * patient has a recorded allergy to Clarithromycin."*, computed from her own allergy record.
 * The backend is explicit that such a finding is "computed rather than quoted from a dataset",
 * so calling it reference data is wrong about the one citation in that answer that is entirely
 * about this patient.
 *
 * This is a difference in WORDING only. Every kind still gets the same treatment the backend
 * requires of the group: no grounding verdict, no navigation target, no badge. The
 * README's "must not treat the `reference`-group types differently" is aimed at a client that
 * keys the badge, the label or the navigation on `resourceType` and drops a type into a default
 * branch — which is why this, like the label map, is a total `Record` with an explicit `other`.
 */
const REFERENCE_KIND_TITLE: Record<ReferenceKind, (t: Translate) => string> = {
  safety_finding: (t) =>
    t(
      'safetyFindingCitation',
      'The module’s own safety finding, computed from this patient’s chart — not a chart record to open.',
    ),
  drug_reference: (t) => t('drugReferenceCitation', 'Clinical reference data — not this patient’s record.'),
  knowledgereference: (t) =>
    t('clinicalGuidelineCitation', 'Clinical guideline reference — not this patient’s record.'),
  drug_class_note: (t) =>
    t('drugClassNoteCitation', 'A note about a drug class the question named — not this patient’s record.'),
  // A `reference`-group type this client predates: say only what the group guarantees.
  other: (t) => t('referenceMaterialCitation', 'Module-supplied reference material — not this patient’s record.'),
};

export function referenceTitle(ref: AiReference, t: Translate): string {
  return REFERENCE_KIND_TITLE[referenceKind(ref)](t);
}

/**
 * The class carrying a rating's colour. An unrecognised word a dataset supplied gets the
 * neutral treatment — colouring it as a tier would assert a ranking the dataset never stated.
 */
const SEVERITY_TONE_CLASS: Record<SeverityTone, string> = {
  major: styles.severityMajor,
  moderate: styles.severityModerate,
  minor: styles.severityMinor,
  // `Unknown` is the LOWEST of the four ratings the module recognises; *unrated* it sorts ABOVE
  // all four. They are opposite ends of one ranking, so they cannot share a treatment — one
  // grey for both would tell a clinician an operator's unrated rule and a DDInter `Unknown`
  // rank equally.
  unknown: styles.severityUnknown,
  unrated: styles.severityUnrated,
};

export interface CitationContext {
  references: AiReference[];
  misattributed: Set<number>;
  /** Citation index → the rating the answer never stated, for the ones that could be resolved. */
  severities: Map<number, string>;
  /** The citation indexes whose finding's unknown-significance caveat the answer left out. */
  qualified: Set<number>;
  patientUuid: string;
  t: Translate;
  badged: Set<number>;
  noted: Set<number>;
}

export function renderTextWithCitations(answer: string, ctx: CitationContext): React.ReactNode[] {
  const { references, misattributed, severities, qualified, patientUuid, t, badged, noted } = ctx;
  const refByIndex = new Map(references.map((r) => [r.index, r]));
  const parts: React.ReactNode[] = [];
  const pattern = citationGroupPattern();
  // A rating belongs to a finding, not to a marker, and the model routinely repeats a finding's
  // marker within one statement — so badge each index at most once per answer.
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(answer)) !== null) {
    if (match.index > lastIndex) {
      parts.push(answer.slice(lastIndex, match.index));
    }
    const matchIndex = match.index;
    const citIndices = parseCitationIndices(match[1]);
    parts.push('[');
    citIndices.forEach((citIndex, i) => {
      const ref = refByIndex.get(citIndex);
      const isMisattributed = misattributed.has(citIndex);
      const url = ref ? buildReferenceUrl(ref, patientUuid, isMisattributed) : null;
      const ungrounded = ref?.grounded === false;
      const referenceData = ref ? isReferenceData(ref) : false;
      const citKey = `cit-${matchIndex}-${i}-${citIndex}`;
      parts.push(
        isMisattributed ? (
          // Struck through and NOT a link: the number stays readable so the chip below can be
          // found, but there is nowhere useful to go. Amber rather than red — this is unreliable
          // evidence, not a refuted claim.
          //
          // The two checks are independent and both can fire on one citation, so this must sit
          // BESIDE the grounding verdict rather than over it: the ⚠ is kept for an ungrounded
          // one, because the reference chip below shows its "Unsupported" badge either way and
          // a marker that hid it would make the panel contradict itself.
          <span
            key={citKey}
            className={
              ungrounded
                ? `${styles.inlineCitation} ${styles.inlineCitationMisattributed} ${styles.inlineCitationUngrounded}`
                : `${styles.inlineCitation} ${styles.inlineCitationMisattributed}`
            }
            title={ungrounded ? `${misattributedTitle(t)} ${notGroundedTitle(t)}` : misattributedTitle(t)}
          >
            {ungrounded ? `${citIndex} ⚠` : citIndex}
          </span>
        ) : url && ref ? (
          <a
            key={citKey}
            className={
              ungrounded ? `${styles.inlineCitation} ${styles.inlineCitationUngrounded}` : styles.inlineCitation
            }
            href={url}
            title={ungrounded ? notGroundedTitle(t) : undefined}
            onClick={(e) => handleReferenceNavigate(e, url, ref)}
          >
            {ungrounded ? `${citIndex} ⚠` : citIndex}
          </a>
        ) : referenceData ? (
          <span
            key={citKey}
            className={`${styles.inlineCitation} ${styles.inlineCitationReference}`}
            title={ref ? referenceTitle(ref, t) : undefined}
          >
            {citIndex}
          </span>
        ) : (
          `${citIndex}`
        ),
      );
      if (i < citIndices.length - 1) {
        parts.push(', ');
      }
    });
    parts.push(']');

    // The rating for any finding cited here that the answer states nowhere, immediately after
    // the marker group — beside the sentence it belongs to, so a flat list of five findings can
    // be ranked in one pass instead of reading as five equals.
    //
    // One badge per unbadged index, in the group's own index order. No de-duplication by rating:
    // the resolver refuses to elect one finding for two citations of the same set, so two badges
    // in one group are two DIFFERENT findings — and collapsing equal ratings would then hide
    // that there are two. (The "Major Major" case that once motivated a dedupe is now refused
    // outright, one level down.)
    const groupRatings: string[] = [];
    citIndices.forEach((citIndex) => {
      const severity = severities.get(citIndex);
      if (!severity || badged.has(citIndex)) return;
      badged.add(citIndex);
      groupRatings.push(severity);
    });
    groupRatings.forEach((severity, group) => {
      // A real space, not just the tag's margin: without it the paragraph's text content reads
      // "[350]Major", which is what a screen reader announces and what any text extraction gets.
      parts.push(' ');
      parts.push(
        <span
          key={`sev-${matchIndex}-${group}`}
          className={`${styles.severityTag} ${SEVERITY_TONE_CLASS[severityTone(severity)]}`}
          title={t(
            'unstatedSeverityTitle',
            'Rated by the reference dataset. This answer may not state the rating — it is shown here so the findings can be ranked.',
          )}
        >
          {severity}
        </span>,
      );
    });

    // And the finding's own caveat the answer dropped (backend ADR Decision 136), after its rating:
    // one per finding per answer, for the reason a rating is.
    citIndices.forEach((citIndex) => {
      if (!qualified.has(citIndex) || noted.has(citIndex)) return;
      noted.add(citIndex);
      parts.push(' ');
      parts.push(
        <span
          key={`sig-${matchIndex}-${citIndex}`}
          className={styles.significanceTag}
          title={t(
            'significanceUnknownTitle',
            'The finding this cites says the clinical significance of the interaction is unknown. The answer leaves that out.',
          )}
        >
          {t('significanceUnknown', 'Clinical significance unknown')}
        </span>,
      );
    });

    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < answer.length) {
    parts.push(answer.slice(lastIndex));
  }
  return parts;
}
