import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BranchCloudHydrationStatus,
  encodeBranchId,
} from "@repo/api/src/types/branch";
import {
  type NormalizedPersistedRepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import {
  type BranchCloudHydrationSource,
  getSharedBranches,
} from "../src/main/branch/shared-branches-api.js";
import {
  BranchProductExclusionCause,
  denominatorEligibleBranchKeys,
  eligibleBranchKeys,
  filterEligibleBranchRows,
  resolveBranchProductEligibilitySnapshot,
} from "../src/main/branch/shared-branches-default-eligibility.js";
import type { BranchCloudHydrationOverlay } from "../src/main/cloud/desktop-cloud-github-hydration.js";
import {
  readBranchSessionTokenRowsForBranch,
  readBranchTokenAggregateRows,
  readLocalBranchLinkRows,
} from "../src/main/database/branch-reads.js";
import { AC_T1, seeder, withAcDb } from "./branch-reads-ac-test-helpers.js";

const repoFullName = "acme/web";

test("Product-visible and denominator-authority keys remain separate", async () => {
  const published = candidate("feature/published", true);
  const commitOnly = candidate("feature/commit-only", false);
  const defaultBranch = candidate("main", true);
  const rows = [published, commitOnly, defaultBranch];
  const snapshot = await resolveBranchProductEligibilitySnapshot(
    rows,
    eligibilitySource(),
    { scope: "list" }
  );

  assert.deepEqual(eligibleBranchKeys(rows, snapshot), [published]);
  const denominatorKeys = [
    { repoFullName, branchName: commitOnly.branchName },
    { repoFullName, branchName: published.branchName },
  ];
  assert.deepEqual(
    denominatorEligibleBranchKeys(rows, snapshot),
    denominatorKeys
  );
  assert.deepEqual(
    filterEligibleBranchRows(rows, snapshot).map((row) => row.branchName),
    ["feature/published"]
  );
  assert.deepEqual(
    denominatorEligibleBranchKeys(
      filterEligibleBranchRows(rows, snapshot),
      snapshot
    ),
    denominatorKeys,
    "a Product-prefiltered caller cannot collapse denominator authority"
  );
  assert.equal(
    exclusionCause(snapshot, commitOnly),
    BranchProductExclusionCause.PublicationMissing
  );
});

test("only a numeric PR with a complete exact head can replace local publication", async () => {
  const exactPr = candidate("feature/exact-pr", false);
  const missingPr = candidate("feature/missing-pr", false);
  const partialHead = candidate("feature/partial-head", false);
  const forkDefault = candidate("fork-main", false);
  const overlays: Record<string, BranchCloudHydrationOverlay> = {
    [overlayKey(exactPr)]: exactPullRequestOverlay(42, "base-id", repoFullName),
    [overlayKey(missingPr)]: {
      ...exactPullRequestOverlay(43, "base-id", repoFullName),
      prNumber: null,
    },
    [overlayKey(partialHead)]: {
      prNumber: 44,
      headRepositoryProvider: VcsProviderKind.GitHub,
      headRepositoryFullName: repoFullName,
    },
    [overlayKey(forkDefault)]: exactPullRequestOverlay(
      45,
      "fork-id",
      "contributor/web"
    ),
  };
  const snapshot = await resolveBranchProductEligibilitySnapshot(
    [exactPr, missingPr, partialHead, forkDefault],
    eligibilitySource(overlays, [
      authority("base-id", repoFullName, "main"),
      authority("fork-id", "contributor/web", "fork-main"),
    ]),
    { scope: "detail" }
  );

  assert.deepEqual([...snapshot!.eligibleBranchIds], [encodeBranchId(exactPr)]);
  for (const excluded of [missingPr, partialHead]) {
    assert.equal(
      exclusionCause(snapshot, excluded),
      BranchProductExclusionCause.PublicationMissing
    );
  }
  assert.equal(exclusionCause(snapshot, forkDefault), "default_branch");
});

test("local publication is independent from unavailable PR-head coverage", async () => {
  const published = candidate("feature/pushed", true);
  const snapshot = await resolveBranchProductEligibilitySnapshot(
    [published],
    eligibilitySource(
      {
        [overlayKey(published)]: {
          headRepositoryUnavailableReason: RepositoryDefaultReason.Capped,
        },
      },
      undefined,
      RepositoryDefaultReason.Capped
    ),
    { scope: "list" }
  );

  assert.deepEqual(
    [...snapshot!.eligibleBranchIds],
    [encodeBranchId(published)]
  );
  assert.deepEqual(
    [...snapshot!.denominatorEligibleBranchIds],
    [encodeBranchId(published)],
    "every Product-visible Branch remains denominator-authoritative"
  );
  assert.equal(snapshot?.pullRequestCoverageComplete, false);
});

test("capped PR coverage keeps one visible Branch and both Session divisor keys", () =>
  withAcDb(async (db) => {
    const seed = seeder(db);
    const sessionId = "shared-session";
    const published = candidate("feature/published", true);
    await seed.session(sessionId);
    await seed.tokens(sessionId, 100);
    await db.run(
      "UPDATE token_usage SET cost_usd_estimated = 2 WHERE session_id = $1",
      sessionId
    );

    const publishedArtifact = await seed.branch({
      branch: published.branchName,
      repo: repoFullName,
    });
    const commitOnlyArtifact = await seed.branch({
      branch: "feature/commit-only",
      repo: repoFullName,
    });
    await seed.link({
      session: sessionId,
      artifactId: publishedArtifact,
      method: "git_push",
    });
    await seed.link({
      session: sessionId,
      artifactId: commitOnlyArtifact,
      method: "git_commit",
    });

    const source = {
      prisma: db.prisma,
      readBranchCanonicalActivityRows: db.readBranchCanonicalActivityRows,
      readBranchMetricEventEvidence: db.readBranchMetricEventEvidence,
      syncSource: db.syncSource,
    };
    const authoritySource = eligibilitySource(
      {
        [overlayKey(published)]: {
          headRepositoryUnavailableReason: RepositoryDefaultReason.Capped,
        },
      },
      undefined,
      RepositoryDefaultReason.Capped
    );
    const list = await getSharedBranches(source, {}, authoritySource);

    assert.deepEqual(
      list.items.map((item) => item.branchName),
      ["feature/published"]
    );
    assert.deepEqual(list.sessionBranchCount, { [sessionId]: 2 });

    const rawRows = await readLocalBranchLinkRows(db.prisma);
    assert.deepEqual(
      rawRows.map((row) => [row.branchName, row.hasLocalPublication]).sort(),
      [
        ["feature/commit-only", false],
        ["feature/published", true],
      ]
    );
    const snapshot = await resolveBranchProductEligibilitySnapshot(
      rawRows,
      authoritySource,
      { scope: "list" }
    );
    const visibleKeys = eligibleBranchKeys(rawRows, snapshot);
    const denominatorKeys = denominatorEligibleBranchKeys(rawRows, snapshot);
    const aggregate = await readBranchTokenAggregateRows(
      db.prisma,
      visibleKeys,
      denominatorKeys
    );
    const sessionRows = await readBranchSessionTokenRowsForBranch(
      db.prisma,
      visibleKeys[0]!,
      denominatorKeys
    );

    assert.equal(aggregate.length, 1);
    assert.equal(aggregate[0]?.branchName, "feature/published");
    assert.equal(aggregate[0]?.inputTokens, 50);
    assert.equal(sessionRows[0]?.branchCount, 2);
    assert.equal(sessionRows[0]?.evenSplitCostUsd, 1);
    assert.equal(
      rawRows.find((row) => row.branchName === "feature/commit-only")
        ?.hasLocalPublication,
      false
    );

    await seed.markPushed(commitOnlyArtifact, AC_T1);
    const afterPublicationRows = await readLocalBranchLinkRows(db.prisma);
    assert.equal(
      afterPublicationRows.find(
        (row) => row.branchName === "feature/commit-only"
      )?.hasLocalPublication,
      true
    );
  }));

test("publication order is irrelevant and never substitutes for active Wrote", () =>
  withAcDb(async (db) => {
    const seed = seeder(db);
    const sessionId = "evidence-order-session";
    await seed.session(sessionId);
    const source = {
      prisma: db.prisma,
      readBranchCanonicalActivityRows: db.readBranchCanonicalActivityRows,
      readBranchMetricEventEvidence: db.readBranchMetricEventEvidence,
      syncSource: db.syncSource,
    };

    const pushFirst = candidate("feature/push-first", true);
    const pushFirstArtifact = await seed.branch({
      branch: pushFirst.branchName,
      repo: repoFullName,
      firstPushedAt: AC_T1,
    });
    assert.deepEqual(
      (await getSharedBranches(source, {}, eligibilitySource())).items,
      [],
      "publication without Wrote remains outside the Product candidate corpus"
    );
    await seed.link({
      session: sessionId,
      artifactId: pushFirstArtifact,
      method: "git_commit",
    });
    assert.deepEqual(
      (await getSharedBranches(source, {}, eligibilitySource())).items.map(
        (item) => item.branchName
      ),
      [pushFirst.branchName]
    );

    const prFirst = candidate("feature/pr-first", false);
    const prFirstArtifact = await seed.branch({
      branch: prFirst.branchName,
      repo: repoFullName,
    });
    const prFirstOverlays = {
      [overlayKey(prFirst)]: exactPullRequestOverlay(
        51,
        "base-id",
        repoFullName
      ),
    };
    assert.deepEqual(
      (
        await getSharedBranches(source, {}, eligibilitySource(prFirstOverlays))
      ).items.map((item) => item.branchName),
      [pushFirst.branchName],
      "an exact PR cannot manufacture the missing Wrote side"
    );
    await seed.link({
      session: sessionId,
      artifactId: prFirstArtifact,
      method: "git_commit",
    });

    const wroteFirst = candidate("feature/wrote-first", false);
    const wroteFirstArtifact = await seed.branch({
      branch: wroteFirst.branchName,
      repo: repoFullName,
    });
    await seed.link({
      session: sessionId,
      artifactId: wroteFirstArtifact,
      method: "git_commit",
    });
    assert.deepEqual(
      (await getSharedBranches(source, {}, eligibilitySource())).items.map(
        (item) => item.branchName
      ),
      [pushFirst.branchName],
      "Wrote without publication remains Product-ineligible"
    );
    const bothPrOverlays = {
      ...prFirstOverlays,
      [overlayKey(wroteFirst)]: exactPullRequestOverlay(
        52,
        "base-id",
        repoFullName
      ),
    };
    assert.deepEqual(
      (
        await getSharedBranches(source, {}, eligibilitySource(bothPrOverlays))
      ).items.map((item) => item.branchName),
      [prFirst.branchName, pushFirst.branchName, wroteFirst.branchName]
    );
  }));

test("Branch rows, head SHAs, and non-Wrote links cannot enter Product membership", () =>
  withAcDb(async (db) => {
    const seed = seeder(db);
    const sessionId = "non-wrote-session";
    await seed.session(sessionId);
    const branchArtifact = await seed.branch({
      branch: "feature/head-only",
      repo: repoFullName,
    });
    await db.run(
      "UPDATE artifacts SET head_sha = 'abc123' WHERE id = $1",
      branchArtifact
    );
    await seed.link({
      session: sessionId,
      artifactId: branchArtifact,
      method: "git_checkout",
    });
    const source = {
      prisma: db.prisma,
      readBranchCanonicalActivityRows: db.readBranchCanonicalActivityRows,
      readBranchMetricEventEvidence: db.readBranchMetricEventEvidence,
      syncSource: db.syncSource,
    };

    assert.deepEqual(await readLocalBranchLinkRows(db.prisma), []);
    assert.deepEqual(
      (
        await getSharedBranches(
          source,
          {},
          eligibilitySource({
            [`${repoFullName}::feature/head-only`]: exactPullRequestOverlay(
              61,
              "base-id",
              repoFullName
            ),
          })
        )
      ).items,
      []
    );
  }));

function candidate(branchName: string, hasLocalPublication: boolean) {
  return { repoFullName, branchName, hasLocalPublication };
}

function exclusionCause(
  snapshot: Awaited<ReturnType<typeof resolveBranchProductEligibilitySnapshot>>,
  row: { repoFullName: string | null; branchName: string }
): string | undefined {
  const decision = snapshot?.exclusionsByKey.get(encodeBranchId(row));
  return decision && "cause" in decision ? decision.cause : undefined;
}

function overlayKey(row: { repoFullName: string | null; branchName: string }) {
  return `${row.repoFullName}::${row.branchName}`;
}

function exactPullRequestOverlay(
  prNumber: number,
  providerRepositoryId: string,
  headRepositoryFullName: string
): BranchCloudHydrationOverlay {
  return {
    prNumber,
    headRepositoryProvider: VcsProviderKind.GitHub,
    headRepositoryProviderId: providerRepositoryId,
    headRepositoryFullName,
  };
}

function eligibilitySource(
  overlays: Record<string, BranchCloudHydrationOverlay> = {},
  authorities: NormalizedPersistedRepositoryDefaultAuthority[] = [
    authority("base-id", repoFullName, "main"),
  ],
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
        authorities,
      }),
  };
}

function authority(
  providerRepositoryId: string,
  fullName: string,
  defaultBranch: string
): NormalizedPersistedRepositoryDefaultAuthority {
  return {
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId,
      fullName,
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Available,
      completeness: RepositoryDefaultCompleteness.Complete,
      defaultBranch,
    },
  };
}
