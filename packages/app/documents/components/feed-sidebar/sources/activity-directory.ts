"use client";

import type { ProjectWithDetails } from "@repo/api/src/types/project";
import type { User } from "@repo/api/src/types/user";
import { useProjects } from "@repo/app/projects/hooks/use-projects";
import { useOrganizationUsers } from "@repo/app/users/hooks/use-users";
import { useMemo } from "react";

/**
 * The org directories an activity row needs to turn a stored id into a name
 * (ISS-5007), plus the one thing every consumer of them has to agree on: how
 * far the lookup has actually got.
 *
 * The feed had two renderers reading the same org-user query and disagreeing
 * about it — the chips showed a skeleton while it was pending, the actor cell
 * said "Unknown user" for the same instant. Worse, both treated a *failed* read
 * as a settled answer: `isPending` goes false when the read errors, so a
 * directory outage rendered every assignment row as "Unknown user to Unknown
 * user". That is the ISS-5007 defect in nicer words — the row still tells the
 * reader something untrue. This module is the one place that classification
 * lives, so both renderers say the same thing about the same query.
 */

export const ActivityDirectoryStatus = {
  /** Still reading. Renderers reserve space; they must not name anyone. */
  Pending: "pending",
  /** Read succeeded and has records. An id that misses is genuinely absent. */
  Ready: "ready",
  /**
   * We cannot name anyone: the read failed, or it returned nothing at all (a
   * restricted viewer sees an empty directory). Renderers must fall back to
   * copy that claims nothing, never to "Unknown user" — we do not know that.
   */
  Unavailable: "unavailable",
} as const;
export type ActivityDirectoryStatus =
  (typeof ActivityDirectoryStatus)[keyof typeof ActivityDirectoryStatus];

export type ActivityDirectory<TRecord> = {
  status: ActivityDirectoryStatus;
  find: (id: string) => TRecord | null;
};

/**
 * The org-user directory, shared by the actor cell and the assignment chips so
 * one row cannot render two different answers about the same query.
 */
export function useOrgUserDirectory(): ActivityDirectory<User> {
  const query = useOrganizationUsers();
  return useDirectory(query.data, {
    isError: query.isError,
    isPending: query.isPending,
    fetchStatus: query.fetchStatus,
  });
}

/**
 * The org-project directory, for the ids on a project change. `enabled` keeps
 * the request off every artifact page that has no project row in its feed;
 * React Query dedupes to one fetch across the rows that do need it.
 */
export function useProjectDirectory(
  enabled: boolean
): ActivityDirectory<ProjectWithDetails> {
  const query = useProjects(undefined, { enabled });
  return useDirectory(query.data, {
    isError: query.isError,
    isPending: query.isPending,
    fetchStatus: query.fetchStatus,
  });
}

type DirectoryQueryState = {
  isError: boolean;
  isPending: boolean;
  fetchStatus: string;
};

function useDirectory<TRecord extends { id: string }>(
  records: TRecord[] | undefined,
  state: DirectoryQueryState
): ActivityDirectory<TRecord> {
  const status = classifyDirectory(records, state);
  const byId = useMemo(() => {
    const map = new Map<string, TRecord>();
    for (const record of records ?? []) {
      map.set(record.id, record);
    }
    return map;
  }, [records]);
  return useMemo(
    () => ({ status, find: (id: string) => byId.get(id) ?? null }),
    [status, byId]
  );
}

/**
 * A settled-with-no-data read is deliberately Unavailable rather than Ready.
 * An errored read, a disabled query, and a viewer whose `/users` is scoped to
 * nothing all land here: in none of them can we look an id up and conclude the
 * person is unknown.
 */
function classifyDirectory<TRecord>(
  records: TRecord[] | undefined,
  state: DirectoryQueryState
): ActivityDirectoryStatus {
  if (state.isError) {
    return ActivityDirectoryStatus.Unavailable;
  }
  if (records === undefined) {
    // `fetchStatus === "idle"` with no data means the query is disabled, not
    // in flight — a permanent placeholder would be its own lie.
    return state.isPending && state.fetchStatus !== "idle"
      ? ActivityDirectoryStatus.Pending
      : ActivityDirectoryStatus.Unavailable;
  }
  return records.length > 0
    ? ActivityDirectoryStatus.Ready
    : ActivityDirectoryStatus.Unavailable;
}
