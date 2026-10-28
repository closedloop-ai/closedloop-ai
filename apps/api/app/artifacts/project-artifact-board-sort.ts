import "server-only";

import { ArtifactSectionOrdering } from "@repo/api/src/types/artifact-group-by-mode";
import { STATUS_DISPLAY_ORDER } from "@repo/api/src/types/artifact-status-display-order";
import {
  DOCUMENT_STATUS_MAPPING,
  ISSUE_STATUS_MAPPING,
  toArtifactStatusFromPullRequestState,
  toArtifactStatusFromSession,
} from "@repo/api/src/types/artifact-status-mapping";
import { artifactStatusRootRankOrNull } from "@repo/api/src/types/artifact-status-rank";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  ProjectArtifactBoardSort,
  ProjectArtifactBoardSortDirection,
} from "@repo/api/src/types/project-artifact-board-page";
import { PRIORITY_ORDINAL } from "@repo/api/src/types/search-query";
import {
  LEGACY_WAITING_WIRE_STATUS,
  normalizeSessionStatus,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { ArtifactSubtype, ArtifactType, Prisma } from "@repo/database";
import {
  COERCED_STATUS_SQL,
  IS_ISSUE_LIFECYCLE_SQL,
  rankCaseSql,
  rootRanksFor,
  statusDisplayRankSql,
} from "./assigned-tree-section-order";

/**
 * ISS-12929 (724-F5): the project table's column sorts as the board's root
 * order, each term restating the browser comparator in
 * `packages/app/documents/lib/table-view-pipeline.ts` (`ITEM_SORT_CONFIGS`,
 * and `rootFirstStatusComparator` for the root-first status order). The
 * browser's sort is stable over the stack-rank order the board was served in,
 * so every term ends with the stack-rank order, never a bare id: tied rows keep
 * their manual order, in either direction.
 *
 * Direction semantics follow each comparator. A comparator multiplied by the
 * direction (title, updated, slug, assignee, type, status) flips its null and
 * miss placement with it, which is Postgres's default NULLS LAST ascending and
 * NULLS FIRST descending. A directed comparator that parks a missing value
 * last both ways (priority, the root-first status ranks) says NULLS LAST.
 *
 * The shared fixture `project-artifact-board-sort.test-fixtures.ts` pins one
 * expected order per key and direction, asserted against these terms in
 * Postgres and against the browser comparators in `@repo/app`.
 */

export type BoardRootSort = {
  by: ProjectArtifactBoardSort;
  direction: ProjectArtifactBoardSortDirection;
  /** The status order the browser resolves from the status flags. */
  statusOrdering: ArtifactSectionOrdering;
};

/** Stack rank, then newest, then id: the order the board always served. */
export const BOARD_STACK_RANK_ORDER_SQL = Prisma.sql`a.sort_order ASC NULLS LAST, a.created_at DESC, a.id ASC`;

export function boardRootOrderSql(sort: BoardRootSort | undefined): Prisma.Sql {
  if (!sort || sort.by === ProjectArtifactBoardSort.StackRank) {
    return BOARD_STACK_RANK_ORDER_SQL;
  }
  const descending = sort.direction === ProjectArtifactBoardSortDirection.Desc;
  return Prisma.sql`${Prisma.join(
    boardSortTerms(sort, {
      direction: descending ? Prisma.sql`DESC` : Prisma.sql`ASC`,
      opposite: descending ? Prisma.sql`ASC` : Prisma.sql`DESC`,
    }),
    ", "
  )}, ${BOARD_STACK_RANK_ORDER_SQL}`;
}

/**
 * The fields a sort reads beyond the ones the population revision already
 * carries, so an edit that reorders a sorted board also changes its revision.
 */
export function boardSortIdentitySql(
  sort: BoardRootSort | undefined
): Prisma.Sql {
  switch (sort?.by) {
    case ProjectArtifactBoardSort.Title:
      return Prisma.sql`a.name`;
    case ProjectArtifactBoardSort.Updated:
      return Prisma.sql`a.updated_at::text`;
    case ProjectArtifactBoardSort.Slug:
      return Prisma.sql`COALESCE(a.slug, '')`;
    case ProjectArtifactBoardSort.Type:
      return Prisma.sql`COALESCE(a.subtype::text, '')`;
    case ProjectArtifactBoardSort.Assignee:
      return Prisma.sql`COALESCE(${ASSIGNEE_NAME_SQL}, '')`;
    default:
      return Prisma.sql`''`;
  }
}

function boardSortTerms(
  sort: BoardRootSort,
  { direction, opposite }: { direction: Prisma.Sql; opposite: Prisma.Sql }
): Prisma.Sql[] {
  switch (sort.by) {
    case ProjectArtifactBoardSort.Title:
      return localeTextTerms(Prisma.sql`a.name`, direction, opposite);
    case ProjectArtifactBoardSort.Updated:
      return [Prisma.sql`a.updated_at ${direction}`];
    case ProjectArtifactBoardSort.Slug:
      // `localeCompare(..., { numeric: true })`: a slug's prefix, then its
      // number as a number, so ISS-9 sorts before ISS-10.
      return [
        Prisma.sql`lower(substring(a.slug from '^[^0-9]*')) ${direction}`,
        Prisma.sql`substring(a.slug from '[0-9]+')::numeric ${direction}`,
        Prisma.sql`lower(a.slug) ${direction}`,
      ];
    case ProjectArtifactBoardSort.Priority:
      // `comparePriorityValuesForSort`: urgent first ascending, unset last
      // in both directions.
      return [
        Prisma.sql`${rankCaseSql(Prisma.sql`a.priority::text`, URGENT_FIRST_PRIORITY_RANKS, null)} ${direction} NULLS LAST`,
      ];
    case ProjectArtifactBoardSort.Assignee:
      return localeTextTerms(ASSIGNEE_NAME_SQL, direction, opposite);
    case ProjectArtifactBoardSort.Type:
      return [Prisma.sql`${ROW_TYPE_SQL} COLLATE "C" ${direction}`];
    case ProjectArtifactBoardSort.Status:
      return statusTerms(sort.statusOrdering, direction);
    case ProjectArtifactBoardSort.StackRank:
      return [];
    default: {
      const exhaustive: never = sort.by;
      return exhaustive;
    }
  }
}

/**
 * `localeCompare` without an ICU collation, which this database does not
 * otherwise depend on: case-insensitive first, then, for names equal but for
 * case, lowercase first, which is byte order reversed. Accented and other
 * non-ASCII text can still order differently from the browser.
 */
function localeTextTerms(
  text: Prisma.Sql,
  direction: Prisma.Sql,
  opposite: Prisma.Sql
): Prisma.Sql[] {
  return [
    Prisma.sql`lower(${text}) ${direction}`,
    Prisma.sql`${text} COLLATE "C" ${opposite}`,
  ];
}

/**
 * `compareByStatus` (vocabulary and retained orderings): the display rank of
 * the row's status, a document's being the subtype-folded one, a miss ranking
 * after every named status. `rootFirstStatusComparator`: the root band, then
 * a document's raw display rank, each missing value last in both directions.
 */
function statusTerms(
  ordering: ArtifactSectionOrdering,
  direction: Prisma.Sql
): Prisma.Sql[] {
  if (ordering !== ArtifactSectionOrdering.RootFirst) {
    return [
      Prisma.sql`(CASE WHEN a.type = ${DOCUMENT_TYPE_SQL} THEN ${statusDisplayRankSql(COERCED_STATUS_SQL)} ELSE ${statusDisplayRankSql(Prisma.sql`a.status`)} END) ${direction}`,
    ];
  }
  return [
    Prisma.sql`${ROOT_RANK_OR_NULL_SQL} ${direction} NULLS LAST`,
    Prisma.sql`(CASE WHEN a.type = ${DOCUMENT_TYPE_SQL} THEN ${rankCaseSql(Prisma.sql`a.status`, STATUS_DISPLAY_RANKS, null)} END) ${direction} NULLS LAST`,
  ];
}

const DOCUMENT_TYPE_SQL = Prisma.sql`${ArtifactType.DOCUMENT}::"ArtifactType"`;

const URGENT_FIRST_PRIORITY_RANKS: ReadonlyMap<string, number> = new Map(
  Object.entries(PRIORITY_ORDINAL).map(([priority, ordinal]) => [
    priority,
    -ordinal,
  ])
);

const STATUS_DISPLAY_RANKS: ReadonlyMap<string, number> = new Map(
  STATUS_DISPLAY_ORDER.map((status, index) => [status, index])
);

const ASSIGNEE_NAME_SQL = Prisma.sql`(
  SELECT ${userDisplayNameSql(Prisma.raw("assignee"))}
  FROM users assignee
  WHERE assignee.id = a.assignee_id
)`;

/**
 * `getItemSortType`: a document row's type is its document type (the
 * subtype, with the input-only ISSUE alias folded onto FEATURE as the row
 * adapter does); other rows carry the artifact type.
 */
const ROW_TYPE_SQL = Prisma.sql`(CASE
  WHEN a.type = ${DOCUMENT_TYPE_SQL} THEN
    CASE WHEN a.subtype::text = ${ArtifactSubtype.ISSUE} THEN ${ArtifactSubtype.FEATURE} ELSE a.subtype::text END
  ELSE a.type::text
END)`;

/** Each status's root band rank, an unknown root ranking as missing. */
function rootRanks<T extends string>(
  statuses: readonly T[],
  fold: (status: T) => { root: string }
): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>();
  for (const status of statuses) {
    const rank = artifactStatusRootRankOrNull(fold(status).root);
    if (rank !== null) {
      ranks.set(status, rank);
    }
  }
  return ranks;
}

const ISSUE_ROOT_RANKS = rootRanksFor(ISSUE_STATUS_MAPPING);

const DOCUMENT_ROOT_RANKS = rootRanksFor(DOCUMENT_STATUS_MAPPING);

/** A branch row's status recognized as a pull request state (`normalizeBranchStatus`). */
const BRANCH_ROOT_RANKS = rootRanks(
  Object.values(GitHubPRState),
  toArtifactStatusFromPullRequestState
);

/**
 * A session row's status through the canonical fold, which reads an
 * unrecognized spelling as active, so the miss rank is active's root.
 */
const SESSION_ROOT_RANKS = rootRanks(
  [...Object.values(SESSION_STATUS), LEGACY_WAITING_WIRE_STATUS],
  (status) => toArtifactStatusFromSession(status)
);
const SESSION_MISS_ROOT_RANK = artifactStatusRootRankOrNull(
  toArtifactStatusFromSession(normalizeSessionStatus("")).root
);

const ROOT_RANK_OR_NULL_SQL = Prisma.sql`(CASE
  WHEN a.type = ${DOCUMENT_TYPE_SQL} AND ${IS_ISSUE_LIFECYCLE_SQL}
    THEN ${rankCaseSql(Prisma.sql`a.status`, ISSUE_ROOT_RANKS, null)}
  WHEN a.type = ${DOCUMENT_TYPE_SQL}
    THEN ${rankCaseSql(Prisma.sql`a.status`, DOCUMENT_ROOT_RANKS, null)}
  WHEN a.type = ${ArtifactType.BRANCH}::"ArtifactType"
    THEN ${rankCaseSql(Prisma.sql`upper(a.status)`, BRANCH_ROOT_RANKS, null)}
  WHEN a.type = ${ArtifactType.SESSION}::"ArtifactType"
    THEN ${rankCaseSql(Prisma.sql`lower(a.status)`, SESSION_ROOT_RANKS, SESSION_MISS_ROOT_RANK)}
END)`;

/**
 * `getUserDisplayName` over a `users` row alias: the trimmed full name, else
 * the email, else the fallback the browser renders.
 */
export function userDisplayNameSql(user: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`COALESCE(
    NULLIF(trim(concat(COALESCE(${user}.first_name, ''), ' ', COALESCE(${user}.last_name, ''))), ''),
    NULLIF(${user}.email, ''),
    'Unknown user'
  )`;
}
