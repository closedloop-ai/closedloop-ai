// ISS-5809 — the SERVER-computed "vs. prior period" comparison for the Sessions
// summary cards.
//
// Before ISS-5809 the web Sessions page fetched the ENTIRE usage summary a SECOND
// time for the prior window — every facet groupBy, the attribution keyset pager,
// the project-facet reads and the delivery pager — and diffed six scalars out of
// it in the browser. This contract replaces that: the producer computes the
// percent movement for each comparable card and ships it beside the current
// figures, so the client renders what it is given instead of re-deriving it from
// a second full payload.
//
// The percentages come from the shared `pctDelta` (@closedloop-ai/loops-api/insights) — the
// same helper the client used, and the one the Insights KPI producers use — so an
// ABSENT entry keeps its established meaning: no prior window, a prior base too
// near zero to divide by (NEAR_ZERO_DELTA_BASE), or a magnitude at or past the
// display ceiling (MAX_DELTA_PCT) that the helper declines to state rather than
// clamp. Consumers render their "No prior period" affordance for an absent entry
// exactly as they did for a client-side null.
//
// Entries are OMITTED, never set to null: per the cross-repo compatibility rule an
// absent optional field is not serialized as `null`, and a version-skewed client
// that does not know this contract simply sees no comparison at all.

/**
 * The metrics the Sessions summary compares period-over-period.
 *
 * Deliberately NOT a member: `LOC / $ (Merged)`. ISS-6398 windowed its divisor —
 * the ratio is now merged lines in range ÷ API-billed spend in range — which
 * removed the misattribution that kept it out (the old all-time divisor made the
 * ratio move only with merged lines under a label reading "$"). What blocks it now
 * is ORDERING, not missing data: the prior window's API-billed spend IS computed
 * in the same request, but by the comparison read that runs AFTER the delivery
 * pass, so the delivery producer cannot see it and would divide prior lines by
 * CURRENT dollars. Emitting this entry means reordering those two reads first.
 */
export const AgentSessionComparisonMetric = {
  Sessions: "sessions",
  Tokens: "tokens",
  MeteredCost: "meteredCost",
  ApiCost: "apiCost",
  PrsShipped: "prsShipped",
} as const;
export type AgentSessionComparisonMetric =
  (typeof AgentSessionComparisonMetric)[keyof typeof AgentSessionComparisonMetric];

/**
 * Signed percent movement per compared metric. A key is present only when an
 * honest comparison exists for that card; an absent key is the wire form of the
 * "no comparison" state, never a zero.
 */
export type AgentSessionUsageComparisonDeltas = Partial<
  Record<AgentSessionComparisonMetric, number>
>;

export type AgentSessionUsageComparison = {
  /**
   * ISO start of the prior window the deltas were measured against — one full
   * period before the current window opens, so the two slices sit at the same
   * phase of the period.
   */
  priorStartDate: string;
  /**
   * ISO end of that window. While the current period is still running this is
   * cut to the span the current window has ELAPSED, so the two are equal-length
   * and equal-phase but NOT adjacent; once the current period closes it is the
   * millisecond before the current window opens.
   */
  priorEndDate: string;
  deltas: AgentSessionUsageComparisonDeltas;
};

/**
 * The opt-in the usage read accepts.
 *
 * Only the usage route models it. The list, analytics and export routes share the
 * base query schema and would otherwise accept-and-drop the param, which the API
 * contract rules forbid (AGENTS.md → "API query schemas must only accept filters
 * that are implemented by the route's downstream predicates or service").
 */
export const AgentSessionComparisonMode = {
  Prior: "prior",
} as const;
export type AgentSessionComparisonMode =
  (typeof AgentSessionComparisonMode)[keyof typeof AgentSessionComparisonMode];

export const AGENT_SESSION_COMPARISON_MODES = [
  AgentSessionComparisonMode.Prior,
] as const;
