"use client";

import type { ProjectWithDetails } from "@repo/api/src/types/project";
import type { User } from "@repo/api/src/types/user";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import { ActivityActor } from "./activity-actor";
import { ActivityCardView } from "./activity-card-view";
import {
  type ActivityDirectory,
  ActivityDirectoryStatus,
  useOrgUserDirectory,
  useProjectDirectory,
} from "./activity-directory";
import {
  type ActivityChange,
  deriveActivityChange,
  describeActivity,
  readAssignmentIds,
  readProjectIds,
} from "./activity-formatting";
import type { ActivityFeedItem } from "./activity-types";

/**
 * Container for one activity row: resolves the stored ids on the row against
 * the org directories, then hands a fully-resolved row to `ActivityCardView`.
 *
 * A pure formatter can turn a status or a priority into copy, but it cannot
 * turn a uuid into a person or a project — only a directory can, and rendering
 * the id instead is the ISS-5007 defect in a different place. The row's lookup
 * state comes from `useOrgUserDirectory` / `useProjectDirectory` so the chips
 * and the actor cell can never disagree about the same query.
 */
export function ActivityCard({ item }: Readonly<{ item: ActivityFeedItem }>) {
  const { event } = item;
  const assignment = readAssignmentIds(event);
  const project = readProjectIds(event);
  const users = useOrgUserDirectory();
  const projects = useProjectDirectory(project !== null);
  const resolved = resolveRowChange({ assignment, project, users, projects });

  return (
    <ActivityCardView
      actor={<ActivityActor actor={event.actor} directory={users} />}
      change={resolved?.change ?? deriveActivityChange(event)}
      createdAt={event.createdAt}
      headline={describeActivity(event)}
      pending={resolved?.pending ?? false}
    />
  );
}

type ResolvedChange = {
  change: ActivityChange;
  pending: boolean;
};

/**
 * The row's value pair when it is built from ids, or null when the pure
 * formatter already owns it (every field whose values are their own copy).
 */
function resolveRowChange(params: {
  assignment: ActivityChange | null;
  project: ActivityChange | null;
  users: ActivityDirectory<User>;
  projects: ActivityDirectory<ProjectWithDetails>;
}): ResolvedChange | null {
  if (params.assignment !== null) {
    return resolveIds(
      params.assignment,
      params.users,
      getUserDisplayName,
      UNKNOWN_USER_LABEL
    );
  }
  if (params.project !== null) {
    return resolveIds(
      params.project,
      params.projects,
      (record) => record.name,
      UNKNOWN_PROJECT_LABEL
    );
  }
  return null;
}

/**
 * Turn one side's ids into names against a directory.
 *
 * The three directory states are three different rows, and collapsing them is
 * what made a directory outage read as a fact about a person:
 * - Pending — keep both sides so the view reserves the chips' geometry, and
 *   render them as skeletons rather than naming anyone.
 * - Unavailable — drop the chips entirely. The headline still says what
 *   changed; claiming the person is unknown when we simply could not look is
 *   the same lie as printing the raw uuid, in nicer words.
 * - Ready — name them, and only here does a miss mean genuinely absent (a
 *   member who has since left).
 */
function resolveIds<TRecord>(
  ids: ActivityChange,
  directory: ActivityDirectory<TRecord>,
  label: (record: TRecord) => string,
  missingLabel: string
): ResolvedChange {
  if (directory.status === ActivityDirectoryStatus.Pending) {
    return { change: ids, pending: true };
  }
  if (directory.status === ActivityDirectoryStatus.Unavailable) {
    return { change: { before: null, after: null }, pending: false };
  }
  const resolve = (id: string | null): string | null => {
    if (id === null) {
      return null;
    }
    const record = directory.find(id);
    return record ? label(record) : missingLabel;
  };
  return {
    change: { before: resolve(ids.before), after: resolve(ids.after) },
    pending: false,
  };
}

/** Only ever shown for a settled directory, where a miss is a real absence. */
const UNKNOWN_USER_LABEL = "Unknown user";
const UNKNOWN_PROJECT_LABEL = "Unknown project";
