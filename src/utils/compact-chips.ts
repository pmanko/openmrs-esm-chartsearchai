import type { AiAnswerLimits, AiReference, AiSafetyWarning } from '../api/chartsearchai';
import { citationGroupPattern, parseCitationIndices } from './safety-disclosure';

/**
 * The `resourceUuid` the backend gives a safety finding's citable record: its chip's `type` and
 * `drug` joined by a colon (`interaction:Acetylsalicylic acid (aspirin)`), written by
 * `ChartSearchAiUtils.resourceKey` in openmrs-module-chartsearchai. Several findings of one type
 * about one drug share it, which is why {@link compactChips} refuses a key two chips carry.
 */
function findingKey(warning: AiSafetyWarning): string {
  return `${warning.type}:${warning.drug}`;
}

/** An answer-limit list that was measured and named nothing. `null` or absent is no measurement. */
function measuredEmpty(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

/** A list that was measured, empty or not. `null` or absent is no measurement. */
function measured(value: unknown): boolean {
  return Array.isArray(value);
}

/**
 * Whether the checks whose report names no finding — order citations that cannot be the order
 * named, and "interacts with active order" claims the findings do not relate — were stated and
 * reported nothing. One of them reporting something, or stating no measurement, keeps every chip in
 * full: it says something is wrong with the answer without saying which finding, so no chip can be
 * cleared.
 */
function noAnswerWideCheckFired(limits: AiAnswerLimits): boolean {
  const pairs = limits.interactionClaimPairs;
  return (
    pairs != null &&
    typeof pairs === 'object' &&
    pairs.unfounded === 0 &&
    measuredEmpty(pairs.misattributedCitations) &&
    measuredEmpty(limits.misattributedOrderCitations)
  );
}

/**
 * The findings a per-finding check named — a rendering unfaithful to its record, a rating the
 * answer attached that the record does not state, a caution lead beside a finding that withholds —
 * whose chips stay in full, the full chip being the backstop for an answer that softened or
 * misstated that finding. `null` where any of these checks, or the unstated-severity one, stated no
 * measurement, which keeps every chip in full.
 *
 * A rating the answer left UNSTATED (`unstatedFindingSeverities`) does not keep its chip open: the
 * one-line chip states that rating, which is what the answer left out.
 */
function findingsACheckNamed(limits: AiAnswerLimits): Set<number> | null {
  if (
    !measured(limits.unstatedFindingSeverities) ||
    !measured(limits.unfoundedFindingSeverities) ||
    !measured(limits.unfaithfullyRenderedCitations) ||
    !measured(limits.cautionLedOverWithholding)
  ) {
    return null;
  }
  const named = new Set<number>(limits.unfaithfullyRenderedCitations as number[]);
  for (const finding of [...(limits.unfoundedFindingSeverities ?? []), ...(limits.cautionLedOverWithholding ?? [])]) {
    if (finding && typeof finding.citation === 'number') named.add(finding.citation);
  }
  return named;
}

/**
 * The finding records the answer's own markers cite, by key: a `safety_finding` reference the
 * answer marks inline. One reading for {@link compactChips} and {@link notInTheAnswer}, so a chip
 * cannot be both cited and not.
 */
function citedFindingRecords(answer: string, references: AiReference[]): Map<string, number[]> {
  const cited = new Set<number>();
  for (const match of answer.matchAll(citationGroupPattern())) {
    for (const index of parseCitationIndices(match[1])) cited.add(index);
  }
  const records = new Map<string, number[]>();
  for (const ref of references) {
    if (ref?.resourceType !== 'safety_finding' || !cited.has(ref.index)) continue;
    records.set(ref.resourceUuid, [...(records.get(ref.resourceUuid) ?? []), ref.index]);
  }
  return records;
}

/**
 * The positions in `warnings` of chips the answer cites that the answer reworded and nothing else
 * flagged: the chip names its own record, the answer cites it, `unfaithfullyRenderedCitations`
 * names it, and no other per-finding check nor any answer-wide one does. The panel draws such a
 * chip on one line tagged as reworded, the record's own words one click away, rather than in full
 * beside the reworded prose. Its markers are the ones the answer cites it at.
 */
export function rewordedInTheAnswer(
  answer: string,
  references: AiReference[],
  warnings: AiSafetyWarning[],
  limits: AiAnswerLimits,
): Map<number, number[]> {
  const reworded = new Map<number, number[]>();
  if (!answer || !Array.isArray(references) || !Array.isArray(warnings) || !noAnswerWideCheckFired(limits)) {
    return reworded;
  }
  const unfaithful = new Set<number>(
    Array.isArray(limits.unfaithfullyRenderedCitations) ? limits.unfaithfullyRenderedCitations : [],
  );
  const otherwiseNamed = new Set<number>();
  for (const finding of [...(limits.unfoundedFindingSeverities ?? []), ...(limits.cautionLedOverWithholding ?? [])]) {
    if (finding && typeof finding.citation === 'number') otherwiseNamed.add(finding.citation);
  }
  const cited = new Set<number>([...citedFindingRecords(answer, references).values()].flat());
  warnings.forEach((warning, position) => {
    const own = warning?.findingCitation;
    if (typeof own === 'number' && cited.has(own) && unfaithful.has(own) && !otherwiseNamed.has(own)) {
      reworded.set(position, [own]);
    }
  });
  return reworded;
}

/**
 * The positions in `warnings` of chips the answer does not cite that are about the drug proposed
 * against a drug the question only LISTS — an interaction naming no order of hers (`namedPartners`
 * empty: a finding relating two drugs the question names) whose subject is not one of her
 * prescriptions (`aboutAnotherOfHerMedications`). Such a finding rests on what the question names
 * rather than on her orders, so the panel draws it on one line marked as not in the answer, its
 * detail behind a toggle. A finding against one of her own orders the answer leaves out is never
 * one of these: that is the finding a clinician must not have to go looking for.
 */
export function notInTheAnswer(answer: string, references: AiReference[], warnings: AiSafetyWarning[]): Set<number> {
  const positions = new Set<number>();
  if (!answer || !Array.isArray(references) || !Array.isArray(warnings)) return positions;
  const cited = new Set<number>([...citedFindingRecords(answer, references).values()].flat());
  warnings.forEach((warning, position) => {
    if (
      warning?.type === 'interaction' &&
      Array.isArray(warning.namedPartners) &&
      warning.namedPartners.length === 0 &&
      warning.aboutAnotherOfHerMedications !== true &&
      typeof warning.findingCitation === 'number' &&
      !cited.has(warning.findingCitation)
    ) {
      positions.add(position);
    }
  });
  return positions;
}

/**
 * The positions in `warnings` whose chip the answer already carries, so the panel can draw it on
 * one line with its detail behind a toggle instead of repeating the answer's paragraph beside it.
 *
 * A chip qualifies only where all three hold, and anything short of proof leaves it in full:
 * - the answer's own inline markers cite the finding's record (a `safety_finding` reference whose
 *   `resourceUuid` is the chip's key) — the one link from prose to chip the wire carries;
 * - where the chip names its own record (`findingCitation`), the answer cites that record;
 *   otherwise every chip carrying that key is covered: the answer cites at least as many DISTINCT
 *   findings of the key as there are chips carrying it. Each finding record the prompt carried
 *   becomes a chip, and the chips pass can only add chips, so per key cited records <= records <=
 *   chips; where the cited ones are as many as the chips, all three are equal and no chip of the
 *   key is uncited. Short of that, a citation of a shared key cannot say which chip it states, and
 *   none of them qualifies;
 * - the checks clear it: every answer-wide check ({@link noAnswerWideCheckFired}) reported nothing,
 *   and no per-finding check named this chip's finding ({@link findingsACheckNamed}) — except on an
 *   answer the module wrote (`answeredByTheModule: true`), which states each finding from the chip
 *   itself, so those checks of a model's prose have nothing to judge and state `null` (backend ADR
 *   Decision 140). The two citation conditions above still hold there.
 *
 * It does not claim the answer states the chip's WORDS: the answer may paraphrase or drop a
 * sentence, which is why the collapsed chip still opens to its full detail.
 *
 * @returns each qualifying position, mapped to the citation indexes in the answer that cite its
 * finding, ascending — where a clinician reads what the chip no longer repeats. For a shared key
 * that is every cited index of the key, since which of them is this chip's cannot be told.
 */
export function compactChips(
  answer: string,
  references: AiReference[],
  warnings: AiSafetyWarning[],
  limits: AiAnswerLimits,
): Map<number, number[]> {
  const compact = new Map<number, number[]>();
  // An answer the module wrote states each finding from the chip itself, so the checks of a model's
  // prose have
  // nothing to judge (backend ADR Decision 140).
  const named =
    limits.answeredByTheModule === true
      ? new Set<number>()
      : noAnswerWideCheckFired(limits)
        ? findingsACheckNamed(limits)
        : null;
  if (!answer || !Array.isArray(references) || !Array.isArray(warnings)) {
    return compact;
  }
  // A finding the module's own sentence after the answer states (backend ADR Decision 147) is drawn
  // as stated, its marker list empty: that sentence cites none, and it is the module's words, which
  // no check of the model's prose judges.
  const stated = new Set<number>(
    Array.isArray(limits.findingsStatedByTheModule) ? limits.findingsStatedByTheModule : [],
  );
  warnings.forEach((warning, position) => {
    const own = warning?.findingCitation;
    if (typeof own === 'number' && stated.has(own)) compact.set(position, []);
  });
  if (named === null) {
    return compact;
  }
  const citedFindingIndexes = citedFindingRecords(answer, references);
  const keyCounts = new Map<string, number>();
  for (const warning of warnings) {
    if (!warning) continue;
    keyCounts.set(findingKey(warning), (keyCounts.get(findingKey(warning)) ?? 0) + 1);
  }
  const citedFindings = new Set<number>([...citedFindingIndexes.values()].flat());
  warnings.forEach((warning, position) => {
    if (!warning || typeof warning.type !== 'string' || typeof warning.drug !== 'string') return;
    // Where the backend names the chip's own record (findingCitation, ADR Decision 138), that is
    // the join:
    // the chip qualifies exactly where the answer cites that record, and its tag names that one
    // marker.
    if (compact.has(position)) return;
    const own = warning.findingCitation;
    if (typeof own === 'number' && Number.isInteger(own)) {
      if (citedFindings.has(own) && !named.has(own)) compact.set(position, [own]);
      return;
    }
    const key = findingKey(warning);
    const indexes = citedFindingIndexes.get(key);
    if (
      indexes &&
      !indexes.some((index) => named.has(index)) &&
      new Set(indexes).size >= (keyCounts.get(key) ?? Infinity)
    )
      compact.set(
        position,
        [...indexes].sort((a, b) => a - b),
      );
  });
  return compact;
}
