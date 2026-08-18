import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BranchCloudHydrationStatus,
  encodeBranchId,
} from "@repo/api/src/types/branch";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { getSharedBranchAnalytics } from "../src/main/branch/branch-analytics-read.js";
import { getSharedBranchCohortAnalytics } from "../src/main/branch/branch-cohort-analytics.js";
import { getSharedBranchTrace } from "../src/main/branch/shared-branch-trace.js";
import {
  type BranchCloudHydrationSource,
  getSharedBranchDetail,
  getSharedBranches,
  getSharedBranchesPageData,
  getSharedBranchUsage,
} from "../src/main/branch/shared-branches-api.js";
import { FAIL_CLOSED_BRANCH_CLOUD_HYDRATION_SOURCE } from "../src/main/branch/shared-branches-cloud-hydration.js";
import { resolveBranchDefaultEligibilitySnapshot } from "../src/main/branch/shared-branches-default-eligibility.js";
import {
  BranchDefaultEligibilityOutcome,
  BranchDefaultExclusionCause,
} from "../src/main/database/branch-default-eligibility.js";
import { readLocalBranchLinkRows } from "../src/main/database/branch-reads.js";
import { SHARED_BRANCHES_SOURCE_ERROR_CODE } from "../src/shared/shared-branches-contract.js";
import { seeder, withAcDb } from "./branch-reads-ac-test-helpers.js";

const repoFullName = "acme/web";

test("ISS-5828: production Branches reads exclude before projection, totals, analytics, and detail", () =>
  withAcDb(async (db) => {
    const seed = seeder(db);
    await seed.session("session-authority");
    await seed.tokens("session-authority", 200);
    await db.run(
      "UPDATE token_usage SET cost_usd_estimated = 2 WHERE session_id = $1",
      "session-authority"
    );
    let eligibleArtifactId = "";
    for (const branch of ["main", "feature/eligible"]) {
      const artifactId = await seed.branch({ branch, repo: repoFullName });
      if (branch === "feature/eligible") {
        eligibleArtifactId = artifactId;
      }
      await seed.link({
        session: "session-authority",
        artifactId,
        method: "git_push",
      });
    }
    await db.run(
      "UPDATE artifacts SET lines_added = 100, lines_removed = 0, files_changed = 1 WHERE id = $1",
      eligibleArtifactId
    );
    const commitOnlyArtifact = await seed.branch({
      branch: "feature/commit-only",
      repo: repoFullName,
    });
    await seed.link({
      session: "session-authority",
      artifactId: commitOnlyArtifact,
      method: "git_commit",
    });
    const source = {
      prisma: db.prisma,
      readBranchCanonicalActivityRows: db.readBranchCanonicalActivityRows,
      readBranchMetricEventEvidence: db.readBranchMetricEventEvidence,
      syncSource: db.syncSource,
    };
    const authority = eligibilitySource("main");

    const commitOnlyId = encodeBranchId({
      repoFullName,
      branchName: "feature/commit-only",
    });
    const eligibleId = encodeBranchId({
      repoFullName,
      branchName: "feature/eligible",
    });
    const [
      list,
      pageData,
      usage,
      analytics,
      cohort,
      featureDetail,
      defaultDetail,
      commitOnlyDetail,
    ] = await Promise.all([
      getSharedBranches(source, {}, authority),
      getSharedBranchesPageData(source, {}, authority),
      getSharedBranchUsage(source, {}, authority),
      getSharedBranchAnalytics(source, {}, authority),
      getSharedBranchCohortAnalytics(
        source,
        { branchIds: [eligibleId, commitOnlyId] },
        authority
      ),
      getSharedBranchDetail(source, eligibleId, authority),
      getSharedBranchDetail(
        source,
        encodeBranchId({ repoFullName, branchName: "main" }),
        authority
      ),
      getSharedBranchDetail(source, commitOnlyId, authority),
    ]);

    assert.deepEqual(
      list.items.map((item) => item.branchName),
      ["feature/eligible"]
    );
    assert.equal(list.total, 1);
    assert.deepEqual(list.sessionBranchCount, { "session-authority": 2 });
    assert.equal(pageData.list.total, 1);
    assert.ok(pageData.analytics);
    assert.equal(pageData.analytics.activeBranchCount.value, 1);
    assert.equal(pageData.analytics.locPerDollar.value, 100);
    assert.equal(usage.totalBranches, 1);
    assert.equal(usage.totalInputTokens, 200);
    assert.equal(analytics.activeBranchCount.value, 1);
    assert.equal(analytics.locPerDollar.value, 100);
    assert.deepEqual(cohort?.matchedBranchIds, [eligibleId]);
    assert.equal(featureDetail?.branchName, "feature/eligible");
    assert.equal(defaultDetail, null);
    assert.equal(commitOnlyDetail, null);

    const defaultTrace = await getSharedBranchTrace(
      source,
      encodeBranchId({ repoFullName, branchName: "main" }),
      authority
    );
    assert.deepEqual(defaultTrace.sessions, []);
    const commitOnlyTrace = await getSharedBranchTrace(
      source,
      commitOnlyId,
      authority
    );
    assert.deepEqual(commitOnlyTrace.sessions, []);

    const flipped = await getSharedBranches(
      source,
      {},
      eligibilitySource("feature/eligible")
    );
    assert.deepEqual(
      flipped.items.map((item) => item.branchName),
      ["main"]
    );
    assert.equal(
      (await readLocalBranchLinkRows(db.prisma)).length,
      3,
      "default changes re-evaluate untouched evidence without deletion"
    );

    await assert.rejects(
      getSharedBranches(source, {}, FAIL_CLOSED_BRANCH_CLOUD_HYDRATION_SOURCE),
      (error: Error) => {
        assert.equal(error.message, SHARED_BRANCHES_SOURCE_ERROR_CODE);
        return true;
      }
    );
  }));

test("ISS-5828: production reads resolve the complete 101-repository corpus before pagination", () =>
  withAcDb(async (db) => {
    const seed = seeder(db);
    await seed.session("session-multi-chunk");
    const repositories = Array.from(
      { length: 101 },
      (_, index) => `acme/repository-${index.toString().padStart(3, "0")}`
    );
    for (const [index, repository] of repositories.entries()) {
      const artifactId = await seed.branch({
        branch: `feature/${index.toString().padStart(3, "0")}`,
        repo: repository,
      });
      await seed.link({
        session: "session-multi-chunk",
        artifactId,
        method: "git_push",
      });
    }
    const source = {
      prisma: db.prisma,
      readBranchCanonicalActivityRows: db.readBranchCanonicalActivityRows,
      readBranchMetricEventEvidence: db.readBranchMetricEventEvidence,
      syncSource: db.syncSource,
    };
    const authority = eligibilitySourceForRepositories(repositories);

    const [list, pageData, usage] = await Promise.all([
      getSharedBranches(source, { limit: 100 }, authority.source),
      getSharedBranchesPageData(source, { limit: 100 }, authority.source),
      getSharedBranchUsage(source, {}, authority.source),
    ]);

    assert.equal(list.items.length, 100);
    assert.equal(list.total, 101);
    assert.equal(pageData.list.total, 101);
    assert.ok(pageData.analytics);
    assert.equal(pageData.analytics.activeBranchCount.value, 101);
    assert.equal(usage.totalBranches, 101);
    assert.ok(
      authority.candidateSets.every((candidates) => candidates.length === 101)
    );
    assert.ok(
      authority.candidateSets.every((candidates) =>
        candidates.some(
          (candidate) => candidate.repoFullName === repositories[100]
        )
      ),
      "the repository after the 100-item store boundary reaches every product read"
    );
  }));

test("ISS-5828: production pagination is filled from the eligible corpus", () =>
  withAcDb(async (db) => {
    const seed = seeder(db);
    await seed.session("session-pagination");
    const branches = [
      "000-default",
      ...Array.from(
        { length: 101 },
        (_, index) => `feature/${index.toString().padStart(3, "0")}`
      ),
    ];
    for (const branch of branches) {
      const artifactId = await seed.branch({ branch, repo: repoFullName });
      await seed.link({
        session: "session-pagination",
        artifactId,
        method: "git_push",
      });
    }
    const source = {
      prisma: db.prisma,
      readBranchCanonicalActivityRows: db.readBranchCanonicalActivityRows,
      readBranchMetricEventEvidence: db.readBranchMetricEventEvidence,
      syncSource: db.syncSource,
    };
    const authority = eligibilitySource("000-default");

    const [firstPage, secondPage, pageData] = await Promise.all([
      getSharedBranches(source, { limit: 100 }, authority),
      getSharedBranches(source, { limit: 100, offset: 100 }, authority),
      getSharedBranchesPageData(source, { limit: 100 }, authority),
    ]);

    assert.equal(firstPage.total, 101);
    assert.equal(firstPage.items.length, 100);
    assert.equal(secondPage.total, 101);
    assert.deepEqual(
      secondPage.items.map((item) => item.branchName),
      ["feature/100"]
    );
    assert.equal(pageData.list.total, 101);
    assert.equal(pageData.list.items.length, 100);
    assert.ok(
      [...firstPage.items, ...secondPage.items].every(
        (item) => item.branchName !== "000-default"
      )
    );
    assert.ok(
      pageData.list.items.every((item) => item.branchName !== "000-default")
    );
  }));

test("ISS-5828: stale and failed hydration cannot reuse available authority", async () => {
  const row = { repoFullName, branchName: "feature/eligible" };
  const available = eligibilitySource("main");
  const resolveAvailable = available.resolveRepositoryDefaultEligibilityInputs;
  assert.ok(resolveAvailable);
  const stale = await resolveBranchDefaultEligibilitySnapshot(
    [row],
    {
      resolveRepositoryDefaultEligibilityInputs: async (request) => ({
        authorities: (await resolveAvailable(request)).authorities,
        status: BranchCloudHydrationStatus.Stale,
      }),
    },
    { scope: "list" }
  );
  const failed = await resolveBranchDefaultEligibilitySnapshot(
    [row],
    {
      resolveRepositoryDefaultEligibilityInputs: async (request) => ({
        authorities: (await resolveAvailable(request)).authorities,
        status: BranchCloudHydrationStatus.Failed,
        failure: "cloud_pull_failed",
      }),
    },
    { scope: "detail" }
  );
  const id = encodeBranchId(row);

  assert.deepEqual(stale?.exclusionsByKey.get(id), {
    outcome: BranchDefaultEligibilityOutcome.Excluded,
    cause: BranchDefaultExclusionCause.AuthorityUnavailable,
    reason: RepositoryDefaultReason.Unknown,
  });
  assert.deepEqual(failed?.exclusionsByKey.get(id), {
    outcome: BranchDefaultEligibilityOutcome.Excluded,
    cause: BranchDefaultExclusionCause.AuthorityUnavailable,
    reason: RepositoryDefaultReason.ProviderError,
  });
});

test("ISS-5828: the production detail resolver retains every typed unavailable cause", async () => {
  const reasons = [
    RepositoryDefaultReason.Malformed,
    RepositoryDefaultReason.Unknown,
    RepositoryDefaultReason.Conflicting,
    RepositoryDefaultReason.Ambiguous,
    RepositoryDefaultReason.PermissionDenied,
    RepositoryDefaultReason.PermissionFiltered,
    RepositoryDefaultReason.RateLimited,
    RepositoryDefaultReason.ProviderError,
    RepositoryDefaultReason.Capped,
  ];
  const rows = reasons.map((reason, index) => ({
    repoFullName: `acme/${reason}-${index}`,
    branchName: "feature",
  }));
  rows.push({ repoFullName: "acme/not-reported", branchName: "feature" });
  rows.push({ repoFullName: "acme/stale", branchName: "feature" });
  const source: BranchCloudHydrationSource = {
    hydrate: () =>
      Promise.resolve({ status: BranchCloudHydrationStatus.Fresh }),
    resolveRepositoryDefaultEligibilityInputs: () =>
      Promise.resolve({
        status: BranchCloudHydrationStatus.Fresh,
        rowHydrationResult: { status: BranchCloudHydrationStatus.Fresh },
        authorities: [
          ...reasons.map((reason, index) => ({
            repository: {
              provider: VcsProviderKind.GitHub,
              providerRepositoryId: `repo-${index}`,
              fullName: `acme/${reason}-${index}`,
            },
            evidence: {
              availability: RepositoryDefaultAvailability.Unavailable,
              completeness:
                reason === RepositoryDefaultReason.Capped
                  ? RepositoryDefaultCompleteness.Partial
                  : RepositoryDefaultCompleteness.Unavailable,
              reason,
            },
          })),
          {
            repository: {
              provider: VcsProviderKind.GitHub,
              providerRepositoryId: "repo-stale",
              fullName: "acme/stale",
            },
            evidence: {
              availability: RepositoryDefaultAvailability.Stale,
              completeness: RepositoryDefaultCompleteness.Partial,
              defaultBranch: "main",
              reason: RepositoryDefaultReason.RateLimited,
            },
          },
        ],
      }),
  };

  const snapshot = await resolveBranchDefaultEligibilitySnapshot(rows, source, {
    scope: "detail",
  });
  assert.ok(snapshot);
  for (const [index, reason] of reasons.entries()) {
    assert.deepEqual(
      snapshot.exclusionsByKey.get(
        encodeBranchId({
          repoFullName: `acme/${reason}-${index}`,
          branchName: "feature",
        })
      ),
      {
        outcome: BranchDefaultEligibilityOutcome.Excluded,
        cause: BranchDefaultExclusionCause.AuthorityUnavailable,
        reason,
      }
    );
  }
  assert.deepEqual(
    snapshot.exclusionsByKey.get(
      encodeBranchId({
        repoFullName: "acme/not-reported",
        branchName: "feature",
      })
    ),
    {
      outcome: BranchDefaultEligibilityOutcome.Excluded,
      cause: BranchDefaultExclusionCause.AuthorityUnavailable,
      reason: RepositoryDefaultReason.NotReported,
    }
  );
  assert.deepEqual(
    snapshot.exclusionsByKey.get(
      encodeBranchId({ repoFullName: "acme/stale", branchName: "feature" })
    ),
    {
      outcome: BranchDefaultEligibilityOutcome.Excluded,
      cause: BranchDefaultExclusionCause.AuthorityUnavailable,
      reason: RepositoryDefaultReason.RateLimited,
    }
  );
});

function eligibilitySource(defaultBranch: string): BranchCloudHydrationSource {
  const inputs = {
    status: BranchCloudHydrationStatus.Fresh,
    rowHydrationResult: { status: BranchCloudHydrationStatus.Fresh },
    authorities: [
      {
        repository: {
          provider: VcsProviderKind.GitHub,
          providerRepositoryId: "repo-acme-web",
          fullName: repoFullName,
        },
        evidence: {
          availability: RepositoryDefaultAvailability.Available,
          completeness: RepositoryDefaultCompleteness.Complete,
          defaultBranch,
        },
      },
    ],
  };
  return {
    hydrate: async () => ({ status: BranchCloudHydrationStatus.Fresh }),
    peekOrWarm: async () => ({ status: BranchCloudHydrationStatus.Fresh }),
    resolveRepositoryDefaultEligibilityInputs: () => Promise.resolve(inputs),
  };
}

function eligibilitySourceForRepositories(repositories: readonly string[]): {
  source: BranchCloudHydrationSource;
  candidateSets: Array<
    Array<{ repoFullName: string | null; branchName: string }>
  >;
} {
  const candidateSets: Array<
    Array<{ repoFullName: string | null; branchName: string }>
  > = [];
  return {
    candidateSets,
    source: {
      hydrate: async () => ({ status: BranchCloudHydrationStatus.Fresh }),
      peekOrWarm: async () => ({ status: BranchCloudHydrationStatus.Fresh }),
      resolveRepositoryDefaultEligibilityInputs: (request) => {
        candidateSets.push([...request.rows]);
        return Promise.resolve({
          status: BranchCloudHydrationStatus.Fresh,
          rowHydrationResult: { status: BranchCloudHydrationStatus.Fresh },
          authorities: repositories.map((repository, index) => ({
            repository: {
              provider: VcsProviderKind.GitHub,
              providerRepositoryId: `repo-${index}`,
              fullName: repository,
            },
            evidence: {
              availability: RepositoryDefaultAvailability.Available,
              completeness: RepositoryDefaultCompleteness.Complete,
              defaultBranch: "main",
            },
          })),
        });
      },
    },
  };
}
