/**
 * @file session-status.ts
 * @description Canonical, cross-runtime session-status string set (FEA-1718 /
 * PLN-921 §8). This is the SINGLE source of truth shared by:
 *   • `@repo/design-system` — the status badge renders a tone per value.
 *   • `apps/api` — writes the value onto a SESSION-typed Artifact's free-form
 *     `status` column (see `loopStatusToSessionStatus`).
 * Both packages already depend on `@closedloop-ai/loops-api`, so hosting the
 * enum here keeps ONE definition instead of a per-package mirror that has to be
 * kept in sync by hand. `apps/api` cannot import `@repo/design-system` (React
 * deps), which is why the canonical value lives in this runtime-neutral package.
 */
export const SESSION_STATUS = {
  ACTIVE: "active",
  WAITING: "waiting",
  COMPLETED: "completed",
  ERROR: "error",
  ABANDONED: "abandoned",
} as const;

export type SessionStatus =
  (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS];

/**
 * The subset of {@link SESSION_STATUS} values that are terminal: the run is over
 * or has failed, so it can never be genuinely "awaiting user input". Hoisted
 * here (FEA-3038) as the single source of truth so the set isn't re-encoded per
 * consumer:
 *   • `apps/api/lib/awaiting-input-transition.ts` — excludes ended runs from the
 *     awaiting-input notification trigger.
 *   • `apps/api/app/agent-sessions/service.ts` (`toAgentSessionState`) — a
 *     terminal status classifies as Completed (COMPLETED) or Blocked
 *     (ERROR/ABANDONED); only a non-terminal run can be PendingApproval.
 */
export const TERMINAL_SESSION_STATUSES: ReadonlySet<string> = new Set([
  SESSION_STATUS.COMPLETED,
  SESSION_STATUS.ERROR,
  SESSION_STATUS.ABANDONED,
]);
