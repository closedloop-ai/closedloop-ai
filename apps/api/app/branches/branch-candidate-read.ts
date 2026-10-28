import {
  BRANCH_CONTRIBUTOR_USER_ID_PARAM,
  BRANCH_LOC_MAX_PARAM,
  BRANCH_LOC_MIN_PARAM,
  normalizeRepoFullName,
} from "@repo/api/src/types/branch";
import { ArtifactType, Prisma } from "@repo/database";
import { toSqlContainsPattern } from "@/lib/sql-like";
import {
  type CanonicalCloudBranchActivityAtom,
  canonicalBranchActivityAtomEligibilitySql,
} from "./branch-activity-canonical-read";
import { selectedAssociatedPullRequestExists } from "./branch-associated-pull-request-sql";
import {
  appendBranchCandidateLocRangePredicate,
  branchContributorExistsSql,
  branchLinkedSessionLastActivitySql,
} from "./branch-contribution-sql";
import type { BranchListOperationQuery } from "./branch-list-query";
import {
  type BranchFilterStatus,
  branchCandidateStatusClause,
} from "./branch-read-service/status-filter-sql";
import { normalizedRepositoryFullNameSql } from "./branch-repository-name-sql";
import {
  cloudBranchMetricDenominatorEligibilitySetSql,
  cloudBranchProductEligibilitySetSql,
} from "./cloud-branch-authority-eligibility";

const BranchCandidateEligibility = {
  Product: "product",
  MetricDenominator: "metric_denominator",
} as const;
type BranchCandidateEligibility =
  (typeof BranchCandidateEligibility)[keyof typeof BranchCandidateEligibility];

type BranchCandidateClient = {
  $queryRaw: <T>(query: Prisma.Sql) => Promise<T>;
};

export type BranchCandidateSnapshot = {
  id: string;
  repositorySortKey: string;
  branchSortKey: string;
  activityAtom: CanonicalCloudBranchActivityAtom | null;
  /**
   * ISS-11915: the linked-session Last-active fallback, read only when no
   * eligible atom exists (`resolveBranchLastActiveMetric`).
   */
  linkedSessionActivityAt: Date | null;
};

/** Index one bounded candidate snapshot set for row-projection reconciliation. */
export function indexBranchCandidateSnapshots(
  candidates: readonly BranchCandidateSnapshot[]
): ReadonlyMap<string, BranchCandidateSnapshot> {
  return new Map(candidates.map((candidate) => [candidate.id, candidate]));
}

/**
 * ISS-8016: attach the candidate-selected atom. This is the SOLE source of
 * `branch.activityAtoms` on the analytics and list paths — their selects no
 * longer fetch the relation, because this call unconditionally replaced it and
 * the fetched rows were discarded.
 *
 * The two values were never interchangeable: a relation load returns the latest
 * atom REGARDLESS of eligibility, while the candidate LATERAL returns the latest
 * ELIGIBLE one. Those differ for the same PRD-600 user-visible Last-active
 * field, so re-adding a fetched fallback would reintroduce that divergence
 * rather than provide a safety net.
 *
 * `candidatesById` is required. Optionality is what would let a future caller
 * silently re-arm it; requiring the map makes that a compile error.
 */
export function applyBranchCandidateActivitySnapshot<
  Row extends { id: string; branch: object },
>(
  row: Row,
  candidatesById: ReadonlyMap<string, BranchCandidateSnapshot>
): Row & {
  branch: Row["branch"] & {
    activityAtoms: CanonicalCloudBranchActivityAtom[];
    linkedSessionActivityAt: Date | null;
  };
} {
  const candidate = candidatesById.get(row.id);
  return {
    ...row,
    branch: {
      ...row.branch,
      activityAtoms: candidate?.activityAtom ? [candidate.activityAtom] : [],
      linkedSessionActivityAt: candidate?.linkedSessionActivityAt ?? null,
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
  atomActivityKind: string | null;
  atomAttributionKind: string | null;
  atomPullRequestDetailId: string | null;
  atomCompleteness: string | null;
  atomCreatedAt: Date | null;
  linkedSessionActivityAt: Date | null;
};

type BranchCandidatePageRow = BranchCandidateRawRow & {
  count: bigint | number | string;
  retainedUnavailableCount: bigint | number | string;
};

type BranchCandidateIdRow = {
  id: string | null;
};

type BranchCandidateKeysetCursor = {
  id: string;
  repositorySortKey: string;
  branchSortKey: string;
  activitySortKey: Date | null;
};

/** Select one reconciled list page and total from a single database snapshot. */
export async function getBranchCandidatePage(
  db: BranchCandidateClient,
  organizationId: string,
  query: BranchListOperationQuery,
  limit: number,
  offset: number,
  evaluationNow: Date = new Date()
): Promise<{
  candidates: BranchCandidateSnapshot[];
  ids: string[];
  total: number;
  hasMore: boolean;
  retainedUnavailableCount: number;
  evaluationNow: Date;
}> {
  const whereClause = branchCandidateWhereClause(
    organizationId,
    query,
    undefined,
    BranchCandidateEligibility.Product,
    evaluationNow
  );
  const rows = await db.$queryRaw<BranchCandidatePageRow[]>(Prisma.sql`
    WITH candidates AS (
      ${branchCandidateSelectClause()}
      ${branchCandidateFromClause()}
      ${whereClause}
    ), page_candidates AS (
      SELECT *
      FROM candidates candidate
      ${branchCandidateOrderClause(Prisma.sql`candidate`, evaluationNow)}
      LIMIT ${limit}
      OFFSET ${offset}
    )
    SELECT page_candidate.*, candidate_count.count,
      candidate_count.retained_unavailable_count AS "retainedUnavailableCount"
    FROM (
      SELECT
        COUNT(*)::bigint AS count,
        COUNT(*) FILTER (
          WHERE canonical_occurred_at IS NULL
            OR canonical_occurred_at > ${evaluationNow}
        )::bigint AS retained_unavailable_count
      FROM candidates
    ) candidate_count
    LEFT JOIN page_candidates page_candidate ON TRUE
    ${branchCandidateOrderClause(Prisma.sql`page_candidate`, evaluationNow)}
  `);
  const candidates = rows.flatMap(candidateSnapshotFromRawRow);
  const ids = candidates.map((candidate) => candidate.id);
  const total = Number(rows[0]?.count ?? 0);
  return {
    candidates,
    ids,
    total,
    hasMore: offset + ids.length < total,
    retainedUnavailableCount: Number(rows[0]?.retainedUnavailableCount ?? 0),
    evaluationNow,
  };
}

/** Select the complete eligible candidate id set for analytics and cohort reads. */
export async function getBranchCandidateIds(
  db: BranchCandidateClient,
  organizationId: string,
  query: BranchListOperationQuery,
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

export type BranchMetricDenominatorCandidates = {
  ids: string[];
  coverageComplete: boolean;
};

/** Select the global divisor authority by id without list projection columns. */
export async function getGlobalBranchMetricDivisorCandidates(
  db: BranchCandidateClient,
  organizationId: string,
  query: BranchListOperationQuery
): Promise<BranchMetricDenominatorCandidates> {
  const nonDateQuery = {
    ...query,
    startDate: undefined,
    endDate: undefined,
  };
  const ids = await readBranchMetricDenominatorCandidateIds(
    db,
    organizationId,
    nonDateQuery,
    BRANCH_METRIC_DENOMINATOR_CANDIDATE_MAX + 1,
    nonDateQuery.evaluationNow ?? new Date()
  );
  return {
    ids: ids.slice(0, BRANCH_METRIC_DENOMINATOR_CANDIDATE_MAX),
    coverageComplete: ids.length <= BRANCH_METRIC_DENOMINATOR_CANDIDATE_MAX,
  };
}

/** Select candidate identity plus canonical activity in one database snapshot. */
export async function getBranchCandidateSnapshots(
  db: BranchCandidateClient,
  organizationId: string,
  query: BranchListOperationQuery,
  requestedIds?: readonly string[],
  eligibility: BranchCandidateEligibility = BranchCandidateEligibility.Product
): Promise<BranchCandidateSnapshot[]> {
  const evaluationNow = query.evaluationNow ?? new Date();
  if (requestedIds === undefined) {
    return getAllBranchCandidateSnapshots(
      db,
      organizationId,
      query,
      eligibility,
      evaluationNow
    );
  }
  if (requestedIds.length === 0) {
    return [];
  }
  const candidates: BranchCandidateSnapshot[] = [];
  for (const branchIds of chunkValues(
    requestedIds,
    BRANCH_CANDIDATE_READ_BATCH_SIZE
  )) {
    candidates.push(
      ...(await readBranchCandidateSnapshots(
        db,
        organizationId,
        query,
        branchIds,
        eligibility,
        undefined,
        undefined,
        evaluationNow
      ))
    );
  }
  return candidates.sort((left, right) =>
    compareBranchCandidateSnapshots(left, right, evaluationNow)
  );
}

/** Read the complete eligible corpus when callers consume the whole set. */
export async function getAllBranchCandidateSnapshots(
  db: BranchCandidateClient,
  organizationId: string,
  query: BranchListOperationQuery,
  eligibility: BranchCandidateEligibility = BranchCandidateEligibility.Product,
  evaluationNow: Date = query.evaluationNow ?? new Date()
): Promise<BranchCandidateSnapshot[]> {
  const candidates: BranchCandidateSnapshot[] = [];
  let after: BranchCandidateKeysetCursor | undefined;
  while (true) {
    const page = await readBranchCandidateSnapshots(
      db,
      organizationId,
      query,
      undefined,
      eligibility,
      BRANCH_FULL_CORPUS_CANDIDATE_READ_BATCH_SIZE,
      undefined,
      evaluationNow,
      after
    );
    candidates.push(...page);
    if (page.length < BRANCH_FULL_CORPUS_CANDIDATE_READ_BATCH_SIZE) {
      return candidates;
    }
    const last = page.at(-1);
    if (!last) {
      return candidates;
    }
    after = branchCandidateKeysetCursorFor(last, evaluationNow);
  }
}

async function readBranchCandidateSnapshots(
  db: BranchCandidateClient,
  organizationId: string,
  query: BranchListOperationQuery,
  requestedIds?: readonly string[],
  eligibility: BranchCandidateEligibility = BranchCandidateEligibility.Product,
  limit?: number,
  offset?: number,
  evaluationNow: Date = query.evaluationNow ?? new Date(),
  after?: BranchCandidateKeysetCursor
): Promise<BranchCandidateSnapshot[]> {
  const whereClause = branchCandidateWhereClause(
    organizationId,
    query,
    requestedIds,
    eligibility,
    evaluationNow
  );
  const rows = await db.$queryRaw<BranchCandidateRawRow[]>(Prisma.sql`
    ${branchCandidateSelectClause()}
    ${branchCandidateFromClause()}
    ${whereClause}
    ${branchCandidateKeysetClause(after, evaluationNow)}
    ${branchCandidateOrderClause(Prisma.sql`a`, evaluationNow, true)}
    ${limit === undefined ? Prisma.empty : Prisma.sql`LIMIT ${limit}`}
    ${offset === undefined ? Prisma.empty : Prisma.sql`OFFSET ${offset}`}
  `);
  return rows.flatMap(candidateSnapshotFromRawRow);
}

/**
 * The ids of every Branch the even-split divisor counts, as a statement
 * selecting `id`. No cap: the divisor is the whole eligible set (ISS-12346).
 */
export function branchMetricDenominatorIdsSql(
  organizationId: string,
  query: BranchListOperationQuery,
  evaluationNow: Date
): Prisma.Sql {
  return Prisma.sql`
    SELECT a.id
    FROM artifacts a
    INNER JOIN branch_detail b ON b.artifact_id = a.id
    ${branchCandidateWhereClause(
      organizationId,
      query,
      undefined,
      BranchCandidateEligibility.MetricDenominator,
      evaluationNow
    )}`;
}

async function readBranchMetricDenominatorCandidateIds(
  db: BranchCandidateClient,
  organizationId: string,
  query: BranchListOperationQuery,
  limit: number,
  evaluationNow: Date
): Promise<string[]> {
  const rows = await db.$queryRaw<BranchCandidateIdRow[]>(Prisma.sql`
    ${branchMetricDenominatorIdsSql(organizationId, query, evaluationNow)}
    ORDER BY a.id ASC
    LIMIT ${limit}
  `);
  return rows.flatMap(({ id }) => (id === null ? [] : [id]));
}

function compareBranchCandidateSnapshots(
  left: BranchCandidateSnapshot,
  right: BranchCandidateSnapshot,
  evaluationNow: Date
): number {
  const now = evaluationNow.getTime();
  const leftOccurredAt = candidateActivityAt(left)?.getTime() ?? null;
  const rightOccurredAt = candidateActivityAt(right)?.getTime() ?? null;
  const leftActivity =
    leftOccurredAt !== null && leftOccurredAt <= now ? leftOccurredAt : null;
  const rightActivity =
    rightOccurredAt !== null && rightOccurredAt <= now ? rightOccurredAt : null;
  if (leftActivity !== rightActivity) {
    if (leftActivity === null) {
      return 1;
    }
    if (rightActivity === null) {
      return -1;
    }
    return rightActivity - leftActivity;
  }
  return (
    left.repositorySortKey.localeCompare(right.repositorySortKey) ||
    left.branchSortKey.localeCompare(right.branchSortKey) ||
    left.id.localeCompare(right.id)
  );
}

function chunkValues<Value>(
  values: readonly Value[],
  size: number
): readonly Value[][] {
  const chunks: Value[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

export const BRANCH_CANDIDATE_READ_BATCH_SIZE = 500;
export const BRANCH_METRIC_DENOMINATOR_CANDIDATE_MAX = 5000;
const BRANCH_FULL_CORPUS_CANDIDATE_READ_BATCH_SIZE = 5000;

function branchCandidateKeysetCursorFor(
  candidate: BranchCandidateSnapshot,
  evaluationNow: Date
): BranchCandidateKeysetCursor {
  const occurredAt = candidateActivityAt(candidate);
  return {
    id: candidate.id,
    repositorySortKey: candidate.repositorySortKey,
    branchSortKey: candidate.branchSortKey,
    activitySortKey:
      occurredAt && occurredAt <= evaluationNow ? occurredAt : null,
  };
}

function branchCandidateKeysetClause(
  after: BranchCandidateKeysetCursor | undefined,
  evaluationNow: Date
): Prisma.Sql {
  if (!after) {
    return Prisma.empty;
  }
  const activity = branchCandidateSortActivityExpr(evaluationNow);
  const repository = normalizedRepositorySortKey();
  const branch = Prisma.sql`btrim(b.branch_name)`;
  const identityTiebreaker = Prisma.sql`
    ${repository} > ${after.repositorySortKey}
    OR (${repository} = ${after.repositorySortKey} AND ${branch} > ${after.branchSortKey})
    OR (${repository} = ${after.repositorySortKey} AND ${branch} = ${after.branchSortKey} AND a.id > ${after.id}::uuid)
  `;
  if (!after.activitySortKey) {
    return Prisma.sql`AND ${activity} IS NULL AND (${identityTiebreaker})`;
  }
  return Prisma.sql`AND (
    ${activity} IS NULL
    OR ${activity} < ${after.activitySortKey}
    OR (${activity} = ${after.activitySortKey} AND (${identityTiebreaker}))
  )`;
}

export function branchCandidateFromClause(): Prisma.Sql {
  return Prisma.sql`
    FROM artifacts a
    INNER JOIN branch_detail b ON b.artifact_id = a.id
    ${branchCandidateActivityJoinsSql()}
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
      latest_activity_atom.activity_kind AS "atomActivityKind",
      latest_activity_atom.attribution_kind AS "atomAttributionKind",
      latest_activity_atom.pull_request_detail_id AS "atomPullRequestDetailId",
      latest_activity_atom.completeness AS "atomCompleteness",
      latest_activity_atom.created_at AS "atomCreatedAt",
      linked_session_activity.last_activity_at AS "linkedSessionActivityAt",
      -- The selected atom, else the linked-session fallback; never
      -- branch_detail.last_activity_at.
      ${branchCandidateActivityExpr()} AS canonical_occurred_at
  `;
}

function branchCandidateOrderClause(
  rowAlias: Prisma.Sql,
  evaluationNow: Date,
  directTableAliases = false
): Prisma.Sql {
  if (directTableAliases) {
    return Prisma.sql`
      ORDER BY ${branchCandidateSortActivityExpr(evaluationNow)} DESC NULLS LAST,
        ${normalizedRepositorySortKey()} ASC,
        btrim(b.branch_name) ASC,
        a.id ASC
    `;
  }
  return Prisma.sql`
    ORDER BY CASE
        WHEN ${rowAlias}.canonical_occurred_at > ${evaluationNow} THEN NULL
        ELSE ${rowAlias}.canonical_occurred_at
      END DESC NULLS LAST,
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
      linkedSessionActivityAt: row.linkedSessionActivityAt,
    },
  ];
}

export function normalizedRepositorySortKey(): Prisma.Sql {
  return normalizedRepositoryFullNameSql(Prisma.sql`b.repository_full_name`);
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
    row.atomCompleteness === null ||
    row.atomCreatedAt === null
  ) {
    return null;
  }
  return {
    version: row.atomVersion,
    source: row.atomSource,
    sourceEventId: row.atomSourceEventId,
    occurredAt: row.atomOccurredAt,
    activityKind: row.atomActivityKind,
    attributionKind: row.atomAttributionKind,
    pullRequestDetailId: row.atomPullRequestDetailId,
    completeness: row.atomCompleteness,
    createdAt: row.atomCreatedAt,
  };
}

/**
 * The ONE cloud Last-active instant every list read windows, sorts, counts and
 * pages on: the latest eligible atom, else the linked-session fallback
 * (ISS-11915, `resolveBranchLastActiveMetric`).
 */
export function branchCandidateActivityExpr(): Prisma.Sql {
  return Prisma.sql`COALESCE(
    latest_activity_atom.occurred_at,
    linked_session_activity.last_activity_at
  )`;
}

export function branchCandidateSortActivityExpr(
  evaluationNow: Date
): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN ${branchCandidateActivityExpr()} > ${evaluationNow} THEN NULL
    ELSE ${branchCandidateActivityExpr()}
  END`;
}

export function branchCandidateWhereClause(
  organizationId: string,
  query: BranchListOperationQuery,
  requestedIds: readonly string[] | undefined,
  eligibility: BranchCandidateEligibility = BranchCandidateEligibility.Product,
  evaluationNow: Date = query.evaluationNow ?? new Date()
): Prisma.Sql {
  const predicates = [
    ...branchCandidateStaticPredicates(
      organizationId,
      query,
      requestedIds,
      eligibility
    ),
    ...branchCandidateActivityPredicates(query, evaluationNow),
  ];
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

function branchCandidateActivityPredicates(
  query: BranchListOperationQuery,
  evaluationNow: Date
): Prisma.Sql[] {
  const predicates: Prisma.Sql[] = [];
  if (query.startDate) {
    predicates.push(
      Prisma.sql`(${branchCandidateActivityExpr()} IS NULL OR ${branchCandidateActivityExpr()} > ${evaluationNow} OR ${branchCandidateActivityExpr()} >= ${query.startDate})`
    );
  }
  if (query.endDate) {
    predicates.push(
      Prisma.sql`(${branchCandidateActivityExpr()} IS NULL OR ${branchCandidateActivityExpr()} > ${evaluationNow} OR ${branchCandidateActivityExpr()} <= ${query.endDate})`
    );
  }
  return predicates;
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

/** The snapshot's Last-active instant, as {@link branchCandidateActivityExpr}. */
function candidateActivityAt(candidate: BranchCandidateSnapshot): Date | null {
  return (
    candidate.activityAtom?.occurredAt ?? candidate.linkedSessionActivityAt
  );
}

/** The latest-atom and linked-session laterals behind {@link branchCandidateActivityExpr}; they read only `a`. */
export function branchCandidateActivityJoinsSql(): Prisma.Sql {
  return Prisma.sql`
    LEFT JOIN LATERAL (
      SELECT
        atom.version,
        atom.source,
        atom.source_event_id,
        atom.occurred_at,
        atom.activity_kind,
        atom.attribution_kind,
        atom.pull_request_detail_id,
        atom.completeness,
        atom.created_at
      FROM branch_activity_atoms atom
      WHERE atom.organization_id = a.organization_id
        AND atom.branch_artifact_id = a.id
        AND ${canonicalBranchActivityAtomEligibilitySql(
          Prisma.sql`a.organization_id`,
          Prisma.sql`a.id`
        )}
      ORDER BY atom.occurred_at DESC, atom.source ASC, atom.source_event_id ASC
      LIMIT 1
    ) latest_activity_atom ON TRUE
    -- ISS-12775: LIMIT 1 (the subquery has at most one row) keeps it from being
    -- pulled up, so the WHERE gates it once per row. Pulled up, prod ran the
    -- session fallback for all 8,568 candidates when 873 had no atom.
    LEFT JOIN LATERAL (
      SELECT ${branchLinkedSessionLastActivitySql()} AS last_activity_at
      WHERE latest_activity_atom.occurred_at IS NULL
      LIMIT 1
    ) linked_session_activity ON TRUE
  `;
}

/**
 * ISS-12775: every Product candidate predicate except Last-active, which needs
 * {@link branchCandidateActivityJoinsSql}. The Branch list resolves these first
 * so the per-branch activity reads skip ineligible branches.
 */
export function branchCandidateStaticWhereClause(
  organizationId: string,
  query: BranchListOperationQuery
): Prisma.Sql {
  return Prisma.sql`WHERE ${Prisma.join(
    branchCandidateStaticPredicates(
      organizationId,
      query,
      undefined,
      BranchCandidateEligibility.Product
    ),
    " AND "
  )}`;
}

/** The Last-active half of {@link branchCandidateWhereClause}, `TRUE` when the query has no window. */
export function branchCandidateActivityPredicateSql(
  query: BranchListOperationQuery,
  evaluationNow: Date
): Prisma.Sql {
  const predicates = branchCandidateActivityPredicates(query, evaluationNow);
  return predicates.length > 0
    ? Prisma.join(predicates, " AND ")
    : Prisma.sql`TRUE`;
}

function branchCandidateStaticPredicates(
  organizationId: string,
  query: BranchListOperationQuery,
  requestedIds: readonly string[] | undefined,
  eligibility: BranchCandidateEligibility
): Prisma.Sql[] {
  const repositories = [...(query.repository ?? []), ...(query.repo ?? [])];
  const predicates: Prisma.Sql[] = [
    Prisma.sql`a.organization_id = ${organizationId}::uuid`,
    Prisma.sql`a.type = ${ArtifactType.BRANCH}::"ArtifactType"`,
    eligibility === BranchCandidateEligibility.Product
      ? cloudBranchProductEligibilitySetSql(organizationId, requestedIds)
      : cloudBranchMetricDenominatorEligibilitySetSql(
          organizationId,
          requestedIds
        ),
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
  return predicates;
}
