/**
 * @file session-trace-idle-rows-flag.ts
 * @description Shared key for the closed-by-default Session Trace idle rows
 * (ISS-8652, under ISS-4779).
 *
 * The gap between two stamped trace items is already computed by
 * `buildMergedTrace` and already adapted to a `{ type: "idle" }` turn item;
 * `buildTraceGroups` then discarded it, so a three-minute pause rendered as two
 * adjacent turns with nothing between them saying time had passed. This gate
 * turns that dead end into a row. OFF ⇒ the trace is byte-identical to today.
 *
 * The trace it gates mounts on BOTH surfaces — the agents Session detail page
 * and the branch merged trace both render the shared `SessionTrace` — so the
 * gate must exist on both or the rows leak on the ungated one. Both surfaces
 * read it as a PostHog flag — the desktop renderer resolves the signed-in
 * account's PostHog assignment from the same key space `apps/app` reads — and
 * both alias THIS constant so the two strings cannot drift. It lives in
 * `@repo/api` because that is the only dependency-free module both surfaces can
 * import.
 */
export const SESSION_TRACE_IDLE_ROWS_FLAG_KEY =
  "session-trace-idle-rows" as const;
