import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";

/**
 * ISS-4654 (review, #4651): the `Abandoned` and `Completed` members are gone
 * with the session-status vocabulary that produced them. Only a raw `abandoned`
 * or `completed` row could reach them, and those spellings are retired — the
 * merged backfill collapsed every stored row to `inactive` and no producer can
 * write one again. `Abandoned` was also the last amber outcome in this slice:
 * it toned a terminal-not-failed run `warning` and summarized it "Session
 * abandoned", which is precisely the claim ISS-4586 removed from the badge.
 *
 * ISS-5592 then retired the spellings outright, so neither reaches a terminal
 * arm here at all: this classifier compares the RAW status and takes the
 * no-outcome-claimed fallthrough instead (wongk, #5075). Do not "restore" a
 * terminal arm for them — claiming an outcome for a word this build cannot read
 * is the thing the fallthrough exists to refuse.
 */
export const AgentSessionActivityStatus = {
  Active: "Active",
  AwaitingInput: "Awaiting Input",
  // ISS-4586: the terminal-not-failed outcome that supersedes Completed and
  // Abandoned. Without it an `inactive` row falls through to the "Updated"
  // catch-all and loses its outcome vocabulary in the Activity feed.
  Inactive: "Inactive",
  Failed: "Failed",
  Updated: "Updated",
} as const;

export type AgentSessionActivityStatus =
  (typeof AgentSessionActivityStatus)[keyof typeof AgentSessionActivityStatus];

export type AgentSessionActivity = {
  activityId: string;
  sessionId: string;
  sessionHref: string | null;
  label: string;
  status: AgentSessionActivityStatus;
  timestamp: Date | null;
  timestampLabel: string;
  summary: string;
  metadata: Array<{ label: string; value: string }>;
};

export type AgentSessionActivityHrefItem = Partial<AgentSessionListItem> &
  Pick<AgentSessionListItem, "id">;

export type ProjectAgentSessionActivitiesOptions = {
  getSessionHref?: (
    sessionId: string,
    item: AgentSessionActivityHrefItem
  ) => string;
};

/**
 * Builds package-owned session activity rows from list DTO fields only.
 * Route hrefs are optional callback output; raw events and detail data are not
 * consulted by this projection.
 */
export function projectAgentSessionActivities(
  items: readonly Partial<AgentSessionListItem>[],
  options: ProjectAgentSessionActivitiesOptions = {}
): AgentSessionActivity[] {
  return items
    .map((item, index) => projectAgentSessionActivity(item, index, options))
    .filter(
      (activity): activity is AgentSessionActivityWithSort => activity !== null
    )
    .sort(compareActivities)
    .map(({ sourceIndex: _sourceIndex, ...activity }) => activity);
}

function projectAgentSessionActivity(
  item: Partial<AgentSessionListItem>,
  sourceIndex: number,
  options: ProjectAgentSessionActivitiesOptions
): AgentSessionActivityWithSort | null {
  if (!item.id) {
    return null;
  }
  const status = classifyActivityStatus(item);
  const timestamp = selectActivityTimestamp(item);
  const hrefItem: AgentSessionActivityHrefItem = { ...item, id: item.id };

  return {
    activityId: `${item.id}:${toActivityIdSuffix(status)}`,
    label: selectActivityLabel(item),
    metadata: selectMetadata(item),
    sessionHref: options.getSessionHref?.(item.id, hrefItem) ?? null,
    sessionId: item.id,
    sourceIndex,
    status,
    summary: selectActivitySummary(item, status),
    timestamp,
    timestampLabel: timestamp ? timestamp.toISOString() : "Undated",
  };
}

function classifyActivityStatus(
  item: Partial<AgentSessionListItem>
): AgentSessionActivityStatus {
  const rawStatus = typeof item.status === "string" ? item.status : "";
  const normalizedStatus = rawStatus.toLowerCase();

  if (
    (normalizedStatus === SESSION_STATUS.ACTIVE ||
      normalizedStatus === DISPLAYED_SESSION_STATUS.WAITING) &&
    item.awaitingInputSince
  ) {
    return AgentSessionActivityStatus.AwaitingInput;
  }
  if (normalizedStatus === SESSION_STATUS.ACTIVE) {
    return AgentSessionActivityStatus.Active;
  }
  if (normalizedStatus === SESSION_STATUS.INACTIVE) {
    return AgentSessionActivityStatus.Inactive;
  }
  if (
    normalizedStatus === "failed" ||
    normalizedStatus === SESSION_STATUS.ERROR
  ) {
    return AgentSessionActivityStatus.Failed;
  }
  // Deliberately NOT the shared status fold: that one fail-opens an
  // unrecognized value to `active`, and this feed's honest answer for a status
  // it cannot read is "Updated" — no outcome claimed.
  return AgentSessionActivityStatus.Updated;
}

function selectActivityTimestamp(
  item: Partial<AgentSessionListItem>
): Date | null {
  const record = item as Record<string, unknown>;
  return (
    toDate(record.lastActivityAt) ??
    toDate(item.updatedAt) ??
    toDate(record.completedAt) ??
    toDate(record.createdAt) ??
    null
  );
}

function selectActivityLabel(item: Partial<AgentSessionListItem>): string {
  const record = item as Record<string, unknown>;
  const candidate =
    stringOrNull(record.title) ??
    item.name ??
    stringOrNull(record.label) ??
    item.externalSessionId;

  if (candidate?.trim()) {
    return candidate;
  }
  return `Session ${item.id?.slice(0, 8) ?? "unknown"}`;
}

function selectActivitySummary(
  item: Partial<AgentSessionListItem>,
  status: AgentSessionActivityStatus
): string {
  const record = item as Record<string, unknown>;
  const candidate =
    stringOrNull(record.summary) ??
    stringOrNull(record.description) ??
    stringOrNull(record.objective);

  if (candidate?.trim()) {
    return candidate;
  }

  if (status === AgentSessionActivityStatus.AwaitingInput) {
    return "Session is awaiting input";
  }
  if (status === AgentSessionActivityStatus.Inactive) {
    // ISS-4654 (review, #4651): replaces the "Session completed" / "Session
    // abandoned" pair. One terminal-not-failed outcome, one neutral sentence —
    // it states that the run is over without claiming it succeeded or was
    // given up on, neither of which this projection can know.
    return "Session ended";
  }
  if (status === AgentSessionActivityStatus.Failed) {
    return "Session failed";
  }
  if (status === AgentSessionActivityStatus.Active) {
    return "Session is active";
  }
  return "Session updated";
}

function selectMetadata(
  item: Partial<AgentSessionListItem>
): Array<{ label: string; value: string }> {
  const metadata: Array<{ label: string; value: string }> = [];
  if (item.repositoryFullName) {
    metadata.push({ label: "Repository", value: item.repositoryFullName });
  }
  if (item.project?.name) {
    metadata.push({ label: "Project", value: item.project.name });
  }
  if (item.computeTarget?.machineName) {
    metadata.push({
      label: "Compute target",
      value: item.computeTarget.machineName,
    });
  }
  if (item.sourceArtifact?.name) {
    metadata.push({ label: "Artifact", value: item.sourceArtifact.name });
  }
  return metadata;
}

function compareActivities(
  left: AgentSessionActivityWithSort,
  right: AgentSessionActivityWithSort
): number {
  if (left.timestamp && right.timestamp) {
    const delta = right.timestamp.getTime() - left.timestamp.getTime();
    return delta === 0 ? left.sourceIndex - right.sourceIndex : delta;
  }
  if (left.timestamp) {
    return -1;
  }
  if (right.timestamp) {
    return 1;
  }
  return left.sourceIndex - right.sourceIndex;
}

function toDate(value: unknown): Date | null {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toActivityIdSuffix(status: AgentSessionActivityStatus): string {
  return status.toLowerCase().replaceAll(" ", "-");
}

type AgentSessionActivityWithSort = AgentSessionActivity & {
  sourceIndex: number;
};
