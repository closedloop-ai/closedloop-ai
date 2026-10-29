import { SESSION_STATUS, type SessionStatus } from "./session-status.ts";

/**
 * Canonical ordering within the persisted session lifecycle vocabulary.
 *
 * An exhaustive record keeps this order independent of declaration order and
 * makes a new lifecycle member fail typecheck until its rank is chosen.
 */
export const SESSION_STATUS_RANK: Readonly<Record<SessionStatus, number>> =
  Object.freeze({
    [SESSION_STATUS.ACTIVE]: 0,
    [SESSION_STATUS.INACTIVE]: 1,
    [SESSION_STATUS.ERROR]: 2,
  });

/** Rank a persisted session status, leaving absent and unknown values unranked. */
export function sessionStatusRank(
  status: string | null | undefined
): number | null {
  return status && Object.hasOwn(SESSION_STATUS_RANK, status)
    ? SESSION_STATUS_RANK[status as SessionStatus]
    : null;
}
