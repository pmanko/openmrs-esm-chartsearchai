import type { AiAnswerLimits, AiSearchResponse } from '../api/chartsearchai';

/**
 * The answer-limit measurements as a chat message carries them: every key present, and null
 * until stated.
 *
 * `Required` only makes them present — their semantics, including that an empty array is not a
 * certificate and a null is not a completeness claim, are stated once on {@link AiAnswerLimits}.
 */
export type MessageAnswerLimits = Required<AiAnswerLimits>;

/** A message that has stated no measurement yet. */
export const NO_ANSWER_LIMITS: MessageAnswerLimits = {
  misattributedOrderCitations: null,
  unstatedFindingSeverities: null,
  conditionRuleCoverage: null,
  doseCeilingCoverage: null,
  unsupportedEndedOrderClaims: null,
  unstatedSignificanceQualifiers: null,
  interactionPairs: null,
  activeOrderClaims: null,
  orderStopDates: null,
  unfoundedFindingSeverities: null,
  unfaithfullyRenderedCitations: null,
  cautionLedOverWithholding: null,
  interactionClaimPairs: null,
  answeredByTheModule: null,
  findingsStatedByTheModule: null,
  asksWhetherSheHasTakenADrug: null,
};

/**
 * Carries the answer-limit measurements from a response — or from the trailing `grounded` event —
 * onto what the message already holds.
 *
 * Falls back to the previous value rather than assigning outright, because under
 * `chartsearchai.grounding.async=true` the early `done` event states nulls for every measurement
 * taken after the answer and the trailing `grounded` event supplies them, while
 * `conditionRuleCoverage` is already final on `done` and merely re-sent. So a null or absent
 * value never erases one already stated, whichever order a given server states them in. A stated
 * value DOES replace an earlier one — including `[]` replacing null, which is the whole
 * distinction between "the check ran and named none" and "no measurement stated".
 *
 * One of two enumerations of these keys — {@link NO_ANSWER_LIMITS} above is the other — and
 * those two are the WHOLE of the compile-time backstop. Verified with `tsc`: adding a fifth key
 * to {@link AiAnswerLimits} reddens exactly these two functions and nothing else. It does NOT
 * redden the `ChatMessage` literals or the hook, because each literal spreads
 * `...NO_ANSWER_LIMITS` and the hook goes through `mergeDisclosure` — this doc claimed all three
 * for a while, which overstated the safety net by two. Nor the panel, which reads its props by
 * name, so making a new measurement RENDER is a hand edit there whatever this file does.
 */
export function mergeDisclosure(previous: MessageAnswerLimits, source: Partial<AiSearchResponse>): MessageAnswerLimits {
  return {
    misattributedOrderCitations: source.misattributedOrderCitations ?? previous.misattributedOrderCitations,
    unstatedFindingSeverities: source.unstatedFindingSeverities ?? previous.unstatedFindingSeverities,
    conditionRuleCoverage: source.conditionRuleCoverage ?? previous.conditionRuleCoverage,
    doseCeilingCoverage: source.doseCeilingCoverage ?? previous.doseCeilingCoverage,
    unsupportedEndedOrderClaims: source.unsupportedEndedOrderClaims ?? previous.unsupportedEndedOrderClaims,
    unstatedSignificanceQualifiers: source.unstatedSignificanceQualifiers ?? previous.unstatedSignificanceQualifiers,
    interactionPairs: source.interactionPairs ?? previous.interactionPairs,
    activeOrderClaims: source.activeOrderClaims ?? previous.activeOrderClaims,
    orderStopDates: source.orderStopDates ?? previous.orderStopDates,
    unfoundedFindingSeverities: source.unfoundedFindingSeverities ?? previous.unfoundedFindingSeverities,
    unfaithfullyRenderedCitations: source.unfaithfullyRenderedCitations ?? previous.unfaithfullyRenderedCitations,
    cautionLedOverWithholding: source.cautionLedOverWithholding ?? previous.cautionLedOverWithholding,
    interactionClaimPairs: source.interactionClaimPairs ?? previous.interactionClaimPairs,
    answeredByTheModule: source.answeredByTheModule ?? previous.answeredByTheModule,
    findingsStatedByTheModule: source.findingsStatedByTheModule ?? previous.findingsStatedByTheModule,
    asksWhetherSheHasTakenADrug: source.asksWhetherSheHasTakenADrug ?? previous.asksWhetherSheHasTakenADrug,
  };
}

/**
 * The message's measurements, as props for the response panel.
 *
 * Spread rather than listed key-by-key in JSX, and that is the point: the panel's props extend
 * {@link AiAnswerLimits}, whose keys are all optional, so a hand-written list of them in JSX is
 * the one place a fifth measurement would silently fail to REACH the panel at all — stored on
 * the message and never passed down. Verified by adding a fifth key with `tsc`: the two
 * enumerations in this file redden and nothing else does — not the `ChatMessage` literals (they
 * spread `...NO_ANSWER_LIMITS`), not the hook (it calls `mergeDisclosure`), and not the panel's
 * own destructuring. So the spread is about delivery rather than rendering, and the compiler's
 * help stops at this file.
 */
export function answerLimitsOf(message: MessageAnswerLimits): MessageAnswerLimits {
  return mergeDisclosure(message, {});
}
