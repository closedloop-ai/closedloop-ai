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
