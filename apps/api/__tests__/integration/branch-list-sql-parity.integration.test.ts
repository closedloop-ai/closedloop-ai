import { BranchPushSource } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import {
  BranchListLastActiveRange,
  BranchListPageMode,
  BranchListPullRequestPresence,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { DEFAULT_BRANCH_STATUS_ORDERING } from "@repo/api/src/types/branch-status-order";
import { FileChangeStatus } from "@repo/api/src/types/branch-view";
import { Priority } from "@repo/api/src/types/common";
import { GitHubPRState } from "@repo/api/src/types/github";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import { BRANCH_PUSH_METHOD_VALUES } from "@repo/api/src/types/session-artifact-link";
import { ArtifactType, Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import {
  BRANCH_OWNER_UNATTRIBUTED_LABEL,
  buildBranchServerPageSnapshot,
  countRetainedUnavailableBranchRows,
} from "@repo/lib/branches/branch-list-page";
import { afterEach, describe, expect, it } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import {
  explainAnalyze,
  relationLoops,
  subqueryRunLoops,
} from "@/__tests__/utils/explain-plan";
import {
  branchCandidateFromClause,
  getBranchCandidateSnapshots,
} from "@/app/branches/branch-candidate-read";
import { branchLinkedSessionCountSql } from "@/app/branches/branch-contribution-sql";
import { createBranchListEnrichmentDomain } from "@/app/branches/branch-list-enrichment";
import {
  attachBranchListPageCostMetadata,
  projectBranchListRows,
} from "@/app/branches/branch-list-projection";
import type { BranchListOperationQuery } from "@/app/branches/branch-list-query";
import { decodeBranchServerPageRows } from "@/app/branches/branch-list-sql/branch-server-page-read";
import {
  type BranchListSqlRow,
  branchServerPageSql,
} from "@/app/branches/branch-list-sql/branch-server-page-sql";
import { seedBranchOwners } from "@/app/branches/branch-owner-seed/branch-owner-seed";
import { getBranchRowsById } from "@/app/branches/branch-read-service/persisted-row-read";
import { listServerPageBranches } from "@/app/branches/branch-read-service/server-page-list";
import { toBranchServerPageQuery } from "@/app/branches/branch-server-page-query";

/**
 * ISS-10298 — the SQL page read is the oracle's subject and the JavaScript
 * kernel is the oracle. Both run over the SAME seeded corpus and the whole page
 * snapshot is compared: page ids IN ORDER, total, the repaired offset, the
 * retained-unavailable tally, and all eight facets with their options, labels,
 * counts and availability.
 *
 * The corpus is built to make every derivation decidable: two organizations so
 * an unscoped query fails, two repositories sharing a short name so the
 * Repository facet must disambiguate, adversarial branch names so an ICU
 * collation is distinguishable from a byte one, LOC that is available,
 * unavailable and half-enriched, branches with and without sessions, tags,
 * owners and pull requests, and last-active instants in every bucket plus one
 * in the future.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(() => committedOrganizations.cleanup());

const NOW = new Date("2026-08-20T12:00:00.000Z");
const REPOSITORY_A = "acme/widgets";
const REPOSITORY_B = "other-owner/widgets";

type SeedBranch = {
  branchName: string;
  repositoryFullName?: string;
  artifactStatus?: GitHubPRState;
  pullRequest?: { state: GitHubPRState; isDraft?: boolean; merged?: boolean };
  fileChanges?: [number | null, number | null][];
  sessions?: number;
  tagNames?: string[];
  lastActiveMinutesAgo?: number | null;
  /**
   * Stamp the session link as PUSH evidence at `first_pushed_at` and run the
   * production Owner seed over it, which writes that pusher to the branch's
   * assignee — the Owner both kernels read (ISS-12463). Without this every
   * row's Owner facet option is the same fallback and the facet's labels are
   * never exercised.
   */
  resolvesOwner?: boolean;
  /** Minutes in the FUTURE — the kernel treats such an instant as absent. */
  lastActiveMinutesAhead?: number;
  /** ISS-10332: omitted seeds a branch with NO priority, the common case. */
  priority?: Priority;
};

const SEED_BRANCHES: SeedBranch[] = [
  // ISS-10332: priorities are seeded so their STRING order (HIGH < LOW <
  // MEDIUM < URGENT) disagrees with the ordinal one, and most rows hold none.
  {
    branchName: "feat/alpha",
    sessions: 2,
    resolvesOwner: true,
    lastActiveMinutesAgo: 10,
    priority: Priority.Low,
  },
  {
    branchName: "feat/Alpha",
    sessions: 1,
    resolvesOwner: true,
    lastActiveMinutesAgo: 200,
    priority: Priority.Urgent,
  },
  {
    branchName: "FEAT/alpha",
    sessions: 1,
    lastActiveMinutesAgo: 800,
    priority: Priority.High,
  },
  {
    branchName: "feat_alpha",
    sessions: 3,
    lastActiveMinutesAgo: 5000,
    priority: Priority.Medium,
  },
  { branchName: "feat-alpha", sessions: 1, lastActiveMinutesAgo: null },
  { branchName: "zeta", sessions: 1, lastActiveMinutesAhead: 60 },
  {
    branchName: "fix/merged",
    sessions: 1,
    artifactStatus: GitHubPRState.Merged,
    pullRequest: { state: GitHubPRState.Merged, merged: true },
    fileChanges: [
      [10, 5],
      [1, 2],
    ],
    lastActiveMinutesAgo: 30,
    tagNames: ["alpha-tag"],
  },
  {
    branchName: "fix/closed",
    sessions: 1,
    artifactStatus: GitHubPRState.Closed,
    pullRequest: { state: GitHubPRState.Closed },
    fileChanges: [[7, null]],
    lastActiveMinutesAgo: 120,
    tagNames: ["alpha-tag", "beta-tag"],
  },
  {
    branchName: "fix/draft",
    sessions: 1,
    pullRequest: { state: GitHubPRState.Open, isDraft: true },
    fileChanges: [[0, 0]],
    lastActiveMinutesAgo: 1500,
  },
  {
    branchName: "other/repo-branch",
    repositoryFullName: REPOSITORY_B,
    sessions: 1,
    fileChanges: [[100, 100]],
    lastActiveMinutesAgo: 60,
    tagNames: ["beta-tag"],
  },
];

type ParityQuery = { name: string; query: Partial<BranchListOperationQuery> };

const SORT_KEYS = Object.values(BranchListSortKey);

const PARITY_QUERIES: ParityQuery[] = [
  {
    name: "inclusive date window with unknown and future activity",
    query: {
      startDate: new Date(NOW.getTime() - 200 * 60_000),
      endDate: new Date(NOW.getTime() - 10 * 60_000),
    },
  },
  {
    name: "start-only date window",
    query: { startDate: new Date(NOW.getTime() - 60 * 60_000) },
  },
  {
    name: "end-only date window with cross-filtered facets",
    query: {
      endDate: new Date(NOW.getTime() - 120 * 60_000),
      repositories: [REPOSITORY_A],
      limit: 20,
      offset: 500,
    },
  },
  ...SORT_KEYS.flatMap((sortKey) =>
    [BranchListSortDirection.Asc, BranchListSortDirection.Desc].map(
      (sortDir) => ({
        name: `sort ${sortKey} ${sortDir}`,
        query: { sortKey, sortDir, limit: 25 },
      })
    )
  ),
  { name: "names filter", query: { names: ["feat/alpha", "zeta"] } },
  { name: "statuses filter", query: { statuses: [BranchStatus.Merged] } },
  {
    name: "statuses filter with no producer",
    query: { statuses: [BranchStatus.Review] },
  },
  {
    name: "pull request presence filter",
    query: { pullRequests: [BranchListPullRequestPresence.Linked] },
  },
  {
    name: "last active range filter",
    query: { lastActiveRanges: [BranchListLastActiveRange.OneDayOrMore] },
  },
  { name: "repositories filter", query: { repositories: [REPOSITORY_B] } },
  { name: "loc range filter", query: { locMin: 1, locMax: 50 } },
  {
    name: "priorities filter",
    query: { priorities: [Priority.Low, Priority.Urgent] },
  },
  {
    name: "priorities filter, unset arm alone",
    query: { priorities: [PRIORITY_UNSET_VALUE] },
  },
  {
    name: "priorities filter, a member and the unset arm",
    query: { priorities: [Priority.High, PRIORITY_UNSET_VALUE] },
  },
  {
    name: "cross filter of priority and repository",
    query: { priorities: [PRIORITY_UNSET_VALUE], repositories: [REPOSITORY_B] },
  },
  {
    name: "cross filter of status and repository",
    query: {
      statuses: [BranchStatus.Open],
      repositories: [REPOSITORY_A],
    },
  },
  { name: "empty result", query: { names: ["no-such-branch"] } },
  { name: "last partial page", query: { limit: 20, offset: 0 } },
  { name: "offset past the end", query: { limit: 20, offset: 500 } },
  { name: "second page", query: { limit: 20, offset: 20 } },
];

function operationQueryFor(
  overrides: Partial<BranchListOperationQuery>
): BranchListOperationQuery {
  return {
    pageMode: BranchListPageMode.Server,
    limit: 25,
    offset: 0,
    evaluationNow: NOW,
    ...overrides,
  } as BranchListOperationQuery;
}

/** The production JavaScript path, corpus-wide, exactly as it ran before. */
async function readJsSnapshot(
  organizationId: string,
  operationQuery: BranchListOperationQuery
) {
  return await withDb(async (db) => {
    const candidates = await getBranchCandidateSnapshots(
      db,
      organizationId,
      operationQuery
    );
    const rows = await getBranchRowsById(
      db,
      organizationId,
      candidates.map((candidate) => candidate.id),
      candidates
    );
    const projected = await projectBranchListRows(
      db,
      organizationId,
      rows,
      operationQuery,
      undefined,
      { includeAttributedCost: false }
    );
    const snapshot = buildBranchServerPageSnapshot(
      projected.items,
      toBranchServerPageQuery(operationQuery),
      NOW.toISOString(),
      DEFAULT_BRANCH_STATUS_ORDERING
    );
    const page = await attachBranchListPageCostMetadata(
      db,
      organizationId,
      projected,
      snapshot.page.items
    );
    return {
      items: page.items,
      pageIds: snapshot.page.items.map((item) => item.id),
      total: snapshot.page.total,
      repairedOffset: snapshot.page.pageInfo.offset,
      retainedUnavailableCount: countRetainedUnavailableBranchRows(
        snapshot.cohortRows,
        NOW.toISOString()
      ),
      facets: snapshot.page.facets,
    };
  });
}

async function readSqlSnapshot(
  organizationId: string,
  operationQuery: BranchListOperationQuery
) {
  return await withDb(async (db) => {
    const response = await listServerPageBranches(
      db,
      organizationId,
      undefined,
      operationQuery,
      NOW,
      createBranchListEnrichmentDomain(),
      DEFAULT_BRANCH_STATUS_ORDERING
    );
    if (!response.facets) {
      throw new Error("A server page must always carry its facets");
    }
    return {
      items: response.items,
      pageIds: response.items.map((item) => item.id),
      total: response.total,
      repairedOffset: response.pageInfo?.offset ?? 0,
      retainedUnavailableCount: Number(
        response.lastActiveCohort?.retainedUnavailable?.value ?? 0
      ),
      facets: response.facets,
    };
  });
}

async function seedCorpus(organizationId: string, branches: SeedBranch[]) {
  const user = await createTestUser(organizationId);
  for (const repositoryFullName of [REPOSITORY_A, REPOSITORY_B]) {
    await seedRepositoryAuthority(organizationId, repositoryFullName);
  }
  let pullRequestNumber = 0;
  for (const branch of branches) {
    pullRequestNumber += 1;
    await seedBranch(organizationId, branch, user.id, pullRequestNumber);
  }
}

/** `cloudBranchEligibilitySql` admits a branch only against a known repository. */
async function seedRepositoryAuthority(
  organizationId: string,
  fullName: string
) {
  const [owner, name] = fullName.split("/");
  await withDb((db) =>
    db.publicRepository.create({
      data: {
        organizationId,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: `repo-${organizationId}-${fullName}`,
          fullName,
        }),
        owner: owner ?? "acme",
        name: name ?? fullName,
        htmlUrl: `https://github.com/${fullName}`,
      },
      select: { id: true },
    })
  );
}

async function seedBranch(
  organizationId: string,
  input: SeedBranch,
  userId: string,
  pullRequestNumber: number
) {
  const repositoryFullName = input.repositoryFullName ?? REPOSITORY_A;
  const artifactId = await withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: input.branchName,
        status: input.artifactStatus ?? BranchStatus.Open,
        priority: input.priority ?? null,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: artifact.id,
        organizationId,
        repositoryFullName,
        branchName: input.branchName,
        firstPushedAt: new Date(NOW.getTime() - 86_400_000),
        pushSource: BranchPushSource.Session,
        lastActivityAt: NOW,
        headSha: "sha-head",
        fileCacheHeadSha: input.fileChanges ? "sha-head" : null,
      },
      select: { artifactId: true },
    });
    if (input.pullRequest) {
      await db.pullRequestDetail.create({
        data: {
          organizationId,
          branchArtifactId: artifact.id,
          number: pullRequestNumber,
          prState: input.pullRequest.state,
          isDraft: input.pullRequest.isDraft ?? false,
          mergedAt: input.pullRequest.merged
            ? new Date(NOW.getTime() - 3_600_000)
            : null,
          closedAt:
            input.pullRequest.state === GitHubPRState.Closed
              ? new Date(NOW.getTime() - 3_600_000)
              : null,
          githubCreatedAt: new Date(NOW.getTime() - 86_400_000),
          lastVerifiedAt: new Date(NOW.getTime() - 1_800_000),
          repositoryFullName,
        },
        select: { id: true },
      });
    }
    if (input.fileChanges) {
      await db.branchFileChange.createMany({
        data: input.fileChanges.map(([additions, deletions], index) => ({
          branchArtifactId: artifact.id,
          headSha: "sha-head",
          path: `src/file-${index}.ts`,
          status: FileChangeStatus.Modified,
          additions,
          deletions,
        })),
      });
    }
    const occurredAt = lastActiveInstant(input);
    if (occurredAt) {
      await db.branchActivityAtom.create({
        data: {
          organizationId,
          branchArtifactId: artifact.id,
          version: BranchActivityAtomVersion.V1,
          source: BranchActivitySource.GitHead,
          sourceEventId: `event-${artifact.id}`,
          occurredAt,
          attributionKind: BranchActivityAttributionKind.Branch,
          completeness: BranchActivityEvidenceCompleteness.Complete,
        },
        select: { branchArtifactId: true },
      });
    }
    for (const tagName of input.tagNames ?? []) {
      const existingTag = await db.tag.findFirst({
        where: { organizationId, name: tagName },
        select: { id: true },
      });
      const tag =
        existingTag ??
        (await db.tag.create({
          data: {
            organization: { connect: { id: organizationId } },
            createdBy: { connect: { id: userId } },
            name: tagName,
            color: "#123456",
          },
          select: { id: true },
        }));
      await db.tagArtifact.create({
        data: { tagId: tag.id, artifactId: artifact.id },
        select: { id: true },
      });
    }
    return artifact.id;
  });
  for (let index = 0; index < (input.sessions ?? 0); index += 1) {
    const sessionArtifactId = await linkValidSessionToBranch({
      organizationId,
      branchArtifactId: artifactId,
      userId,
      label: `${input.branchName}-${index}`,
    });
    if (input.resolvesOwner) {
      await withDb((db) =>
        db.artifactLink.updateMany({
          where: { sourceId: sessionArtifactId, targetId: artifactId },
          data: {
            branchParticipationMethod: BRANCH_PUSH_METHOD_VALUES[0],
            branchParticipationObservedAt: new Date(NOW.getTime() - 86_400_000),
          },
        })
      );
    }
  }
  if (input.resolvesOwner) {
    await withDb.tx((tx) => seedBranchOwners(tx, organizationId, [artifactId]));
  }
}

function lastActiveInstant(input: SeedBranch): Date | null {
  if (input.lastActiveMinutesAhead !== undefined) {
    return new Date(NOW.getTime() + input.lastActiveMinutesAhead * 60_000);
  }
  if (input.lastActiveMinutesAgo === null) {
    return null;
  }
  return new Date(NOW.getTime() - (input.lastActiveMinutesAgo ?? 0) * 60_000);
}

describeIfDb("Branch list page — SQL and JavaScript kernel parity", () => {
  it("agrees on every page, total, offset and facet across the matrix", async () => {
    const organizationId = await committedOrganizations.create();
    const otherOrganizationId = await committedOrganizations.create();
    await seedCorpus(organizationId, SEED_BRANCHES);
    // A second organization whose branches must never reach the first one's
    // page or facet counts — an unscoped statement fails here and nowhere else.
    await seedCorpus(otherOrganizationId, [
      { branchName: "feat/alpha", sessions: 5, lastActiveMinutesAgo: 1 },
      { branchName: "other-org-only", sessions: 1, lastActiveMinutesAgo: 2 },
    ]);

    // The Owner facet must mix RESOLVED people with the unattributed fallback,
    // or every owner comparison below is the same trivial option and the
    // parity it claims is vacuous. This is the coverage that moved here from
    // `branch-read-service.owner.test.ts` when the facet left JavaScript.
    const ownerFacet = (
      await readSqlSnapshot(organizationId, operationQueryFor({}))
    ).facets.owners;
    expect(
      ownerFacet.options.filter(
        (option) => option.id !== BRANCH_OWNER_UNATTRIBUTED_LABEL
      ).length
    ).toBeGreaterThan(0);
    expect(
      ownerFacet.options.some(
        (option) => option.id === BRANCH_OWNER_UNATTRIBUTED_LABEL
      )
    ).toBe(true);

    // Facet-valued filters can only be named once the corpus exists, so they
    // join the matrix here rather than as literals above.
    const resolvedOwnerId = ownerFacet.options.find(
      (option) => option.id !== BRANCH_OWNER_UNATTRIBUTED_LABEL
    )?.id;
    const tagId = (await readSqlSnapshot(organizationId, operationQueryFor({})))
      .facets.tags.options[0]?.id;
    const dynamicQueries: ParityQuery[] = [
      ...(resolvedOwnerId
        ? [
            {
              name: "owners filter",
              query: { owners: [resolvedOwnerId] },
            },
            {
              name: "owners filter on the unattributed fallback",
              query: { owners: [BRANCH_OWNER_UNATTRIBUTED_LABEL] },
            },
          ]
        : []),
      ...(tagId ? [{ name: "tags filter", query: { tags: [tagId] } }] : []),
      { name: "collaborators filter", query: { collaborators: ["nobody"] } },
    ];

    for (const parityQuery of [...PARITY_QUERIES, ...dynamicQueries]) {
      const operationQuery = operationQueryFor(parityQuery.query);
      const [jsSnapshot, sqlSnapshot] = await Promise.all([
        readJsSnapshot(organizationId, operationQuery),
        readSqlSnapshot(organizationId, operationQuery),
      ]);
      expect(sqlSnapshot, parityQuery.name).toEqual(jsSnapshot);
    }
  });

  it("agrees on a mid-corpus page and on repairing an offset past the end", async () => {
    const organizationId = await committedOrganizations.create();
    // Larger than one page, so `repairOffset` lands on the last FULL page
    // rather than collapsing to zero — the arithmetic the ten-branch matrix
    // above cannot reach.
    await seedCorpus(
      organizationId,
      Array.from({ length: 45 }, (_, index) => ({
        branchName: `feat/page-${String(index).padStart(3, "0")}`,
        sessions: 1,
        lastActiveMinutesAgo: index + 1,
      }))
    );

    for (const [limit, offset] of [
      [20, 20],
      [20, 40],
      [20, 1000],
      [25, 50],
    ]) {
      const operationQuery = operationQueryFor({ limit, offset });
      const [jsSnapshot, sqlSnapshot] = await Promise.all([
        readJsSnapshot(organizationId, operationQuery),
        readSqlSnapshot(organizationId, operationQuery),
      ]);
      expect(sqlSnapshot, `limit ${limit}, offset ${offset}`).toEqual(
        jsSnapshot
      );
      if (limit === 25) {
        // Driver parameter types must not turn floor into a rounding cast.
        const sql = branchServerPageSql(
          organizationId,
          operationQuery,
          { ...toBranchServerPageQuery(operationQuery), offset: 30 },
          NOW,
          DEFAULT_BRANCH_STATUS_ORDERING
        );
        const floatRows = await withDb((db) =>
          db.$queryRaw<BranchListSqlRow[]>(
            Prisma.sql(
              sql.strings,
              ...sql.values.map((value) =>
                typeof value === "number" ? Prisma.sql`${value}::float8` : value
              )
            )
          )
        );
        const floatSnapshot = decodeBranchServerPageRows(
          floatRows,
          DEFAULT_BRANCH_STATUS_ORDERING
        );
        expect(floatSnapshot.repairedOffset).toBe(25);
        expect(floatSnapshot.pageIds).toEqual(jsSnapshot.pageIds);
      }
    }
  });

  it("ISS-10332: ranks priority by ordinal with unset last both ways, and serves it on the row", async () => {
    const organizationId = await committedOrganizations.create();
    await seedCorpus(organizationId, SEED_BRANCHES);
    const prioritized = [
      "feat/alpha",
      "feat_alpha",
      "FEAT/alpha",
      "feat/Alpha",
    ];

    const namesFor = async (query: Partial<BranchListOperationQuery>) =>
      (await readSqlSnapshot(organizationId, operationQueryFor(query))).items;

    const ascending = await namesFor({
      sortKey: BranchListSortKey.Priority,
      sortDir: BranchListSortDirection.Asc,
    });
    const descending = await namesFor({
      sortKey: BranchListSortKey.Priority,
      sortDir: BranchListSortDirection.Desc,
    });
    // Low → Medium → High → Urgent, NOT the enum's spelling order; the six
    // unset rows trail in BOTH directions rather than leading the descending one.
    expect(ascending.slice(0, 4).map((row) => row.branchName)).toEqual(
      prioritized
    );
    expect(descending.slice(0, 4).map((row) => row.branchName)).toEqual(
      [...prioritized].reverse()
    );
    expect(ascending.slice(0, 4).map((row) => row.priority)).toEqual([
      Priority.Low,
      Priority.Medium,
      Priority.High,
      Priority.Urgent,
    ]);
    // `null`, not omitted: the cloud producer KNOWS these rows hold none.
    expect(ascending.slice(4).map((row) => row.priority)).toEqual(
      new Array(SEED_BRANCHES.length - 4).fill(null)
    );

    const unset = await namesFor({ priorities: [PRIORITY_UNSET_VALUE] });
    expect(unset).toHaveLength(SEED_BRANCHES.length - 4);
    expect(unset.every((row) => row.priority === null)).toBe(true);

    const highOrUnset = await namesFor({
      priorities: [Priority.High, PRIORITY_UNSET_VALUE],
    });
    expect(highOrUnset).toHaveLength(SEED_BRANCHES.length - 3);
  });

  it("keeps a second organization out of the page and every facet", async () => {
    const organizationId = await committedOrganizations.create();
    const otherOrganizationId = await committedOrganizations.create();
    await seedCorpus(organizationId, [
      { branchName: "only-mine", sessions: 1, lastActiveMinutesAgo: 5 },
    ]);
    await seedCorpus(otherOrganizationId, [
      { branchName: "not-mine", sessions: 1, lastActiveMinutesAgo: 5 },
      { branchName: "also-not-mine", sessions: 1, lastActiveMinutesAgo: 6 },
    ]);

    const snapshot = await readSqlSnapshot(
      organizationId,
      operationQueryFor({})
    );

    expect(snapshot.total).toBe(1);
    expect(snapshot.facets.names.options.map((option) => option.id)).toEqual([
      "only-mine",
    ]);
  });

  // ISS-12775: the prod plan read the latest atom for every candidate and the
  // linked-session fallback for every row, then discarded most of both.
  it("reads per-branch activity only for eligible branches, and the session fallback only without an atom", async () => {
    const organizationId = await committedOrganizations.create();
    await seedCorpus(organizationId, [
      { branchName: "with-atom-1", sessions: 1, lastActiveMinutesAgo: 5 },
      { branchName: "with-atom-2", sessions: 1, lastActiveMinutesAgo: 50 },
      { branchName: "with-atom-3", sessions: 1, lastActiveMinutesAgo: 500 },
      { branchName: "no-atom", sessions: 1, lastActiveMinutesAgo: null },
      // No Wrote session, so not Product-eligible.
      { branchName: "ineligible", lastActiveMinutesAgo: 5 },
    ]);
    const operationQuery = operationQueryFor({});
    const eligible = await readSqlSnapshot(organizationId, operationQuery);
    expect(eligible.total).toBe(4);

    const pageSql = (query: Partial<BranchListOperationQuery>) => {
      const pageQuery = operationQueryFor(query);
      return branchServerPageSql(
        organizationId,
        pageQuery,
        toBranchServerPageQuery(pageQuery),
        NOW,
        DEFAULT_BRANCH_STATUS_ORDERING
      );
    };
    const pagePlan = await explainAnalyze(pageSql({}));
    expect(relationLoops(pagePlan, "branch_activity_atoms")).toEqual([4]);
    expect(relationLoops(pagePlan, "branch_file_changes")).toEqual([]);
    const changesPlan = await explainAnalyze(
      pageSql({ sortKey: BranchListSortKey.Changes })
    );
    expect(relationLoops(changesPlan, "branch_file_changes")).toEqual([4]);
    const sessionCount = branchLinkedSessionCountSql().sql;
    expect(pageSql({}).sql).not.toContain(sessionCount);
    expect(pageSql({ sortKey: BranchListSortKey.Sessions }).sql).toContain(
      sessionCount
    );

    const candidatePlan = await explainAnalyze(Prisma.sql`
      SELECT a.id, linked_session_activity.last_activity_at
      ${branchCandidateFromClause()}
      WHERE a.organization_id = ${organizationId}::uuid
        AND a.type = ${ArtifactType.BRANCH}::"ArtifactType"
    `);
    expect(relationLoops(candidatePlan, "branch_activity_atoms")).toEqual([5]);
    // Runs of the fallback subquery rather than of its session_detail scan,
    // which with grown statistics the planner may reach once per org session
    // inside that one run. A session_detail scan outside any subquery still
    // reports its own loops.
    expect(subqueryRunLoops(candidatePlan, "session_detail")).toEqual([1]);
  });
});
