import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";

export const AgentSessionActivityStatus = {
  Abandoned: "Abandoned",
  Active: "Active",
  AwaitingInput: "Awaiting Input",
  Completed: "Completed",
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
    (normalizedStatus === "active" || normalizedStatus === "waiting") &&
    item.awaitingInputSince
  ) {
    return AgentSessionActivityStatus.AwaitingInput;
  }
  if (normalizedStatus === "active") {
    return AgentSessionActivityStatus.Active;
  }
  if (normalizedStatus === "completed") {
    return AgentSessionActivityStatus.Completed;
  }
  if (normalizedStatus === "failed" || normalizedStatus === "error") {
    return AgentSessionActivityStatus.Failed;
  }
  if (normalizedStatus === "abandoned") {
    return AgentSessionActivityStatus.Abandoned;
  }
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
  if (status === AgentSessionActivityStatus.Completed) {
    return "Session completed";
  }
  if (status === AgentSessionActivityStatus.Failed) {
    return "Session failed";
  }
  if (status === AgentSessionActivityStatus.Abandoned) {
    return "Session abandoned";
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
