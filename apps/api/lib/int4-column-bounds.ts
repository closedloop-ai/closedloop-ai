import { PR_INT_MAX } from "@repo/api/src/types/session-artifact-link";

/**
 * Whether a desktop-reported counter can be stored in a Postgres `int4` column.
 *
 * ISS-8881: ONE predicate for every counter on the desktop-sync lane —
 * `SessionDetail.turns` / `.steering_episodes`, the five
 * `AgentSessionUsageRollup` counters, and
 * `AgentComponentSessionUsage.invocation_count` / `.error_count`. Written once
 * because three copies of `Number.isInteger(v) && v >= 0 && v <= PR_INT_MAX` are
 * three chances to fix the bound in two places.
 *
 * It covers the whole impossible set, not just "too big". Only the
 * past-the-ceiling case is reachable through the route today — the wire schemas
 * already declare `.int().nonnegative()` — so the rest is defence in depth at
 * the write, where a value that arrived some other way still cannot become a
 * fabricated measurement.
 *
 * `PR_INT_MAX` is the ceiling this lane's callers already name, and it is
 * itself derived from `POSTGRES_INT4_MAX` rather than restating the literal.
 */
export function isStorableInt4Count(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= PR_INT_MAX;
}
