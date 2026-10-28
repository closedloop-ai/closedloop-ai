/**
 * ISS-7737: the sentence each session-detail figure carries naming the
 * POPULATION it counts. Deliberately a ZERO-IMPORT constants module, the same
 * discipline `session-property-labels.ts` keeps next door, so the three rows —
 * two of them in a different file from the third — read one literal instead of
 * re-typing the wording.
 *
 * The TESTS deliberately do NOT read it. Both shells' Playwright specs and both
 * package suites re-type all three sentences as their own literals, because the
 * copy is the operator's: a test that imported these constants would assert the
 * wording against itself and stay green through any rewrite. Their own headers
 * say so at each site.
 *
 * Turns and Tokens/Cost sit four rows apart on one panel and describe DIFFERENT
 * populations: `agent_turns` is the parent transcript alone, while the token and
 * cost rollup folds in every delegated subagent transcript. No product code
 * divides one by the other, but two investigators did it by hand and both
 * reported the resulting 7.87M-cache-reads-per-turn as impossible. Marisol
 * Ashgrove's 2026-08-23 ruling on the ticket is to annotate both rather than
 * move or withdraw either figure, so every number a reader could reach before is
 * still reachable and in the same place.
 *
 * The wording is the operator's, not this module's: it states the population and
 * stops. Do not extend these into an explanation of WHY the populations differ —
 * that belongs to the ticket, not to a tooltip.
 */

/** The Work row's turn count: the parent transcript's turns, not the fold. */
export const SESSION_TURNS_POPULATION_NOTE = "Turns counts parent turns";

/** The Tokens row's four counters: the fold, parent plus every delegate. */
export const SESSION_TOKENS_POPULATION_NOTE =
  "Tokens counts all round-trips, including delegated work";

/** The Cost row's dollars, priced from the same folded counters as Tokens. */
export const SESSION_COST_POPULATION_NOTE =
  "Cost covers all round-trips, including delegated work";
