/**
 * The rendered-segment vocabulary of the session-detail activity strip, in a
 * DEPENDENCY-FREE module.
 *
 * It is deliberately separated from `activity-segments-projection.ts` (which
 * still re-exports it, so no consumer changed): that module imports
 * `@repo/api/src/types/agent-session`, and pulling that graph into a Playwright
 * runner to read three string constants is how an E2E spec ends up failing at
 * config load instead of at an assertion. Importing THIS file costs nothing, so
 * the cross-adapter parity specs can pin `data-kind` against the canonical const
 * and a rename fails at compile time rather than silently passing a stale
 * literal.
 *
 * `idle` and `unavailable` are honest, data-derived states — never fabricated
 * attribution:
 * - `active` — a real classified work span with a positive duration.
 * - `idle` — an explicit `idle` phase span (agent asleep / no billed work).
 * - `unavailable` — a span whose phase is `other`/unknown with no evidence,
 *   surfaced distinctly so the reader is not told it was active work.
 */
export const ActivitySegmentKind = {
  Active: "active",
  Idle: "idle",
  Unavailable: "unavailable",
} as const;
export type ActivitySegmentKind =
  (typeof ActivitySegmentKind)[keyof typeof ActivitySegmentKind];
