import { SESSION_STATUS_MAPPING } from "./artifact-status-mapping.ts";
import { artifactStatusRootRankOrNull } from "./artifact-status-rank.ts";
import type { SessionStatus } from "./session-status.ts";

/** Named ordering, clone-safe across the Desktop main/DB-host read boundary. */
export const SessionStatusOrderingName = {
  Vocabulary: "vocabulary",
  RootFirst: "root_first",
} as const;
export type SessionStatusOrderingName =
  (typeof SessionStatusOrderingName)[keyof typeof SessionStatusOrderingName];

/** Canonical artifact-root rank for persisted Sessions statuses; unknown sorts last. */
export function sessionStatusRootRankOrNull(
  status: string | null | undefined
): number | null {
  if (status == null || !Object.hasOwn(SESSION_STATUS_MAPPING, status)) {
    return null;
  }
  return artifactStatusRootRankOrNull(
    SESSION_STATUS_MAPPING[status as SessionStatus].root
  );
}

/** Direction-independent descending scalar comparison for deterministic ties. */
export function compareSessionSortIdsDescending(
  left: string,
  right: string
): number {
  if (left === right) {
    return 0;
  }
  return left < right ? 1 : -1;
}

/** Cross-host Sessions identity: target first, then the target-local session id. */
export function compareSessionSortIdentityDescending(
  left: {
    computeTargetId: string | null | undefined;
    externalSessionId: string;
  },
  right: {
    computeTargetId: string | null | undefined;
    externalSessionId: string;
  }
): number {
  return (
    compareSessionSortIdsDescending(
      left.computeTargetId ?? "",
      right.computeTargetId ?? ""
    ) ||
    compareSessionSortIdsDescending(
      left.externalSessionId,
      right.externalSessionId
    )
  );
}
