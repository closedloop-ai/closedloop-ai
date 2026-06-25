import { SESSION_STATUS } from "@closedloop-ai/loops-api/session-status";

/**
 * Sort keys for the Sessions table. Values match both the table column ids AND
 * the server's `sortBy` enum (see `AGENT_SESSION_SORT_COLUMNS` in apps/api) so a
 * column-header click round-trips straight to the query. Sorting is server-side.
 */
export const SessionSortKey = {
  User: "user",
  Status: "status",
  Repo: "repo",
  Harness: "harness",
  Model: "model",
  Duration: "duration",
  Cost: "cost",
  Started: "started",
  LastActivity: "lastActivity",
} as const;
export type SessionSortKey =
  (typeof SessionSortKey)[keyof typeof SessionSortKey];

export const SessionSortDir = {
  Asc: "asc",
  Desc: "desc",
} as const;
export type SessionSortDir =
  (typeof SessionSortDir)[keyof typeof SessionSortDir];

/**
 * Display labels for the session statuses used by the Status facet. Unknown
 * statuses fall back to their raw value.
 */
export const SESSION_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  [SESSION_STATUS.WAITING]: "Waiting",
  completed: "Completed",
  [SESSION_STATUS.ERROR]: "Failed",
  abandoned: "Abandoned",
};

export function sessionStatusLabel(status: string): string {
  return SESSION_STATUS_LABELS[status] ?? status;
}
