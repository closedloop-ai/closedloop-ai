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
