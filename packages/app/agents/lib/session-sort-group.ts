import { formatSessionSortRule } from "@repo/api/src/types/agent-session-sort";
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
  Autonomy: "autonomy",
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
 * its server sort key (`user`), so the two are mapped rather than assumed equal.
 *
 * `user`, not `assignee` (ISS-12251, PLN-2176 T-4.2): the cloud API orders
 * `user` by the assignee and accepts `assignee` only as its alias; Desktop's
 * local read refuses `assignee` and orders `user` by the local creator, its
 * Owner (D-7); and an API that predates the alias rejects `assignee`.
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

/**
 * ISS-8335: an ordered rule list as the repeatable `sorts` query param the
 * Sessions list route accepts.
 *
 * Each entry is encoded by the SHARED codec the server's validator parses with
 * (`@repo/api/src/types/agent-session-sort`), so the two halves of the wire
 * contract cannot drift on the separator or the field order. Column ids are
 * translated through {@link columnIdToSessionSortKey} for the same reason a
 * single-column sort is — Owner is `owner` to the table and `user` to the API,
 * and a rule spelled the table's way is rejected by the route's closed enum.
 */
export function toSessionSortRuleParams(
  rules: readonly { fieldId: string; direction: SessionSortDir }[]
): string[] {
  return rules.map((rule) =>
    formatSessionSortRule(
      columnIdToSessionSortKey(rule.fieldId),
      rule.direction
    )
  );
}

/**
 * ISS-8335: one ordered sort rule in the HOST's vocabulary — a server sort key,
 * not a table column id.
 *
 * The distinction is the same one {@link columnIdToSessionSortKey} exists for,
 * and it is why this is not the surface's `SessionsListSortRule`: that carries
 * COLUMN ids, whose set is strictly wider (it adds the lead `name` column and,
 * client-side, sortable custom fields). Nothing outside this closed key set can
 * reach the API — `AGENT_SESSION_SORT_COLUMNS` is a `z.enum` and rejects the
 * rest — so a host rule is spelled in keys and translated at the surface
 * boundary, exactly as the primary `sortKey` already is.
 */
export type SessionSortRule = {
  direction: SessionSortDir;
  fieldId: SessionSortKey;
};
