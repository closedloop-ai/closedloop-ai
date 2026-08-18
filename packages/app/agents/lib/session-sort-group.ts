/**
 * Sort keys for the Sessions table. Values match the server's `sortBy` enum (see
 * `AGENT_SESSION_SORT_COLUMNS` in apps/api). Most also match the table column id
 * 1:1 so a header click round-trips straight to the query; the ONE exception is
 * Owner, whose column id is `owner` but whose server sort key is `user` — the
 * two are bridged by {@link columnIdToSessionSortKey} /
 * {@link sessionSortKeyToColumnId} so the header click reaches the API and the
 * active-sort indicator lights the right column (FEA-4300). Sorting is
 * server-side.
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
  // ISS-6005: record-mutation recency (the `Updated` column). Matches the
  // server sort key and the column id 1:1, like every key except Owner.
  Updated: "updated",
  LastActivity: "lastActivity",
} as const;
export type SessionSortKey =
  (typeof SessionSortKey)[keyof typeof SessionSortKey];

/**
 * The Sessions table column id for the Owner cell. It intentionally differs from
 * its server sort key (`user`) — the cell renders ownership, the API orders by
 * the `user` relation — so the two are mapped rather than assumed equal.
 */
export const OWNER_COLUMN_ID = "owner";

/**
 * Translate a table COLUMN id into the server `sortBy` value the API accepts.
 * Every column id maps 1:1 except `owner` → `user` (FEA-4300); an unknown id
 * passes through so non-owner columns keep working unchanged.
 */
export function columnIdToSessionSortKey(columnId: string): string {
  return columnId === OWNER_COLUMN_ID ? SessionSortKey.User : columnId;
}

/**
 * Translate a server `sortBy` value back into the table COLUMN id, so the
 * active-sort indicator highlights the right header. Inverse of
 * {@link columnIdToSessionSortKey}: `user` → `owner`, everything else passes
 * through.
 */
export function sessionSortKeyToColumnId(sortBy: string | null): string | null {
  return sortBy === SessionSortKey.User ? OWNER_COLUMN_ID : sortBy;
}

export const SessionSortDir = {
  Asc: "asc",
  Desc: "desc",
} as const;
export type SessionSortDir =
  (typeof SessionSortDir)[keyof typeof SessionSortDir];
