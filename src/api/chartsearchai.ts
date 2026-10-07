import { openmrsFetch, restBaseUrl } from '@openmrs/esm-framework';

const BASE_PATH = `${restBaseUrl}/chartsearchai`;

/**
 * Error code emitted via {@code onError} for every way an expired session surfaces on the SSE
 * endpoint: the 302 opaque redirect, a bare 401/403, and the committed-redirect 500. It is a stable
 * code, NOT a display string — user-facing text must be localized in a component (the translation
 * extractor only scans {@code *.component.tsx}). {@code AiResponsePanel} maps this to a translated
 * message.
 */
export const SESSION_EXPIRED_ERROR_CODE = 'chartsearchai:session-expired';

export interface AiReference {
  index: number;
  /** Stable evidence-ledger id supplied by med-agent-hub. */
  sourceId?: string;
  resourceType: string;
  /**
   * OpenMRS UUID of the cited record (the backend serializes this field as `resourceUuid`).
   * Used to locate and highlight the record's row after navigating to its chart page.
   */
  resourceUuid: string;
  date: string;
  /** Resolved source record text, when supplied by the hub staged path. */
  sourceText?: string;
  /** Human-readable source title supplied by the evidence ledger. */
  title?: string;
  /** Whether the citation index resolved to a record in this turn's evidence ledger. */
  resolutionStatus?: 'resolved' | 'unresolved';
  /** Answer, In-Depth, or table locations that used this source. */
  usage?: Array<{ location: string; text: string; path?: string }>;

  /**
   * Citation grounding verdict from the backend: true = the cited record
   * supports the claim, false = it does not, null/absent = unverified.
   * Never render null as "verified".
   *
   * This client renders NO badge for it, and was drawing none at the base commit either. The harm
   * the backend names — mislabelling an unverified citation as verified — is avoided that way.
   *
   * What the backend asks is narrower than this doc used to claim, and it differs by GROUP, which
   * the single sentence here flattened. For a **chart**-group citation it asks that `false` and
   * `null` both be surfaced as unverified — and says in the same breath that it withholds the
   * verdict "because it must not assert what it has not established, not because it is relying on
   * a particular rendering", so "a neutral badge is the render it asks for" was this file's
   * invention rather than the backend's request. For a **reference**-group citation, where
   * `grounded` is ALWAYS null, it asks for the opposite reading: treat null as "grounding does not
   * apply", not as "unverified evidence" — a client that read it as unverified badged a
   * deterministic Major-interaction finding *"Unsupported"*, which is the issue that made the
   * field stop being published there. So a client that renders every null as unverified would be
   * wrong on exactly the citations this feature is about.
   *
   * `null` does not mean one thing, and two of its causes are not "verification was tried
   * and failed": a {@link group} of `reference` is always null (there is no way to vouch for
   * an answer that recites reference prose), and so is a citation the module attached
   * ({@link attachedByTheModule}), where the module attached no claim for grounding to ask
   * about. The rest are: grounding disabled, this citation not checked, or checked and not
   * certifiable. So do not render any null as evidence that the module tried.
   */
  grounded?: boolean | null;
  /**
   * Lifecycle/status for citation grounding. `checking` means the backend has resolved
   * the source record but final support verification is still running.
   */
  groundingStatus?: 'checking' | 'verified' | 'unsupported' | 'unchecked' | 'mixed';
  /** Whether support was evaluated from this record alone or a cited source set. */
  groundingScope?: 'record' | 'source_set';
  /** Citation indices evaluated together when groundingScope is source_set. */
  groundingGroup?: number[];
  /** Claim/path-level verdicts retained when one record is used more than once. */
  groundingChecks?: Array<{
    status: 'verified' | 'unsupported' | 'unchecked';
    claim: string;
    location: string;
    path?: string;
    source_indices: number[];
  }>;

  /**
   * Which corpus the cited record came from: `chart` = the patient's own record,
   * `reference` = module-supplied reference material (a drug-reference entry, a
   * safety finding, a drug-class note), which has no chart page to navigate to.
   * Optional so a response predating the field still parses — {@link isReferenceData} accepts
   * either signal, so a `reference` type this client predates is still recognised by its group.
   */
  group?: string | null;
  /**
   * Whether the MODULE attached this citation rather than the model emitting it — true for
   * a chart record that an injected safety finding the model *did* cite was derived from
   * (the recorded allergy or condition whose match raised it).
   *
   * Two consequences a client must handle, neither derivable from any other field:
   * the answer prose carries NO `[N]` marker for such a citation, so a reference list
   * built by scanning the answer text drops it silently; and its {@link grounded} is
   * always null, which here is "there was no claim to verify" rather than "verification
   * failed" — the module attached no claim. `chart` group + no marker + `grounded: null`
   * do NOT together identify a module-supplied citation, which is why this key exists.
   */
  attachedByTheModule?: boolean | null;
  /**
   * The citation indexes of the cited findings this record was attached FOR — the safety findings
   * whose match fired on it, e.g. `[46]`. Empty for a citation the model emitted; absent from a
   * backend that predates the key. Rendered as "source of [46]".
   */
  attachedFor?: number[] | null;
  /**
   * The dataset the cited record's content came from — e.g. `DDInter 2.0 (via
   * openmrs-ddi-knowledge-base)` for a drug-reference entry — and null for a chart record and for
   * the module's own computed finding. The backend: branch on the value, never on `group`.
   */
  source?: string | null;
  /**
   * How many of the cited record's interaction partners the record does not show; 0 when it shows
   * them all. The backend asks for "the citation shows a subset", never "omitted for length": a
   * large count normally means the rest are not relevant to this patient.
   */
  withheldInteractions?: number | null;
}

/**
 * A non-blocking drug-safety advisory raised by the backend's post-answer validator
 * (only when the optional drug-reference feature is enabled). It annotates the answer
 * — it never alters it. Rendered as a chip below the answer.
 */
export interface AiSafetyWarning {
  /** 'overdose' | 'interaction' | 'contraindication' */
  type: string;
  /** the reference drug the warning is about */
  drug: string;
  /** human-readable detail, e.g. "interacts with active order warfarin" */
  detail: string;
  /**
   * The rating the loaded reference dataset assigns the rule this warning was raised from,
   * verbatim and unnormalized — the dataset's rating, NOT the module's advice, and never a
   * statement about what the rating licenses clinically.
   *
   * null where the finding carries no rating: a contraindication, an overdose and an
   * ATC-class or cross-reactivity join carry none by construction, AND a hand-authored rule
   * usually omits it — every interaction rule in the module's own bundled curated seed does.
   * So `severity: null` on an `interaction` chip is a statement, not a missing field.
   *
   * Not a closed vocabulary: the bundled knowledge base publishes Major/Moderate/Minor/Unknown
   * but an operator's dataset supplies its own words, so compare case-insensitively after
   * trimming and treat an unrecognised value as unrated rather than as a floor. Read this
   * field; never parse the rating back out of {@link detail}.
   */
  severity?: string | null;
  /**
   * Which of this patient's own active orders each substance the chip names was resolved from,
   * where that order's displayed name does not reach the substance. Empty means nothing on
   * this chip was attributed — common, and not an error.
   *
   * Published as typed fields rather than left inside {@link detail} so a client is handed two
   * strings instead of a sentence to parse. It is the reason a chip can name `Methylprednisolone`
   * while the answer names the same prescription `Solu-Medrol 125mg/5ml`, and it is what lets
   * `resolveFindingSeverities` (in `utils/safety-disclosure.ts`, not imported here, so a
   * `{@link}` to it would not resolve) recognises a finding in the answer's own words whichever
   * vocabulary the answer used.
   *
   * It is a resolution the MODULE performed — say "resolved from", never that the prescription
   * *is* that substance, and never that the chart records those substances.
   */
  chartOrderBridges?: AiChartOrderBridge[] | null;
  /**
   * Whether the module raised this chip from one of the patient's own active orders, so that it is
   * about a medication the patient is already taking rather than a drug a question proposed.
   *
   * Nothing else on the chip says so: the backend keeps {@link detail} the same words either way
   * (openmrs-module-chartsearchai#527; #535 put this key on the wire). Only `true` is rendered.
   * `false` is NOT a statement that the patient is off the drug — among others it is the answer
   * for a drug the question named, even one the patient takes — and a backend that predates the
   * key sends nothing, which reads the same as `false`.
   *
   * {@link drug} is the substance the module matched the order to, which the order's own name need
   * not spell, so a rendering of `true` must not name the drug in that claim.
   */
  aboutACurrentMedication?: boolean;
  /**
   * Which of the patient's own active orders a contraindication chip about a medication she already
   * takes is about (openmrs-module-chartsearchai#552), each as her chart displays it — her *Advil
   * 400mg* on a chip whose {@link drug} is `Ibuprofen`. Name the order from here rather than
   * resolving {@link drug} against her orders. Empty on every other chip; absent from a backend
   * that predates the key.
   */
  currentMedicationOrders?: Array<{ orderDisplay?: string | null; orderUuid?: string | null }>;
  /**
   * Whether this chip is about a drug the chart records only as an order no longer in force
   * (openmrs-module-chartsearchai#472): a finding about what giving that drug again would mean, not
   * about a medication the patient is taking now. The backend keeps it and
   * {@link aboutACurrentMedication} exclusive, so the two are rendered as different marks.
   *
   * Only `true` is rendered. `false` is NOT a statement that the drug is current — it is also the
   * answer for a drug a question proposes, for every chip the other checks raise, and wherever the
   * module could not rule out that the patient is on it — and a backend that predates the key
   * sends nothing, which reads the same as `false`.
   */
  aboutAnEndedOrder?: boolean;
  /**
   * Whether this chip is about one of the patient's own medications OTHER than the drug the
   * response is about: a contraindication raised by checking one of her prescriptions against her
   * own records, on a response that put another drug in play. {@link aboutACurrentMedication}
   * cannot say it, since that is also `true` for a drug the question names that she takes — which
   * is what was asked.
   *
   * Only `true` is rendered, as a chip drawn apart from the findings about the drug in question.
   * `false` is NOT a claim the chip is about that drug, and a backend that predates the key sends
   * nothing, which reads the same as `false`.
   */
  aboutAnotherOfHerMedications?: boolean;
  /**
   * Whether this chip is about a drug OTHER than the one the question proposes (backend ADR
   * Decision 137): the question proposes a drug and this chip's subject is not of it — wider than
   * {@link aboutAnotherOfHerMedications}, since a drug only the question lists is not her
   * prescription. Only `true` is rendered, as a chip drawn apart from the findings about the drug
   * asked about. `false` is NOT a claim it is about that drug, and a backend that predates the key
   * sends nothing.
   */
  aboutADrugOtherThanTheOneProposed?: boolean;
  /**
   * The record number this chip's own finding has in the prompt — the `index` of the
   * `safety_finding` reference an answer's marker cites — or `null` where no single record is it
   * (backend ADR Decision 138). The join from a chip to its citation where several findings share
   * one key.
   */
  findingCitation?: number | null;
  /**
   * The day the ended order behind {@link aboutAnEndedOrder} stopped being in force, `yyyy-MM-dd`,
   * or `null` — on every chip answering `false`, and on one whose ended records carry no stop date.
   * Of several ended orders of the drug, the latest. A UTC calendar date, so it can be a day off
   * the local one: never render it as more exact than a day.
   */
  endedOrderStopDate?: string | null;
  /**
   * Whether the answer itself already states this finding (openmrs-module-chartsearchai ADR
   * Decision 124): on a question asking only for the patient's allergies, the backend appends her
   * conflicting order's name and this chip's own {@link detail} to the answer. A `true` chip is not
   * drawn again. `false` says nothing about the answer's prose, and a backend that predates the key
   * sends nothing, which reads the same as `false`.
   */
  statedInTheAnswer?: boolean;
  /**
   * The active orders this finding names as its partners, in the backend's own spelling
   * (`["Metoclopramide"]`); empty or absent for a finding with no partner, such as an allergy.
   * Read by the compact chip, which names the partner on one line where the detail is collapsed.
   */
  namedPartners?: string[] | null;
}

/** One rating the backend found attached to, or missing from, a cited safety finding. */
export interface AiCitedRating {
  citation: number;
  rating: string;
}

/**
 * Whether each "X interacts with active order Y" claim in the answer names a pair the module's
 * findings relate (backend #514). `null` on the response is no measurement.
 */
export interface AiInteractionClaimPairs {
  judged: number;
  misattributedCitations: number[];
  unfounded: number;
}

/**
 * When one cited prescription stopped being in force (openmrs-module-chartsearchai#315, #432).
 *
 * `citation` is the {@link AiReference.index} it belongs to. `stopDate` is the ORDER's own end,
 * `yyyy-MM-dd` in UTC, and not the record's clinical {@link AiReference.date}: the two are
 * different facts, and one must never be shown in place of the other.
 */
export interface AiOrderStopDate {
  citation: number;
  stopDate: string;
}

/**
 * One `(substance, orderDisplay)` correspondence on a safety warning.
 *
 * The backend asks a client to render this beside the chip and not to parse it apart. This one
 * does neither yet, and the doc said the opposite of both: display is deferred (the repo README's
 * *Not rendered* section says so), and `shortOrderDisplay` (module-private in
 * `utils/safety-disclosure.ts`) does split `orderDisplay` on
 * whitespace to drop trailing dose tokens, because a live chart's `Vitamin B12 1000mcg` matched
 * nothing as a whole string. The severity join reads it in both the full and the dose-stripped
 * form.
 *
 * Not "the strongest" of that join's leads, which this said for a while: there is no strongest.
 * The three lead groups are read order-free and can only corroborate or contradict, never outrank
 * — reversing the array changes no behaviour, and `candidateLeadTiers` says so where they are
 * built. This group is the one with the best VOCABULARY match, because it carries the chart's
 * words and the knowledge base's both; that is a different claim from precedence.
 */
export interface AiChartOrderBridge {
  substance: string;
  orderDisplay: string;
}

/**
 * How bounded the interaction check that stated it was: the rule pairs it found above the
 * server's severity floor, and the number it reported. Where `reported < found` the list is
 * truncated (least severe dropped first) and has to say so, because silent truncation reads
 * as "nothing else was found".
 *
 * Two readings to keep apart. `found === reported` says that check withheld nothing — NOT
 * that the response is complete, which this field has never claimed. And a null/absent key
 * is the absence of a measurement, never a statement that nothing was found.
 *
 * It counts drug PAIRS, not the warnings beside it: a response can legitimately carry more
 * safety warnings than this states pairs, so never derive the ratio by counting chips.
 */
export interface AiInteractionPairs {
  found: number;
  reported: number;
}

/**
 * Whether the loaded drug-reference dataset can run the CONDITION arm of the
 * contraindication screen at all.
 *
 * `absent` = a dataset was read and no entry carries a condition rule, so the arm cannot
 * fire; `unloaded` = nothing was read, so nothing is known. Those two must not be collapsed —
 * "we looked and there is none" is not "nobody looked". `published` says the DATASET can run
 * the arm and is deliberately NOT a claim that any recorded condition was screened.
 */
export type ConditionRuleCoverage = 'absent' | 'published' | 'unloaded';

/**
 * How many claims about the patient's ACTIVE ORDERS the answer made, and how many of them
 * offered no chart record as evidence.
 *
 * This is what makes {@link AiSearchResponse.misattributedOrderCitations} readable, and the
 * backend says so: without it that key's `[]` is two responses a client cannot tell apart — an
 * answer whose active-order claims all cited chart records that were accepted, and an answer
 * that cited no chart record for any of them. Both have been recorded on one patient and one
 * question, with `misattributedOrderCitations` reading `[]` in each.
 *
 * So `uncited` is the number that carries the warning, and `stated` is what makes it a ratio
 * rather than a bare count. `uncited === 0` says every such claim offered SOME chart record —
 * never that the record was the right one, which is the neighbouring key's business and which it
 * cannot certify either.
 */
export interface AiActiveOrderClaims {
  stated: number;
  uncited: number;
}

/**
 * Honest drug-safety check state: `checked` = the full check ran against real reference data and
 * a real patient context; `limited` = only a subset of checks ran; `unavailable` = the check could
 * not run at all (no patient context, or the policy has drug safety disabled). An empty
 * `safetyWarnings` list must never be read as `checked` on its own.
 */
export type AiSafetyStatus = 'checked' | 'limited' | 'unavailable';

export interface AiSafetyReferencePackage {
  id?: string;
  source_format?: string;
  version?: string;
  provenance?: unknown;
  review_state?: 'proposed' | 'evidence_curated' | 'clinically_approved' | 'retired' | string;
  issues?: string[];
}

/** Provenance and coverage for the deterministic medication-safety pass. */
export interface AiSafetyCheck {
  schema_version?: 'drug_safety.v1' | string;
  status: AiSafetyStatus;
  warnings?: AiSafetyWarning[];
  package?: AiSafetyReferencePackage & {
    cross_reactivity_review_state?: string;
    cross_reactivity?: AiSafetyReferencePackage;
  };
  coverage?: {
    mapping_complete?: boolean;
    exposure_complete?: boolean;
    execution_complete?: boolean;
    active_order_count?: number;
    mapped_active_order_count?: number;
  };
  identity_confidence?: 'high' | 'limited' | 'unavailable' | string;
  issues?: string[];
}

export interface AiCell {
  text: string;
  refs?: number[];
}

export interface AiTableColumn {
  key: string;
  label: string;
}

export interface AiTableBlock {
  kind: 'table';
  title?: string;
  columns: AiTableColumn[];
  rows: Array<{ cells: Record<string, AiCell> }>;
}

export type AiBlock = AiTableBlock;

/** One section's validator confidence: a traffic-light level + an optional caveat note. */
export interface AiConfidenceSection {
  level: 'green' | 'yellow' | 'red';
  note?: string;
}

/**
 * Per-section confidence metadata emitted by the selected med-agent-hub profile.
 */
export interface AiConfidence {
  answer?: AiConfidenceSection;
  in_depth?: AiConfidenceSection;
}

export interface AiInDepth {
  status: 'pending' | 'complete' | 'failed' | 'needs_review';
  answer?: string;
  error?: string;
  validation?: {
    status?: 'checked' | 'edited' | 'needs_review' | 'unavailable';
    review_status?: 'checked' | 'edited' | 'needs_review' | 'unavailable';
    summary?: string;
    [key: string]: unknown;
  };
  /** Pre-check model claims rendered for review. Never the shipped answer. */
  reviewDraft?: string;
  /** References resolved specifically for reviewDraft; kept separate from final answer evidence. */
  reviewReferences?: AiReference[];
}

type AiInDepthEvent = Partial<AiSearchResponse> & { messageId?: string; inDepth: AiInDepth };

export type AiAnswerValidationStatus = 'checking' | 'checked' | 'edited' | 'needs_review' | 'unavailable';

export interface AiAnswerValidation {
  status: AiAnswerValidationStatus;
  label: string;
  summary?: string;
  issues?: unknown[];
  completedAt?: string;
  originalAnswer?: string;
  /** References resolved for originalAnswer; never substitute the final answer's references. */
  originalReferences?: AiReference[];
  /** Pre-check table/list blocks. Review-only and never part of the shipped answer blocks. */
  originalBlocks?: AiBlock[];
}

export interface AiSearchResponse {
  answer: string;
  references: AiReference[];
  /** Empty/absent unless the optional drug-reference feature is enabled on the server. */
  safetyWarnings?: AiSafetyWarning[];
  /** checked/limited/unavailable — present alongside safetyWarnings, even when it's empty. */
  safetyStatus?: AiSafetyStatus;
  /** Canonical safety result with source identity, coverage, and limitation reasons. */
  safetyCheck?: AiSafetyCheck;
  blocks?: AiBlock[];
  /** Numeric OpenMRS audit row id used only for feedback. */
  auditLogId?: number;
  /** Server-side conversation handle. Present on chat responses only. */
  session?: string;
  /** Server-assigned uuid for the assistant message row. Present on chat responses only. */
  messageId?: string;
  /** Product profile id that produced this answer. */
  resolvedModel?: string;
  /** Per-section check confidence (green/yellow/red + note) from checked hub profiles. */
  confidence?: AiConfidence;
  /** Clinician-facing answer check lifecycle for staged checked responses. */
  answerValidation?: AiAnswerValidation;
  /** In-Depth analysis attached after the direct answer settles. */
  inDepth?: AiInDepth;
  /**
   * Citation indices the answer offered as evidence of an active drug order that CANNOT be
   * one — a condition, a visit, an encounter, or an order the chart says is no longer in
   * force. Render as "this citation cannot be the order named", never as "this claim is
   * unsupported": the finding behind the sentence is deterministic and typically correct;
   * it is the chart evidence attached to it that is wrong.
   *
   * An EMPTY array is not a certificate that the citations are sound. The check sees only an
   * answer that reproduces the module's own "interacts with active order" phrase, only the
   * markers directly following it, and it cannot tell a citation of the wrong in-force order
   * from a citation of the right one — so `[]` says the check ran and named none. Never
   * render a "citations verified" affordance off this field.
   */
  misattributedOrderCitations?: number[] | null;
  /**
   * Citation indices of safety findings whose rating the answer states NOWHERE, leaving a
   * clinician no way to rank a flat list of findings.
   *
   * The rating is NOT on this key, and the backend is explicit that it "cannot be joined to a
   * chip: chips carry no citation index, and `(type, drug)` does not identify one — a screening
   * question raises several findings sharing it". `resolveFindingSeverities` therefore
   * narrows to that candidate set and requires the answer's own sentence to single one out,
   * declining where it cannot.
   *
   * Render whatever it yields as a CAVEAT, never as a verdict: the backend documents three
   * measured cells where this key over-reports — a rating stated by synonym, a `minor` caution
   * the prompt never asked to be rated, and an operator dataset whose mechanism text happens to
   * contain the rating word.
   *
   * The check asks of the whole answer rather than of the citing sentence, so an answer that
   * states the rating anywhere is silent here — which is why rendering is gated on this list
   * rather than on severity being present.
   */
  unstatedFindingSeverities?: number[] | null;
  /** @see ConditionRuleCoverage */
  // `string & {}` rather than a bare `string`, which would collapse the union and discard the
  // literals — keeping them is what makes the renderer's switch checkable while still accepting
  // a verdict word this client predates.
  conditionRuleCoverage?: ConditionRuleCoverage | (string & {}) | null;
  /**
   * The same three-valued verdict for the loaded dataset's DOSE-CEILING arm: whether it publishes
   * an age-banded dose ceiling. Dose ceilings are the only thing the backend reads the patient's
   * AGE against, so `absent` or `unloaded` is what licenses saying her age was not checked. `null`
   * or absent (an older backend) states nothing, and never licenses that sentence.
   */
  doseCeilingCoverage?: ConditionRuleCoverage | (string & {}) | null;
  /**
   * The drugs the answer says have an order that is no longer in force where no chart record the
   * answer was built from marks an order of that drug as not in force (backend ADR Decision 135) —
   * a statement in the answer that nothing in the records supports, never a finding that the order
   * is in force. `[]` is a measurement of none and not a certificate (an answer saying "was
   * stopped" is not read); `null` or absent is no measurement.
   */
  unsupportedEndedOrderClaims?: string[] | null;
  /**
   * The citation indexes of the safety findings the answer cites whose record says the
   * interaction's clinical significance is unknown, where the answer says nothing of the kind
   * (backend ADR Decision 136). The finding's own caveat the answer left out, never a correction of
   * its rating. `[]` is not a certificate; `null` or absent is no measurement, which the early
   * `done` always is.
   */
  unstatedSignificanceQualifiers?: number[] | null;
  /** @see AiInteractionPairs */
  interactionPairs?: AiInteractionPairs | null;
  /** @see AiActiveOrderClaims */
  activeOrderClaims?: AiActiveOrderClaims | null;
  /**
   * When each cited prescription stopped being in force, one entry per cited chart record whose
   * order is out of force and has an end date to state. Rendered beside that citation: the answer
   * may say an order ended without saying when.
   *
   * An absent entry is never a claim that a cited order is still in force — an order can be out of
   * force with no end date anywhere — so `[]` is not a certificate of anything. `null` is no
   * measurement. Final on the early `done` under async grounding; the `grounded` event re-sends it.
   */
  orderStopDates?: AiOrderStopDate[] | null;
  /**
   * Ratings the answer attaches, in the sentence citing it, to a cited safety finding that carries
   * none (backend #560). `[]` found none; `null` is no measurement.
   */
  unfoundedFindingSeverities?: AiCitedRating[] | null;
  /**
   * Citations whose rendering in the answer the backend found unfaithful to the reference record
   * they point at (backend #337). `[]` named none — which is not a certificate of faithfulness —
   * and `null` is no measurement.
   */
  unfaithfullyRenderedCitations?: number[] | null;
  /**
   * Findings about the drug the answer's caution lead says can be given, where the finding's record
   * ends in a reason to withhold it. `[]` found none; `null` is no measurement.
   */
  cautionLedOverWithholding?: AiCitedRating[] | null;
  /** @see AiInteractionClaimPairs */
  interactionClaimPairs?: AiInteractionClaimPairs | null;
  /**
   * `true` where no model wrote the answer: the module composed it from its own safety findings
   * (backend `answeredByTheModule`). The keys that judge a model's prose then state `null`
   * because there was no prose to judge, not because a check failed. `false` says a model was
   * asked; it is no claim about the answer's quality.
   */
  answeredByTheModule?: boolean | null;
  /**
   * The record numbers of the findings the module's own sentence after a model's answer states
   * (backend ADR Decision 147) — a sentence citing no marker, so this is how a chip is joined to
   * it. `[]` stated none; `null` is no measurement, which is every answer the module wrote.
   */
  findingsStatedByTheModule?: number[] | null;
  /**
   * `true` where the question asked whether the patient has ever taken one drug (backend
   * `asksWhetherSheHasTakenADrug`, ADR Decision 156). The chips beside such an answer are about
   * that drug's place in her chart, not a reading of the question, so they are drawn apart.
   */
  asksWhetherSheHasTakenADrug?: boolean | null;
  questionId?: string;
}

/**
 * The response fields that state what a bounded safety answer did not cover. Declared once here,
 * on the wire type, and referenced by the chat message and the panel props so the three cannot
 * drift — in particular the reading that an empty array is not a certificate.
 *
 * FIVE now, not four. `activeOrderClaims` was added to the backend after this client's work on
 * the other four began, and it is not a sixth nice-to-have: it is the key that separates the two
 * readings of `misattributedOrderCitations: []`, so leaving it out left an already-rendered field
 * ambiguous in exactly the way that field's own doc warns about.
 *
 * `orderStopDates` is here too, though it states a date rather than a limit: it reaches the panel
 * by the same path, and riding this merge is what delivers it from `done` and `grounded` alike.
 */
export type AiAnswerLimits = Pick<
  AiSearchResponse,
  | 'misattributedOrderCitations'
  | 'unstatedFindingSeverities'
  | 'conditionRuleCoverage'
  | 'doseCeilingCoverage'
  | 'unsupportedEndedOrderClaims'
  | 'unstatedSignificanceQualifiers'
  | 'interactionPairs'
  | 'activeOrderClaims'
  | 'orderStopDates'
  | 'unfoundedFindingSeverities'
  | 'unfaithfullyRenderedCitations'
  | 'cautionLedOverWithholding'
  | 'interactionClaimPairs'
  | 'answeredByTheModule'
  | 'findingsStatedByTheModule'
  | 'asksWhetherSheHasTakenADrug'
>;

/**
 * What the trailing `grounded` SSE event re-sends. Under `chartsearchai.grounding.async=true`
 * the `done` event is emitted before validation runs, so it carries `safetyWarnings: []` and a
 * null for each measurement taken AFTER the answer — `interactionPairs`,
 * `misattributedOrderCitations`, `unstatedFindingSeverities` — and those arrive only here.
 *
 * Two exceptions to that, both of which a client must not gate on this event.
 * `conditionRuleCoverage` is read off the dataset load before the model is called, so it is
 * already final on the early `done` and is merely re-sent here. And on an answer-cache hit no
 * early `done` is emitted at all: the single `done` carries the replayed final answer, so every
 * field reads as the original request measured it and no `grounded` event follows.
 */
export type AiGroundedUpdate = Pick<AiSearchResponse, 'references' | 'safetyWarnings'> & AiAnswerLimits;

export type FeedbackRating = 'positive' | 'negative';

export interface AiFeedback {
  questionId: string;
  rating: FeedbackRating;
  comment?: string;
}

export interface AiSearchError {
  error: string;
}

/**
 * Pre-warms the server-side LLM prompt cache for the given patient. Fire-and-forget;
 * fired when the chart is opened so the first AI query skips full prefill cost. Pass
 * an AbortSignal to cancel an in-flight warmup when the user navigates to a different
 * patient before the previous warmup finished.
 */
export function warmupPatient(patientUuid: string, signal?: AbortSignal): void {
  openmrsFetch(`${BASE_PATH}/warmup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patient: patientUuid }),
    signal,
  }).catch(() => {
    // ignore — the user does not depend on this completing, and aborts are expected on patient
    // switch
  });
}

/**
 * Submits user feedback (thumbs up/down + optional comment) for an AI response.
 */
export async function submitFeedback(feedback: AiFeedback): Promise<void> {
  try {
    await openmrsFetch(`${BASE_PATH}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(feedback),
    });
  } catch (err) {
    console.error('[submitFeedback] Failed to submit feedback:', err);
    throw err;
  }
}

/**
 * Sends a synchronous AI search request.
 */
export async function searchPatientChart(
  patientUuid: string,
  question: string,
  abortController?: AbortController,
): Promise<AiSearchResponse> {
  const response = await openmrsFetch(`${BASE_PATH}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patient: patientUuid, question }),
    signal: abortController?.signal,
  });
  if (!response.data?.answer) {
    throw new Error('Unexpected response from server');
  }
  return response.data as AiSearchResponse;
}

/**
 * Opens an SSE (Server-Sent Events) stream for AI search.
 *
 * Uses raw fetch instead of openmrsFetch because openmrsFetch consumes
 * the response body to parse it as JSON, which prevents streaming.
 * We need direct access to response.body (the ReadableStream).
 */
export function searchPatientChartStream(
  patientUuid: string,
  question: string,
  callbacks: {
    onToken: (token: string) => void;
    onDone: (response: AiSearchResponse) => void;
    onError: (error: string) => void;
    /**
     * Early citations, emitted by the server the moment the answer's references are
     * known — before the (slower) grounding pass attaches verdicts. Lets the UI show
     * the citations immediately as unverified; the {@code done} event then re-sends
     * the same references with their grounding verdicts. Optional and best-effort: a
     * missing or malformed event is ignored, since {@code done} is authoritative.
     */
    onReferences?: (references: AiReference[]) => void;
    /**
     * Trailing grounding verdicts, emitted only when the server runs with
     * {@code chartsearchai.grounding.async=true}: in that mode {@code done} arrives as soon
     * as the answer is complete (its references carry no verdicts) and this event re-sends
     * the same references with their {@code grounded} verdicts once the (slower) Tier-2
     * verification finishes. Best-effort like {@code onReferences}: when the server runs in
     * classic mode the event never arrives and {@code done}'s references are already final;
     * a malformed payload just leaves citations rendered as unverified.
     *
     * It carries more than the verdicts: the final {@code safetyWarnings} and the answer-limit
     * measurements ({@code interactionPairs}, {@code misattributedOrderCitations},
     * {@code unstatedFindingSeverities}) are all null/empty on the early {@code done} in that
     * mode and arrive only here, so the whole payload is handed over rather than the
     * references alone.
     */
    onGrounded?: (update: AiGroundedUpdate) => void;
    /**
     * Live reasoning ("thinking") chunks, streamed by the server before the answer so the
     * UI can show progress and the model's rationale instead of a dead spinner during the
     * reasoning phase. Scratchpad only — render distinctly (subdued, transient), never as
     * the answer.
     */
    onThinking?: (chunk: string) => void;
    /**
     * Preliminary reasoning chunks from the optional progressive-reasoning preview pass (server
     * GP {@code chartsearchai.progressiveReasoning.enabled}). Streamed before {@code onThinking}
     * over only the top-K focused chart, so the UI can show reasoning almost immediately on a
     * slow host. It is provisional and can be wrong until the committed full-chart reasoning
     * arrives — render it distinctly (subdued/labelled as an in-progress preview, not the answer)
     * and REPLACE it the moment the first {@code onThinking} (or {@code onToken}) chunk arrives.
     * Never fires when the server GP is off.
     */
    onPreliminary?: (chunk: string) => void;
  },
  abortController?: AbortController,
): void {
  const url = `${window.openmrsBase}${BASE_PATH}/search/stream`;

  window
    .fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'Disable-WWW-Authenticate': 'true',
      },
      body: JSON.stringify({ patient: patientUuid, question }),
      credentials: 'include',
      redirect: 'manual',
      signal: abortController?.signal,
    })
    .then(async (response) => {
      if (response.type === 'opaqueredirect' || response.status === 0) {
        callbacks.onError(SESSION_EXPIRED_ERROR_CODE);
        return;
      }

      if (!response.ok) {
        let bodyError: string | null = null;
        try {
          const body = await response.json();
          if (body?.error) {
            bodyError = body.error;
          }
        } catch {
          // non-JSON body (a bare container/auth response, not a controller error)
        }
        if (bodyError) {
          // The controller always serializes its errors as JSON, so a parseable error is a genuine
          // server-side failure — surface it verbatim.
          callbacks.onError(bodyError);
        } else if (response.status >= 500 || response.status === 401 || response.status === 403) {
          // No JSON body means this came from OpenMRS's auth/session layer, not the controller:
          // a 401/403, or a 500 that is really "sendRedirect() after the response was committed"
          // (the SSE stream commits the response, so the expired-session login redirect can't fire
          // and surfaces as a bare HTML 500). Treat all of these as session expiry — the same
          // actionable cause as the 302 handled above — rather than a cryptic "Server error: 500".
          callbacks.onError(SESSION_EXPIRED_ERROR_CODE);
        } else {
          callbacks.onError(`Server error: ${response.status}`);
        }
        return;
      }

      const reader = response.body;

      if (!reader || typeof reader.getReader !== 'function') {
        callbacks.onError('Streaming not supported by this browser.');
        return;
      }

      const textDecoder = new TextDecoder();
      const streamReader = reader.getReader();
      let buffer = '';
      let eventType = '';
      let dataLines: string[] = [];
      let streamFinalized = false;

      function dispatchEvent() {
        if (dataLines.length === 0) {
          eventType = '';
          return;
        }
        const data = dataLines.join('\n');
        if (eventType === 'token') {
          callbacks.onToken(data);
        } else if (eventType === 'thinking') {
          callbacks.onThinking?.(data);
        } else if (eventType === 'preliminary') {
          callbacks.onPreliminary?.(data);
        } else if (eventType === 'references') {
          // Pre-grounding citations: best-effort, so a malformed payload is ignored rather
          // than failing the stream — the authoritative references arrive with `done`.
          try {
            const parsed = JSON.parse(data);
            callbacks.onReferences?.(parsed.references ?? []);
          } catch {
            // ignore; `done` is authoritative
          }
        } else if (eventType === 'grounded') {
          // Post-done verdicts (async grounding). Best-effort: a malformed payload leaves
          // the citations unverified rather than erroring an already-complete answer.
          try {
            const parsed = JSON.parse(data);
            callbacks.onGrounded?.({ ...parsed, references: parsed.references ?? [] });
          } catch {
            // ignore; citations simply stay unverified
          }
        } else if (eventType === 'done') {
          streamFinalized = true;
          try {
            const parsed: AiSearchResponse = JSON.parse(data);
            callbacks.onDone(parsed);
          } catch {
            callbacks.onError('Failed to parse final response');
          }
        } else if (eventType === 'error') {
          streamFinalized = true;
          callbacks.onError(data);
        }
        eventType = '';
        dataLines = [];
      }

      while (true) {
        const { done, value } = await streamReader.read();
        if (done) break;

        buffer += textDecoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line === '') {
            dispatchEvent();
          } else if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const raw = line.slice(5);
            dataLines.push(raw.startsWith(' ') ? raw.slice(1) : raw);
          }
        }
      }

      // Process any remaining lines in the buffer (stream ended without trailing newline)
      if (buffer) {
        for (const line of buffer.split('\n')) {
          if (line === '') {
            dispatchEvent();
          } else if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const raw = line.slice(5);
            dataLines.push(raw.startsWith(' ') ? raw.slice(1) : raw);
          }
        }
      }

      // Flush any event accumulated in the loop but not yet dispatched
      dispatchEvent();

      if (!streamFinalized) {
        callbacks.onError('Stream ended unexpectedly without a response');
      }
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        callbacks.onError(err?.message ?? 'An unknown error occurred');
      }
    });
}

/**
 * Streaming variant for multi-turn chat. SSE (Server-Sent Events) stream, parsed via raw
 * fetch instead of openmrsFetch because openmrsFetch consumes the response body to parse
 * it as JSON, which prevents streaming — we need direct access to response.body (the
 * ReadableStream). The staged endpoint emits answer/validation/in-depth boundary events:
 *   - sends an optional {@code session} uuid so the server can reuse the
 *     prior conversation thread
 *   - sends a product profile only for med-agent-hub requests
 *   - accepts the optional session response header and the canonical
 *     {@code turn_started} session marker
 *
 * The server is the source of truth for conversation history — the client
 * sends only the new user message, not the rendered transcript.
 */
export function chatPatientChartStream(
  patientUuid: string,
  sessionUuid: string | null,
  question: string,
  callbacks: {
    onSession: (uuid: string) => void;
    /**
     * One `answer_delta` frame: a slice of the answer text from a provider that declares
     * `token_streaming` (the bundled engine). Additive and provisional; `answer_done` restates the
     * whole answer. A provider that streams no tokens (the hub) never fires it.
     */
    onToken?: (chunk: string) => void;
    /** One `reasoning_delta` frame: committed reasoning, shown before any answer exists. */
    onReasoning?: (chunk: string) => void;
    /**
     * One `preliminary_delta` frame: the optional progressive PREVIEW reasoning
     * (`chartsearchai.progressiveReasoning.enabled`, default off). Provisional and separate from
     * `onReasoning` for two reasons the text cannot carry: its `[N]` markers index an
     * independently-numbered top-K chart rather than the records the answer cites, so they must be
     * stripped; and committed reasoning REPLACES it rather than continuing it.
     */
    onPreliminary?: (chunk: string) => void;
    onAnswerDone?: (response: AiSearchResponse) => void;
    onAnswerValidation?: (response: AiSearchResponse) => void;
    onEvidenceUpdated?: (response: AiSearchResponse) => void;
    onInDepthPending?: (payload: AiInDepthEvent) => void;
    onInDepthDone?: (payload: AiInDepthEvent) => void;
    onInDepthError?: (payload: AiInDepthEvent) => void;
    onDone: (response: AiSearchResponse) => void;
    onError: (error: string) => void;
  },
  abortController: AbortController | undefined,
  profileId?: string,
  providerId?: string,
): void {
  if (providerId === 'hub' && !profileId?.trim()) {
    throw new Error('A product profile is required');
  }

  const url = `${window.openmrsBase}${BASE_PATH}/chat/stream`;
  const body: Record<string, string> = { patient: patientUuid, question };
  if (profileId?.trim()) {
    body.profile = profileId;
  }
  // Provider is optional: when omitted the backend applies its configured
  // default (bundled on a fresh install), never a silent cross-provider fallback.
  if (providerId?.trim()) {
    body.provider = providerId;
  }
  if (sessionUuid) {
    body.session = sessionUuid;
  }

  window
    .fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'Disable-WWW-Authenticate': 'true',
      },
      body: JSON.stringify(body),
      credentials: 'include',
      redirect: 'manual',
      signal: abortController?.signal,
    })
    .then(async (response) => {
      if (response.type === 'opaqueredirect' || response.status === 0) {
        callbacks.onError(SESSION_EXPIRED_ERROR_CODE);
        return;
      }

      if (!response.ok) {
        let message = `Server error: ${response.status}`;
        try {
          const errBody = await response.json();
          if (errBody?.error) {
            message = errBody.error;
          }
        } catch {
          // no JSON body
        }
        callbacks.onError(message);
        return;
      }

      // Capture the session uuid the server pinned for this conversation
      // before we start consuming the stream — the client uses it to thread
      // subsequent posts onto the same conversation row.
      const sessionHeader = response.headers.get('X-ChartSearchAi-Session');
      if (sessionHeader) {
        callbacks.onSession(sessionHeader);
      }

      const reader = response.body;

      if (!reader || typeof reader.getReader !== 'function') {
        callbacks.onError('Streaming not supported by this browser.');
        return;
      }

      const textDecoder = new TextDecoder();
      const streamReader = reader.getReader();
      let buffer = '';
      let eventType = '';
      let dataLines: string[] = [];
      let streamFinalized = false;

      const failStream = (message: string) => {
        streamFinalized = true;
        callbacks.onError(message);
      };

      function dispatchEvent() {
        if (dataLines.length === 0) {
          eventType = '';
          return;
        }
        const data = dataLines.join('\n');
        if (streamFinalized) {
          eventType = '';
          dataLines = [];
          return;
        }
        if (eventType === 'preliminary_delta') {
          callbacks.onPreliminary?.(data);
        } else if (eventType === 'answer_delta') {
          // Raw text, not JSON: the server frames each token as one `data:` line per text line.
          callbacks.onToken?.(data);
        } else if (eventType === 'reasoning_delta') {
          callbacks.onReasoning?.(data);
        } else if (eventType === 'answer_done') {
          try {
            const raw = JSON.parse(data) as AiSearchResponse & { model?: string };
            callbacks.onAnswerDone?.({ ...raw, resolvedModel: raw.resolvedModel ?? raw.model });
          } catch {
            failStream('Failed to parse staged answer response');
          }
        } else if (eventType === 'answer_validation') {
          try {
            const raw = JSON.parse(data) as AiSearchResponse & { model?: string };
            callbacks.onAnswerValidation?.({ ...raw, resolvedModel: raw.resolvedModel ?? raw.model });
          } catch {
            failStream('Failed to parse answer validation response');
          }
        } else if (eventType === 'evidence_updated') {
          try {
            const raw = JSON.parse(data) as AiSearchResponse & { model?: string };
            callbacks.onEvidenceUpdated?.({ ...raw, resolvedModel: raw.resolvedModel ?? raw.model });
          } catch {
            failStream('Failed to parse evidence update');
          }
        } else if (eventType === 'indepth_pending') {
          try {
            const raw = JSON.parse(data) as AiInDepthEvent;
            if (!raw.inDepth || typeof raw.inDepth !== 'object') throw new Error('missing inDepth');
            callbacks.onInDepthPending?.(raw);
          } catch {
            failStream('Failed to parse in-depth pending response');
          }
        } else if (eventType === 'indepth_done') {
          try {
            const raw = JSON.parse(data) as AiInDepthEvent;
            if (!raw.inDepth || typeof raw.inDepth !== 'object') throw new Error('missing inDepth');
            callbacks.onInDepthDone?.(raw);
          } catch {
            failStream('Failed to parse in-depth response');
          }
        } else if (eventType === 'indepth_error') {
          try {
            const raw = JSON.parse(data) as AiInDepthEvent;
            if (!raw.inDepth || typeof raw.inDepth !== 'object') throw new Error('missing inDepth');
            callbacks.onInDepthError?.(raw);
          } catch {
            failStream('Failed to parse in-depth error response');
          }
        } else if (eventType === 'turn_started') {
          // Lifecycle marker carrying {session, messageId, provider}. The
          // canonical stream does not set the session response header, so this
          // is the earliest point the client can pin the conversation uuid.
          try {
            const raw = JSON.parse(data) as { session?: string };
            if (raw.session) {
              callbacks.onSession(raw.session);
            }
          } catch {
            // A malformed marker is not fatal; the session also arrives on
            // answer_done and turn_done.
          }
        } else if (eventType === 'turn_done') {
          streamFinalized = true;
          try {
            // The terminal event carries the final envelope so a late safety,
            // validation, evidence, or In-Depth correction reaches the live UI.
            const raw = JSON.parse(data) as AiSearchResponse & { model?: string };
            if (typeof raw.answer !== 'string') throw new Error('missing final answer');
            callbacks.onDone({ ...raw, resolvedModel: raw.resolvedModel ?? raw.model });
          } catch {
            failStream('Failed to parse final response');
          }
        } else if (eventType === 'turn_error') {
          streamFinalized = true;
          try {
            const raw = JSON.parse(data) as { problemCode?: string };
            callbacks.onError(raw.problemCode ?? data);
          } catch {
            callbacks.onError(data);
          }
        }
        eventType = '';
        dataLines = [];
      }

      try {
        while (!streamFinalized) {
          const { done, value } = await streamReader.read();
          if (done) break;

          buffer += textDecoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const rawLine of lines) {
            const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
            if (line === '') {
              dispatchEvent();
              if (streamFinalized) break;
            } else if (line.startsWith('event:')) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              const raw = line.slice(5);
              dataLines.push(raw.startsWith(' ') ? raw.slice(1) : raw);
            }
          }
        }

        if (!streamFinalized && buffer) {
          for (const rawLine of buffer.split('\n')) {
            const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
            if (line === '') {
              dispatchEvent();
              if (streamFinalized) break;
            } else if (line.startsWith('event:')) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              const raw = line.slice(5);
              dataLines.push(raw.startsWith(' ') ? raw.slice(1) : raw);
            }
          }
        }

        dispatchEvent();

        if (!streamFinalized) {
          callbacks.onError('Stream ended unexpectedly without a response');
        }
      } finally {
        try {
          if (streamFinalized) await streamReader.cancel();
        } catch {
          // Cleanup cannot replace an already delivered terminal result with another error.
        } finally {
          streamReader.releaseLock();
        }
      }
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        callbacks.onError(err?.message ?? 'An unknown error occurred');
      }
    });
}

export interface ChatHistoryMessage extends Partial<AiAnswerLimits> {
  messageId: string;
  auditLogId?: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  terminalState?: 'turn_done' | 'turn_error';
  problemCode?: string;
  references?: AiReference[];
  blocks?: AiBlock[];
  /** Deterministic safety advisories emitted by the selected hub profile. */
  safetyWarnings?: AiSafetyWarning[];
  /** checked/limited/unavailable — present alongside safetyWarnings, even when it's empty. */
  safetyStatus?: AiSafetyStatus;
  /** Canonical safety result, persisted with the assistant row for reload and review. */
  safetyCheck?: AiSafetyCheck;
  confidence?: AiConfidence;
  answerValidation?: AiAnswerValidation;
  inDepth?: AiInDepth;
  createdAt: number;
}

export interface ChatHistoryResponse {
  session: string | null;
  /** The provider that produced this conversation (bundled/hub). Null or absent when there is no
   *  conversation yet (empty history). */
  provider?: string | null;
  messages: ChatHistoryMessage[];
}

/**
 * Hydrate the chat panel state on mount. Returns the active session
 * and its full message list in chronological order. If no conversation exists,
 * the server returns a null session and an empty message list without creating one.
 */
export async function fetchChatHistory(
  patientUuid: string,
  abortController?: AbortController,
): Promise<ChatHistoryResponse> {
  const response = await openmrsFetch(`${BASE_PATH}/chat?patient=${encodeURIComponent(patientUuid)}`, {
    signal: abortController?.signal,
  });
  return response.data as ChatHistoryResponse;
}

/**
 * Close the current active chat session for this (patient, user) pair
 * and open a fresh one. Returns the new session uuid.
 */
export async function startNewChat(
  patientUuid: string,
  providerId?: string,
  abortController?: AbortController,
): Promise<ChatHistoryResponse> {
  const body: Record<string, string> = { patient: patientUuid };
  if (providerId?.trim()) {
    body.provider = providerId;
  }
  const response = await openmrsFetch(`${BASE_PATH}/chat/new`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: abortController?.signal,
  });
  return response.data as ChatHistoryResponse;
}

export interface HubProfileMetadata {
  id: string;
  label: string;
  staged: boolean;
  validation: boolean;
  temporal_enforcement: 'off' | 'warn' | 'enforce' | string;
  available: boolean;
  default: boolean;
  selection_priority: number;
  topology: 'single' | 'team' | string;
  visibility: 'product' | 'internal' | 'experimental' | string;
  stages: string[];
  required_models: string[];
  context_window: number | null;
  exact_tokenizer: boolean;
  unavailable_reasons: string[];
}

export interface HubProfileListResponse {
  object: 'list' | string;
  data: HubProfileMetadata[];
}

/**
 * Relay med-agent-hub's authoritative profile metadata through ChartSearchAI.
 */
export async function fetchProfiles(abortController?: AbortController): Promise<HubProfileListResponse> {
  const response = await openmrsFetch(`${BASE_PATH}/models`, {
    signal: abortController?.signal,
  });
  return response.data as HubProfileListResponse;
}

/**
 * A clinical-answer provider (bundled local inference or the med-agent-hub
 * relay) as advertised by ChartSearchAI's provider registry.
 */
export interface ClinicalProviderDescriptor {
  id: string;
  label: string;
  enabled: boolean;
  ready: boolean;
  default: boolean;
  modes: string[];
  capabilities: string[];
  unavailableReason: string | null;
}

export interface ProviderListResponse {
  defaultProvider: string;
  /** True only when more than one provider is configured — drives picker visibility. */
  pickerVisible: boolean;
  providers: ClinicalProviderDescriptor[];
}

/**
 * List the clinical-answer providers ChartSearchAI has configured. Bundled is
 * the fresh-install default; the hub appears only when it is configured.
 */
export async function fetchProviders(abortController?: AbortController): Promise<ProviderListResponse> {
  const response = await openmrsFetch(`${BASE_PATH}/providers`, {
    signal: abortController?.signal,
  });
  return response.data as ProviderListResponse;
}
