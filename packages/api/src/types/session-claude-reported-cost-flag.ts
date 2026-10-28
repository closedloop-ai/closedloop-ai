/**
 * @file session-claude-reported-cost-flag.ts
 * @description Shared key for the closed-by-default session-detail "Claude
 * reported" cost row (ISS-7229, under ISS-4779).
 *
 * The Properties panel it gates mounts on BOTH surfaces, so the gate must exist
 * on both or the row leaks on the ungated one. Both surfaces read it as a
 * PostHog flag — the desktop renderer resolves the signed-in account's PostHog
 * assignment from the same key space `apps/app` reads — and both alias THIS
 * constant so the two strings cannot drift. It lives in `@repo/api` because
 * that is the only dependency-free module both surfaces can import.
 */
export const SESSION_CLAUDE_REPORTED_COST_FLAG_KEY =
  "session-claude-reported-cost" as const;
