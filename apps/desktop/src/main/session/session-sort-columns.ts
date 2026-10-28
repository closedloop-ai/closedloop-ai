/**
 * @file session-sort-columns.ts
 * @description The columns the desktop-local session source can actually order
 * by — the vocabulary side of the `<column>:<dir>` wire rule whose ENCODING
 * `@repo/api/src/types/agent-session-sort` owns and whose column list it
 * deliberately leaves to each side.
 *
 * ISS-8679: `sanitizeQuery` refused a `sorts` entry it could not READ (an
 * unsplittable entry, a direction outside `asc`/`desc`) but accepted any column
 * whatever, and `sessionSortKey`'s `default` arm answers an unrecognized column
 * with the `started` key. So `sorts: ["autonomy:asc"]` — `autonomy` is a real
 * v2 toolbar sort key with no case in that comparator — READ successfully and
 * was served in started order: the request answered with a different order from
 * the one it asked for, silently, which is the exact divergence ISS-8679 exists
 * to make loud.
 *
 * Lightweight ON PURPOSE. It carries no imports so the request-validation
 * boundary can narrow a column without pulling in the comparator's runtime
 * (`org-directory-cache` and its fetch/zod dependencies).
 */

/**
 * One column `sessionSortKey` implements. `Started` is the `default` arm of that
 * switch rather than a `case` of its own — the fallback IS the started ordering,
 * which is why an unrecognized column was indistinguishable from a real one.
 *
 * This list and that switch are one vocabulary in two files, so
 * `shared-agent-sessions-multi-rule-sort.test.ts` pins them together against
 * that `Started` key: a column listed here must NOT resolve to it (the
 * comparator implements the column), and a column outside the list must (the
 * comparator does not). Widening this list past the switch, or teaching the
 * switch a column this list does not carry, turns that test red.
 */
export const LocalSessionSortColumn = {
  Status: "status",
  Repo: "repo",
  Harness: "harness",
  Model: "model",
  User: "user",
  Cost: "cost",
  Priority: "priority",
  Duration: "duration",
  Started: "started",
  Updated: "updated",
  LastActivity: "lastActivity",
} as const;
export type LocalSessionSortColumn =
  (typeof LocalSessionSortColumn)[keyof typeof LocalSessionSortColumn];

/** Whether this source can order by `column`, rather than answering as if it could. */
export function isLocalSessionSortColumn(
  column: string
): column is LocalSessionSortColumn {
  return LOCAL_SESSION_SORT_COLUMNS.has(column);
}

const LOCAL_SESSION_SORT_COLUMNS = new Set<string>(
  Object.values(LocalSessionSortColumn)
);
