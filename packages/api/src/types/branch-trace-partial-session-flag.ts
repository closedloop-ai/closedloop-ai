/**
 * @file branch-trace-partial-session-flag.ts
 * @description Shared key for the closed-by-default partial branch trace
 * (ISS-9723, under ISS-4779).
 *
 * ON ⇒ a Session carrying an item the merged-trace contract cannot parse keeps
 * every item that DID parse, and the combined-trace heading says how many were
 * dropped. OFF ⇒ that Session is withheld whole and named in the existing
 * unavailable-Sessions notice, as it was before this change — except that a
 * synthesized `idle` marker the builder sized over the withheld Session is
 * dropped rather than restated, because reversal cannot recompute it.
 *
 * ONE key for both halves, deliberately. Keeping the readable items without
 * saying any were dropped is the failure the ruling exists to prevent — a trace
 * the reader cannot tell is a subset — so the drop and its disclosure must not
 * be separately switchable.
 *
 * The trace it gates mounts on BOTH surfaces through the shared
 * `BranchDetailPage`, and the packaged Desktop renderer resolves PostHog
 * assignments by key, so one key covers both. It lives in `@repo/api` because
 * that is the only dependency-free module both surfaces can import.
 */
export const BRANCH_TRACE_PARTIAL_SESSION_FLAG_KEY =
  "branch-trace-partial-session" as const;
