import assert from "node:assert/strict";
import { test } from "node:test";
import { BranchCloudHydrationStatus } from "@repo/api/src/types/branch";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { getSharedBranchAnalytics } from "../src/main/branch/branch-analytics-read.js";
import {
  type BranchCloudHydrationSource,
  getSharedBranches,
  getSharedBranchesPageData,
  getSharedBranchUsage,
} from "../src/main/branch/shared-branches-api.js";
import type { BranchCloudHydrationOverlay } from "../src/main/cloud/desktop-cloud-github-hydration.js";
import { seeder, withAcDb } from "./branch-reads-ac-test-helpers.js";

const repoFullName = "acme/web";
const eligibleBranches = Array.from(
  { length: 6 },
  (_, index) => `feature/${index + 1}`
);

test("ISS-6103: capped 3-of-6 PR coverage retains the known eligible cohort", () =>
  withAcDb(async (db) => {
    const seed = seeder(db);
    const branchNames = [...eligibleBranches, "main"];
    for (const [index, branch] of branchNames.entries()) {
      const sessionId = `session-${index}`;
      await seed.session(sessionId);
      await seed.tokens(sessionId, 100 + index);
      const artifactId = await seed.branch({ branch, repo: repoFullName });
      await seed.link({
        session: sessionId,
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
    let overlayAcquisitionCount = 0;
    const authority = cappedEligibilitySource(() => {
      overlayAcquisitionCount += 1;
    });

    const [list, pageData, usage, analytics, lastPage] = await Promise.all([
      getSharedBranches(source, {}, authority),
      getSharedBranchesPageData(source, {}, authority),
      getSharedBranchUsage(source, {}, authority),
      getSharedBranchAnalytics(source, {}, authority),
      getSharedBranches(source, { limit: 2, offset: 4 }, authority),
    ]);

    assert.deepEqual(
      list.items.map((item) => item.branchName).sort(),
      eligibleBranches
    );
    assert.equal(list.total, 6);
    assert.equal(
      list.items.filter((item) => typeof item.prNumber === "number").length,
      3
    );
    assert.equal(list.items.filter((item) => item.prNumber === null).length, 3);
    assert.equal(pageData.list.total, 6);
    assert.equal(usage.totalBranches, 6);
    assert.equal(analytics.activeBranchCount.value, 6);
    assert.equal(lastPage.total, 6);
    assert.equal(lastPage.items.length, 2);
    assert.ok(list.items.every((item) => item.branchName !== "main"));
    assert.equal(overlayAcquisitionCount, 0);
  }));

test("ISS-6103: capped empty PR coverage leaves non-PR metrics available", () =>
  withAcDb(async (db) => {
    const seed = seeder(db);
    await seed.session("session-known");
    const artifactId = await seed.branch({
      branch: "feature/known",
      repo: repoFullName,
    });
    await seed.link({
      session: "session-known",
      artifactId,
      method: "git_push",
    });
    const analytics = await getSharedBranchAnalytics(
      {
        prisma: db.prisma,
        readBranchCanonicalActivityRows: db.readBranchCanonicalActivityRows,
        readBranchMetricEventEvidence: db.readBranchMetricEventEvidence,
        syncSource: db.syncSource,
      },
      {},
      eligibilitySource({}, RepositoryDefaultReason.Capped)
    );

    assert.equal(
      analytics.canonicalMetrics?.activeBranches.current.state,
      BranchMetricAvailability.Complete
    );
    assert.equal(
      analytics.canonicalMetrics?.medianPrSize.current.state,
      BranchMetricAvailability.Unavailable
    );
    assert.equal(
      analytics.canonicalMetrics?.mergeRatePct.current.state,
      BranchMetricAvailability.Unavailable
    );
  }));

test("ISS-6542: partial PR identity cannot revoke local push publication", () =>
  withAcDb(async (db) => {
    const seed = seeder(db);
    for (const [index, branch] of [
      "feature/known",
      "feature/unknown-fork",
    ].entries()) {
      const sessionId = `session-partial-${index}`;
      await seed.session(sessionId);
      await seed.tokens(sessionId, 100 + index);
      const artifactId = await seed.branch({ branch, repo: repoFullName });
      await seed.link({ session: sessionId, artifactId, method: "git_push" });
    }
    const source = {
      prisma: db.prisma,
      readBranchCanonicalActivityRows: db.readBranchCanonicalActivityRows,
      readBranchMetricEventEvidence: db.readBranchMetricEventEvidence,
      syncSource: db.syncSource,
    };
    const authority = eligibilitySource({
      [`${repoFullName}::feature/unknown-fork`]: {
        headRepositoryUnavailableReason: RepositoryDefaultReason.Unknown,
      },
    });

    const list = await getSharedBranches(source, {}, authority);
    assert.deepEqual(
      list.items.map((item) => item.branchName),
      ["feature/known", "feature/unknown-fork"]
    );
    const usage = await getSharedBranchUsage(source, {}, authority);
    assert.equal(usage.totalBranches, 2);
  }));

function cappedEligibilitySource(
  recordOverlayAcquisition: () => void
): BranchCloudHydrationSource {
  const overlays = Object.fromEntries([
    ...eligibleBranches.slice(0, 3).map((branchName, index) => [
      `${repoFullName}::${branchName}`,
      {
        prNumber: index + 1,
        headRepositoryProvider: VcsProviderKind.GitHub,
        headRepositoryProviderId: "repo-acme-web",
        headRepositoryFullName: repoFullName,
      },
    ]),
  ]);
  const source = eligibilitySource(overlays, RepositoryDefaultReason.Capped);
  return {
    ...source,
    hydrate: (request) => {
      recordOverlayAcquisition();
      return source.hydrate(request);
    },
    peekOrWarm: (request) => {
      recordOverlayAcquisition();
      return source.peekOrWarm!(request);
    },
  };
}

function eligibilitySource(
  overlays: Record<string, BranchCloudHydrationOverlay>,
  incompleteReason?: RepositoryDefaultReason
): BranchCloudHydrationSource {
  const hydrationResult = {
    status: BranchCloudHydrationStatus.Fresh,
    overlays,
    ...(incompleteReason
      ? { pullRequestIncompleteReasons: { [repoFullName]: incompleteReason } }
      : {}),
  };
  return {
    hydrate: () => Promise.resolve(hydrationResult),
    peekOrWarm: () => Promise.resolve(hydrationResult),
    resolveRepositoryDefaultEligibilityInputs: () =>
      Promise.resolve({
        ...hydrationResult,
        rowHydrationResult: hydrationResult,
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
              defaultBranch: "main",
            },
          },
        ],
      }),
  };
}
