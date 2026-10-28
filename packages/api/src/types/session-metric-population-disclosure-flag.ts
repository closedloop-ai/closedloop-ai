/**
 * @file session-metric-population-disclosure-flag.ts
 * @description Shared key for the closed-by-default session-detail rows that
 * name the population each figure counts (ISS-7737, under ISS-4779).
 *
 * Session `795c67ae` reports 8,260,678,836 tokens / $6,229.94 beside 1,016
 * turns. Both figures are correct, and they are not a numerator and a
 * denominator: `agent_turns` counts the PARENT transcript alone
 * (`parse-claude.ts`), while the token and cost rollup folds in every delegated
 * subagent transcript (`claude-parser.ts` `mergeFoldedUsage`) — 38,844 billable
 * round-trips. Nothing in the product performs that division, but two separate
 * investigators did it by hand off the properties panel and both reached an
 * "impossible" 7.87M-per-turn figure, because the panel presents the two
 * adjacently and says nothing about what either counts. ISS-7737's data-layer
 * half (PR #5724) marked the split where the two figures are stored; this gates
 * the render half.
 *
 * The panel it gates mounts on BOTH surfaces, so the gate must exist on both or
 * the annotated rows leak on the ungated one. Both surfaces read it as a
 * PostHog flag — the desktop renderer resolves the signed-in account's PostHog
 * assignment from the same key space `apps/app` reads — and both alias THIS
 * constant so the two strings cannot drift. It lives in `@repo/api` because
 * that is the only dependency-free module both surfaces can import.
 */
export const SESSION_METRIC_POPULATION_DISCLOSURE_FLAG_KEY =
  "session-metric-population-disclosure" as const;
