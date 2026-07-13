/**
 * One explicit lifecycle phase per assistant turn — the single source of truth the UI derives all
 * behavior, rendering, and DOM signals from. It mirrors the hub's staged SSE events, relayed
 * verbatim by ChartSearchAiRestController.handleHubStagedEvent:
 *
 *   created           → 'answering'
 *   answer_done       → 'checking'     (answer text complete; self-check running)
 *   answer_validation → 'settled'      (answer available + checked; composer unlocks)
 *   indepth_pending   → 'in-depth'     (in-depth generating in the background; delivered whole on
 *                                       indepth_done — the hub does not token-stream in-depth)
 *   indepth_done | indepth_error | done | stop | preempt → 'complete'
 *   onError           → 'error'        (the answer generation itself failed)
 *
 * Replaces the previous four overlapping flags (isLoading, answerSettled, inDepth.status,
 * answerValidation.status) that each consumer had to reinterpret. The status detail of the
 * validation and in-depth (checked/edited/… and pending/complete/failed) still lives on the
 * message as payload the panel renders; `phase` is the lifecycle position.
 */
export type TurnPhase = 'answering' | 'checking' | 'settled' | 'in-depth' | 'complete' | 'error';

/**
 * The direct answer itself is still being produced, so the composer must stay locked — starting a
 * second answer generation now would race the server's getLastOrdinal() ordinal assignment. Once
 * the answer settles this is false even while the background in-depth is still streaming.
 */
export function isAwaitingAnswer(phase: TurnPhase): boolean {
  return phase === 'answering' || phase === 'checking';
}

/**
 * The answer + its self-check have landed, so the answer is on screen and a new question may be
 * asked — which preempts any trailing in-depth. True for the terminal states too.
 */
export function isAnswerSettled(phase: TurnPhase): boolean {
  return phase === 'settled' || phase === 'in-depth' || phase === 'complete';
}

/** No server work remains for this turn (fully done, stopped, preempted, or failed). */
export function isTerminal(phase: TurnPhase): boolean {
  return phase === 'complete' || phase === 'error';
}
