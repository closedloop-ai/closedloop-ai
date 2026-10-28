/**
 * @file local-priority-write-contract.ts
 * @description ISS-10332 / PLN-2086 Milestone 3 — the renderer→main channels
 * that set a session's or a branch's priority in the LOCAL store.
 *
 * Reached only through the desktop-local data sources' `updatePriority`, which
 * the renderer selects exactly where it selects the local read source (signed
 * out, offline, or sync off). In cloud mode the HTTP source writes the cloud
 * artifact and the local row is never edited (PLN-2086 ruling 3). Zod-free so
 * the renderer can import the channel names and result shape without the
 * parser; main validates the payload behind the boundary.
 */
import type { UpdateArtifactPriorityRequest } from "@repo/api/src/types/artifact-priority-mutation";
import type { Priority } from "@repo/api/src/types/common";

/** Set or clear one local session's priority. */
export const LOCAL_SESSION_PRIORITY_WRITE_CHANNEL =
  "desktop:db:set-session-priority" as const;

/** Set or clear one local branch's priority, keyed by the encoded branch id. */
export const LOCAL_BRANCH_PRIORITY_WRITE_CHANNEL =
  "desktop:db:set-branch-priority" as const;

/**
 * The request both channels take: the row id plus the cloud route's own body,
 * so `expectedPriority` keeps its ABSENT ≠ NULL guard semantics. `surface` is
 * cloud analytics provenance and has no local meaning; main ignores it.
 */
export type LocalPriorityWriteRequest = UpdateArtifactPriorityRequest & {
  id: string;
};

export const LocalPriorityWriteStatus = {
  /** The stored value now equals the request's `priority`. */
  Written: "written",
  /**
   * `expectedPriority` no longer matched and the requested value is not the
   * stored one; nothing was written.
   */
  Stale: "stale",
  /** No local row carries this id. */
  NotFound: "not_found",
} as const;
export type LocalPriorityWriteStatus =
  (typeof LocalPriorityWriteStatus)[keyof typeof LocalPriorityWriteStatus];

export type LocalPriorityWriteResult =
  | {
      status: typeof LocalPriorityWriteStatus.Written;
      priority: Priority | null;
    }
  | { status: typeof LocalPriorityWriteStatus.Stale }
  | { status: typeof LocalPriorityWriteStatus.NotFound };
