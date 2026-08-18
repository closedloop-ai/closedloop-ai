import type { Prisma } from "@repo/database";
import type { AgentSessionListQuery } from "../validators";

/**
 * The Sessions list ORDER BY, as ONE source of truth.
 *
 * Four correctness invariants this module owns so no single column can regress
 * them independently:
 *
 *  - FEA-4329 — offset pagination has no natural unique key, so a tie on the sort
 *    column (two sessions with the same timestamp/cost/…) lets `skip`/`take` skip
 *    or repeat a row across pages EVEN on a static snapshot. EVERY orderBy
 *    therefore ends with {@link SESSION_UNIQUE_TIEBREAKER}, the `artifactId`
 *    primary key — a TOTAL order, so a given result set paginates deterministically
 *    with no ambiguous adjacent rows. This does NOT make `skip`/`take` stable
 *    across concurrent INSERTS: a row landing ahead of the current page still
 *    shifts every later offset by one (the row repeats), which is inherent to
 *    offset pagination — only cursor/keyset pagination is insert-stable. The
 *    tiebreaker's guarantee is a total, repeatable order for a fixed population,
 *    not immunity to a moving one.
 *  - FEA-4330 — Postgres orders NULLs FIRST on `DESC` by default, so a descending
 *    sort on a nullable column (cost, model, repository, harness, started,
 *    duration) put blank rows ABOVE the real maxima. Every nullable sort column
 *    is pinned `nulls: "last"` in BOTH directions here, so blanks always sort to
 *    the end regardless of direction ({@link nullableColumnOrder}).
 *  - FEA-4297 — the displayed Duration is the SERVED span
 *    `(lastActivityAt ?? startedAt) - startedAt`: the list projection coalesces a
 *    null `lastActivityAt` to `sessionStartedAt` (`projections.ts`), so the served
 *    row's end instant is `lastActivityAt ?? startedAt` and `endedAt` is never read
 *    on the served row (ISS-4766). It has no single stored column to order by, so
 *    `duration` is a {@link isDisplayValueSort} sort resolved in memory. NOTE
 *    (ISS-4989): the comparator (`resolveDisplayDurationMs`) keys on the RAW
 *    candidate column and falls through to `endedAt` (`lastActivityAt ?? endedAt`),
 *    which diverges from the served `?? startedAt` for an event-less completed row
 *    — a pre-existing cross-surface gap tracked in ISS-4989.
 *  - FEA-4300 — the Owner cell renders the user's display name
 *    (`"First Last"`, falling back to email), but the server ordered by the hidden
 *    email. `user` is a {@link isDisplayValueSort} sort resolved in memory against
 *    the same display-name derivation, case-insensitively.
 *
 * The DB-native columns (status/repo/harness/model/cost/started/lastActivity)
 * stay in Prisma `orderBy`; the two display-value columns (duration/user) route
 * through the in-memory candidate path, mirroring the cost-reconcile path that
 * already sorts by a value the DB column can't be trusted for.
 */

/**
 * FEA-4329: the stable unique tiebreaker appended to EVERY orderBy. `artifactId`
 * is the `SessionDetail` primary key, so it is total and never null — the last
 * key in the order is guaranteed unique, giving offset pagination a deterministic,
 * repeatable order over a FIXED population (no ambiguous adjacent rows). It does
 * NOT make `skip`/`take` immune to concurrent inserts — a row landing ahead of the
 * page still shifts later offsets; that is inherent to offset (vs cursor)
 * pagination.
 */
export const SESSION_UNIQUE_TIEBREAKER: Prisma.SessionDetailOrderByWithRelationInput =
  { artifactId: "desc" };

/**
 * FEA-4330: order a nullable column with NULLs last in BOTH directions. Postgres
 * defaults to NULLs-first on `DESC`, which floats blank rows above real maxima;
 * pinning `nulls: "last"` keeps "no value" at the end whichever way the user
 * sorts.
 */
function nullableColumnOrder(
  column: keyof Prisma.SessionDetailOrderByWithRelationInput,
  dir: "asc" | "desc"
): Prisma.SessionDetailOrderByWithRelationInput {
  return { [column]: { sort: dir, nulls: "last" } };
}

/**
 * PLN-1034: the Sessions list defaults to most-recent genuine activity. Null
 * activity (pre-backfill rows) sorts last; `sessionStartedAt` narrows ties and
 * the unique `artifactId` key closes them (FEA-4329).
 */
export const SESSION_DEFAULT_ORDER_BY: Prisma.SessionDetailOrderByWithRelationInput[] =
  [
    { lastActivityAt: { sort: "desc", nulls: "last" } },
    { sessionStartedAt: "desc" },
    SESSION_UNIQUE_TIEBREAKER,
  ];

/**
 * FEA-4297/FEA-4300/FEA-4301: the sort columns whose displayed value is a
 * derivation with no single trustworthy DB column — Duration (a computed span),
 * Owner (a "First Last"/email display name), and Status (the PROJECTED status:
 * the raw persisted status, except an awaiting-input row DISPLAYS as Waiting
 * though it stores `active`). These route through the in-memory candidate path so
 * the ordering matches exactly what the row renders — an order-by on the raw
 * `artifact.status` column sorted a displayed-Waiting row among the Active rows.
 */
const DISPLAY_VALUE_SORTS = new Set<AgentSessionListQuery["sortBy"]>([
  "duration",
  "user",
  "status",
  // ISS-6005: the rendered `Updated` value is MAX(session_detail.updated_at,
  // artifacts.updated_at) — no single stored column a Prisma orderBy can
  // express — so it rides the in-memory path like its three siblings.
  "updated",
]);

export function isDisplayValueSort(
  sortBy: AgentSessionListQuery["sortBy"]
): boolean {
  return sortBy !== undefined && DISPLAY_VALUE_SORTS.has(sortBy);
}

/**
 * The DB-native ORDER BY for a sort column, with FEA-4330 nulls-last on every
 * nullable column and the FEA-4329 unique tiebreaker appended. The display-value
 * sorts (duration/user/status) never reach here — they are ordered in memory —
 * and an unset `sortBy` keeps {@link SESSION_DEFAULT_ORDER_BY}. The exhaustive
 * `switch` makes a newly-added sort column fail typecheck until it is mapped here
 * or routed through the display-value path.
 */
export function buildDbSortOrderBy(
  filters: AgentSessionListQuery
): Prisma.SessionDetailOrderByWithRelationInput[] {
  const dir = filters.sortDir ?? "desc";
  switch (filters.sortBy) {
    case undefined:
      return SESSION_DEFAULT_ORDER_BY;
    case "lastActivity":
      return [
        nullableColumnOrder("lastActivityAt", dir),
        { sessionStartedAt: "desc" },
        SESSION_UNIQUE_TIEBREAKER,
      ];
    case "repo":
      return [
        nullableColumnOrder("repositoryFullName", dir),
        SESSION_UNIQUE_TIEBREAKER,
      ];
    case "harness":
      // `harness` is non-null (schema default "unknown"), so nulls-ordering is
      // moot — but it still needs the unique tiebreaker for deterministic pages.
      return [{ harness: dir }, SESSION_UNIQUE_TIEBREAKER];
    case "model":
      return [nullableColumnOrder("model", dir), SESSION_UNIQUE_TIEBREAKER];
    case "cost":
      return [
        nullableColumnOrder("estimatedCost", dir),
        SESSION_UNIQUE_TIEBREAKER,
      ];
    case "started":
      // `sessionStartedAt` is non-null; nulls-ordering is moot but the unique
      // tiebreaker is required.
      return [{ sessionStartedAt: dir }, SESSION_UNIQUE_TIEBREAKER];
    case "duration":
    case "user":
    case "status":
    case "updated":
      // Display-value sorts are resolved in memory (see isDisplayValueSort). The
      // DB order-by is only the candidate pre-scan order; a deterministic recency
      // order keeps a stable candidate set under the scan cap. `status` joins them
      // (FEA-4301): the displayed status projects Waiting from `awaitingInputSince`,
      // which no `ORDER BY artifact.status` can express. `updated` joins them
      // (ISS-6005): the rendered value is a MAX over two columns, one of them on
      // the parent artifact row, equally inexpressible as a column orderBy.
      return SESSION_DEFAULT_ORDER_BY;
    default: {
      const exhaustive: never = filters.sortBy;
      return exhaustive;
    }
  }
}
