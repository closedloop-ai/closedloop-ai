import {
  BRANCH_CONTRIBUTOR_USER_ID_PARAM,
  BRANCH_LOC_MAX_PARAM,
  BRANCH_LOC_MIN_PARAM,
  normalizeRepoFullName,
} from "@repo/api/src/types/branch";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
} from "@repo/api/src/types/branch-activity";
import { ArtifactType, Prisma } from "@repo/database";
import {
  type CanonicalCloudBranchActivityAtom,
  canonicalBranchActivityCompleteness,
  canonicalBranchActivitySources,
} from "./branch-activity-canonical-read";
import { selectedAssociatedPullRequestExists } from "./branch-associated-pull-request-sql";
import {
  appendBranchCandidateLocRangePredicate,
  branchContributorExistsSql,
  branchLinkedSessionExistsSql,
} from "./branch-contribution-sql";
import type { BranchListQuery } from "./branch-read-service";
import {
  type BranchFilterStatus,
  branchCandidateStatusClause,
} from "./branch-read-service/status-filter-sql";
import { cloudBranchEligibilitySql } from "./cloud-branch-eligibility";

type BranchCandidateClient = {
  $queryRaw: <T>(query: Prisma.Sql) => Promise<T>;
};

export type BranchCandidateSnapshot = {
  id: string;
  repositorySortKey: string;
  branchSortKey: string;
  activityAtom: CanonicalCloudBranchActivityAtom | null;
};

/** Index one bounded candidate snapshot set for row-projection reconciliation. */
export function indexBranchCandidateSnapshots(
  candidates: readonly BranchCandidateSnapshot[] | undefined
): ReadonlyMap<string, BranchCandidateSnapshot> | undefined {
  return candidates
    ? new Map(candidates.map((candidate) => [candidate.id, candidate]))
    : undefined;
}

/** Replace a separately hydrated atom with the exact candidate-selected atom. */
export function applyBranchCandidateActivitySnapshot<
  Row extends {
    id: string;
    branch: { activityAtoms: readonly unknown[] };
  },
>(
  row: Row,
  candidatesById: ReadonlyMap<string, BranchCandidateSnapshot> | undefined
): Row {
  if (!candidatesById) {
    return row;
  }
  const candidate = candidatesById.get(row.id);
  if (!candidate) {
    return row;
  }
  return {
    ...row,
    branch: {
      ...row.branch,
      activityAtoms: candidate.activityAtom ? [candidate.activityAtom] : [],
    },
  };
}

type BranchCandidateRawRow = {
  id: string | null;
  repositorySortKey: string | null;
  branchSortKey: string | null;
  atomVersion: number | null;
  atomSource: string | null;
  atomSourceEventId: string | null;
  atomOccurredAt: Date | null;
  atomAttributionKind: string | null;
  atomPullRequestDetailId: string | null;
  atomCompleteness: string | null;
};

type BranchCandidatePageRow = BranchCandidateRawRow & {
  count: bigint | number | string;
};

/** Select one reconciled list page and total from a single database snapshot. */
export async function getBranchCandidatePage(
  db: BranchCandidateClient,
  organizationId: string,
  query: BranchListQuery,
  limit: number,
  offset: number
): Promise<{
  candidates: BranchCandidateSnapshot[];
  ids: string[];
  total: number;
  hasMore: boolean;
}> {
  const whereClause = branchCandidateWhereClause(organizationId, query);
  const rows = await db.$queryRaw<BranchCandidatePageRow[]>(Prisma.sql`
    WITH candidates AS (
      ${branchCandidateSelectClause()}
      ${branchCandidateFromClause()}
      ${whereClause}
    ), page_candidates AS (
      SELECT *
      FROM candidates candidate
      ${branchCandidateOrderClause(Prisma.sql`candidate`)}
      LIMIT ${limit}
      OFFSET ${offset}
    )
    SELECT page_candidate.*, candidate_count.count
    FROM (SELECT COUNT(*)::bigint AS count FROM candidates) candidate_count
    LEFT JOIN page_candidates page_candidate ON TRUE
    ${branchCandidateOrderClause(Prisma.sql`page_candidate`)}
  `);
  const candidates = rows.flatMap(candidateSnapshotFromRawRow);
  const ids = candidates.map((candidate) => candidate.id);
  const total = Number(rows[0]?.count ?? 0);
  return {
    candidates,
    ids,
    total,
    hasMore: offset + ids.length < total,
  };
}

/** Select the complete eligible candidate id set for analytics and cohort reads. */
export async function getBranchCandidateIds(
  db: BranchCandidateClient,
  organizationId: string,
  query: BranchListQuery,
  requestedIds?: readonly string[]
): Promise<string[]> {
  const candidates = await getBranchCandidateSnapshots(
    db,
    organizationId,
    query,
    requestedIds
  );
  return candidates.map((candidate) => candidate.id);
}

/** Select candidate identity plus canonical activity in one database snapshot. */
export async function getBranchCandidateSnapshots(
  db: BranchCandidateClient,
  organizationId: string,
  query: BranchListQuery,
  requestedIds?: readonly string[]
): Promise<BranchCandidateSnapshot[]> {
  const whereClause = branchCandidateWhereClause(
    organizationId,
    query,
    requestedIds
  );
  const rows = await db.$queryRaw<BranchCandidateRawRow[]>(Prisma.sql`
    ${branchCandidateSelectClause()}
    ${branchCandidateFromClause()}
    ${whereClause}
    ${branchCandidateOrderClause(Prisma.sql`a`, true)}
  `);
  return rows.flatMap(candidateSnapshotFromRawRow);
}

function branchCandidateFromClause(): Prisma.Sql {
  return Prisma.sql`
    FROM artifacts a
    INNER JOIN branch_detail b ON b.artifact_id = a.id
    LEFT JOIN LATERAL (
      SELECT
        atom.version,
        atom.source,
        atom.source_event_id,
        atom.occurred_at,
        atom.attribution_kind,
        atom.pull_request_detail_id,
        atom.completeness
      FROM branch_activity_atoms atom
      WHERE atom.organization_id = a.organization_id
        AND atom.branch_artifact_id = a.id
        AND atom.version = ${BranchActivityAtomVersion.V1}
        AND atom.source IN (${Prisma.join(canonicalBranchActivitySources)})
        AND atom.source_event_id = btrim(atom.source_event_id)
        AND length(atom.source_event_id) > 0
        AND length(atom.source_event_id) <= 512
        AND isfinite(atom.occurred_at)
        AND atom.completeness IN (${Prisma.join(
          canonicalBranchActivityCompleteness
        )})
        AND (
          (
            atom.attribution_kind = ${BranchActivityAttributionKind.Branch}
            AND atom.pull_request_detail_id IS NULL
          )
          OR (
            atom.attribution_kind = ${BranchActivityAttributionKind.PullRequest}
            AND atom.pull_request_detail_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM pull_request_detail activity_pr
              WHERE activity_pr.id = atom.pull_request_detail_id
                AND activity_pr.organization_id = a.organization_id
                AND activity_pr.branch_artifact_id = a.id
            )
          )
        )
      ORDER BY atom.occurred_at DESC, atom.source ASC, atom.source_event_id ASC
      LIMIT 1
    ) latest_activity_atom ON TRUE
  `;
}

function branchCandidateSelectClause(): Prisma.Sql {
  return Prisma.sql`
    SELECT
      a.id,
      ${normalizedRepositorySortKey()} AS "repositorySortKey",
      btrim(b.branch_name) AS "branchSortKey",
      latest_activity_atom.version AS "atomVersion",
      latest_activity_atom.source AS "atomSource",
      latest_activity_atom.source_event_id AS "atomSourceEventId",
      latest_activity_atom.occurred_at AS "atomOccurredAt",
      latest_activity_atom.attribution_kind AS "atomAttributionKind",
      latest_activity_atom.pull_request_detail_id AS "atomPullRequestDetailId",
      latest_activity_atom.completeness AS "atomCompleteness",
      ${branchCandidateActivityExpr()} AS last_activity_at
  `;
}

function branchCandidateOrderClause(
  rowAlias: Prisma.Sql,
  directTableAliases = false
): Prisma.Sql {
  if (directTableAliases) {
    return Prisma.sql`
      ORDER BY ${branchCandidateActivityExpr()} DESC NULLS LAST,
        ${normalizedRepositorySortKey()} ASC,
        btrim(b.branch_name) ASC,
        a.id ASC
    `;
  }
  return Prisma.sql`
    ORDER BY ${rowAlias}.last_activity_at DESC NULLS LAST,
      ${rowAlias}."repositorySortKey" ASC,
      ${rowAlias}."branchSortKey" ASC,
      ${rowAlias}.id ASC
  `;
}

function candidateSnapshotFromRawRow(
  row: BranchCandidateRawRow
): BranchCandidateSnapshot[] {
  if (
    row.id === null ||
    row.repositorySortKey === null ||
    row.branchSortKey === null
  ) {
    return [];
  }
  return [
    {
      id: row.id,
      repositorySortKey: row.repositorySortKey,
      branchSortKey: row.branchSortKey,
      activityAtom: candidateActivityAtomFromRawRow(row),
    },
  ];
}

function normalizedRepositorySortKey(): Prisma.Sql {
  return Prisma.sql`lower(regexp_replace(regexp_replace(btrim(b.repository_full_name), '^/+|/+$', '', 'g'), '\.git$', '', 'i'))`;
}

function candidateActivityAtomFromRawRow(
  row: BranchCandidateRawRow
): CanonicalCloudBranchActivityAtom | null {
  if (
    row.atomVersion === null ||
    row.atomSource === null ||
    row.atomSourceEventId === null ||
    row.atomOccurredAt === null ||
    row.atomAttributionKind === null ||
    row.atomCompleteness === null
  ) {
    return null;
  }
  return {
    version: row.atomVersion,
    source: row.atomSource,
    sourceEventId: row.atomSourceEventId,
    occurredAt: row.atomOccurredAt,
    attributionKind: row.atomAttributionKind,
    pullRequestDetailId: row.atomPullRequestDetailId,
    completeness: row.atomCompleteness,
  };
}

function branchCandidateActivityExpr(): Prisma.Sql {
  return Prisma.sql`latest_activity_atom.occurred_at`;
}

function branchCandidateWhereClause(
  organizationId: string,
  query: BranchListQuery,
  requestedIds?: readonly string[]
): Prisma.Sql {
  const repositories = [...(query.repository ?? []), ...(query.repo ?? [])];
  const predicates: Prisma.Sql[] = [
    Prisma.sql`a.organization_id = ${organizationId}::uuid`,
    Prisma.sql`a.type = ${ArtifactType.BRANCH}::"ArtifactType"`,
    Prisma.sql`b.deleted_at IS NULL`,
    branchLinkedSessionExistsSql(),
    cloudBranchEligibilitySql(),
  ];
  if (requestedIds && requestedIds.length > 0) {
    predicates.push(
      Prisma.sql`a.id IN (${Prisma.join(
        requestedIds.map((branchId) => Prisma.sql`${branchId}::uuid`)
      )})`
    );
  }
  appendProjectPredicates(predicates, query.projectId ?? []);
  appendRepositoryPredicates(predicates, repositories);
  appendActivityPredicates(predicates, query);
  appendSearchPredicate(predicates, query.search);
  appendStatusPredicate(predicates, query.status ?? []);
  appendContributorPredicate(
    predicates,
    query[BRANCH_CONTRIBUTOR_USER_ID_PARAM]
  );
  appendBranchCandidateLocRangePredicate(
    predicates,
    query[BRANCH_LOC_MIN_PARAM],
    query[BRANCH_LOC_MAX_PARAM]
  );
  return Prisma.sql`WHERE ${Prisma.join(predicates, " AND ")}`;
}

function appendContributorPredicate(
  predicates: Prisma.Sql[],
  contributorUserId: string | undefined
) {
  if (contributorUserId) {
    predicates.push(branchContributorExistsSql(contributorUserId));
  }
}

function appendProjectPredicates(
  predicates: Prisma.Sql[],
  projectIds: string[]
) {
  if (projectIds.length > 0) {
    predicates.push(
      Prisma.sql`a.project_id IN (${Prisma.join(
        projectIds.map((projectId) => Prisma.sql`${projectId}::uuid`)
      )})`
    );
  }
}

function appendRepositoryPredicates(
  predicates: Prisma.Sql[],
  repositories: string[]
) {
  if (repositories.length > 0) {
    predicates.push(
      Prisma.sql`b.repository_full_name IN (${Prisma.join(
        repositories.map(normalizeRepoFullName)
      )})`
    );
  }
}

function appendActivityPredicates(
  predicates: Prisma.Sql[],
  query: BranchListQuery
) {
  if (query.startDate) {
    predicates.push(
      Prisma.sql`(${branchCandidateActivityExpr()} IS NULL OR ${branchCandidateActivityExpr()} >= ${query.startDate})`
    );
  }
  if (query.endDate) {
    predicates.push(
      Prisma.sql`(${branchCandidateActivityExpr()} IS NULL OR ${branchCandidateActivityExpr()} <= ${query.endDate})`
    );
  }
}

function appendSearchPredicate(
  predicates: Prisma.Sql[],
  rawSearch: string | undefined
) {
  const search = rawSearch?.trim();
  if (!search) {
    return;
  }
  const pattern = toSqlContainsPattern(search);
  predicates.push(Prisma.sql`(
    a.name ILIKE ${pattern} ESCAPE '\\'
    OR b.branch_name ILIKE ${pattern} ESCAPE '\\'
    OR b.repository_full_name ILIKE ${pattern} ESCAPE '\\'
    OR ${selectedAssociatedPullRequestExists([
      Prisma.sql`pr.title ILIKE ${pattern} ESCAPE '\\'`,
    ])}
  )`);
}

function appendStatusPredicate(
  predicates: Prisma.Sql[],
  statuses: BranchFilterStatus[]
) {
  if (statuses.length > 0) {
    predicates.push(
      Prisma.sql`(${Prisma.join(
        statuses.map((status) => branchCandidateStatusClause(status)),
        " OR "
      )})`
    );
  }
}

function toSqlContainsPattern(value: string): string {
  return `%${value.replace(SQL_LIKE_ESCAPE_PATTERN, "\\$&")}%`;
}

const SQL_LIKE_ESCAPE_PATTERN = /[%_\\]/g;
