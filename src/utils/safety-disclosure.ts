import type { AiReference, AiSafetyWarning } from '../api/chartsearchai';

/**
 * Resource types the backend classifies as module-supplied reference material rather than as
 * the patient's own record. Either signal suffices in {@link isReferenceData}: a response
 * predating the `group` field is recognised by its type, and a `reference`-group type added
 * later is recognised by its group without this list changing.
 *
 * `active_drug_order` is deliberately absent — the module injects it, but it is the patient's
 * own order carrying a real `Order` uuid, so it groups as `chart` and navigates.
 */
export const REFERENCE_RESOURCE_TYPES = [
  'drug_reference',
  'knowledgereference',
  'safety_finding',
  'drug_class_note',
] as const;
const REFERENCE_RESOURCE_TYPE_SET: ReadonlySet<string> = new Set(REFERENCE_RESOURCE_TYPES);

/**
 * Whether a citation points at module-supplied reference material (a drug-reference entry, a
 * safety finding, a drug-class note) rather than at a record in this patient's chart.
 *
 * Such a citation has no chart page to navigate to, so it must not be rendered as a link:
 * before this predicate existed only `drug_reference` was recognised, and a `safety_finding`
 * citation linked to Patient Summary and then tried to highlight a row keyed on a synthetic
 * uuid like `interaction:Clarithromycin` — a link that could never land anywhere.
 */
export function isReferenceData(ref: AiReference): boolean {
  return (
    ref.group === 'reference' ||
    (typeof ref.resourceType === 'string' && REFERENCE_RESOURCE_TYPE_SET.has(ref.resourceType.toLowerCase()))
  );
}

/**
 * Which kind of reference material a citation is, for labelling. DERIVED from the list above
 * rather than restated, so adding a type there is a compile error at every `ReferenceKind`
 * switch until it is labelled — the previous shape spelled the union out and bridged the two
 * with an `as`, which would have classified a new type and then labelled it "Reference
 * material" with no error anywhere.
 */
export type ReferenceKind = (typeof REFERENCE_RESOURCE_TYPES)[number] | 'other';

/**
 * Classifies a reference-group citation off the same list {@link isReferenceData} uses.
 * `other` is reachable and must be labelled neutrally: the predicate admits any citation whose
 * `group` is `reference`, including a type this client predates.
 */
export function referenceKind(ref: AiReference): ReferenceKind {
  const resourceType = typeof ref.resourceType === 'string' ? ref.resourceType.toLowerCase() : undefined;
  return REFERENCE_RESOURCE_TYPES.find((known) => known === resourceType) ?? 'other';
}

/** The severity words the module itself recognises. Anything else a dataset supplies is *unrated*. */
export type SeverityTone = 'major' | 'moderate' | 'minor' | 'unknown' | 'unrated';

/**
 * Classifies a dataset's rating for styling only.
 *
 * `severity` is not a closed vocabulary — an operator's dataset supplies its own words — so an
 * unrecognised value maps to `unrated`. It must NOT be coerced to a tier: the module ranks its
 * four recognised words `Unknown` < `Minor` < `Moderate` < `Major` and then sorts *unrated
 * above all four*, so `unknown` and `unrated` sit at opposite ends and cannot share a
 * treatment. The rating is always displayed verbatim; only the emphasis comes from this.
 */
export function severityTone(severity: string): SeverityTone {
  // `severity` is documented as null for a contraindication, an overdose and a class join, so a
  // second call site would crash on the value the wire states most often. The one call site today
  // feeds a value the resolver already type-guarded; this makes that not a precondition.
  if (typeof severity !== 'string') return 'unrated';
  switch (severity.trim().toLowerCase()) {
    case 'major':
      return 'major';
    case 'moderate':
      return 'moderate';
    case 'minor':
      return 'minor';
    case 'unknown':
      return 'unknown';
    default:
      return 'unrated';
  }
}

const CITATION_GROUP_SOURCE = String.raw`\[(\d+(?:\s*,\s*\d+)*)\]`;

/**
 * A fresh matcher for one citation marker group (`[3]`, `[1, 2]`), capturing its index list.
 *
 * A factory rather than a shared constant, defensively: the answer renderer drives it with
 * `exec`, which parks `lastIndex` mid-string if a caller ever stops early. Nothing does today —
 * `matchAll` clones per spec, and the `exec` loop runs to completion, which resets it — so
 * sharing one instance would currently pass every test. That is why the freshness property is
 * asserted directly rather than left to a behavioural test that cannot see it.
 * One source string so the resolver and the renderer cannot recognise different markers — if
 * they diverge, the renderer draws markers the resolver can no longer key a rating to, and
 * ratings vanish from an answer that still looks complete.
 */
export function citationGroupPattern(): RegExp {
  return new RegExp(CITATION_GROUP_SOURCE, 'g');
}

/**
 * A fresh matcher for a citation marker group plus any single space before it, for stripping
 * markers out of prose.
 *
 * Shares {@link citationGroupPattern}'s one source string, so a change to marker syntax cannot
 * reach the renderer and the resolver while leaving the strippers behind — which would leak raw
 * `[350]` markers into the clipboard text and the reasoning preview. The behavioural difference
 * the two call sites DO have is whether they trim the result, and that stays at the call sites.
 */
export function citationStripPattern(): RegExp {
  return new RegExp(`\\s?${CITATION_GROUP_SOURCE}`, 'g');
}

/** Splits a marker group's captured index list (`"1, 2"`) into numbers. */
export function parseCitationIndices(group: string): number[] {
  return group.split(/\s*,\s*/).map(Number);
}

// -----------------------------------------------------------------------------------------------
// WHY THIS FILE EXISTS, AND WHAT WOULD DELETE IT.
//
// The backend publishes `unstatedFindingSeverities` as a list of citation indices and publishes
// the ratings on `safetyWarnings[]`, with no key joining the two: a chip carries no citation index
// and `(type, drug)` does not identify one, because a single screening question raises several
// findings sharing it — five on the demo chart, all `(interaction, Clarithromycin)`. So everything
// below reconstructs that join from the model's prose and refuses wherever the reading is
// ambiguous.
//
// The backend already HAS the join. `SafetyFindingSeverityFidelityCheck` builds a
// `Map<citation index, rating>` in order to decide what to publish, and then publishes the key set
// while dropping the values. Publishing them per citation is filed as
// openmrs-module-chartsearchai#387, and that is the change that lets this file be DELETED rather
// than maintained — every refusal below, and the 18 ratings they cost, exists only because the
// values are dropped on the wire. Read that issue before extending anything here; a new rule is
// worth adding only if it is worth adding to code with a known exit.
// -----------------------------------------------------------------------------------------------

// -----------------------------------------------------------------------------------------------
// THE CORPUS. Named once because notes throughout this file quote it and several had drifted —
// 94 where others said 98, and separately a 62-answer and a 40-answer count for the same phrase.
//
// "The live corpus" always means: 46 answers captured from a running server against the demo
// chart, of which 22 carry an `unstatedFindingSeverities` measurement this module resolves. It
// renders 80 ratings today across 18 of those answers, down from 98 before the two
// leftover-subject rules — 13 for the tail rule and 5 for the head rule's loss of its exemption.
// All 85 that stood at the tail-rule stage were read against the sentence each was drawn from
// and were correct; today's 80 are a subset of those. It briefly read 82: the stated-rating rule
// was first built as a candidate FILTER, which recovered two correct ratings here and was then
// found to manufacture a swapped pair elsewhere, so it became an objection and these two went
// back to blanks — the only ratings this module has ever recovered, given up on purpose. This
// number has drifted twice, once per cycle that changed a refusal, so re-measure it rather than
// quoting it. It is
// replayed on every change, and a byte-identical result is the regression bar. It is NOT in the
// repo — it lives in a scratch directory — so a measurement quoted against it cannot be re-run
// from a clean checkout.
// Where one of its answers decides a design choice, that answer is committed as a fixture
// instead: ANSWER_TWO_FAMILIES, ANSWER_MECHANISM_CLAUSES and ANSWER_RESTATED_SUBJECT are those.
//
// This was a javadoc block and so was silently documenting `normalize` below it — a
// whitespace-collapsing helper described as the answer corpus, the fifth insertion-orphan of
// that kind in this file. A `//` block cannot attach to a declaration.
// -----------------------------------------------------------------------------------------------

/** Collapses whitespace and lowercases, so every lead and claim is compared in one shape. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * {@link normalize}, but keeping LINE breaks — collapsing only horizontal whitespace.
 *
 * Exists so {@link stripExclusions} can see the line structure {@link EXCLUDED_NAME} is written
 * against. That pattern bounds an excluded name with `[^\S\n]`, horizontal-only, precisely so a
 * name cannot cross a line — and the guard was INERT for as long as it existed, because every
 * call site handed it `normalize` output and `normalize` had already turned every newline into a
 * space. A guard that cannot fire reads in review exactly like one that can.
 *
 * Measured, with the guard live again: *"Apart from dose timing\nSolu-Medrol 125mg/5ml, her worst
 * order\n…The rise is above what Prednisone Co 5mg gives [350]"* stopped deleting Solu-Medrol —
 * the marker's own subject, which the clause never excluded — out of the head, and stopped
 * rendering Prednisone's MODERATE for a MAJOR finding.
 */
function normalizeKeepingLines(text: string): string {
  return text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n[^\S\n]*/g, '\n')
    .trim()
    .toLowerCase();
}

/** At most four whitespace-separated tokens — a drug name, not a clause. See {@link stripExclusions}. */
const EXCLUDED_NAME = String.raw`[^\s,;:.]+(?:[^\S\n]+[^\s,;:.]+){0,3}`;

/**
 * A comparison word list lived here for one cycle and is gone, because it could not do the job
 * it was written for and the head rule can.
 *
 * It was added for a live wrong rating — a claim whose subject sits in an earlier sentence names
 * only the drug it is compared against — and then measured: 11 of 12 plausible rephrasings still
 * rendered the wrong rating ("over", "compared with", "versus", "beyond", "in contrast to",
 * "relative to", "; X is milder", ", not X", "— X is the lesser worry", "well above", "unlike").
 * A list of words cannot decide which drug a sentence is ABOUT. Removing it now changes nothing:
 * the leaks stay closed, the corpus does not move and the suite stays green, because the head
 * rule in `resolveFindingSeverities` asks a structural question instead — is some
 * candidate the answer names left with no citation willing to claim it?
 *
 * Kept as a note rather than deleted silently: this is the second word list in this file to be
 * tried and withdrawn, and the next person reaching for a third should read both first.
 */
const EXCLUSION_CLAUSES = [
  // "apart from X," / "unlike X," / "other than X," — the excluded name FOLLOWS the marker word.
  new RegExp(
    String.raw`\b(?:apart from|aside from|other than|unlike|except for|except)[^\S\n]+${EXCLUDED_NAME}[^\S\n]*[,;:]`,
    'g',
  ),
  // "X aside," — the excluded name PRECEDES it.
  new RegExp(String.raw`\b[^\s,;:.]+(?:[^\S\n]+[^\s,;:.]+)?[^\S\n]+aside[^\S\n]*[,;:]`, 'g'),
];

/**
 * A clause that names a drug in order to EXCLUDE it, removed from an already-normalised claim.
 *
 * "Apart from Prednisone, the interacting orders are …" names Prednisone and says it is not one
 * of them. Reading that name as the claim's subject is not a near-miss: it elects the one
 * candidate the sentence rules out.
 *
 * Found by the fuzzer the moment it could write a foreign marker after the subject on a
 * marker-first line. Singly such an answer already refused — the forward reading disagreed —
 * but TWO exclusion lines in one answer scavenge from each other's preambles and produce a
 * complete, injective, wholly wrong bijection that nothing objects to:
 *
 *   "Apart from Prednisone, the interacting orders are [353] Dexamethasone
 *    Dexamethasone aside, the worry is [352] Prednisone Co 5mg [17]
 *    Consider Budesonide carefully [351]; the exposure rises."
 *
 * rendered [353] with Prednisone's rating and [352] with Dexamethasone's — a swapped pair.
 *
 * This is not a heuristic about which candidate is likelier; it is removing text that states
 * the opposite of what it was being read as. Where a claim's only candidate was named in such a
 * clause it now names none and the set refuses, and where the real subject sits outside the
 * clause the answer resolves that subject instead of refusing on a two-candidate window — so
 * this both removes wrong ratings and recovers correct ones.
 *
 * Operates on the lowercased output of {@link normalize}, which is why the patterns carry no
 * case flag.
 *
 * TWO CORRECTIONS, both of which had turned this into a source of wrong ratings rather than a
 * cure for them:
 *
 * `besides` was in the list and is not exclusive — in ordinary English "besides X" means IN
 * ADDITION TO X. "Clarithromycin will raise her Solu-Medrol levels, besides those of Prednisone
 * Co 5mg … [352]" had Prednisone stripped out, leaving Solu-Medrol as the only candidate named,
 * and rendered a Major rating where the truth was Moderate. Written with "as well as" instead
 * the same sentence correctly REFUSES, so the strip was turning a refusal into a wrong rating.
 *
 * And the span was bounded by CHARACTERS (60) rather than by tokens, with a lazy quantifier
 * that backtracks — so leftmost-match consumed the longest run it could before " aside,". Only
 * the noun immediately before "aside" is what a writer excluded. "…active order Prednisone Co
 * 5mg though dose timing aside, Solu-Medrol … [352]" had the module's own anchoring phrase for
 * Prednisone deleted, and rendered Major against a truth of Moderate. Both patterns now allow at
 * most FOUR tokens for the name, which a drug display fits ("Hydrocortisone Injection vial
 * 100mg") and a clause does not: "except Prednisone Co 5mg at her current dose," no longer
 * matches at all, so the claim keeps both names and refuses.
 *
 * EXPORTED FOR TESTS ONLY, like {@link claimTextByCitation} and for a sharper reason: the
 * property test's shifted population became VACUOUS when this function landed, because every
 * lead-in it generated used a word removed here — 0 of 20,000 shifted answers resolved anything
 * for three cycles while "150,000 seeds clean" was reported against them. The generator now
 * asserts its own population is still capable of closing a rotation, and it cannot ask that
 * question without applying this.
 */
export function stripExclusions(claim: string): string {
  let stripped = claim;
  for (const pattern of EXCLUSION_CLAUSES) stripped = stripped.replace(pattern, ' ');
  return stripped;
}

/**
 * Which way {@link claimTextByCitation} reads a marker's claim: back to the previous marker,
 * line-confined (`trailing`) or not (`block`), or forward to the next, unconfined
 * (`block-leading`).
 *
 * There is no confined-forward member. `'leading'` was one until the reading itself was proved
 * redundant — see the note beside `objectingBlockLeading` — and leaving it in the union would
 * offer a caller a reading this module has established says nothing the unconfined one does not.
 */
export type ClaimDirection = 'trailing' | 'block' | 'block-leading';

/**
 * A sentence terminator that is not a decimal point inside a dose.
 *
 * `Digoxin Elixir 0.125mg` must not read as a sentence end: it does, the window-widening below
 * stops at it, and the very truncation it exists to prevent comes back. Measured — 183
 * mis-attributions survived until this exclusion was added. Same class as the digit-inside-a-name
 * note on {@link shortOrderDisplay}.
 */
const SENTENCE_END = /(?<!\d)[.;!?]|[.;!?](?!\d)/;

/**
 * The same terminator, global, for finding the LAST break in a span rather than asking whether
 * one exists. Declared from {@link SENTENCE_END} rather than retyped so the two cannot drift —
 * a decimal-point exclusion present in one and missing in the other would show up only as a
 * window that disagrees with itself depending on which question was asked of it.
 */
const SENTENCE_END_GLOBAL = new RegExp(SENTENCE_END.source, 'g');

/**
 * Where every sentence break in the answer ENDS, ascending — computed once per reading rather
 * than per marker.
 *
 * Scanning the whole answer is equivalent to scanning each claim window on its own, and only
 * because of where the windows are cut. {@link SENTENCE_END} looks one character to each side,
 * so a window computed from a slice could see different context at its edges than the same
 * position sees in the whole string — but a trailing window starts at 0 or just past a `]` and
 * ends at a `[`, and neither is a digit, so the one exclusion those lookarounds encode cannot
 * turn on the difference. Cutting a window anywhere else would break that and this would have
 * to go back to slicing.
 */
function sentenceBreaks(answer: string): number[] {
  const breaks: number[] = [];
  for (const match of answer.matchAll(SENTENCE_END_GLOBAL)) breaks.push((match.index ?? 0) + match[0].length);
  return breaks;
}

/**
 * Where a trailing claim's window begins.
 *
 * Two things bound it, and a marker citing something OUTSIDE this measurement is neither.
 * Letting a foreign marker bound the window cuts the subject out — live, in 4 of a 62-answer
 * capture taken before THE CORPUS above was fixed at 46, so it is a different and larger
 * population; the shape it names is in the 46 too. Counted in 4
 * answers and 7 times in all: *"Solu-Medrol 125mg/5ml [17] carries more risk than Prednisone
 * does [350]"* left only the contrast partner in the window, and `[350]` elected it. The block
 * reading cannot help; on one line its window is the same one.
 *
 * What does bound it:
 *
 * 1. The nearest earlier marker that cites an index of THIS measurement (`ownEnd`, carried
 *    forward by the caller). Past that marker the text is another finding's claim, and the
 *    renderer badges each index at its own first marker, so borrowing across one would show a
 *    rating beside a sentence it was not read from.
 * 2. The last sentence break after that — a claim cannot begin before its own sentence does.
 *
 * The break is a TIGHTER bound than the marker that was previously returned in its place, and
 * that mattered: bounding at the marker left the tail of the previous sentence in the window, so
 * a partner named there was read as a second candidate for this claim and the set was refused.
 * *"Clarithromycin was reviewed [12] against Prednisone. It also interacts with Solu-Medrol
 * [350]."* resolved nothing, because Prednisone leaked across the full stop. Whichever bound
 * sits later wins, so neither can widen the window the other narrowed.
 */
function trailingWindowStart(breaks: number[], ownEnd: number, markerStart: number): number {
  // Last, not first: with several sentences in between, only the one this marker sits in is
  // this claim. `breaks` is ascending, so the last one inside `(ownEnd, markerStart]` is found by
  // bisection rather than by re-scanning the window — which is what made this quadratic in the
  // number of markers preceding the first finding citation.
  let low = 0;
  let high = breaks.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (breaks[mid] <= markerStart) low = mid + 1;
    else high = mid;
  }
  const last = breaks[low - 1];
  return last === undefined || last <= ownEnd ? ownEnd : last;
}

/**
 * The text of the claim each citation marker is attached to.
 *
 * EXPORTED FOR TESTS, and it must not become production API. Its output is ONE reading, and the
 * whole finding of this module is that one reading cannot be trusted: for any list the forward
 * reading is a rotation of the backward one, both internally consistent, and only the contest
 * between them plus {@link resolveFindingSeverities}' refusals separates them. A caller that
 * used a claim from here to attribute a rating would be doing the exact thing eleven review
 * rounds were spent stopping. `resolveFindingSeverities` is the only entry point that renders.
 *
 * A marker's claim is the prose running back to the previous marker — but adjacent markers
 * (`[177] [350]`) cite ONE claim between them, so a run of marker groups separated by nothing
 * but whitespace, a comma or a semicolon is treated as a single attachment point and they all
 * share the text before
 * the run. Without that, `[350]` in `Methylprednisolone [177] [350]` would see a claim text of
 * just `" "` and could never be resolved.
 *
 * An index cited more than once keeps its FIRST claim. Measured live, the model routinely
 * repeats a finding's marker inside its own statement — *"…interacts with active order
 * Solu-Medrol 125mg/5ml [350], a Major problem because … adrenal suppression [350]"* — where
 * the first occurrence is the statement that names the finding and the repeat trails a
 * mechanism clause. An earlier version blanked such an index to avoid attributing a rating to
 * the wrong sentence, which discarded the only evidence there was on every one of those
 * answers.
 *
 * First rather than a union of all of them, because the renderer badges an index at its first
 * marker too: the rating is then read from, and shown beside, the same sentence. A union would
 * let evidence from a later sentence justify a badge drawn against an earlier one.
 */
export function claimTextByCitation(
  answer: string,
  direction: ClaimDirection = 'trailing',
  // Undefined means "every marker bounds the window" — the conservative reading. Only
  // `resolveFindingSeverities` knows which indices this measurement is about, and only it opts
  // into widening past the others.
  ownIndices?: ReadonlySet<number>,
): Map<number, string> {
  const matches = [...answer.matchAll(citationGroupPattern())];

  const runs: Array<{ start: number; end: number; groups: RegExpMatchArray[] }> = [];
  for (const match of matches) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const open = runs[runs.length - 1];
    // Horizontal whitespace only: `\s` would let a NEWLINE merge two runs, and the second would
    // then take the FIRST marker's line — falsifying the confinement below rather than supporting
    // it.
    if (open && /^[^\S\n]*[,;]?[^\S\n]*$/.test(answer.slice(open.end, start))) {
      open.end = end;
      open.groups.push(match);
    } else {
      runs.push({ start, end, groups: [match] });
    }
  }

  const claims = new Map<number, string>();
  const breaks = direction === 'trailing' && ownIndices ? sentenceBreaks(answer) : [];
  // The end of the nearest earlier run citing an index of THIS measurement, carried forward so
  // it is not re-derived by scanning back over every earlier run.
  let lastOwnEnd = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    let claim: string;
    if (direction === 'trailing' || direction === 'block') {
      // The prose BEFORE the marker: confined to the marker's own line for `trailing`, and
      // unconfined back to the previous marker for `block`.
      //
      // The block reading exists because the line-confined one asks only whether exactly one
      // candidate is NAMED in its window, never whether the window is a statement ABOUT that
      // candidate. Where a marker's true subject sits on the item's header line and a CONTRAST
      // partner sits on the citation's own line, the confined window names only the contrast
      // partner and elects it. Live, that produced a derangement — a bijection, so completeness
      // and injectivity both held — with both Major findings badged Moderate.
      // Only the confined `trailing` window widens past a foreign marker. `block` is
      // back-to-the-previous-marker by design, and widening it or the forward windows was
      // measured to regress the live corpus hard — the one note that still quoted a 94-rating
      // baseline after the figure was consolidated. Re-stated against the corpus as THE CORPUS
      // defines it: widening these windows took it from 98 correct ratings to 74 — measured
      // BEFORE the leftover-subject rules, against the then-98 baseline. Do not read 98 here as
      // the corpus's current size — the canonical note near the top of this file is the only
      // place that number should be taken from, precisely so this one does not have to move
      // again. It has already been wrong twice.
      const from =
        direction === 'trailing' && ownIndices
          ? trailingWindowStart(breaks, lastOwnEnd, run.start)
          : (runs[i - 1]?.end ?? 0);
      const preceding = answer.slice(from, run.start);
      const lineStart = direction === 'block' ? -1 : preceding.lastIndexOf('\n');
      claim = lineStart < 0 ? preceding : preceding.slice(lineStart + 1);
    } else {
      // The prose AFTER the marker, up to the next marker, and never line-confined. Unconfined
      // is what survives a marker written at the END of its line with its subject on the next:
      // there a confined forward window is empty and the confined backward window holds only the
      // preamble, so nothing contests an election made from the preamble's partner.
      //
      // It used to be confined for `'leading'`, whose removal took the only branch that could
      // reach the confinement with it.
      claim = answer.slice(run.end, runs[i + 1]?.start ?? answer.length);

      // Zero the claim when the marker is immediately followed by a sentence terminator: nothing
      // after a full stop can be the marker's subject. Without it an ordinary trailing-marker
      // list self-contests — the forward claim of marker N is sentence N+1, a complete claim
      // about the NEXT candidate, so the forward reading is a clean shift-by-one bijection
      // disagreeing with the correct trailing one, and correct ratings are discarded.
      //
      // THIS LINE WAS DELETED AND PUT BACK IN ONE CYCLE, and the round trip is the most useful
      // thing in this file, so it is recorded rather than tidied away. It was removed as
      // redundant on three measurements that all came back clean — the suite green, the live
      // corpus unmoved, a seeded sweep unchanged — plus a direction argument that
      // is sound as far as it goes: zeroing a claim REDUCES objections, so the clause makes
      // refusals fire LESS often, and deleting it can only add them. Every one of those
      // statements is true. The conclusion drawn from them was still wrong, twice over.
      //
      // First, "the reason it existed no longer reproduces" was false, and an ordinary answer
      // shows it: *"Methylprednisolone [350]. Budesonide [351]. Prednisone [352]\n  Prednisone
      // Co 5mg"* — a three-item sentence-separated list with a restated tail — resolved all three
      // correctly with this line and refused all three without it. The corpus does not happen to
      // contain that shape, so no measurement taken over the corpus could see it. A clean result
      // is evidence about the inputs it ran on and nothing else.
      //
      // Second, and worse, the deletion silently un-pinned OTHER rules. This clause is what
      // empties a forward window in NINE of the tests that discriminate the tail and interior
      // objections; with it gone those nine stopped exercising what they are named for — the
      // tail rule's witnesses fell from 11 to 3, the interior rule's from 2 to 1 — and the suite
      // reported nothing, because every one of them still refused, for a different reason. A
      // green suite cannot see coverage it has just lost. Restoring the clause restores all
      // nine, which is how the number is known. (It read "ten" for a cycle, from adding 8 and 1
      // and writing down 10, beside the arithmetic that gives 9.)
      //
      // What makes keeping it safe is not this argument but the tail rule. The suppression here
      // once let a rotation ship wherever the last citation's forward window could be emptied
      // (see the objecting-sets gate, further DOWN this file); that hole is now closed in the
      // answer's TAIL, where
      // no claim window can hide it, and the two tests encoding it still refuse with this line
      // in. Measured on restoration: suite green, corpus byte-identical, a 400,000-seed sweep
      // clean.
      if (/^[^\S\n]*[.;!?]/.test(answer.slice(run.end))) claim = '';
    }
    for (const group of run.groups) {
      for (const index of parseCitationIndices(group[1])) {
        if (!claims.has(index)) claims.set(index, claim);
        if (ownIndices?.has(index)) lastOwnEnd = run.end;
      }
    }
  }

  return claims;
}

/**
 * The leading clause of a safety warning's `detail` — the part that states the finding, before
 * the rating and the mechanism the bundled dataset appends (`… — Major. Coadministration …`).
 *
 * `detail` is clinician-facing prose the module rewords freely and holds out as no contract, so
 * the delimiter split here is not promised. Truncation is NOT automatically harmless: a note
 * whose text breaks early can shorten the clause all the way down to the shared subject drug,
 * and a lead that short matches every claim about that drug — which is a false SINGLE match
 * wherever the sibling candidates' longer leads fail, not the ambiguity that would be refused.
 * {@link discriminatingLeads} is what makes that safe, by discarding a lead that cannot tell
 * this candidate from its siblings.
 */
function leadClause(detail: string): string {
  // Guarded like `severity` beside it, and for the same reason: this runs inside a render memo
  // with no error boundary above it, so a non-string here would take the answer, its citations
  // and its safety chips off the screen. Guarding one member of the family and not the others
  // is how the panel stayed one malformed field away from blanking.
  if (typeof detail !== 'string') return '';
  const dash = detail.indexOf(' — ');
  const stop = detail.indexOf('. ');
  const cut = [dash, stop].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  return cut === undefined ? detail : detail.slice(0, cut);
}

/**
 * The three groups of leads, as a fixed tuple. Fixed is what lets the caller take the group
 * count from any one candidate: a conditionally-present group would have to change this type,
 * so the compiler carries the invariant rather than a runtime guard nothing could discriminate.
 */
type LeadGroups = [bridges: string[], partner: string[], leadClause: string[]];

/**
 * An order display with its dose tokens dropped — `Solu-Medrol 125mg/5ml` → `Solu-Medrol`.
 *
 * The model routinely re-writes a chart order in short form after reproducing the module's own
 * phrase: live, *"Clarithromycin interacts with active order Solu-Medrol [350]"*, where the
 * bridge carries the full display. Without this the two MAJOR findings of that answer refused
 * while a Moderate one beside them resolved, so the reader saw a rating on the finding the
 * answer called least concerning and none on the two graver ones.
 *
 * Empty when there is no dose token to drop, so it never duplicates the full display as a lead.
 */
function shortOrderDisplay(display: string): string {
  const tokens = display.trim().split(/\s+/);
  // Trailing tokens that BEGIN with a digit — `125mg/5ml`, `90mcg`, `400mg`. Not merely tokens
  // CONTAINING one: a digit inside a product's NAME is not a dose, and truncating there yielded
  // the generic prefix `Vitamin` from `Vitamin B12 1000mcg`, which then matched a sentence about
  // `Vitamin D 50000iu` and elected the wrong finding's rating. Every later guard missed it — the
  // prefix is not the finding's own drug, is not shared by all candidates, and matched only one
  // group, so nothing contradicted it and one index elected one candidate.
  let nameEnd = tokens.length;
  while (nameEnd > 0 && /^\d/.test(tokens[nameEnd - 1])) nameEnd -= 1;
  if (nameEnd === tokens.length) return '';
  return tokens.slice(0, nameEnd).join(' ');
}

/**
 * The groups of strings that can identify a warning in the answer's own words.
 *
 * Three groups, and their ORDER carries no precedence — {@link electCandidate} is deliberately
 * order-free, so a group can only ever corroborate or contradict, never outrank. Reversing this
 * array changes no behaviour, and nothing here should be read as a ladder:
 *
 * - `bridges` — `chartOrderBridges`, typed fields published so a client is handed two strings
 *   rather than a sentence to parse, and carrying both vocabularies: a chip names its substances
 *   as the knowledge base does (`Methylprednisolone`) while the answer names the same
 *   prescription as the chart does (`Solu-Medrol 125mg/5ml`), both observed live in the same
 *   position.
 * - `partner` — the partner substance alone (see {@link partnerFromLead}), for an answer that
 *   names the finding more briefly than the module does.
 * - `leadClause` — the module's whole *"X interacts with active order Y"* sentence, which is the
 *   longest and hardest to collide with, but rests on a delimiter the backend does not promise.
 *
 * Every lead is passed through {@link discriminatingLeads} first, because a bare name is far
 * easier to confuse than the anchored sentence.
 */
function candidateLeadTiers(warning: AiSafetyWarning): LeadGroups {
  // Guarded at the element level, not just the array: a null entry or a non-string member would
  // reach `normalize` and throw inside a render memo. An Array.isArray on the outside alone was
  // the same partial guard this file has now been caught making twice.
  const bridges = Array.isArray(warning.chartOrderBridges) ? warning.chartOrderBridges : [];
  const bridgeLeads = bridges.flatMap((bridge) => {
    const stated = [bridge?.orderDisplay, bridge?.substance].filter(
      (value): value is string => typeof value === 'string',
    );
    const short = typeof bridge?.orderDisplay === 'string' ? shortOrderDisplay(bridge.orderDisplay) : '';
    return short ? [...stated, short] : stated;
  });
  const lead = leadClause(warning.detail);
  return [bridgeLeads, [partnerFromLead(lead)], [lead]];
}

/**
 * The partner substance named at the end of the module's own *"X interacts with active order Y"*
 * lead — `Y`.
 *
 * Needed because the answer often names the finding in a SHORTER form than the module does.
 * Live: asked to list the interactions one line each, the answer wrote just `"Prednisone Co
 * 5mg [352]"`, so the full lead clause appears nowhere and only the two findings carrying a
 * bridge can be named at all.
 *
 * Measured, because this paragraph twice described the wrong counterfactual: without this group
 * `ANSWER_BARE_LIST` resolves NONE of its five, not two of five. Naming two of five is not a
 * state this module can reach — `soundSets` wants a candidate at every cited index, so the whole
 * set withdraws together. So what the group buys is five correct ratings where there would
 * otherwise be five blanks, and "leaving the list half-badged, which the backend forbids" was
 * wrong about both halves: half-badged is unreachable, and rendering none is what the backend
 * asks for — *"render them together or render none, because picking one arbitrarily is how a
 * client ends up showing a different partner's mechanism beside the very citation it is
 * flagging"* (backend README, the `unstatedFindingSeverities` section). The blanks would have
 * been correct behaviour; they would just have been five fewer ratings.
 *
 * A narrower slice of the sentence this already parses, not a new dependency on it: where the
 * module's phrase is absent this group yields nothing, and the others are read anyway — all
 * three always are.
 */
function partnerFromLead(lead: string): string {
  const at = lead.lastIndexOf(' order ');
  return at < 0 ? '' : lead.slice(at + ' order '.length);
}

/**
 * Drops the leads that cannot tell this candidate from its siblings.
 *
 * Candidates are selected on the finding's own `(type, drug)`, so EVERY candidate is about that
 * drug and every claim naming the finding names it too. A lead equal to that drug therefore
 * matches every claim and would single its candidate out for all of them — measured: one chip
 * bridging its own subject drug took four of five ratings and reported them all as its own
 * Major. A lead the whole answer shares is not evidence about one candidate.
 */
function discriminatingLeads(leads: string[], drug: string): string[] {
  const shared = normalize(drug ?? '');
  return (
    leads
      .map((lead) => normalize(lead ?? ''))
      // A lead with no text carries no evidence to match on. It does NOT "match everything":
      // `namesLead` would not terminate on it, which is why that function refuses an empty lead
      // outright too. An operator's dataset can rate a rule and leave its note empty.
      .filter((lead) => lead !== '' && lead !== shared)
  );
}

/** Word-ish characters BEFORE a lead. `/` and `-` count so a lead cannot match the tail of a
 *  combination product (`dipyridamole` inside `aspirin/dipyridamole`) or the tail of a hyphenated
 *  brand (`Medrol` inside `Solu-Medrol 125mg/5ml`, a different product). */
function isWordish(character: string): boolean {
  return /[a-z0-9/-]/.test(character);
}

/**
 * Word-ish characters AFTER a lead, where `-` is a BOUNDARY rather than part of the word.
 *
 * The asymmetry is the point, and it is about which side of the hyphen the lead sits on. A lead
 * that is the tail of a compound is usually a different product — `Medrol` is not `Solu-Medrol` —
 * so `-` before it must keep hiding it. A lead that is the HEAD of one is normally that very
 * drug in adjectival form, which is how a clinician writes it: measured live, *"it interacts with
 * active order Prednisone Co 5mg and with her methylprednisolone-containing injection [350]"*
 * hid the lead `methylprednisolone` behind the `-containing`, so the window named only the
 * sibling Prednisone, elected it unanimously in all three readings, and rendered a MAJOR
 * interaction as Moderate. Two of them in one answer, and under-warning is the direction that
 * actually reaches a patient.
 *
 * With `-` a boundary on this side the window names BOTH drugs, elects nobody, and the set
 * refuses — the outcome the module wants. Cost, measured: one correct rating, on the mirror shape
 * where a bridge names `Medrol` and the claim names `Solu-Medrol` — that one is preserved by the
 * `before` half above, which is why the halves are separate functions rather than one.
 *
 * THIS WAS NOT THE WHOLE FIX, and shipping it as though it were traded one wrong-rating class for
 * its mirror. The premise above — "a lead at the HEAD of a compound is normally that drug in
 * adjectival form" — fails when the hyphen joins two DRUG names, and then this boundary exposes
 * the head, which is a sibling, while the `-` before the tail keeps the marker's own subject
 * hidden. {@link hyphenHiddenCandidates} is the other half — it gives the tail back — and the two
 * tests named for this pair of classes each redden under the other's rule, which is the evidence
 * that neither half alone can serve both.
 *
 * No counts in this paragraph on purpose. The first figures written for the class said "every one
 * of them under-warned", which was an artefact of sweeping only the two Major indices, where a
 * wrong rating can only under-warn. Across all five it is close to an even split, structurally:
 * for a pair `(A,B)` and `(B,A)` with different ratings, one ordering under-warns and the other
 * over-warns. The direction was what the safety argument rested on, so getting it wrong mattered
 * more than the count did.
 */
function isWordishAfter(character: string): boolean {
  return /[a-z0-9/]/.test(character);
}

/**
 * The candidates a group's leads single out, after removing the leads every candidate shares.
 *
 * A lead the whole set carries cannot tell its members apart, and it does worse than nothing:
 * measured live, every finding of one set bridged the SUBJECT's own order, so all seven matched
 * that order's display, the one decisive lead was swamped, the group went ambiguous and six
 * correct ratings were discarded. `discriminatingLeads` cannot see this on its own — it compares
 * a lead against the finding's drug NAME, and the shared lead here was that drug's order display.
 */
function matchesInGroup(
  candidates: AiSafetyWarning[],
  leadsPerCandidate: string[][],
  shared: ReadonlySet<string>,
  claim: string,
): AiSafetyWarning[] {
  return candidates.filter((_candidate, i) =>
    leadsPerCandidate[i].some((lead) => !shared.has(lead) && namesLead(claim, lead)),
  );
}

/** One group's leads per candidate, plus the leads every candidate in the set carries. */
interface CandidateGroup {
  leadsPerCandidate: string[][];
  shared: ReadonlySet<string>;
}

/** A `(type, drug)` set's candidates with their leads already normalised and filtered. */
interface CandidateSet {
  candidates: AiSafetyWarning[];
  groups: CandidateGroup[];
  /**
   * Per candidate, every lead it carries, across all groups — flattened once here because
   * {@link hyphenPairedCandidates} walks all of them for every claim and the readings share it.
   *
   * Includes leads that are SHARED across the set, deliberately. Everywhere else a shared lead is
   * discarded because it cannot tell candidates apart; here the question is whether a second DRUG
   * NAME sits on the other side of a hyphen, and an order display several findings bridge to —
   * a shape the live chart has produced — is a name even though it singles out nobody. Nothing
   * measured discriminates the variant that excludes them.
   */
  allLeads: string[][];
  /**
   * True when some candidate has NO discriminating lead in any group, so no prose can name it.
   *
   * Such a set must be refused wholesale. Every window that mentions any sibling then names
   * exactly one candidate, unanimously, in all three readings — so `electCandidate` returns a
   * confident winner and every objection agrees with it, and the unnameable finding silently
   * inherits whichever sibling the prose happened to mention. Measured: a rated chip with an
   * empty `detail` and no bridges beside a bridged Methylprednisolone rendered Major for the
   * answer's Prednisone sentence, against a truth of Minor.
   *
   * Both halves are reachable rather than hypothetical: `discriminatingLeads` already notes that
   * "an operator's dataset can rate a rule and leave its note empty", and a note that truncates
   * to the subject drug ("Clarithromycin. Interacts with active order Prednisone — Minor…")
   * yields a lead the same function then drops as non-discriminating. Either way the finding ends
   * up with nothing to be named by, and a set holding one cannot be resolved from prose at all.
   */
  unnameable: boolean;
}

/**
 * Everything about a candidate set that does NOT depend on the claim being read.
 *
 * Split out because it was being rebuilt for every citation of the set and again for each of the
 * readings — the same leads re-derived and re-`normalize`d once per reading per citation of the set,
 * which is quadratic in the size of the set. Measured on a 12-member `(interaction, drug)` family
 * — the size the live corpus reaches — `resolveFindingSeverities` ran 2.50 ms and dropped to
 * 0.18 ms once this was computed once per set; a 20-member family went 4.80 ms to 0.40 ms.
 *
 * Nothing here may be given a claim: the moment this depends on which sentence is being read it
 * stops being shareable across the readings, and the readings must stay independent.
 */
function buildCandidateSet(candidates: AiSafetyWarning[]): CandidateSet {
  // Two cases, and only one of them is about wasted work. A SINGLE candidate resolves by the
  // shortcut in `readClaims` and its leads are never asked for, so building them would be
  // pointless. ZERO candidates must not reach `leadsPerCandidate[0]` below at all: it is
  // `undefined` there and `.map` throws, inside a render memo with no error boundary above it —
  // the same class this file guards everywhere else. That path is ordinary, not exotic:
  // `readClaims` calls this BEFORE its own `candidates.length === 0` check, and the live payload
  // has a `contraindication:Clarithromycin` finding with `severity: null`, which yields zero
  // RATED candidates on every real answer of that shape.
  if (candidates.length <= 1) return { candidates, groups: [], allLeads: [], unnameable: false };
  const leadsPerCandidate = candidates.map(candidateLeadTiers);
  const groups = leadsPerCandidate[0].map((_unused, group) => {
    const leads = candidates.map((candidate, i) => discriminatingLeads(leadsPerCandidate[i][group], candidate.drug));
    const shared = leads.reduce<string[]>((common, own) => common.filter((lead) => own.includes(lead)), leads[0] ?? []);
    return { leadsPerCandidate: leads, shared: new Set(shared) };
  });
  const unnameable = candidates.some((_candidate, i) =>
    groups.every((group) => group.leadsPerCandidate[i].length === 0),
  );
  const allLeads = candidates.map((_candidate, i) => groups.flatMap((group) => group.leadsPerCandidate[i]));
  return { candidates, groups, allLeads, unnameable };
}

/**
 * Whether the claim names the lead as a whole term rather than inside a longer one.
 *
 * A bare substring test is what made the bridge group unsafe: `Cortisone` occurs inside
 * `Hydrocortisone`, so a chip bridged to the first was resolved for a sentence about the second
 * — while the `leadClause` group, anchored by the *"interacts with active order …"* phrase, got
 * the same case right.
 */
export function namesLead(claim: string, lead: string): boolean {
  // An empty lead is not merely uninformative — `indexOf('')` returns `from` for every `from`, so
  // the scan below would never advance and never terminate. It is filtered out upstream, but a
  // guard whose failure mode is a frozen render thread does not get to rely on that.
  if (lead === '') return false;
  for (let from = 0; ; from += 1) {
    const at = claim.indexOf(lead, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : claim[at - 1];
    const end = at + lead.length;
    const after = end >= claim.length ? '' : claim[end];
    if (!isWordish(before) && !isWordishAfter(after)) return true;
    from = at;
  }
}

/**
 * The one candidate the answer's sentence identifies, or null to refuse.
 *
 * The whole rule: the lead groups, between them, must name exactly ONE candidate. That subsumes
 * every refusal this used to spell out separately — two groups naming different candidates, and
 * a group that is ambiguous or that excludes another group's winner, all put a second candidate
 * into the union — and it closes the case those checks missed, where an ambiguous group was a
 * strict SUPERSET of the winner. That group then excluded nobody, so it decided nothing, while a
 * group blind to the second candidate decided everything: live, a Moderate Hydrocortisone
 * finding rendered Major because its sentence also mentioned a bridged Methylprednisolone.
 *
 * Order-free by construction — a set union cannot depend on the order of the groups. That is the
 * safety property (a group can corroborate or contradict, never outrank), and it is why nothing
 * anywhere may describe these groups as a precedence ladder.
 */

function electCandidate(perGroupMatches: AiSafetyWarning[][]): AiSafetyWarning | null {
  const named = new Set(perGroupMatches.flat());
  return named.size === 1 ? [...named][0] : null;
}

/**
 * The candidates a HYPHEN hides, and that the claim therefore names after all.
 *
 * {@link isWordish} counts `-` before a lead so that a lead cannot match the TAIL of a compound —
 * `Medrol` must not match inside `Solu-Medrol`, a different product. The cost is that a full drug
 * name glued to something by a hyphen becomes invisible, and when that name is the marker's own
 * subject the window is left naming only a sibling, which every reading then elects unanimously.
 * Measured on the shipped fixture, under-warning: *"…and with her prednisone-to-Solu-Medrol switch
 * [350]"* rendered Prednisone's Moderate for a MAJOR finding.
 *
 * So: a lead that BEGINS just after a hyphen names its candidate — unless another candidate's lead
 * SPANS that hyphen, which is what tells `Solu-Medrol` apart from `prednisone-to-Solu-Medrol`. In
 * the first, one lead covers both sides of the hyphen and the compound is one product's name; in
 * the second nothing does, and the hyphen is joining two names. That single test replaces two
 * earlier attempts — one anchored on the matched lead, which could not see a hyphen further along
 * the token, and one requiring a lead to END at the hyphen, which missed a chart order display
 * whose last token is a dose (`Prednisone Co 5mg-Methylprednisolone`).
 *
 * "Just after" runs to the next SPACE, which admits the connector forms without a word list —
 * `prednisone-to-methylprednisolone` puts its second name three characters past a hyphen with no
 * space between, so `-to-`, `-and-`, `-versus-` are covered by shape rather than enumeration. A
 * lead may contain spaces once it has started, which is what makes a multi-word substance
 * readable (`metformin-Insulin Glargine`).
 */
function hyphenHiddenCandidates(
  candidates: AiSafetyWarning[],
  leadsPerCandidate: string[][],
  claim: string,
): AiSafetyWarning[] {
  // Behaviour-neutral fast path, and stated as such because no test pins it: with no hyphen in
  // the claim the loops below find nothing anyway, so deleting this line leaves the suite green.
  // That is a proof rather than a coverage gap — unlike the guard further down, which is also
  // unpinned-looking and is not, and has a test of its own for exactly that reason.
  if (!claim.includes('-')) return [];

  // Both scans are hoisted out of the hyphen loop, and that is not premature. Doing them per
  // hyphen cost an `indexOf` for every lead of every candidate at every hyphen: measured on a
  // 20-member family with a hyphen-dense answer, 0.95 ms without this rule and 4.80 ms with it —
  // and 4.80 ms is precisely the figure this file records `buildCandidateSet`'s own hoist as
  // having REMOVED, so the first version of this handed that whole optimisation back. Hoisting
  // takes the same case to 1.21 ms, and an ordinary 20-member answer from 1.45 to 0.83 against a
  // 0.68 baseline. Re-measure rather than trusting these; they are wall-clock on one machine and
  // the shape of the answer moves them more than the family size does.
  //
  // `startsAt` maps a position to the candidates whose lead begins there; `spanned` holds the
  // hyphen positions strictly inside some hyphenated lead's occurrence, which is the
  // `Solu-Medrol` exception.
  const startsAt = new Map<number, Set<number>>();
  const spanned = new Set<number>();
  for (const [i, leads] of leadsPerCandidate.entries()) {
    for (const lead of leads) {
      if (lead === '') continue;
      const hyphenated = lead.includes('-');
      for (let from = claim.indexOf(lead); from >= 0; from = claim.indexOf(lead, from + 1)) {
        const here = startsAt.get(from) ?? new Set<number>();
        here.add(i);
        startsAt.set(from, here);
        if (!hyphenated) continue;
        for (let k = from + 1; k < from + lead.length; k += 1) {
          if (claim[k] === '-') spanned.add(k);
        }
      }
    }
  }

  const hidden = new Set<AiSafetyWarning>();
  for (let at = claim.indexOf('-'); at >= 0; at = claim.indexOf('-', at + 1)) {
    // A lead covering both sides of this hyphen means the compound IS one candidate's name.
    if (spanned.has(at)) continue;
    const space = claim.indexOf(' ', at + 1);
    const limit = space < 0 ? claim.length : space;
    for (let from = at + 1; from <= limit; from += 1) {
      for (const i of startsAt.get(from) ?? []) {
        if (candidates[i]) hidden.add(candidates[i]);
      }
    }
  }
  return [...hidden];
}

/** Splits a safety finding's synthetic uuid (`interaction:Clarithromycin`) into type and drug. */
function splitFindingUuid(resourceUuid: string): { type: string; drug: string } | null {
  if (typeof resourceUuid !== 'string') return null;
  const colon = resourceUuid.indexOf(':');
  if (colon <= 0 || colon === resourceUuid.length - 1) return null;
  return { type: resourceUuid.slice(0, colon), drug: resourceUuid.slice(colon + 1) };
}

/** One reading of the answer: which candidate each citation elects, plus the per-set bookkeeping. */
interface ClaimReading {
  resolved: Map<number, string>;
  setOfIndex: Map<number, string>;
  citedIndices: Set<number>;
  electedOf: Map<number, AiSafetyWarning>;
  /** Every candidate this reading's window NAMED, not just the one it elected. */
  namedOf: Map<number, Set<AiSafetyWarning>>;
}

/**
 * The candidate set for one finding, built at most once per `(type, drug)` per resolve.
 *
 * Keyed on the same `setKey` the readings and {@link soundSets} use, so a cache hit is by
 * construction the same set the uncached path would have selected. The cache spans all three
 * readings deliberately: which chips share a finding's `(type, drug)`, and what they can be
 * named by, is a fact about the payload, not about the direction the answer is being read in.
 */
function candidateSetFor(
  safetyWarnings: AiSafetyWarning[],
  finding: { type: string; drug: string },
  setKey: string,
  setCache: Map<string, CandidateSet>,
): CandidateSet {
  const cached = setCache.get(setKey);
  if (cached) return cached;

  const candidates = safetyWarnings.filter(
    (warning) =>
      // typeof, not a truthy check: a non-string rating would throw inside a render memo and
      // take the whole answer panel down. This filter also DEFINES the candidate set as the
      // RATED subset of the chips sharing this (type, drug), which is what makes the
      // single-candidate shortcut sound — the backend never lists a finding whose record
      // states no rating.
      //
      // Nothing narrows this list by what the ANSWER says, and that is a constraint rather than
      // an omission. {@link answerStatesRating} held exactly that job for one cycle and was moved
      // to the end of `resolveFindingSeverities`, because removing a candidate here changes what
      // {@link discriminatingLeads} counts as shared by all and can turn an honest refusal into a
      // confident wrong election — that function's note carries the swapped pair it cost. Keeping
      // this list the payload's own view is also what lets the cache be keyed on (type, drug)
      // alone, with no answer in the key.
      typeof warning.severity === 'string' &&
      warning.severity.trim() !== '' &&
      // typeof on these too. Optional chaining guards null, not TYPE — a numeric `type` reaches
      // `.toLowerCase()` and throws, one line below the guard that exists for exactly that.
      typeof warning.type === 'string' &&
      typeof warning.drug === 'string' &&
      warning.type.toLowerCase() === finding.type.toLowerCase() &&
      warning.drug.toLowerCase() === finding.drug.toLowerCase(),
  );

  const set = buildCandidateSet(candidates);
  setCache.set(setKey, set);
  return set;
}

/**
 * Whether the answer states this rating anywhere in its prose.
 *
 * The one objection in this file that consults the payload's contract rather than the sentence,
 * and it is the backend's own published rule read backwards. A citation lands in
 * `unstatedFindingSeverities` when the finding's rating word "appears nowhere in the answer" —
 * the check asks it of the WHOLE answer, not of the citing sentence, so an answer that states the
 * rating anywhere leaves the citation off the list (backend README, the
 * `unstatedFindingSeverities` section, and ADR Decision 78). Contrapositive: a resolution that
 * gives an index a rating the answer already states contradicts the payload, because the backend
 * would not have listed that index at all. So it is refused.
 *
 * That closes a wrong-rating class no reading of the prose could, because in it all three readings
 * AGREE and every other objection is satisfied. The answer names the marker's own subject in a
 * form the payload publishes no lead for — an anaphor, or a clause instead of a name — so the
 * window is left naming exactly one drug, the SIBLING, which the readings then elect unanimously;
 * and the head and interior rules are satisfied by the very election they should be doubting,
 * because the wrongly-elected sibling sits in `claimedByTrailing` precisely BECAUSE it was
 * wrongly elected. Captured live: *"it interacts with active order Solu-Medrol 125mg/5ml, a Major
 * interaction, and by the same mechanism [352]"* badged a MODERATE finding Major. The prose gives
 * nothing to work with — but the answer says "Major", so [352] is not a Major finding.
 *
 * IT MUST STAY AN OBJECTION AND NOT A CANDIDATE FILTER, and that distinction cost a swapped pair
 * to learn. Reading the same rule as "so those findings are not candidates" is the obvious
 * implementation, it closes the same class, and it is unsafe: the candidate list is not only what
 * an election chooses FROM, it is also what {@link discriminatingLeads} measures "shared by every
 * candidate" against. Drop one candidate and a lead that told nobody apart can start telling two
 * apart, so a window that honestly elected NOBODY elects somebody — confidently and wrongly.
 * Measured on a payload the backend could have emitted: {352: Contraindicated, 354: Minor}
 * against a truth of {352: Minor, 354: Contraindicated}. Deleting a resolution cannot invent one,
 * which is the whole argument for this shape; the filter shape had no such argument, and the
 * paragraph justifying it read as though it did.
 *
 * That case was found only by a sweep in which EVERY answer stated a rating. The shipping
 * distribution reaches the shape about a quarter of the time and 400,000 seeds of it found
 * nothing, so the targeted run is what made it visible — a rare interaction between two features
 * needs the population skewed at it, not enlarged. The same 400,000 skewed answers are clean on
 * this shape. That population is not committed, because with nothing narrowing the candidate list
 * the coupling it probed is no longer reachable; what is committed is the one answer, as
 * `does not narrow the candidate field, which is how this rule went wrong once`, which reddens if
 * anyone rebuilds the filter.
 *
 * The price is two correct ratings, and it is the right price. The filter shape narrowed one live
 * answer's field to the two findings that were still possible and rendered both, the only ratings
 * this module has ever recovered rather than given up; the objection shape refuses them again.
 * The corpus is byte-identical to before either — see THE CORPUS at the top of this file — and a
 * blank is safe where a swapped pair is not, which is the premise the whole module rests on.
 *
 * Decided the BACKEND'S way, with {@link RATING_BOUNDARY} rather than the drug matcher, and the
 * reason is a safety property that only holds if the two agree.
 *
 * For a citation the backend LISTED, `statesWord(answer, its true rating)` is false — that is what
 * listing means. So if this function answers the same question the same way, a resolution carrying
 * the RIGHT rating is never deleted, and only a resolution carrying some OTHER rating the answer
 * states can be, which is a wrong one. The rule then cannot cost a correct rating on any payload
 * the backend could emit.
 *
 * IT USED TO BORROW {@link namesLead}, WITH A WRITTEN PROOF THAT THE BORROWING WAS SAFE, AND THE
 * PROOF WAS FALSE. It argued that `isWordish` is a superset of alphanumeric so everything
 * `namesLead` accepts `statesWord` accepts — but `isWordish` is ASCII-only and
 * `Character.isLetterOrDigit` is Unicode-aware, so the subset inverts wherever a non-ASCII letter
 * or digit sits next to the rating word. Measured on the shipped fixture: appending *"Majorの相互
 * 作用に注意してください。"* to a live answer deleted BOTH correct Major ratings while the
 * backend's own scan returned false for "Major", meaning it had listed exactly those citations.
 * Also reproduced with an accented letter and an Arabic-Indic digit. This module is translated and
 * its answer language follows the model, so non-ASCII prose is the normal case, not the exotic one.
 *
 * The probe behind the false proof is why it survived: seventeen surroundings, all ASCII. A
 * boundary rule is exactly the kind of claim where the interesting inputs are the ones outside the
 * character set the prober was thinking in — and "provable rather than measured" is the phrase
 * that told the next reader not to check.
 *
 * One consequence of agreeing with the backend is worth stating, because it looks like a cost and
 * is not: an ordinary-English use of the word deletes nothing, because the backend reads the same
 * text with the same scan and would not have listed the citation. A sweep measured 64,251 correct
 * ratings deleted on answers saying "recovering from major abdominal surgery" — on payloads that
 * cannot occur. That changes the day the backend's check becomes rating-CONTEXT aware rather than
 * textual; if it does, this rule starts over-refusing and this paragraph is where to look.
 *
 * Reachable only where two findings of one group share a rating, which is the live chart's shape
 * (three of five Moderate) and deliberately NOT the property fixture's — see the note above
 * `generateAnswer` there for why that fixture is right anyway, and why this rule's coverage is a
 * named test rather than the sweep.
 *
 * ONE test, not the three the describe block holds, and the difference was measured: neutering
 * the line that calls this reddens only `refuses where the prose gives nothing but the backend
 * does — captured live`. Its two neighbours look like coverage and are not — the typo case
 * states no rating at all, so this never fires on it, and the narrowing case guards against
 * rebuilding the FILTER rather than against deleting this objection. Three describe-mates are
 * not three witnesses.
 */
function answerStatesRating(normalizedAnswer: string, severity: string): boolean {
  const needle = normalize(severity);
  if (needle === '') return false;
  for (let at = normalizedAnswer.indexOf(needle); at >= 0; at = normalizedAnswer.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    const before = at === 0 ? '' : normalizedAnswer[at - 1];
    const after = end >= normalizedAnswer.length ? '' : normalizedAnswer[end];
    if (!RATING_BOUNDARY.test(before) && !RATING_BOUNDARY.test(after)) return true;
  }
  return false;
}

/**
 * What counts as part of a word on either side of a RATING, mirroring `Character.isLetterOrDigit`
 * — Unicode letters and numbers, and nothing else.
 *
 * Transcribed from the backend's `statesWord` rather than shared with {@link isWordish}, and the
 * difference is not cosmetic. `isWordish` is a DRUG-name boundary: it counts `/` and `-` so a lead
 * cannot match half a combination product, and it is ASCII-only. Borrowing it here looked like
 * reuse and was a contract mismatch, because this question is the backend's question and has to be
 * decided the backend's way.
 */
const RATING_BOUNDARY = /[\p{L}\p{N}]/u;

function readClaims(
  references: AiReference[],
  safetyWarnings: AiSafetyWarning[],
  unstatedFindingSeverities: number[],
  claims: Map<number, string>,
  setCache: Map<string, CandidateSet>,
): ClaimReading {
  const resolved = new Map<number, string>();
  const setOfIndex = new Map<number, string>();
  const citedIndices = new Set<number>();
  const electedOf = new Map<number, AiSafetyWarning>();
  const namedOf = new Map<number, Set<AiSafetyWarning>>();
  // Array.isArray on `references` too — the last member of this family without the guard its
  // siblings got. Not reachable from this backend, but the panel has no error boundary above it.
  const refByIndex = new Map((Array.isArray(references) ? references : []).map((ref) => [ref.index, ref]));

  for (const index of unstatedFindingSeverities) {
    const ref = refByIndex.get(index);
    if (!ref) continue;
    const finding = splitFindingUuid(ref.resourceUuid);
    if (!finding) continue;

    const setKey = `${finding.type.toLowerCase()}:${finding.drug.toLowerCase()}`;
    const set = candidateSetFor(safetyWarnings, finding, setKey, setCache);
    const candidates = set.candidates;
    if (candidates.length === 0) continue;

    setOfIndex.set(index, setKey);
    if (claims.has(index)) citedIndices.add(index);

    if (candidates.length === 1) {
      resolved.set(index, candidates[0].severity!.trim());
      electedOf.set(index, candidates[0]);
      namedOf.set(index, new Set(candidates));
      continue;
    }

    // A set holding a finding no prose can name is refused outright — see `unnameable`.
    if (set.unnameable) continue;

    // Several findings share this (type, drug), so the answer's own sentence has to single one
    // out. Each lead group is asked of the whole candidate list and the verdicts are reconciled
    // by `electCandidate`, which refuses on every disagreement — group order decides nothing.
    const claim = normalize(stripExclusions(normalizeKeepingLines(claims.get(index) ?? '')));
    const perGroupMatches = set.groups.map((group) =>
      matchesInGroup(candidates, group.leadsPerCandidate, group.shared, claim),
    );
    // Appended as one more group rather than merged into any of them, because it is not evidence
    // of the same kind: the groups say "this lead names this candidate", and this says "a hyphen
    // hid a name that is in here too". `electCandidate` unions the groups, so an entry that takes
    // the union past one is exactly a claim that singles nobody out.
    //
    // Pushed ONLY when it takes the union to two or more, which is what keeps this on the safe
    // side of the invariant above: it can then delete an election and never create one. Adding a
    // lone name to a window that named nobody would turn a refusal into a resolution, and a
    // refusal there is the honest answer — the window found no candidate at all.
    const hidden = hyphenHiddenCandidates(candidates, set.allLeads, claim);
    const union = new Set([...perGroupMatches.flat(), ...hidden]);
    if (hidden.length > 0 && union.size > 1) perGroupMatches.push(hidden);
    namedOf.set(index, new Set(perGroupMatches.flat()));
    const winner = electCandidate(perGroupMatches);
    if (winner) {
      resolved.set(index, winner.severity!.trim());
      electedOf.set(index, winner);
    }
  }

  return { resolved, setOfIndex, citedIndices, electedOf, namedOf };
}

/**
 * Each candidate set's citation indices, in one place.
 *
 * The two bars below — the right to RESOLVE and the right to OBJECT — differ only in which
 * predicate completeness is measured on and whether injectivity is required, and each kept its
 * own copy of this grouping and its own `citedIndices` filter as well. (Both of those bars were
 * described as differing "by one word" in three places, which was never true and is corrected
 * where each of them is defined.) A change to how an index is assigned to a set, or
 * to which indices count as cited, made once would silently give the two bars different
 * POPULATIONS, so a set could qualify to object under one grouping while being judged sound
 * under another. (Also drops the quadratic array copy the grouping loops both used.)
 */
function indicesBySet(reading: ClaimReading): Map<string, number[]> {
  const grouped = new Map<string, number[]>();
  for (const [index, setKey] of reading.setOfIndex) {
    const own = grouped.get(setKey);
    if (own) own.push(index);
    else grouped.set(setKey, [index]);
  }
  return grouped;
}

/** The candidate sets this reading identified COMPLETELY and INJECTIVELY. */
function soundSets(reading: ClaimReading): Set<string> {
  const sound = new Set<string>();
  for (const [setKey, indices] of indicesBySet(reading)) {
    // Completeness over the CITED members only — an index the prose never carries renders
    // nothing either way. Injectivity over EVERY member: two citations of one set electing the
    // same finding cannot both be right, and an uncited index still consumes a candidate.
    const complete = indices.filter((i) => reading.citedIndices.has(i)).every((i) => reading.resolved.has(i));
    const elected = indices.map((i) => reading.electedOf.get(i)).filter(Boolean);
    if (complete && new Set(elected).size === elected.length) sound.add(setKey);
  }
  return sound;
}

/**
 * The sets for which this reading found a candidate NAMED at every cited citation, and whose
 * elections — so far as it made any — are pairwise distinct.
 *
 * This is the qualification to OBJECT, and it is deliberately weaker than {@link soundSets},
 * which is the qualification to RESOLVE. They differ in WHICH predicate completeness is
 * measured on — named here, resolved there — and in whether injectivity is required at all
 * (it is not, see below). It was described as a one-word difference, which the paragraph 35
 * lines down already contradicted. Getting it wrong
 * shipped every rating of an answer wrong.
 *
 * Why completeness has to be measured on NAMED rather than ELECTED. For any list of findings,
 * the forward reading is a ROTATION of the trailing one and vice versa — so a bare disagreement
 * between them is the norm and carries no information at all. What actually separates the two
 * orientations is whether a subject DANGLES past the last marker: written trailing, the text
 * after the final marker names no candidate, so the forward reading has nothing there and is
 * incomplete; written shifted, there is a name left over, and the forward reading reaches every
 * citation. That is the signal, and requiring an ELECTION for it threw it away wherever the
 * dangling text was ambiguous.
 *
 * Measured — a five-item shifted list whose last line read "Budesonide rather than Prednisone
 * Co 5mg". The forward reading elected the CORRECT finding for four of the five citations and
 * named two candidates on the fifth, so it elected nobody there, lost completeness, and was
 * barred from objecting at all. Meanwhile the trailing reading resolved the set as a clean
 * rotation — complete, injective, and wrong in all five positions. Every rating rendered was
 * the neighbouring finding's.
 *
 * This gate is all-or-nothing over the set: one cited index whose forward window names nobody
 * disqualifies the whole set from objecting anywhere, so a rotation used to ship wherever the
 * LAST citation's forward window could be emptied — by a marker citing something outside the
 * measurement, or by a full stop. That was a WRONG RATING and not a refusal, and it is closed
 * now, but NOT here: it is closed by the leftover-subject rule in `resolveFindingSeverities`,
 * which asks the same "does a subject dangle past the last marker" question of the answer's
 * TAIL, where no claim window can hide it. Two local repairs to this gate were implemented and
 * measured first, and both cost correct live ratings — widening the forward window past a
 * foreign marker (98 -> 95) and removing the `.` from the terminator rule (98 -> 82), both
 * against the then-98 baseline rather than the current one — see THE CORPUS at the top of this
 * file, which is the only place that number should be read from. Neither
 * was shipped. That is why the answer to a bad proxy here was a different question elsewhere
 * rather than a better proxy.
 *
 * Named-completeness is the WHOLE test, and two further restrictions were tried and dropped:
 * requiring the forward elections to be injective, and requiring an election at the index being
 * contested. Both make an objection fire LESS often, which is the unsafe direction for a rule
 * whose only output is a refusal — and neither is justified by anything measurable. With both
 * removed the suite, the live corpus and a 150,000-seed sweep
 * (5,171 resolving answers) are unchanged. NOT byte-identical any more, and that matters: the
 * INJECTIVITY half can no longer be re-added without cost — doing so now reddens "refuses where
 * the forward-disagreement rule is the ONLY objection" with a swapped Major/Moderate pair,
 * because that test did not exist when this was measured. The `forwardElected` half really is
 * inert. Re-measure before believing either; the figure here said 269, which was a 9,000-seed
 * count read as a 150,000-seed one. They were noise in the direction
 * of resolving more, and are gone rather than left for the next change to delete for free.
 */
function objectingSets(reading: ClaimReading): Set<string> {
  const qualified = new Set<string>();
  for (const [setKey, indices] of indicesBySet(reading)) {
    const named = indices
      // Cited members only: an index the prose never carries names nothing either way, so
      // requiring it would bar the set from objecting for a reason that is not about this answer.
      // Nothing discriminates the filter — dropping it makes objections fire LESS often, which is
      // the unsafe side, so it stays.
      .filter((i) => reading.citedIndices.has(i))
      .every((i) => (reading.namedOf.get(i)?.size ?? 0) > 0);
    if (named) qualified.add(setKey);
  }
  return qualified;
}

/**
 * The rating to render beside each citation named in `unstatedFindingSeverities`.
 *
 * The backend states plainly that the rating "cannot be joined to a chip: chips carry no
 * citation index, and `(type, drug)` does not identify one". So this does not attempt that
 * join. It narrows to the candidates sharing the finding's `(type, drug)` and requires the
 * answer's own sentence to single ONE of them out. An index that stays ambiguous renders no
 * rating: attributing "Major" to the wrong sentence is worse than attributing nothing.
 *
 * A marker's subject may sit on EITHER SIDE of it, and one reading cannot tell which. Live, both
 * occur: *"…active order Methylprednisolone [350]"* trails its subject, while *"Apart from
 * Prednisone, the interacting orders are [364] Methylprednisolone, [365] Budesonide, …"* leads
 * it — and that second shape resolved as a clean BIJECTION under the trailing reading, shifted
 * by one, rendering the Major Methylprednisolone interaction as Moderate. Completeness and
 * injectivity cannot see a rotation, because a rotation is both.
 *
 * So the answer is read THREE ways — backward line-confined (`trailing`), backward unconfined
 * (`block`), and forward unconfined (`block-leading`) — and only the trailing reading may ever
 * resolve a set, which it must identify completely and injectively ({@link soundSets}). The
 * other two exist to CONTEST it, and the bar to contest
 * is deliberately lower than the bar to resolve ({@link objectingSets}): a reading barred from
 * objecting until it is decisive everywhere would fall silent on exactly the ambiguous answers
 * that need it, which is measured, not hypothetical — it shipped five rotated ratings.
 *
 * A set is withheld on any of SEVEN objections: a forward reading that identified a candidate at
 * every cited citation and elects a different one here; a forward reading that NAMES a finding
 * the trailing reading claims for no citation of the set; a candidate named past the SET's last
 * own-index marker that is not the last citation's own election; a candidate named BEFORE the
 * set's first marker that no citation claims; a candidate named BETWEEN two of the set's own
 * markers that no citation claims; the unconfined backward window no longer singling
 * out what the confined one elected; or the trailing reading not being sound in the first place.
 *
 * The third, fourth and fifth are the three spans of one answer — after the set's last own
 * marker, before its first, and between them — added across three cycles, each for a live or
 * measured wrong rating and each after a word list had failed at the same job. Together they say:
 * EVERY candidate this answer names must have a citation willing to claim it, wherever it sits.
 * That is the closest this module gets to a principle rather than a patch.
 *
 * They are not one rule, and that was measured rather than assumed: collapsing them into a
 * single whole-answer scan yields MORE ratings than the three spans do, and reddens refusal
 * tests, because each span needs a different refinement — the head strips its own last sentence,
 * the tail exempts the last citation's own election, and the interior is plain.
 *
 * The figures this used to carry (83 against 80, five refusal tests) are gone because the
 * variant was never specified and so the measurement could not be repeated: a reviewer trying it
 * got a different set of failures, and neither of us can say whether we collapsed the same thing,
 * since "one whole-answer scan" leaves open whether the head's sentence-strip and the tail's
 * exemption are retained. If you try it, say which. The direction is what the decision rested
 * on and it is reproducible under any of those variants; the exact counts were not.
 *
 * Where nothing objects, orientation never mattered — and a single-candidate set resolves the
 * same either way, by the shortcut in `readClaims`.
 *
 * Their weights are very unequal and it is worth knowing which, because the shape of this thing
 * is not what its rule list suggests. Measured on the live corpus:
 *
 *   - Rule 1 is nearly INERT on real answers. Forcing its gate open dropped the corpus from its
 *     then-98 ratings to ONE, which says the forward reading disagrees somewhere almost always
 *     and the gate closing is what allows any rating at all.
 *   - Rule 2 has NO witness, and this bullet has now been wrong in both directions. It first
 *     said "changes nothing measurable"; that was corrected to "disabling it reddens two tests,
 *     one of them the property sweep, with five seeds rendering a wrong rating"; and the
 *     correction was measured again and is false too. Disabling it leaves the whole suite green,
 *     the corpus unmoved, and a 400,000-seed sweep clean, and instrumenting every objection site
 *     shows it is the SOLE objection on nothing the repo can produce. The accurate account, with
 *     the firing counts, is at the rule itself — a second copy of a measurement is how this one
 *     drifted, so this bullet now points there instead of restating it. The rule is kept, for
 *     the reason given there.
 *   - Rule 1 survives in two places, and it took a constructed shape to find the first: where
 *     rule 3's carve-out stands down because the tail restates the LAST citation's own election,
 *     an earlier citation's forward disagreement is left as the only objection. It was
 *     discriminated by nothing at all until that test was written, and the test NAMED for it had
 *     been caught up with by rule 3, which refuses its answer earlier.
 *   - Rules 3 and 4 carry most of the weight on a real answer, and rule 3 exists because 1 and 2
 *     are both blind to a ROTATION: a permutation is invisible to a per-finding check, and rule
 *     1's gate closes on exactly the answers a rotation needs.
 *
 * What no rule here can do is prefer one orientation on its merits. For any list the forward
 * reading is a rotation of the trailing one, so disagreement between them is the ordinary case
 * and says nothing on its own; the only structural signal is whether a subject dangles past the
 * last marker. Refusing is therefore the answer wherever that signal is absent or contradicted,
 * rather than adopting an orientation on the strength of one example.
 *
 * Gated on `unstatedFindingSeverities` deliberately, not on `severity` being present — the
 * backend check asks of the whole answer, so an answer that states its ratings somewhere is
 * absent from the list and must not have them repeated.
 */
export function resolveFindingSeverities(
  answer: string,
  references: AiReference[],
  safetyWarnings: AiSafetyWarning[],
  unstatedFindingSeverities: number[] | null | undefined,
): Map<number, string> {
  // Array.isArray on both: guarding one member of this family is not guarding the family, and a
  // non-iterable would throw inside a render memo with no error boundary above it.
  if (typeof answer !== 'string') return new Map();
  if (!Array.isArray(unstatedFindingSeverities) || !Array.isArray(safetyWarnings)) return new Map();
  if (unstatedFindingSeverities.length === 0 || safetyWarnings.length === 0) return new Map();

  const ownIndices = new Set(unstatedFindingSeverities);
  // Shared across all three readings on purpose: see {@link candidateSetFor}.
  const setCache = new Map<string, CandidateSet>();
  const trailing = readClaims(
    references,
    safetyWarnings,
    unstatedFindingSeverities,
    claimTextByCitation(answer, 'trailing', ownIndices),
    setCache,
  );
  const block = readClaims(
    references,
    safetyWarnings,
    unstatedFindingSeverities,
    claimTextByCitation(answer, 'block'),
    setCache,
  );
  const blockLeading = readClaims(
    references,
    safetyWarnings,
    unstatedFindingSeverities,
    claimTextByCitation(answer, 'block-leading'),
    setCache,
  );
  const soundTrailing = soundSets(trailing);
  // Qualified to OBJECT, which is a weaker test than qualified to RESOLVE — see
  // {@link objectingSets} for the answer that made the difference.
  //
  // Only the UNCONFINED forward reading is taken. The line-confined one used to sit beside it in
  // both contests below and is provably redundant, which is why the answer is read three ways
  // rather than four: its window is a SUBSET of this one's, so (a) everything it names, this
  // names — which settles the NAMED contest — and (b) wherever it would object here, this one
  // does too. Take the only case that looks like an exception: the confined window names exactly
  // one candidate and disagrees with trailing, while the wider window names two and so elects
  // nobody. Electing nobody is `undefined`, which is not what trailing elected either, so the
  // objection still lands. That equivalence needs the `forwardElected` guard to be absent — it
  // was removed in the same cycle for its own reasons, and this fell out.
  //
  // Measured alongside the proof, before removal: dropping the confined reading from either
  // contest left the suite, the live corpus, a 150,000-seed sweep and a
  // 60,000-answer rotation search all unchanged.
  const objectingBlockLeading = objectingSets(blockLeading);

  // Which findings the trailing reading claims for SOME citation of each set.
  const claimedByTrailing = new Map<string, Set<AiSafetyWarning>>();
  for (const [index, setKey] of trailing.setOfIndex) {
    const elected = trailing.electedOf.get(index);
    if (!elected) continue;
    const claimed = claimedByTrailing.get(setKey) ?? new Set<AiSafetyWarning>();
    claimed.add(elected);
    claimedByTrailing.set(setKey, claimed);
  }

  // A candidate the ANSWER names that no citation of its set claims.
  //
  // The shift signature, and the only signal measured to separate a rotation from the
  // interleaved lists that must keep resolving. A trailing-written answer names one subject per
  // citation; a shifted one leaves one over — that is the same "dangling subject" the gate above
  // is a proxy for, asked of the whole answer text instead of a single window, so a foreign
  // marker or a full stop cannot hide it.
  // The TAIL of a set: the text after the last marker citing one of ITS OWN indices, taking
  // first occurrences only. A candidate named there has no citation left to claim it, which is
  // what makes it a leftover subject rather than simply another drug the answer talks about.
  //
  // THIS PARAGRAPH USED TO DECLARE THE SHIPPED CUT WRONG, which is the worst thing a comment in
  // this file can do — the alternative it recommended is recorded twelve lines down as dormant
  // on 35,010 resolving answers of which 35,010 carried a wrong rating. It described two
  // narrower tails as "both wrong": the WHOLE answer, which costs 11 live ratings because an
  // ordinary answer names other drugs in its mechanism clauses ("various CYP450 3A4 inhibitors
  // including…") and each reads as a leftover — that one is still true and still the reason not
  // to widen — and "the text after the SET's last marker", costing 6, which is what the code
  // does. Both statements were true when written: the cut was the ANSWER's last marker until a
  // later cycle moved it per-set and left this paragraph behind.
  //
  // The 6-rating cost is real and paid deliberately, and the example is worth keeping because it
  // is what the cost looks like: `n5_worst_first` is a numbered list of five items of which only
  // two are unstated, so items 4 and 5 sit in this set's tail naming candidates they have their
  // own markers for. Paying it buys the 35,010.
  const markerRuns = [...answer.matchAll(citationGroupPattern())];
  // PER SET, after the last marker citing one of ITS indices, with any remaining marker groups
  // left in place rather than treated as a boundary — see the note at the slice below, which is
  // the correct home for that detail.
  //
  // Cutting at the ANSWER's last marker left the tail empty whenever any citation followed the
  // dangling name — ` [14]`, ` [17].`, `, an active order [14]` — and on this chart a trailing
  // chart citation is the ORDINARY form, measured on two live answers. So the rule was not merely
  // evadable; it was dormant on a large share of real answers. Swept: 35,010 resolving answers of
  // that family, 35,010 carrying a wrong rating.
  //
  // FIRST occurrences only, which is the same rule `claimTextByCitation` applies to a repeated
  // marker. Without it, repeating one of the set's own markers after the dangling name — a live
  // shape, "— see [350] above" — pushed the tail start past the leftover and the rule went
  // silent again.
  const firstRunEndOfIndex = new Map<number, number>();
  const firstRunStartOfIndex = new Map<number, number>();
  for (const run of markerRuns) {
    for (const index of parseCitationIndices(run[1])) {
      if (!firstRunEndOfIndex.has(index)) firstRunEndOfIndex.set(index, (run.index ?? 0) + run[0].length);
      if (!firstRunStartOfIndex.has(index)) firstRunStartOfIndex.set(index, run.index ?? 0);
    }
  }

  // The HEAD, mirroring the tail: everything before the FIRST marker citing one of the set's own
  // indices. A candidate named there and claimed by no citation of the set is a subject left
  // over BEFORE the markers, which is the same signature as one left over after them.
  //
  // This exists because the word lists could not close the class they were written for. A claim
  // whose subject sits in an earlier sentence names only the drug it is compared against, and
  // `stripExclusions` was extended with comparison markers to catch that — then measured: 11 of
  // 12 plausible rephrasings still rendered the wrong rating ("over", "compared with", "versus",
  // "beyond", "in contrast to", "relative to", "; X is milder", ", not X", "— X is the lesser
  // worry", "well above", "unlike"). A list of words cannot decide which drug a sentence is
  // ABOUT. What can be decided is whether some candidate the answer names has no citation
  // willing to claim it, and that is a fact about the whole answer rather than about phrasing.
  const headTextOfSet = new Map<string, string>();
  for (const setKey of new Set(trailing.setOfIndex.values())) {
    let upto = -1;
    for (const [index, end] of firstRunStartOfIndex) {
      if (trailing.setOfIndex.get(index) !== setKey) continue;
      // `min` — the FIRST own marker. Nothing discriminates this against `max`, and since the
      // interior rule landed nothing can: `max` would make the head [0, last own marker), which
      // is exactly this head plus the interior span, and both are scanned with the same predicate
      // into the same contest. The boundary only becomes observable again if the interior rule is
      // removed, which is where a test for it would have to go.
      upto = upto < 0 ? end : Math.min(upto, end);
    }
    // Stripped like a CLAIM is, unlike the tail — but only the LAST SENTENCE of the head, which
    // is the part that is the first citation's claim window.
    //
    // The strip has to reach that sentence: "Hydrocortisone aside, the order that matters is
    // Solu-Medrol … [350]" reads Hydrocortisone as a leftover subject otherwise, and refuses an
    // answer the strip exists to resolve. It must NOT reach further back, because an exclusion
    // clause in an EARLIER sentence is not about this claim, and stripping it there deleted the
    // subject: "No corticosteroid is safe here, except for Solu-Medrol 125mg/5ml, which is the
    // worst of them. The rise is above what Prednisone Co 5mg gives [350]" lost Solu-Medrol out
    // of the head and rendered Prednisone's rating. That was the last recorded open residual of
    // this class, and stripping by sentence rather than wholesale closes it for nothing — the
    // alternative measured four live ratings.
    const rawHead = upto < 0 ? '' : answer.slice(0, upto);
    const breaks = [...rawHead.matchAll(SENTENCE_END_GLOBAL)];
    const lastBreak = breaks[breaks.length - 1];
    // Bounding this at a LINE break as well as a sentence break was tried and REMOVED, and the
    // reason is worth the four lines. It looked necessary: in a newline-separated list — the shape
    // `ANSWER_BARE_LIST` is captured from — the head holds no sentence terminator, so this cut is
    // 0 and the strip runs over every line of it, which is how a clause on line 1 came to delete
    // the subject named on line 2 and render a MAJOR finding as Moderate. But what actually closed
    // that was giving {@link stripExclusions} its line breaks back, a few lines below: with those
    // intact, {@link EXCLUDED_NAME}'s horizontal-only bound stops an excluded name crossing a line
    // by itself. With the fix in place, mutating the line bound away leaves the whole suite green,
    // so nothing discriminated it — and an unpinned addition to a refusal rule is the exact shape
    // that twice this week turned out to change an election nobody intended.
    const cut = lastBreak === undefined ? 0 : (lastBreak.index ?? 0) + lastBreak[0].length;
    headTextOfSet.set(
      setKey,
      `${normalize(rawHead.slice(0, cut))} ${stripExclusions(normalizeKeepingLines(rawHead.slice(cut)))}`,
    );
  }

  const tailTextOfSet = new Map<string, string>();
  for (const setKey of new Set(trailing.setOfIndex.values())) {
    let from = -1;
    for (const [index, end] of firstRunEndOfIndex) {
      if (trailing.setOfIndex.get(index) === setKey) from = Math.max(from, end);
    }
    // Markers left in place. Deleting them from the tail was tried and nothing discriminates it:
    // the only case it could serve is a marker splitting a candidate's order display, and
    // `shortOrderDisplay` already offers the dose-stripped form as a lead, which matches either
    // way. The tail START skipping repeated markers is what actually mattered, above.
    tailTextOfSet.set(setKey, normalize(from < 0 ? '' : answer.slice(from)));
  }

  // Which index of each set its LAST marker cites. A tail that restates the last citation's own
  // subject is an ordinary flourish; a tail naming a candidate an EARLIER citation claimed is a
  // rotation closing on itself.
  const lastIndexOfSet = new Map<string, number>();
  {
    const seen = new Set<number>();
    for (const run of markerRuns) {
      for (const index of parseCitationIndices(run[1])) {
        if (seen.has(index)) continue;
        seen.add(index);
        const setKey = trailing.setOfIndex.get(index);
        if (setKey !== undefined) lastIndexOfSet.set(setKey, index);
      }
    }
  }

  const namedInHead = new Map<string, Set<AiSafetyWarning>>();
  for (const setKey of new Set(trailing.setOfIndex.values())) {
    const set = setCache.get(setKey);
    if (!set) continue;
    const text = headTextOfSet.get(setKey) ?? '';
    const found = new Set<AiSafetyWarning>();
    for (const group of set.groups) {
      for (const candidate of matchesInGroup(set.candidates, group.leadsPerCandidate, group.shared, text)) {
        // No exemption for a mention that carries a citation of its own. There WAS one, and it
        // was the whole of this rule's failure: it meant "some bracketed number sits within two
        // words of this name", which a trailing chart citation on an order display always
        // satisfies — and that is the form this module's own fixture carries verbatim
        // (`active order Methylprednisolone [177] [350]`) and the form the file elsewhere calls
        // "the ORDINARY form, measured on two live answers". So the leftover subject was exempted
        // on exactly the prose the rule was written for. Measured: 1,696 of 1,696 resolving
        // answers of that class carried a wrong rating, including one captured verbatim from the
        // running server, and NONE resolved correctly. The exemption also never checked WHOSE
        // marker it was — another drug's chart citation two words away exempted just as well, and
        // so did `[999]`, an index no payload ever sent.
        //
        // Its cost is real and paid deliberately: 5 live ratings, on `q1_mixed` and
        // `q6_interleaved`, where an answer names one family member with a chart citation and the
        // next with a finding citation. Two tests assert that refusal.
        found.add(candidate);
      }
    }
    namedInHead.set(setKey, found);
  }

  // The INTERIOR: between the set's first and last own markers. Head, interior and tail together
  // are the whole answer, and that is the point — the mirrored pair covered only OUTSIDE the
  // markers, and a leftover subject named BETWEEN two of them fell in the hole between the two
  // rules, where the two per-window objections that would otherwise see it are each switched off
  // by one ordinary feature of real prose: the unconfined backward window is bounded at the
  // previous marker of ANY kind, so a chart citation shields the subject from it, and the forward
  // claim is zeroed when the preceding own marker is closed by a full stop.
  //
  // Both of those are documented in this file as the ORDINARY live form. Only their conjunction
  // was untested, and it renders a rating with no objection firing at all — measured, "…active
  // order Dexamethasone [353]. She is also on Hydrocortisone Injection vial 100mg [14]. The
  // mechanism is the same CYP450 3A4 inhibition that raises Budesonide exposure [354]." puts
  // Budesonide's Major beside a sentence about Hydrocortisone. A 7,776-answer enumeration of the
  // class resolved 7,776 and every one carried a wrong rating.
  const namedInside = new Map<string, Set<AiSafetyWarning>>();
  for (const setKey of new Set(trailing.setOfIndex.values())) {
    const set = setCache.get(setKey);
    if (!set) continue;
    let lo = -1;
    let hi = -1;
    for (const [index, start] of firstRunStartOfIndex) {
      if (trailing.setOfIndex.get(index) !== setKey) continue;
      lo = lo < 0 ? start : Math.min(lo, start);
    }
    for (const [index, end] of firstRunEndOfIndex) {
      if (trailing.setOfIndex.get(index) !== setKey) continue;
      hi = Math.max(hi, end);
    }
    const text = lo < 0 || hi <= lo ? '' : normalize(answer.slice(lo, hi));
    const found = new Set<AiSafetyWarning>();
    for (const group of set.groups) {
      for (const candidate of matchesInGroup(set.candidates, group.leadsPerCandidate, group.shared, text)) {
        found.add(candidate);
      }
    }
    namedInside.set(setKey, found);
  }

  const namedInTail = new Map<string, Set<AiSafetyWarning>>();
  for (const setKey of new Set(trailing.setOfIndex.values())) {
    const set = setCache.get(setKey);
    if (!set) continue;
    const found = new Set<AiSafetyWarning>();
    for (const group of set.groups) {
      const text = tailTextOfSet.get(setKey) ?? '';
      for (const candidate of matchesInGroup(set.candidates, group.leadsPerCandidate, group.shared, text)) {
        found.add(candidate);
      }
    }
    // ANY candidate named in the tail counts, whatever the tail's grammar.
    //
    // Two narrower forms were tried and both let a rotation through. A token COUNT cannot work:
    // an unbridged candidate's only lead is its substance, so a tail carrying its ORDER DISPLAY
    // leaves "injection vial 100mg" behind, and any threshold low enough to catch that catches
    // real clauses too. A FUNCTION-WORD list — the idea that a dangling subject is a bare noun
    // phrase and a clause is prose — shipped for one cycle and was defeated by every tail with a
    // determiner in it: "Hydrocortisone Injection vial 100mg is the last of them." renders the
    // swapped pair, and so do four other phrasings of the same dangling name. A word list cannot
    // separate these because the distinction is grammatical and nothing here parses.
    //
    // So the tail is read without regard to its shape. The cost is real and is measured: 13 of the
    // 98 ratings this would otherwise render across the live corpus, on three answers whose
    // closing text names one of their own family's drugs for an unrelated reason. (This said the
    // cost was ZERO, which the README and one of the two tests it points at both contradict —
    // the zero was true of an earlier, narrower form of the rule and outlived it.) Against that:
    // the shape it catches resolved 35,010 answers of which 35,010 carried a wrong rating.
    namedInTail.set(setKey, found);
  }

  // -----------------------------------------------------------------------------------------
  // THE ONE RULE ABOUT RULES, before the objections start, because a maintainer adding one
  // reads this line and I did not have it to read.
  //
  // AND HOW TO MEASURE ONE, which is the other half and has cost more than the rules have. A
  // clean sweep is evidence about the inputs it ran on and nothing else. Twice on this file a
  // 400,000-seed run of the shipping distribution found nothing while a population SKEWED at the
  // shape found a wrong rating immediately — enlarging bought nothing, skewing bought both. And
  // the population that matters is often one the generator cannot express at all: the worst
  // defect here was invisible to every sweep because no generated answer ever wrote a rating word
  // into its prose. So before believing a clean result, say out loud what these inputs could not
  // have produced. That applies to a measurement as much as to a generator — a truth map keyed on
  // citation index is wrong by construction, because which finding an index refers to is exactly
  // what the prose decides.
  //
  // A RENDERED RATING IS ALWAYS THE TRAILING READING'S OWN ELECTION. Every rule from here down
  // may only SUPPRESS it. That is exact rather than aspirational: a value is produced in just
  // two places, both inside `readClaims` — the single-candidate shortcut and `electCandidate`'s
  // winner — and the assembly below re-emits `trailing.resolved` unchanged.
  //
  // The suppression machinery, counted rather than asserted, because the first version of this
  // paragraph said "all seven objections do nothing but `contested.add`" and that was wrong in
  // two ways. SIX sites add to `contested` (the two forward rules, the three spans, and the
  // block rule), and `contested` is read in exactly ONE place. The seventh of the seven
  // objections enumerated on {@link objectingSets} is "the trailing reading not being sound",
  // which is a gate on the same line as that read, not an add. And `answerStatesRating` below
  // is labelled the last objection while touching neither: it drops a single RESOLUTION rather
  // than withholding a set, which is why it is not one of the seven.
  //
  // So a rule whose JOB is to refuse must not touch the two inputs to that election — the
  // candidate list and the claim text. Suppressing cannot invent a rating; changing an input
  // can, and it does not look like it can, which is the whole problem. Twice now:
  //
  //   - A clause was deleted for making objections fire less often. True, and the direction
  //     argument was right — but it also emptied the forward windows that nine OTHER tests used
  //     to discriminate the tail and interior rules, and they all still passed. See the
  //     terminator clause, in the forward branch of `claimTextByCitation`.
  //   - `answerStatesRating` was first written to drop findings from the candidate list. Same
  //     class closed, corpus happy, suite and 400,000 seeds green — and a shorter candidate list
  //     changes what `discriminatingLeads` counts as shared by all, so a window that had
  //     honestly elected nobody elected somebody. It rendered a swapped pair.
  //
  // The two rules that MAY change an election are the two whose stated purpose is to: the
  // candidate list comes from the payload in `candidateSetFor`, and `stripExclusions` rewrites
  // claim text on purpose, with its own measured history of what that costs. Nothing else.
  // -----------------------------------------------------------------------------------------
  const contested = new Set<string>();
  for (const [index, setKey] of trailing.setOfIndex) {
    // The forward reading disagrees about THIS index — a permutation within the same findings.
    //
    // It has to be the UNCONFINED forward reading, and this rule has to exist separately from
    // the NAMED one below, because on a multi-line answer nothing else can object. A trailing
    // marker there sits at end-of-line, so a line-confined forward window is empty; and a
    // permutation is invisible to the NAMED rule by construction, since every finding the
    // forward reading names IS claimed by trailing, merely for a different index. `block` reads
    // the same direction as trailing and agrees with it.
    //
    // Two answers were measured resolving wrong with this rule missing or too strict, both
    // against the shipped fixture and both a SWAPPED PAIR or worse — never a missing badge:
    //
    //   "Hydrocortisone aside, the order that matters most is [350]
    //    Solu-Medrol 125mg/5ml [354]
    //    Hydrocortisone Injection vial 100mg"
    //     -> {350: Moderate, 354: Major}, truth {350: Major, 354: Moderate}
    //
    //   the same shape at five items with a dangling last line naming two partners
    //     -> all five ratings the neighbouring finding's
    //
    // The first needed the rule to consult the unconfined reading at all; the second needed
    // {@link objectingSets}, because the forward reading elected correctly for four of five
    // citations and losing completeness on the fifth had been barring it from objecting.
    if (soundTrailing.has(setKey) && objectingBlockLeading.has(setKey)) {
      // No `forwardElected` guard: on a reading that named a candidate at every cited citation,
      // an index that still elected NOBODY named two, and that ambiguity is itself a reason to
      // doubt the confined reading's confidence rather than something to pass over.
      if (trailing.electedOf.get(index) !== blockLeading.electedOf.get(index)) contested.add(setKey);
    }

    // Or the forward reading NAMES a finding the trailing reading claims for no citation of this
    // set. That is not a shift artifact; it is a genuine alternative parse, so the layout does
    // not determine the mapping. Live: a single marker-written-before-its-drug line among
    // trailing ones was read backwards, uncontested — "Hydrocortisone aside, the order that
    // matters most is [350] Solu-Medrol 125mg/5ml…" badged the MAJOR Methylprednisolone finding
    // as Moderate, scavenging Hydrocortisone's rating from the lead-in, next to a correctly-
    // badged Major.
    //
    // NAMED, not elected. `electCandidate` returns null both for "this window named nobody" and
    // for "this window named two candidates", so keying the contest on an ELECTION silenced it
    // in exactly the second case — and the trailing reading's election, scavenged from a
    // lead-in, then stood. Measured: one extra clause naming a second candidate flipped a
    // correct refusal into a wrong rating.
    //
    // NOTHING WITNESSES THIS RULE, and the number is worth having exactly: instrumented over a
    // 400,000-answer sweep it contests 268,874 of them and is the SOLE objection on ZERO. The
    // suite is green without it, the 46-answer corpus does not move, and 400,000 seeds find no
    // violation. Two tests are still NAMED for it — `refuses where shift-consistency is the ONLY
    // rule that can object` and its neighbour — and both are now over-determined: they were
    // written before the three leftover-subject rules existed, and those rules object on their
    // shapes too. Their names are the stale part, not their assertions.
    //
    // The subsumption has a structural reason rather than being a coincidence of the generator.
    // This rule asks "is a name in a CLAIM WINDOW unclaimed by any citation of the set", and the
    // three leftover-subject rules below ask the same question of the head, the interior and the
    // tail — which together are the whole answer. Every claim window is a substring of one of
    // them, so a name this rule can see is a name they can see.
    //
    // Kept regardless, and the direction is why: an objection ADDS refusals, so deleting a
    // redundant one can only make refusals fire LESS often, and this cycle measured what that
    // costs. Removing the terminator rule — also redundant, also green, also corpus-neutral —
    // silently un-pinned this rule and the block rule below by destroying their sole witnesses,
    // and the suite reported nothing. Redundancy on every input this repo can produce is not
    // evidence about the input it cannot. Keeping it costs nothing but this paragraph.
    for (const named of blockLeading.namedOf.get(index) ?? []) {
      if (!claimedByTrailing.get(setKey)?.has(named)) contested.add(setKey);
    }

    // Or a candidate of this set is named past the SET'S last own-index marker (first
    // occurrences only) and is not the last citation's own election.
    //
    // Not the ANSWER's last marker: that version left the tail empty whenever any citation
    // followed the dangling name, and a trailing chart citation is the ordinary form on this
    // chart — 35,010 resolving answers of that family, all wrong. Three docs and a describe name
    // still said "past the answer's last marker" after the code stopped doing it.
    //
    // A candidate there is a subject left over with nothing to cite it — the shift signature —
    // and asking it of the tail rather than of a claim window is what makes it proof against the
    // two things that hid it before: a foreign marker truncating a forward window, and a full
    // stop closing one.
    //
    // A candidate in the tail objects unless it is the LAST citation's own subject restated.
    //
    // Testing only "claimed by nobody" was not enough, and the gap is the same one that defeats
    // rule 2: a rotation CLOSED by a lead-in naming the last partner claims every candidate, so
    // the leftover is claimed — at the wrong index — and the rule fell silent. Measured, that
    // shipped a swapped pair off an answer one character away from refusing:
    //
    //   "Hydrocortisone Injection vial 100mg is the lesser worry, but the greater one is [350].
    //    Solu-Medrol 125mg/5ml [354]
    //    Hydrocortisone Injection vial 100mg"
    //
    // rendered {350: Moderate, 354: Major} against {350: Major, 354: Moderate}; delete the full
    // stop and it refuses. Across 26,766 resolving answers of that family EVERY one carried a
    // wrong rating — the class has no correct resolutions at all.
    //
    // Nor is "any candidate in the tail" right: a live answer restates its own subject there
    // ("Methylprednisolone [350]\n  Solu-Medrol 125mg/5ml"), and contesting that costs a real
    // rating. So the test is: anything but the LAST citation's own election objects — which
    // covers a candidate no citation claimed at all, since that is not the last one's either.
    //
    // KNOWN LIMIT, and the sharpest one left: THIS RULE HAS NO TAIL TO READ WHEN THE ANSWER ENDS
    // ON ITS LAST MARKER. Then the closed-rotation protection below is simply absent, and nothing
    // else covers it — the forward window of that last citation is empty so the disagreement rule
    // is barred set-wide, `block` reads the same span as trailing and agrees, and a lead-in that
    // names a partner WITHOUT excluding it leaves that partner claimed, so the head rule is
    // satisfied too. Measured on the committed fixture:
    //
    //   "In addition to Hydrocortisone Injection vial 100mg, the greater worry is [350].
    //    Solu-Medrol 125mg/5ml [354]"
    //     -> {350: Moderate, 354: Major}
    //
    // Add one dangling name after that last marker and the same answer refuses — that is the
    // committed test one describe below. So the module's verdict on this shape depends on whether
    // it can SEE the tail, not on how ambiguous the prose is.
    //
    // Left open, and this is a judgement rather than a measurement: the two readings really do
    // disagree here (the full stop after [350] argues the marker takes the lead-in's partner; the
    // next line argues it takes Solu-Medrol), so there is no truth to check a fix against, and
    // a rule built on the wrong choice of truth would render wrong ratings rather than blanks.
    // An adversarial sweep reached this shape and declined to file it for that reason. What it did
    // not establish, and what is recorded here because it changes the picture: the hole does NOT
    // need self-contradicting prose. "In addition to X" is an ordinary, coherent lead-in, so
    // ambiguity of the prose is not what is standing in for the missing rule.
    const lastClaim = trailing.electedOf.get(lastIndexOfSet.get(setKey) ?? -1);
    for (const named of namedInTail.get(setKey) ?? []) {
      if (named !== lastClaim) contested.add(setKey);
    }

    // KNOWN RESIDUAL, now down to ONE sentence shape. Where a LEADING exclusion form names the
    // subject and contradicts itself about it WITHIN THE SAME SENTENCE — "Nothing other than
    // Solu-Medrol 125mg/5ml: that order drives the rise, well above what Prednisone Co 5mg gives
    // [350]" — the strip removes the subject from that sentence and the rule cannot see it.
    //
    // The two-sentence form of this ("… which is the worst of them. The rise is above …") IS
    // closed, by stripping only the head's last sentence rather than the whole head, and that
    // cost nothing. What is left needs the strip not to run on the marker's own sentence at all,
    // which measured four live ratings (`r8_apartfrom`, an earlier cycle's recovery). Left open
    // deliberately: the prose excludes a drug and then calls it the worst in the same breath, and
    // paying four correct ratings for self-contradicting text is the wrong trade.
    //
    // KNOWN COST, measured and left open. A candidate named in the head or the interior is judged
    // a leftover when no citation OF THIS MEASUREMENT claims it — and an answer that states one
    // finding's rating in prose makes exactly that happen to the rest, because the backend then
    // drops that finding's citation from the list. Live shape:
    //
    //   "…it interacts with active order Methylprednisolone [350], which is a Major interaction;
    //    it interacts with active order Prednisone [352]; and … Dexamethasone [353]."
    //     unstated [352, 353] -> refused; the same answer without the rating clause, with all
    //     three listed, resolves all three correctly.
    //
    // Methylprednisolone is named with a citation of its own, just not one this measurement is
    // about, so it reads as a subject left over and the two ratings that ARE asked for are
    // withheld with it. Realistic — a model stating one rating and not the others is the shape
    // `unstatedFindingSeverities` exists to report. No live corpus answer resolves through it, so
    // the cost is not in the 46.
    //
    // Not fixed here on purpose. The fix is to treat a candidate claimed by a same-family citation
    // OUTSIDE the measurement as accounted for, which adds resolutions — the unsafe direction, on
    // a safety rule, and twice this week a change in that direction on this file turned out to
    // manufacture a wrong rating. It wants a cycle of its own with the corpus and a skewed sweep
    // behind it.
    //
    // Or the mirror: a candidate named BEFORE the set's first marker that no citation of the set
    // claims. In a trailing-written answer the head holds the first citation's own subject and it
    // IS claimed, so this stays quiet; where the subject sits in an earlier sentence and the
    // claim names only what it is compared against, the subject is in the head with nothing to
    // claim it.
    const claimedAnywhere = claimedByTrailing.get(setKey);
    for (const named of namedInHead.get(setKey) ?? []) {
      if (!claimedAnywhere?.has(named)) contested.add(setKey);
    }
    for (const named of namedInside.get(setKey) ?? []) {
      if (!claimedAnywhere?.has(named)) contested.add(setKey);
    }

    // Or the wider, unconfined BACKWARD window no longer singles out what the line-confined one
    // elected. This is the check that survives a forward reading with nothing to say, and it has
    // nothing to say in exactly the layouts that break the confined backward one: across a
    // 40-answer subset of the capture (counted before THE CORPUS was fixed at 46), a finding
    // marker sits at end-of-line 54 times and is followed by a sentence
    // terminator 151 times, and a marker closed by a terminator has its forward claim zeroed
    // outright by the terminator clause in `claimTextByCitation`'s forward branch.
    //
    // Its witness is `refuses a swapped pair only the unconfined backward reading can see`, which
    // renders {351: Moderate, 352: Major} against a truth of {351: Major, 352: Moderate} with
    // this line disabled — a swapped pair, and this is the only objection that fires on it. That
    // test was added late: for a while the rule had no named coverage at all and the seeded sweep
    // was the whole of it, which is not a name a maintainer can search for before deleting a line
    // that looks redundant.
    const confined = trailing.electedOf.get(index);
    if (block.electedOf.get(index) !== confined) contested.add(setKey);
  }

  const resolved = new Map<number, string>();
  const normalizedAnswer = normalize(answer);
  for (const [index, setKey] of trailing.setOfIndex) {
    if (!soundTrailing.has(setKey) || contested.has(setKey)) continue;
    const severity = trailing.resolved.get(index);
    if (severity === undefined) continue;
    // Last objection, and the only one that consults the payload's contract rather than the
    // prose: a rating the answer already states cannot belong to a citation the backend listed as
    // unstated. Applied HERE, on the resolution, rather than upstream on the candidate list —
    // see {@link answerStatesRating} for the swapped pair that distinction cost.
    if (answerStatesRating(normalizedAnswer, severity)) continue;
    resolved.set(index, severity);
  }
  return resolved;
}
