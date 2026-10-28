/**
 * ISS-12292 — an OPEN pull-request row with no session link, on a USER-TOKEN
 * repo, is re-read by the reconcile sweep, end to end against Postgres.
 *
 * The rows have the prod rtk-ai/rtk shape: repo-less, OPEN, last observed in
 * July by the retired tier-2 history sweep, and no session link, so the
 * targeted tier's session-linked arm never selects them. The PRs have since
 * closed on GitHub.
 *
 * THE PROVIDER AND THE CLERK TOKEN FETCH ARE THE ONLY MOCKS. The sync pool's
 * org-scoped draw, the tier routing, target selection, the projection write
 * and the attempt stamp are production code on real rows.
 */
import { BranchStatus } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  GitHubBundledPullRequestsStopReason,
  GitHubFetchMechanism,
  GitHubProviderBudgetState,
  type GitHubReadModelPullRequest,
  GitHubReadModelSource,
} from "@repo/api/src/types/github-read-model";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { GitHubProviderResultStatus } from "@repo/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/github/pull-request-point-read", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@repo/github/pull-request-point-read")
  >()),
  getRepositoryPullRequestsByNumberWithProviderResult: vi.fn(),
}));
vi.mock("@/lib/github/github-user-credential", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/github/github-user-credential")
  >()),
  acquireGitHubUserToken: vi.fn(),
}));

import {
  GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE,
  getRepositoryPullRequestsByNumberWithProviderResult,
} from "@repo/github/pull-request-point-read";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import { RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS } from "@/app/cron/reconcile-pull-requests/constants";
import { reconcileRepo } from "@/app/cron/reconcile-pull-requests/repo-reconciler";
import { selectSessionLinkedPullRequestTargets } from "@/app/cron/reconcile-pull-requests/session-linked-targets";
import { selectUnlinkedOpenPullRequestTargets } from "@/app/cron/reconcile-pull-requests/unlinked-open-pull-request-targets";
import { GITHUB_REPO_SCOPE } from "@/lib/github/github-connection-credential";
import { acquireGitHubUserToken } from "@/lib/github/github-user-credential";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const organizations = createCommittedTestOrganizationTracker();

const REPOSITORY = "upstream-oss/tool";
const MERGED_PR = 2219;
const CLOSED_PR = 2221;
const OPEN_PR = 2285;

const JULY_UPDATED_AT = new Date("2026-06-22T16:29:34.000Z");
const JULY_VERIFIED_AT = new Date("2026-07-26T03:21:25.000Z");
const CLOSED_ON_GITHUB_AT = "2026-09-14T06:39:39.000Z";
const GITHUB_UPDATED_AT = "2026-09-14T06:40:00.000Z";
const NOW = new Date("2026-10-09T03:30:00.000Z");

const PROVIDER_PULL_REQUESTS = new Map<number, GitHubReadModelPullRequest>([
  [
    MERGED_PR,
    providerPullRequest(MERGED_PR, {
      state: GitHubPRState.Merged,
      closedAt: CLOSED_ON_GITHUB_AT,
      mergedAt: CLOSED_ON_GITHUB_AT,
      updatedAt: GITHUB_UPDATED_AT,
    }),
  ],
  [
    CLOSED_PR,
    providerPullRequest(CLOSED_PR, {
      state: GitHubPRState.Closed,
      closedAt: CLOSED_ON_GITHUB_AT,
      mergedAt: null,
      updatedAt: GITHUB_UPDATED_AT,
    }),
  ],
  [
    OPEN_PR,
    providerPullRequest(OPEN_PR, {
      state: GitHubPRState.Open,
      closedAt: null,
      mergedAt: null,
      updatedAt: GITHUB_UPDATED_AT,
    }),
  ],
]);

const pointRead = vi.mocked(
  getRepositoryPullRequestsByNumberWithProviderResult
);
const acquireToken = vi.mocked(acquireGitHubUserToken);

function providerPullRequest(
  number: number,
  lifecycle: Pick<
    GitHubReadModelPullRequest,
    "state" | "closedAt" | "mergedAt" | "updatedAt"
  >
): GitHubReadModelPullRequest {
  return {
    githubId: `PR_node_${number}`,
    number,
    title: `PR ${number}`,
    htmlUrl: `https://github.com/${REPOSITORY}/pull/${number}`,
    headBranch: `feature/${number}`,
    baseBranch: "main",
    headSha: "a".repeat(40),
    isDraft: false,
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    reviewDecision: null,
    checksStatus: null,
    statusCheckRollup: null,
    openedAt: "2026-06-02T17:44:13.000Z",
    mergeCommitSha: null,
    author: "octocat",
    source: GitHubReadModelSource.Provider,
    ...lifecycle,
  };
}

function providerAnswer(numbers: readonly number[]) {
  const pullRequests = numbers.flatMap((number) => {
    const pullRequest = PROVIDER_PULL_REQUESTS.get(number);
    return pullRequest ? [pullRequest] : [];
  });
  return {
    status: GitHubProviderResultStatus.Success,
    value: {
      pullRequests,
      rateLimit: {
        cost: 1,
        remaining: 4999,
        resetAt: "2026-10-09T04:00:00.000Z",
        state: GitHubProviderBudgetState.Available,
      },
      pageInfo: { hasNextPage: false, endCursor: null },
      hasMore: false,
      truncated: false,
      nextCursor: null,
      fetchedPages: 1,
      stopReason: GitHubBundledPullRequestsStopReason.Complete,
      targetNumbers: [...numbers],
      missingTargetNumbers: [],
      attemptedNumbers: [...numbers],
      missingNumbers: numbers.filter(
        (number) => !PROVIDER_PULL_REQUESTS.has(number)
      ),
      unattemptedNumbers: [],
    },
  };
}

/** An org member whose GitHub token the sync pool may draw for this org. */
async function seedConnectedOrg(): Promise<{
  organizationId: string;
  userId: string;
}> {
  const organizationId = await organizations.create();
  const user = await createTestUser(organizationId);
  await withDb((db) =>
    db.gitHubUserConnection.create({
      data: {
        organizationId,
        userId: user.id,
        githubUserId: `gh-${user.id}`,
        login: `octocat-${user.id.slice(0, 8)}`,
        normalizedLogin: `octocat-${user.id.slice(0, 8)}`,
        scopes: [GITHUB_REPO_SCOPE],
      },
    })
  );
  return { organizationId, userId: user.id };
}

/** The prod rtk-ai/rtk row: repo-less, OPEN, last read in July. */
async function seedOpenRow(
  organizationId: string,
  userId: string,
  number: number
): Promise<{ detailId: string; branchArtifactId: string }> {
  return await withDb(async (db) => {
    const branch = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: `branch-${number}`,
        status: BranchStatus.Open,
        createdById: userId,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: branch.id,
        organizationId,
        repositoryId: null,
        repositoryFullName: REPOSITORY,
        branchName: `feature/${number}`,
      },
      select: { artifactId: true },
    });
    const row = await db.pullRequestDetail.create({
      data: {
        organizationId,
        branchArtifactId: branch.id,
        repositoryId: null,
        repositoryFullName: REPOSITORY,
        number,
        prState: GitHubPRState.Open,
        isCurrent: true,
        githubUpdatedAt: JULY_UPDATED_AT,
        lastVerifiedAt: JULY_VERIFIED_AT,
        lastRefreshAttemptAt: JULY_VERIFIED_AT,
        fetchMechanism: GitHubFetchMechanism.Graphql,
      },
      select: { id: true },
    });
    return { detailId: row.id, branchArtifactId: branch.id };
  });
}

function runSweep(organizationId: string) {
  return reconcileRepo(
    {
      organizationId,
      repositoryFullName: REPOSITORY,
      watermark: null,
      cursor: null,
      consecutiveFailureCount: 0,
    },
    { now: NOW }
  );
}

function selectUnlinked(organizationId: string, now: Date = NOW) {
  return selectUnlinkedOpenPullRequestTargets({
    organizationId,
    repositoryId: null,
    repositoryFullName: REPOSITORY,
    now,
    limit: GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE,
  });
}

function readRow(detailId: string) {
  return withDb((db) =>
    db.pullRequestDetail.findUniqueOrThrow({ where: { id: detailId } })
  );
}

function readBranchPointer(branchArtifactId: string) {
  return withDb((db) =>
    db.branchDetail.findUniqueOrThrow({
      where: { artifactId: branchArtifactId },
      select: { currentPullRequestDetailId: true },
    })
  );
}

function requestedNumbers(): number[] {
  return pointRead.mock.calls.flatMap((call) => [...call[3]]);
}

beforeEach(() => {
  acquireToken.mockResolvedValue({ ok: true, token: "ghu_iss12292" });
  pointRead.mockImplementation((_octokit, _owner, _repo, numbers) =>
    Promise.resolve(providerAnswer(numbers))
  );
});

afterEach(async () => {
  vi.clearAllMocks();
  await organizations.cleanup();
});

describeIfDb("ISS-12292 user-token-tier unlinked OPEN rows", () => {
  it("writes MERGED and CLOSED with their timestamps, with the org's own token, in one read", async () => {
    const org = await seedConnectedOrg();
    const merged = await seedOpenRow(org.organizationId, org.userId, MERGED_PR);
    const closed = await seedOpenRow(org.organizationId, org.userId, CLOSED_PR);

    await runSweep(org.organizationId);

    expect(pointRead).toHaveBeenCalledTimes(1);
    expect(new Set(requestedNumbers())).toEqual(
      new Set([MERGED_PR, CLOSED_PR])
    );
    const mergedRow = await readRow(merged.detailId);
    expect(mergedRow.prState).toBe(GitHubPRState.Merged);
    expect(mergedRow.mergedAt).toEqual(new Date(CLOSED_ON_GITHUB_AT));
    expect(mergedRow.closedAt).toEqual(new Date(CLOSED_ON_GITHUB_AT));
    expect(mergedRow.githubUpdatedAt).toEqual(new Date(GITHUB_UPDATED_AT));
    expect(mergedRow.lastVerifiedAt).toEqual(NOW);
    expect(mergedRow.fetchCredentialOwnerId).toBe(org.userId);
    const closedRow = await readRow(closed.detailId);
    expect(closedRow.prState).toBe(GitHubPRState.Closed);
    expect(closedRow.closedAt).toEqual(new Date(CLOSED_ON_GITHUB_AT));
    expect(closedRow.mergedAt).toBeNull();
    // PRD-683 D1: only a session-linked branch's pointer may be set here.
    expect(await readBranchPointer(merged.branchArtifactId)).toEqual({
      currentPullRequestDetailId: null,
    });
  });

  it("keeps a still-open row OPEN and out of the arm until the attempt debounce passes", async () => {
    const org = await seedConnectedOrg();
    const open = await seedOpenRow(org.organizationId, org.userId, OPEN_PR);

    await runSweep(org.organizationId);

    const row = await readRow(open.detailId);
    expect(row.prState).toBe(GitHubPRState.Open);
    expect(row.lastRefreshAttemptAt).toEqual(NOW);
    expect(await selectUnlinked(org.organizationId)).toEqual([]);
    const afterDebounce = new Date(
      NOW.getTime() + RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS + 1
    );
    expect(
      (await selectUnlinked(org.organizationId, afterDebounce)).map(
        (target) => target.number
      )
    ).toEqual([OPEN_PR]);
  });

  it("leaves a session-linked OPEN row to the session-linked arm", async () => {
    const org = await seedConnectedOrg();
    const linked = await seedOpenRow(org.organizationId, org.userId, CLOSED_PR);
    await linkValidSessionToBranch({
      organizationId: org.organizationId,
      userId: org.userId,
      branchArtifactId: linked.branchArtifactId,
      label: "iss12292-linked",
      linkKind: SessionArtifactLinkKind.SessionPr,
      metadata: {
        linkKind: SessionArtifactLinkKind.SessionPr,
        repositoryFullName: REPOSITORY,
        prNumber: CLOSED_PR,
      },
    });

    expect(await selectUnlinked(org.organizationId)).toEqual([]);
    const sessionLinked = await selectSessionLinkedPullRequestTargets({
      organizationId: org.organizationId,
      repositoryId: null,
      repositoryFullName: REPOSITORY,
      now: NOW,
    });
    expect(sessionLinked.map((target) => target.number)).toEqual([CLOSED_PR]);
  });

  it("selects a row whose session-link evidence is NULL, which the session-linked arm drops", async () => {
    const org = await seedConnectedOrg();
    const row = await seedOpenRow(org.organizationId, org.userId, MERGED_PR);
    // A session_branch link with no recorded fetch mechanism and no desktop
    // origin: the desktop-origin disjunct evaluates to NULL, not false.
    await withDb((db) =>
      db.pullRequestDetail.update({
        where: { id: row.detailId },
        data: { fetchMechanism: null },
      })
    );
    await linkValidSessionToBranch({
      organizationId: org.organizationId,
      userId: org.userId,
      branchArtifactId: row.branchArtifactId,
      label: "iss12292-null-evidence",
    });

    const sessionLinked = await selectSessionLinkedPullRequestTargets({
      organizationId: org.organizationId,
      repositoryId: null,
      repositoryFullName: REPOSITORY,
      now: NOW,
    });
    expect(sessionLinked).toEqual([]);
    expect(
      (await selectUnlinked(org.organizationId)).map((target) => target.number)
    ).toEqual([MERGED_PR]);
  });

  it("does not read another org's row on the same repository, with distinct numbers so dedupe cannot mask a missing org predicate", async () => {
    const org = await seedConnectedOrg();
    const other = await seedConnectedOrg();
    await seedOpenRow(org.organizationId, org.userId, MERGED_PR);
    const otherRow = await seedOpenRow(
      other.organizationId,
      other.userId,
      CLOSED_PR
    );

    await runSweep(org.organizationId);

    expect(requestedNumbers()).toEqual([MERGED_PR]);
    expect((await readRow(otherRow.detailId)).prState).toBe(GitHubPRState.Open);
  });

  it("does not read a row when its own org has no token, even if another org does", async () => {
    const tokenless = await organizations.create();
    const tokenlessUser = await createTestUser(tokenless);
    const row = await seedOpenRow(tokenless, tokenlessUser.id, MERGED_PR);
    // Another org can read the same repository; its token must not be used.
    await seedConnectedOrg();

    await runSweep(tokenless);

    expect(pointRead).not.toHaveBeenCalled();
    const after = await readRow(row.detailId);
    expect(after.prState).toBe(GitHubPRState.Open);
    expect(after.fetchCredentialOwnerId).toBeNull();
  });
});
