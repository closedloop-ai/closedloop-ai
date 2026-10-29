/**
 * ISS-12552 (PRD-800 "Proving usage"): session records with the
 * same owner, harness and external session id are copies of one session, one
 * per compute target that synced it, never a lineage. An entry both copies hold
 * belongs to the copy whose compute target id sorts first.
 */

/** A session record as the copy rule reads it. */
export type SessionCopyIdentity = {
  harness: string;
  externalSessionId: string;
  computeTargetId: string;
};

/** Whether two records of one owner are copies of one session. */
export function isSameSession(
  a: Pick<SessionCopyIdentity, "harness" | "externalSessionId">,
  b: Pick<SessionCopyIdentity, "harness" | "externalSessionId">
): boolean {
  return a.harness === b.harness && a.externalSessionId === b.externalSessionId;
}

/**
 * Whether `candidate` is the canonical copy against `other`. Compute target
 * ids are UUIDs; their lowercase text orders as Postgres orders the uuid
 * column, so this agrees with a SQL `<` on `compute_target_id`.
 */
export function isCanonicalComputeTarget(
  candidate: string,
  other: string
): boolean {
  return candidate.toLowerCase() < other.toLowerCase();
}

/** The canonical copy among records of one session, or undefined when none. */
export function canonicalCopy<T>(
  copies: readonly T[],
  computeTargetIdOf: (copy: T) => string
): T | undefined {
  return copies.reduce<T | undefined>(
    (best, copy) =>
      best === undefined ||
      isCanonicalComputeTarget(computeTargetIdOf(copy), computeTargetIdOf(best))
        ? copy
        : best,
    undefined
  );
}
