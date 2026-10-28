/**
 * ISS-8226 (the ISS-8151 remainder, PRD-683 Phase 1 P1-B) — the TARGETED
 * DELIVERY LANE end to end, against real Postgres.
 *
 * #6061 shipped the read-path invariant and refused this suite, correctly: the
 * Phase-0 code it must revert was not on `main` yet. ISS-8147 (#6049, Tier-2
 * targeted PR sync) has since landed, so the lane this drives now exists.
 *
 * ONE ACT, the whole chain: an observed App-installed repository, a
 * session-linked merged PR row that no producer has verified, the real target
 * enumeration, a point-read fetch through a MOCKED provider, the real write,
 * verify stamp and promotion, and finally the coverage derivation that decides
 * whether Delivery may print a number at all.
 *
 * WHAT MAKES IT FAIL FOR THE RIGHT REASON. The seeded PR is merged IN WINDOW,
 * session-linked, carries NO diff stats and NO `lastVerifiedAt`, and its branch
 * has NO current pointer. So before the lane runs the population is
 * legitimately UNMEASURED and every merged-PR KPI is nulled by production code;
 * after it runs, the same production code prints the number. Each piece the
 * ticket names — enumeration, fetch, verify stamp, promotion — sits between
 * those two assertions, and the counterfactual table in the PR body records
 * which revert each case detects.
 *
 * THE PROVIDER IS THE ONLY MOCK. Everything else — the raw target SQL, the
 * projection write, the promotion transaction, the census query, the branch
 * population read — is production code on real rows.
 *
 * SCOPE, stated plainly: the push-gate half of ISS-8226 is NOT built here. Four
 * suites on `main` already pin it end to end (see the PR body's refutation with
 * file:line). What this suite does hold is the READ-side exclusion those suites
 * do not drive against real rows: a local-only branch stays out of the branch
 * population while a pushed one stays in.
 */
import {
  GitHubCredentialKind,
  GitHubPRState,
} from "@repo/api/src/types/github";
import {
  GitHubBundledPullRequestsStopReason,
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  GitHubProviderBudgetState,
  type GitHubReadModelPullRequest,
  GitHubReadModelSource,
} from "@repo/api/src/types/github-read-model";
import { InsightsPeriod, InsightsScope } from "@repo/api/src/types/insights";
import { RepositoryDefaultSource } from "@repo/api/src/types/repository-default-identity";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { GitHubProviderResultStatus } from "@repo/github";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/github/pull-request-point-read", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@repo/github/pull-request-point-read")
  >()),
  getRepositoryPullRequestsByNumberWithProviderResult: vi.fn(),
}));

// ISS-8424 gates the honest-unmeasured render behind a server flag, and an
// unresolved flag deliberately keeps the pre-ISS-8424 behaviour. Pinning it ON
// is what makes the KPI assertions below read the fold this lane exists to
// unblock, rather than the fallback (#7213 review, whitlockk).
vi.mock("@/lib/unmeasured-delivery-population-feature", () => ({
  isUnmeasuredDeliveryPopulationEnabled: vi.fn().mockResolvedValue(true),
}));

import { getRepositoryPullRequestsByNumberWithProviderResult } from "@repo/github/pull-request-point-read";
import {
  IN_WINDOW_MERGED_AT,
  REPO_FULL_NAME,
  seedBranch,
  seedRepository,
  WINDOW_END,
  WINDOW_START,
} from "@/__tests__/integration/delivery-cross-surface-seed-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { reconcileTargetedSessionLinkedPullRequests } from "@/app/cron/reconcile-pull-requests/targeted-reconciler";
import { isMergedPrPopulationUnmeasured } from "@/app/insights/delivery-measurement";
import {
  fetchBranchesWithoutPrBuckets,
  readBranchListPopulationIds,
} from "@/app/insights/insights-branch-population";
import { censusMergedPrVerification } from "@/app/insights/merged-pr-queries";
import { insightsService } from "@/app/insights/service";
import { artifactScope } from "@/app/insights/service/scope";
import type { GitHubSyncClient } from "@/lib/github/github-sync-client-pool";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const organizations = createCommittedTestOrganizationTracker();
const NOW = new Date("2026-07-20T12:00:00.000Z");
const LANDED_PR_NUMBER = 101;
const LANDED_ADDITIONS = 613;
const LANDED_DELETIONS = 407;
const NO_PR_BUCKET_KEY = "no-pr";

const pointRead = vi.mocked(
  getRepositoryPullRequestsByNumberWithProviderResult
);

/** The provider's answer for the seeded merged PR: the facts the row lacks. */
function providerPullRequest(number: number): GitHubReadModelPullRequest {
  return {
    githubId: `PR_node_${number}`,
    number,
    title: `PR ${number}`,
    htmlUrl: `https://github.com/${REPO_FULL_NAME}/pull/${number}`,
    headBranch: "landed",
    baseBranch: "main",
    headSha: "a".repeat(40),
    state: GitHubPRState.Merged,
    isDraft: false,
    additions: LANDED_ADDITIONS,
    deletions: LANDED_DELETIONS,
    changedFiles: 9,
    reviewDecision: null,
    checksStatus: null,
    statusCheckRollup: null,
    openedAt: "2026-07-14T11:00:00.000Z",
    closedAt: IN_WINDOW_MERGED_AT.toISOString(),
    mergedAt: IN_WINDOW_MERGED_AT.toISOString(),
    mergeCommitSha: "b".repeat(40),
    updatedAt: "2026-07-15T12:05:00.000Z",
    author: "octocat",
    source: GitHubReadModelSource.Provider,
  };
}

function providerSuccess(numbers: number[]) {
  return {
    status: GitHubProviderResultStatus.Success,
    value: {
      pullRequests: numbers.map(providerPullRequest),
      rateLimit: {
        cost: 1,
        remaining: 4999,
        resetAt: "2026-07-20T13:00:00.000Z",
        state: GitHubProviderBudgetState.Available,
      },
      pageInfo: { hasNextPage: false, endCursor: null },
      hasMore: false,
      truncated: false,
      nextCursor: null,
      fetchedPages: 1,
      stopReason: GitHubBundledPullRequestsStopReason.Complete,
      missingNumbers: [],
      attemptedNumbers: numbers,
      unattemptedNumbers: [],
    },
  };
}

function syncClient(credentialOwnerId: string): GitHubSyncClient {
  return {
    kind: GitHubCredentialKind.OauthUser,
    credentialOwnerId,
    actingAs: { githubUserId: "gh-user-1", login: "octocat" },
    rateLimitTier: null,
    octokit: {} as GitHubSyncClient["octokit"],
    recordRateLimit: vi.fn(),
    recordRepoAccess: vi.fn(),
  } as unknown as GitHubSyncClient;
}

function laneInput(
  organizationId: string,
  repositoryId: string,
  credentialOwnerId: string
) {
  return {
    organizationId,
    repositoryId,
    repositoryFullName: REPO_FULL_NAME,
    owner: "acme",
    repo: "delivery",
    client: syncClient(credentialOwnerId),
    provenance: {
      source: RepositoryDefaultSource.PullRequestGraphql,
      mechanism: GitHubFetchMechanism.Graphql,
      trigger: GitHubFetchTrigger.Backfill,
      credentialType: GitHubFetchCredentialType.UserOAuth,
      credentialOwnerId,
      observationKey: `${repositoryId}:${credentialOwnerId}`,
      observedAt: NOW.toISOString(),
    },
    now: NOW,
  };
}

function scopeContext(organizationId: string, userId: string) {
  return { organizationId, userId, scope: InsightsScope.Org };
}

/**
 * The SHIPPED delivery response, keyed by KPI.
 *
 * #7213 review (whitlockk): this used to rebuild the fold locally — a fixture KPI
 * list run through `withUnmeasuredMergedPrKpis` behind a local re-check of the
 * census. That proved the two helpers compose, which their own unit suite
 * already proves, and stayed green if `getDelivery` stopped applying the census
 * at all, because the production composition never ran here. Driving the real
 * service is the only thing that makes the lane's effect on what a user SEES
 * the subject of the assertion.
 */
async function readDeliveryKpis(
  organizationId: string,
  userId: string
): Promise<Map<string, number | null>> {
  const response = await insightsService.getDelivery(
    scopeContext(organizationId, userId),
    InsightsPeriod.Month,
    WINDOW_END
  );
  return new Map(response.kpis.map((stat) => [stat.key, stat.value]));
}

function readPullRequest(organizationId: string, number: number) {
  return withDb((db) =>
    db.pullRequestDetail.findFirst({
      where: { organizationId, number },
      select: {
        id: true,
        branchArtifactId: true,
        additions: true,
        deletions: true,
        lastVerifiedAt: true,
        prState: true,
      },
    })
  );
}

function readBranchPointer(organizationId: string, artifactId: string) {
  return withDb((db) =>
    db.branchDetail.findUnique({
      where: { organizationId_artifactId: { organizationId, artifactId } },
      select: { currentPullRequestDetailId: true },
    })
  );
}

/** Strip the seeded push evidence, leaving the local-only shape D7 excludes. */
function makeLocalOnly(organizationId: string, artifactId: string) {
  return withDb((db) =>
    db.branchDetail.update({
      where: { organizationId_artifactId: { organizationId, artifactId } },
      data: { firstPushedAt: null, pushSource: null },
      select: { artifactId: true },
    })
  );
}

afterEach(async () => {
  vi.clearAllMocks();
  await organizations.cleanup();
});

describeIfDb("targeted delivery lane, end to end (ISS-8226)", () => {
  it("enumerates a session-linked target, fetches it, stamps and promotes it, and makes the coverage KPI printable", async () => {
    const organizationId = await organizations.create();
    const author = await createTestUser(organizationId);
    const repository = await seedRepository(organizationId);
    const landedBranchId = await seedBranch({
      organizationId,
      userId: author.id,
      ...repository,
      branchName: "landed",
      prNumber: LANDED_PR_NUMBER,
      linkedPrNumbers: [LANDED_PR_NUMBER],
      // The tier-2 heal shape: a merged, session-linked row that no producer
      // has verified, carrying no diff stats and installed as nobody's pointer.
      withoutPointer: true,
      pr: {
        prState: GitHubPRState.Merged,
        mergedAt: IN_WINDOW_MERGED_AT,
        additions: null,
        deletions: null,
        unverified: true,
      },
    });
    const seeded = await readPullRequest(organizationId, LANDED_PR_NUMBER);
    expect(seeded?.lastVerifiedAt).toBeNull();

    const ctx = scopeContext(organizationId, author.id);
    const before = await censusMergedPrVerification(
      ctx,
      WINDOW_START,
      WINDOW_END
    );

    // The honest pre-state: the population EXISTS and none of it is verified,
    // so production nulls every merged-PR-derived KPI rather than printing 0.
    expect(before).toEqual({
      hasSessionLinkedMergedPrs: true,
      hasVerifiedMergedPrs: false,
    });
    expect(isMergedPrPopulationUnmeasured(before)).toBe(true);
    const beforeKpis = await readDeliveryKpis(organizationId, author.id);
    // `toBeNull`, never `toBeFalsy`: the value this replaces is `0`, and a
    // falsy assertion cannot tell the fabricated measurement from the honest
    // absence of one.
    expect(beforeKpis.get("merged")).toBeNull();
    expect(beforeKpis.get("mergedCount")).toBeNull();
    // The selectivity control, on the SAME response: session spend is read from
    // `agent_session_*` and is measured either way, so a fold that nulled
    // everything would satisfy the two assertions above and fail here.
    expect(beforeKpis.get("cost")).not.toBeNull();

    pointRead.mockResolvedValue(
      providerSuccess([LANDED_PR_NUMBER]) as Awaited<
        ReturnType<typeof getRepositoryPullRequestsByNumberWithProviderResult>
      >
    );

    const result = await reconcileTargetedSessionLinkedPullRequests(
      laneInput(organizationId, repository.repositoryId, author.id)
    );

    // 1. ENUMERATION — the real target SQL found the session-linked row.
    expect(result.targetNumbers).toEqual([LANDED_PR_NUMBER]);
    // 2. FETCH — the point read was issued for exactly those numbers, and for
    //    no others: a lane that widened to repository history fails here.
    expect(pointRead).toHaveBeenCalledTimes(1);
    expect(pointRead.mock.calls[0]?.[3]).toEqual([LANDED_PR_NUMBER]);
    expect(
      result.status === GitHubProviderResultStatus.Success
        ? result.providerRead
        : null
    ).toBe(true);

    const reconciled = await readPullRequest(organizationId, LANDED_PR_NUMBER);
    // 3. ENRICHMENT — the provider's facts reached the row.
    expect(reconciled?.additions).toBe(LANDED_ADDITIONS);
    expect(reconciled?.deletions).toBe(LANDED_DELETIONS);
    // 4. VERIFY STAMP — written only by this lane for an OAuth-only org.
    expect(reconciled?.lastVerifiedAt).toEqual(NOW);
    // 5. PROMOTION — the branch had no pointer, so the verified row becomes it.
    expect(
      (await readBranchPointer(organizationId, landedBranchId))
        ?.currentPullRequestDetailId
    ).toBe(reconciled?.id);

    // 6. COVERAGE — the same production derivation now prints the number it
    //    honestly could not print before the lane ran.
    const after = await censusMergedPrVerification(
      ctx,
      WINDOW_START,
      WINDOW_END
    );
    expect(after.hasVerifiedMergedPrs).toBe(true);
    expect(isMergedPrPopulationUnmeasured(after)).toBe(false);
    const afterKpis = await readDeliveryKpis(organizationId, author.id);
    expect(afterKpis.get("merged")).toBe(1);
    expect(afterKpis.get("mergedCount")).toBe(1);
    expect(afterKpis.get("cost")).not.toBeNull();
  });

  it("issues no provider read when the org has no session-linked target", async () => {
    const organizationId = await organizations.create();
    const author = await createTestUser(organizationId);
    const repository = await seedRepository(organizationId);
    // Seeded with a merged PR but NO session link: PRD-683 Ruling 1 makes
    // session-linkage the population, so this row is not this lane's to fetch.
    await seedBranch({
      organizationId,
      userId: author.id,
      ...repository,
      branchName: "unlinked",
      prNumber: 202,
      unlinked: true,
      pr: {
        prState: GitHubPRState.Merged,
        mergedAt: IN_WINDOW_MERGED_AT,
        additions: null,
        deletions: null,
        unverified: true,
      },
    });

    const result = await reconcileTargetedSessionLinkedPullRequests(
      laneInput(organizationId, repository.repositoryId, author.id)
    );

    expect(result.targetNumbers).toEqual([]);
    // Zero qualifying rows means zero provider calls — the property that makes
    // this a targeted lane rather than a repository-history reader.
    expect(pointRead).not.toHaveBeenCalled();
    expect(
      (await readPullRequest(organizationId, 202))?.lastVerifiedAt
    ).toBeNull();
  });

  it("excludes a local-only branch from the branch population and keeps the pushed one", async () => {
    const organizationId = await organizations.create();
    const author = await createTestUser(organizationId);
    const repository = await seedRepository(organizationId);
    const localOnlyBranchId = await seedBranch({
      organizationId,
      userId: author.id,
      ...repository,
      branchName: "local-only",
      prNumber: 303,
    });
    await makeLocalOnly(organizationId, localOnlyBranchId);
    const pushedBranchId = await seedBranch({
      organizationId,
      userId: author.id,
      ...repository,
      branchName: "pushed",
      prNumber: 304,
    });

    const scope = artifactScope(scopeContext(organizationId, author.id));
    // ISS-11915: the donut counts the Branches list population, whose Product
    // eligibility always requires verified publication — the ISS-8148 flag no
    // longer gates it.
    const noPrBucket = async () => {
      const populationIds = await readBranchListPopulationIds(organizationId, {
        startDate: WINDOW_START,
        endDate: WINDOW_END,
        evaluationNow: WINDOW_END,
      });
      const buckets = await fetchBranchesWithoutPrBuckets(populationIds, scope);
      return buckets.find((bucket) => bucket.key === NO_PR_BUCKET_KEY)?.value;
    };

    // Both branches carry no PR row, so only push evidence separates them.
    expect(await noPrBucket()).toBe(1);

    // A COUNT alone cannot tell "kept the pushed one" from "kept the local-only
    // one": inverting the predicate to `firstPushedAt: null` swaps which row
    // survives and still leaves exactly one. So strip the push evidence from
    // the OTHER branch too — an inverted gate then keeps both rows and this
    // reads 2, while the honest gate keeps neither.
    await makeLocalOnly(organizationId, pushedBranchId);
    expect(await noPrBucket()).toBe(0);
  });
});
