import "server-only";

import { createHash } from "node:crypto";
import {
  ArtifactDateField,
  type ArtifactDateWindow,
} from "@repo/api/src/types/artifact-date-filter";
import {
  HIDE_COMPLETED_BRANCH_STATUSES,
  HIDE_COMPLETED_DOCUMENT_STATUSES,
  HIDE_COMPLETED_ISSUE_STATUSES,
} from "@repo/api/src/types/artifact-hide-completed";
import { DISPLAYED_ARTIFACT_STATUS } from "@repo/api/src/types/artifact-status";
import {
  DOCUMENT_STATUS_OPTIONS,
  DocumentStatus,
  ISSUE_STATUS_OPTIONS,
  IssueStatus,
} from "@repo/api/src/types/document";
import { splitPriorityFilter } from "@repo/api/src/types/priority-filter";
import {
  PROJECT_ARTIFACT_BOARD_NO_PRIORITY_LANE_ID,
  PROJECT_ARTIFACT_BOARD_UNASSIGNED_LANE_ID,
} from "@repo/api/src/types/project-artifact-board-move";
import {
  PROJECT_ARTIFACT_BOARD_UNASSIGNED_FILTER,
  type ProjectArtifactBoardFilters,
  ProjectArtifactBoardGroup,
} from "@repo/api/src/types/project-artifact-board-page";
import { TERMINAL_SESSION_STATUSES } from "@repo/api/src/types/session-status";
import {
  ArtifactSubtype,
  ArtifactType,
  LinkType as DatabaseLinkType,
  Prisma,
  type TransactionClient,
} from "@repo/database";
import { toSqlContainsPattern } from "@/lib/sql-like";
import { boardListToolbarFilterSql } from "./project-artifact-board-list-filters";
import {
  type BoardRootSort,
  boardRootOrderSql,
  boardSortIdentitySql,
} from "./project-artifact-board-sort";

/**
 * ISS-12929 (724-F5): the board's root population as database queries. A page
 * reads only its own ids, and lane counts and the population revision are
 * aggregates computed by Postgres, so a request no longer ships every root to
 * the server or every page to the browser. Filters apply inside the same
 * snapshot, keeping the browser predicate's per-kind meaning: status, priority
 * and tags narrow documents only, hide-completed asks each kind's own
 * vocabulary, and search reads a document's title or slug and any other
 * artifact's title.
 */

/**
 * Which status the browser shows a document under, decided by the
 * universal-artifact-status flag: the stored, subtype-folded status (off), or
 * the projected facet with its Unknown bucket (on).
 */
export const BoardStatusEvidence = {
  Projected: "projected",
  Stored: "stored",
} as const;
export type BoardStatusEvidence =
  (typeof BoardStatusEvidence)[keyof typeof BoardStatusEvidence];

export type BoardRootLane = {
  count: number;
  id: string;
  /** Roots of this lane at positions up to the page's end. */
  loadedCount: number;
};

export type BoardRootAggregate = {
  lanes: BoardRootLane[];
  revision: string;
  total: number;
};

type BoardRootScope = {
  filters: ProjectArtifactBoardFilters | undefined;
  groupBy: ProjectArtifactBoardGroup;
  organizationId: string;
  projectId: string;
  sort?: BoardRootSort;
  statusEvidence: BoardStatusEvidence;
  viewerUserId: string;
};

/** Lane counts, loaded counts and the filtered population's revision. */
export async function readBoardRootAggregate(
  db: TransactionClient,
  scope: BoardRootScope,
  loadedThrough: number
): Promise<BoardRootAggregate> {
  const rows = await db.$queryRaw<
    Array<{
      count: number | null;
      digest: string;
      laneId: string | null;
      loadedCount: number | null;
      total: number;
    }>
  >(Prisma.sql`
    WITH ordered AS (
      SELECT
        ${boardLaneSql(scope.groupBy)} AS lane_id,
        ROW_NUMBER() OVER (ORDER BY ${boardRootOrderSql(scope.sort)}) AS position,
        concat_ws(
          ',',
          a.id::text,
          a.status,
          COALESCE(a.priority::text, ''),
          COALESCE(a.assignee_id::text, ''),
          COALESCE(a.sort_order::text, ''),
          to_char(a.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US'),
          ${boardSortIdentitySql(scope.sort)}
        ) AS identity
      FROM artifacts a
      WHERE ${boardRootWhereSql(scope)}
    ),
    lanes AS (
      SELECT
        lane_id,
        COUNT(*)::int AS count,
        (COUNT(*) FILTER (WHERE position <= ${loadedThrough}))::int AS loaded_count,
        MIN(position) AS first_position
      FROM ordered
      GROUP BY lane_id
    ),
    digest AS (
      SELECT
        encode(
          sha256(
            convert_to(
              COALESCE(string_agg(identity, '|' ORDER BY position), ''),
              'UTF8'
            )
          ),
          'hex'
        ) AS digest,
        COUNT(*)::int AS total
      FROM ordered
    )
    SELECT
      lanes.lane_id AS "laneId",
      lanes.count AS count,
      lanes.loaded_count AS "loadedCount",
      digest.digest AS digest,
      digest.total AS total
    FROM digest
    LEFT JOIN lanes ON true
    ORDER BY lanes.first_position ASC NULLS LAST
  `);
  const first = rows[0];
  return {
    lanes: rows.flatMap((row) =>
      row.laneId === null
        ? []
        : [
            {
              count: row.count ?? 0,
              id: row.laneId,
              loadedCount: row.loadedCount ?? 0,
            },
          ]
    ),
    revision: boardPopulationRevision(first?.digest ?? "", scope.filters),
    total: first?.total ?? 0,
  };
}

/** One page of root ids in board order. */
export async function readBoardRootPage(
  db: TransactionClient,
  scope: BoardRootScope,
  offset: number,
  pageSize: number
): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT a.id
    FROM artifacts a
    WHERE ${boardRootWhereSql(scope)}
    ORDER BY ${boardRootOrderSql(scope.sort)}
    OFFSET ${offset}
    LIMIT ${pageSize}
  `);
  return rows.map((row) => row.id);
}

/**
 * The revision a cursor is fenced against: the database digest of the ordered
 * population's lane-relevant fields, bound to the filters that selected it, so
 * a cursor minted under one filter cannot continue another.
 */
export function boardPopulationRevision(
  digest: string,
  filters: ProjectArtifactBoardFilters | undefined
): string {
  return createHash("sha256")
    .update(digest)
    .update("\u0000")
    .update(boardFilterKey(filters))
    .digest("hex");
}

function boardFilterKey(filters: ProjectArtifactBoardFilters | undefined) {
  if (!filters) {
    return "";
  }
  const sorted = (values: readonly string[] | undefined) =>
    values && values.length > 0 ? [...new Set(values)].sort() : null;
  return JSON.stringify([
    sorted(filters.assigneeIds),
    filters.dateWindow
      ? [
          filters.dateWindow.field,
          filters.dateWindow.from.toISOString(),
          filters.dateWindow.to.toISOString(),
        ]
      : null,
    filters.favoritesOnly === true,
    filters.hideCompletedItems === true,
    sorted(filters.priorities),
    filters.search?.trim() || null,
    sorted(filters.statuses),
    sorted(filters.tagIds),
    sorted(filters.anyKindPriorities),
    sorted(filters.anyKindTagIds),
    sorted(filters.kinds),
    filters.kindStatuses
      ? filters.kindStatuses
          .map(
            (entry) =>
              `${entry.kind}:${entry.match}:${[...new Set(entry.statuses)].sort().join(",")}`
          )
          .sort()
      : null,
    filters.mineOnly === true,
    filters.slugOrTitle?.trim() || null,
    sorted(filters.parentIds),
    sorted(filters.relatedSessionIds),
    filters.customFieldValues
      ? filters.customFieldValues
          .map(
            (field) =>
              `${field.fieldId}:${[...field.labels].sort().join("\u0000")}`
          )
          .sort()
      : null,
    filters.customFieldRanges
      ? filters.customFieldRanges
          .map(
            (range) => `${range.fieldId}:${range.min ?? ""}:${range.max ?? ""}`
          )
          .sort()
      : null,
  ]);
}

const DOCUMENT_TYPE_SQL = Prisma.sql`${ArtifactType.DOCUMENT}::"ArtifactType"`;

const ISSUE_SUBTYPES_SQL = Prisma.join(
  [ArtifactSubtype.FEATURE, ArtifactSubtype.ISSUE].map(
    (subtype) => Prisma.sql`${subtype}`
  )
);

function boardRootWhereSql(scope: BoardRootScope): Prisma.Sql {
  const filters = scope.filters ?? {};
  return Prisma.sql`a.organization_id = ${scope.organizationId}::uuid
      AND a.project_id = ${scope.projectId}::uuid
      AND NOT EXISTS (
        SELECT 1
        FROM artifact_links parent_link
        WHERE parent_link.target_id = a.id
          AND parent_link.organization_id = ${scope.organizationId}::uuid
          AND parent_link.link_type = ${DatabaseLinkType.PRODUCES}::"LinkType"
      )
      ${assigneeSql(filters.assigneeIds)}
      ${documentStatusSql(filters.statuses, scope.statusEvidence)}
      ${documentPrioritySql(filters.priorities)}
      ${documentTagsSql(filters.tagIds)}
      ${favoritesSql(filters.favoritesOnly, scope.viewerUserId)}
      ${hideCompletedSql(filters.hideCompletedItems)}
      ${dateSql(filters.dateWindow)}
      ${searchSql(filters.search)}
      ${boardListToolbarFilterSql(filters, scope)}`;
}

function boardLaneSql(groupBy: ProjectArtifactBoardGroup): Prisma.Sql {
  switch (groupBy) {
    case ProjectArtifactBoardGroup.Status:
      return Prisma.sql`a.status`;
    case ProjectArtifactBoardGroup.Priority:
      return Prisma.sql`COALESCE(a.priority::text, ${PROJECT_ARTIFACT_BOARD_NO_PRIORITY_LANE_ID})`;
    case ProjectArtifactBoardGroup.Assignee:
      return Prisma.sql`COALESCE(a.assignee_id::text, ${PROJECT_ARTIFACT_BOARD_UNASSIGNED_LANE_ID})`;
    case ProjectArtifactBoardGroup.None:
      return Prisma.sql`'all'`;
    default: {
      const exhaustive: never = groupBy;
      return exhaustive;
    }
  }
}

function assigneeSql(assigneeIds: readonly string[] | undefined) {
  if (!assigneeIds || assigneeIds.length === 0) {
    return Prisma.empty;
  }
  const ids = [...new Set(assigneeIds)].filter(
    (id) => id !== PROJECT_ARTIFACT_BOARD_UNASSIGNED_FILTER
  );
  const arms: Prisma.Sql[] = [];
  if (ids.length > 0) {
    arms.push(
      Prisma.sql`a.assignee_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})`
    );
  }
  if (ids.length < new Set(assigneeIds).size) {
    arms.push(Prisma.sql`a.assignee_id IS NULL`);
  }
  return Prisma.sql`AND (${Prisma.join(arms, " OR ")})`;
}

/**
 * A document's status facet, matched against the status the browser shows for
 * it; other kinds carry no document status. A stored value matches only inside
 * its own subtype's vocabulary. An off-vocabulary status reads as the
 * subtype's fallback (Backlog for issues, Draft otherwise, as
 * `parseStatusForSubtype` folds it) under stored evidence, and as the Unknown
 * facet under projected evidence.
 */
function documentStatusSql(
  statuses: readonly string[] | undefined,
  evidence: BoardStatusEvidence
) {
  if (!statuses || statuses.length === 0) {
    return Prisma.empty;
  }
  const selected = new Set(statuses);
  const vocabularies = [
    {
      fallback: IssueStatus.Backlog,
      subtypeSql: Prisma.sql`a.subtype::text IN (${ISSUE_SUBTYPES_SQL})`,
      vocabulary: ISSUE_STATUS_OPTIONS,
    },
    {
      fallback: DocumentStatus.Draft,
      subtypeSql: Prisma.sql`a.subtype::text NOT IN (${ISSUE_SUBTYPES_SQL})`,
      vocabulary: DOCUMENT_STATUS_OPTIONS,
    },
  ];
  const arms = vocabularies.flatMap(({ fallback, subtypeSql, vocabulary }) => {
    const matches = vocabulary.filter((status) => selected.has(status));
    const offVocabularyMatches =
      evidence === BoardStatusEvidence.Stored
        ? selected.has(fallback)
        : selected.has(DISPLAYED_ARTIFACT_STATUS.Unknown);
    const statusArms: Prisma.Sql[] = [];
    if (matches.length > 0) {
      statusArms.push(Prisma.sql`a.status IN (${statusList(matches)})`);
    }
    if (offVocabularyMatches) {
      statusArms.push(Prisma.sql`a.status NOT IN (${statusList(vocabulary)})`);
    }
    return statusArms.length > 0
      ? [Prisma.sql`(${subtypeSql} AND (${Prisma.join(statusArms, " OR ")}))`]
      : [];
  });
  if (arms.length === 0) {
    return Prisma.sql`AND a.type <> ${DOCUMENT_TYPE_SQL}`;
  }
  return Prisma.sql`AND (a.type <> ${DOCUMENT_TYPE_SQL} OR ${Prisma.join(arms, " OR ")})`;
}

function documentPrioritySql(
  priorities: ProjectArtifactBoardFilters["priorities"]
) {
  if (!priorities || priorities.length === 0) {
    return Prisma.empty;
  }
  const { members, includesUnset } = splitPriorityFilter(priorities);
  const arms: Prisma.Sql[] = [];
  if (members.length > 0) {
    arms.push(
      Prisma.sql`a.priority IN (${Prisma.join(members.map((member) => Prisma.sql`${member}::"Priority"`))})`
    );
  }
  if (includesUnset) {
    arms.push(Prisma.sql`a.priority IS NULL`);
  }
  if (arms.length === 0) {
    // Fail closed: a selection that resolves to no arm must never widen to
    // every root. The route's enum makes this unreachable.
    throw new Error("Board priority facet resolved to no SQL arm");
  }
  return Prisma.sql`AND (a.type <> ${DOCUMENT_TYPE_SQL} OR ${Prisma.join(arms, " OR ")})`;
}

/** Any one selected tag keeps a document, as the browser predicate does. */
function documentTagsSql(tagIds: readonly string[] | undefined) {
  if (!tagIds || tagIds.length === 0) {
    return Prisma.empty;
  }
  const ids = [...new Set(tagIds)].map((id) => Prisma.sql`${id}::uuid`);
  return Prisma.sql`AND (a.type <> ${DOCUMENT_TYPE_SQL} OR EXISTS (
        SELECT 1
        FROM tag_artifacts tag_artifact
        WHERE tag_artifact.artifact_id = a.id
          AND tag_artifact.tag_id IN (${Prisma.join(ids)})
      ))`;
}

/** The viewer's favorites, never another member's. */
function favoritesSql(favoritesOnly: boolean | undefined, viewerId: string) {
  if (favoritesOnly !== true) {
    return Prisma.empty;
  }
  return Prisma.sql`AND EXISTS (
        SELECT 1
        FROM favorite_artifacts favorite
        WHERE favorite.artifact_id = a.id
          AND favorite.user_id = ${viewerId}::uuid
      )`;
}

/**
 * Completion per kind, from the shared hide-completed vocabularies the
 * browser's `isRowItemCompleted` reads. A kind with no completed state (a
 * deployment) stays visible.
 */
function hideCompletedSql(hideCompletedItems: boolean | undefined) {
  if (hideCompletedItems !== true) {
    return Prisma.empty;
  }
  return Prisma.sql`AND NOT (
        CASE
          WHEN a.type = ${DOCUMENT_TYPE_SQL} AND a.subtype::text IN (${ISSUE_SUBTYPES_SQL})
            THEN a.status IN (${statusList(HIDE_COMPLETED_ISSUE_STATUSES)})
          WHEN a.type = ${DOCUMENT_TYPE_SQL}
            THEN a.status IN (${statusList(HIDE_COMPLETED_DOCUMENT_STATUSES)})
          WHEN a.type = ${ArtifactType.BRANCH}::"ArtifactType"
            THEN upper(a.status) IN (${statusList(HIDE_COMPLETED_BRANCH_STATUSES)})
          WHEN a.type = ${ArtifactType.SESSION}::"ArtifactType"
            THEN lower(a.status) IN (${statusList([...TERMINAL_SESSION_STATUSES])})
          ELSE false
        END
      )`;
}

/** Both ends inclusive, matching the browser predicate. */
function dateSql(window: ArtifactDateWindow | undefined) {
  if (!window) {
    return Prisma.empty;
  }
  const column =
    window.field === ArtifactDateField.CreatedAt
      ? Prisma.sql`a.created_at`
      : Prisma.sql`a.updated_at`;
  return Prisma.sql`AND ${column} >= ${window.from} AND ${column} <= ${window.to}`;
}

function searchSql(search: string | undefined) {
  const term = search?.trim();
  if (!term) {
    return Prisma.empty;
  }
  const pattern = toSqlContainsPattern(term);
  return Prisma.sql`AND (
        a.name ILIKE ${pattern} ESCAPE '\\'
        OR (a.type = ${DOCUMENT_TYPE_SQL} AND a.slug ILIKE ${pattern} ESCAPE '\\')
      )`;
}

function statusList(statuses: readonly string[]): Prisma.Sql {
  return Prisma.join(statuses.map((status) => Prisma.sql`${status}`));
}
