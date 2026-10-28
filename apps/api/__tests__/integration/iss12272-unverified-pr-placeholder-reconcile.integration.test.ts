/**
 * ISS-12272 — a desktop placeholder PR row on the INSTALLED tier is verified
 * against GitHub by the reconcile sweep, end to end against Postgres.
 *
 * The placeholder is written by the real session ingest, so it has the shape
 * prod measured on 303 rows: desktop-originated, no GitHub id, no title, and
 * `pr_state` OPEN from the column default. The PR closed on GitHub BEFORE the
 * row was inserted, so the sweep's watermark is already past it and the window
 * read cannot return it. That is the defect: nothing else on this tier re-read
 * such a row, and the PR-comment cron kept treating it as open.
 *
 * THE PROVIDER AND THE CREDENTIAL DRAW ARE THE ONLY MOCKS. Target selection, the
 * projection write and the attempt stamp are production code on real rows.
 *
 * Counterfactual: drop `unverifiedNumbers` from the by-number union in
 * `reconcileRepo` and the MERGED and CLOSED cases fail on `prState`.
 */
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import {
  GitHubCredentialKind,
  GitHubPRState,
} from "@repo/api/src/types/github";
import {
  type GitHubBundledPullRequestsResult,
  GitHubBundledPullRequestsStopReason,
  GitHubProviderBudgetState,
  type GitHubReadModelPullRequest,
  GitHubReadModelSource,
} from "@repo/api/src/types/github-read-model";
import { withDb } from "@repo/database";
import {
  GitHubProviderResultStatus,
  queryBundledPullRequestsWithProviderResult,
  queryPullRequestsByNumberWithProviderResult,
} from "@repo/github";
import type { GitHubProviderResult } from "@repo/github/provider-result";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS } from "@/app/cron/reconcile-pull-requests/constants";
import { reconcileRepo } from "@/app/cron/reconcile-pull-requests/repo-reconciler";
import { selectUnverifiedPullRequestTargets } from "@/app/cron/reconcile-pull-requests/unverified-pull-request-targets";
import {
  type GitHubSyncClient,
  getGitHubSyncClient,
} from "@/lib/github/github-sync-client-pool";
import { persistedGitHubRepositoryAuthority } from "../fixtures/repository-default-authority";
import { createCommittedTestOrganizationTracker } from "../utils/db-helpers";
import {
  baseFixture,
  branchRef,
  findBranch,
  findPrByBranchNumber,
  PR_OBSERVED_AT,
  pullRequestRef,
  seedRepo,
  syncSession,
} from "./agent-session-pr-sync-helpers";

vi.mock("@repo/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/github")>()),
  queryBundledPullRequestsWithProviderResult: vi.fn(),
  queryPullRequestsByNumberWithProviderResult: vi.fn(),
}));
vi.mock("@/lib/github/github-sync-client-pool", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/github/github-sync-client-pool")
  >()),
  getGitHubSyncClient: vi.fn(),
}));

const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const REPOSITORY = "acme/widgets";
const NORMALIZED = normalizeRepoFullName(REPOSITORY);
const SIBLING_REPOSITORY = "acme/gadgets";
const MERGED_PR = 501;
const CLOSED_PR = 502;
const OPEN_PR = 503;
const MISSING_PR = 504;

/** The PRs closed a week before the desktop session that names them synced. */
const CLOSED_ON_GITHUB_AT = "2026-07-03T09:00:00.000Z";
const GITHUB_UPDATED_AT = "2026-07-03T09:05:00.000Z";
const OPEN_UPDATED_AT = "2026-07-04T12:00:00.000Z";
/** Already past every PR above, so the window read cannot return them. */
const WATERMARK = new Date("2026-07-09T00:00:00.000Z");
const NOW = new Date(
  PR_OBSERVED_AT.getTime() + RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS / 2
);

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
      updatedAt: OPEN_UPDATED_AT,
    }),
  ],
]);

const mockGetClient = vi.mocked(getGitHubSyncClient);
const mockWindow = vi.mocked(queryBundledPullRequestsWithProviderResult);
const mockByNumber = vi.mocked(queryPullRequestsByNumberWithProviderResult);

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
    openedAt: "2026-07-01T09:00:00.000Z",
    mergeCommitSha: null,
    author: "octocat",
    source: GitHubReadModelSource.Provider,
    ...lifecycle,
  };
}

function providerSuccess(
  pullRequests: GitHubReadModelPullRequest[]
): GitHubProviderResult<GitHubBundledPullRequestsResult> {
  return {
    status: GitHubProviderResultStatus.Success,
    value: {
      pullRequests,
      rateLimit: {
        cost: 1,
        remaining: 4999,
        resetAt: "2026-07-10T13:00:00.000Z",
        state: GitHubProviderBudgetState.Available,
      },
      pageInfo: { hasNextPage: false, endCursor: null },
      hasMore: false,
      truncated: false,
      nextCursor: null,
      fetchedPages: 1,
      stopReason: GitHubBundledPullRequestsStopReason.Complete,
    },
  };
}

function installationClient(): GitHubSyncClient {
  return {
    kind: GitHubCredentialKind.Installation,
    credentialOwnerId: null,
    actingAs: { installationId: "inst-12272" },
    rateLimitTier: null,
    octokit: {} as GitHubSyncClient["octokit"],
    recordRateLimit: vi.fn().mockResolvedValue(undefined),
    recordRepoAccess: vi.fn().mockResolvedValue(undefined),
  };
}

type PlaceholderScope = {
  organizationId: string;
  repositoryId: string;
  detailIdByNumber: Map<number, string>;
};

/**
 * One desktop session naming each PR on its own branch, through the real
 * ingest. Throws unless each row has the prod placeholder shape, so no case
 * can pass on a row that was never a placeholder.
 */
async function seedPlaceholders(numbers: number[]): Promise<PlaceholderScope> {
  const fixture = await baseFixture();
  committedOrganizations.track(fixture.organizationId);
  const repo = await seedRepo(fixture.organizationId, REPOSITORY);
  await syncSession({
    ...fixture,
    artifactRefs: numbers.flatMap((prNumber) => [
      branchRef(REPOSITORY, `feature/${prNumber}`),
      pullRequestRef({
        repositoryFullName: REPOSITORY,
        prNumber,
        branchName: `feature/${prNumber}`,
      }),
    ]),
  });
  const detailIdByNumber = new Map<number, string>();
  for (const prNumber of numbers) {
    const branch = await findBranch(
      fixture.organizationId,
      NORMALIZED,
      `feature/${prNumber}`
    );
    if (!branch) {
      throw new Error(`branch for PR ${prNumber} did not materialize`);
    }
    const row = await findPrByBranchNumber(branch.artifactId, prNumber);
    if (!row) {
      throw new Error(`PR ${prNumber} did not materialize`);
    }
    const isPlaceholder =
      row.repositoryId === repo.repositoryId &&
      row.prState === GitHubPRState.Open &&
      row.githubId === null &&
      row.title === null &&
      row.githubUpdatedAt === null &&
      row.desktopOriginated &&
      row.isCurrent;
    if (!isPlaceholder) {
      throw new Error(`PR ${prNumber} is not the prod placeholder shape`);
    }
    detailIdByNumber.set(prNumber, row.id);
  }
  return {
    organizationId: fixture.organizationId,
    repositoryId: repo.repositoryId,
    detailIdByNumber,
  };
}

function runSweep(scope: PlaceholderScope) {
  return reconcileRepo(
    {
      organizationId: scope.organizationId,
      repositoryFullName: NORMALIZED,
      watermark: WATERMARK,
      cursor: null,
      consecutiveFailureCount: 0,
    },
    { now: NOW }
  );
}

function detailId(scope: PlaceholderScope, prNumber: number): string {
  const id = scope.detailIdByNumber.get(prNumber);
  if (!id) {
    throw new Error(`no seeded row for PR ${prNumber}`);
  }
  return id;
}

function readRow(scope: PlaceholderScope, prNumber: number) {
  return withDb((db) =>
    db.pullRequestDetail.findUniqueOrThrow({
      where: { id: detailId(scope, prNumber) },
    })
  );
}

function patchRow(
  scope: PlaceholderScope,
  prNumber: number,
  data: { githubUpdatedAt?: Date; prState?: GitHubPRState }
) {
  return withDb((db) =>
    db.pullRequestDetail.update({
      where: { id: detailId(scope, prNumber) },
      data,
    })
  );
}

function selectUnverified(scope: PlaceholderScope, now: Date = NOW) {
  return selectUnverifiedPullRequestTargets({
    organizationId: scope.organizationId,
    repositoryId: scope.repositoryId,
    repositoryFullName: NORMALIZED,
    now,
  });
}

/**
 * A row with the placeholder shape, written straight to the table: on a
 * sibling repository of the same installation (`repositoryId` set), or
 * repo-less (`repositoryId` null). The scope case needs rows the ingest helper
 * cannot place side by side in one org.
 */
async function insertPlaceholderRow(
  scope: PlaceholderScope,
  input: { number: number; repositoryId: string | null; fullName: string }
) {
  const anchor = await readRow(scope, MERGED_PR);
  await withDb((db) =>
    db.pullRequestDetail.create({
      data: {
        organizationId: scope.organizationId,
        branchArtifactId: anchor.branchArtifactId,
        repositoryId: input.repositoryId,
        repositoryFullName: input.fullName,
        number: input.number,
        desktopOriginated: true,
      },
    })
  );
}

async function addSiblingRepository(scope: PlaceholderScope): Promise<string> {
  const installation = await withDb((db) =>
    db.gitHubInstallation.findFirstOrThrow({
      where: { organizationId: scope.organizationId },
      select: { id: true },
    })
  );
  const repository = await withDb((db) =>
    db.gitHubInstallationRepository.create({
      data: {
        installationId: installation.id,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: `fixture-${SIBLING_REPOSITORY}`,
          fullName: SIBLING_REPOSITORY,
        }),
        name: "gadgets",
        owner: "acme",
        private: false,
      },
      select: { id: true },
    })
  );
  return repository.id;
}

describeIfDb("ISS-12272 installed-tier placeholder verification", () => {
  afterEach(() => committedOrganizations.cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClient.mockResolvedValue({ ok: true, value: installationClient() });
    // The watermark is past every seeded PR, so the window returns none of them.
    mockWindow.mockResolvedValue(providerSuccess([]));
    mockByNumber.mockImplementation((_octokit, _owner, _repo, numbers) =>
      Promise.resolve(
        providerSuccess(
          numbers.flatMap((number) => {
            const pullRequest = PROVIDER_PULL_REQUESTS.get(number);
            return pullRequest ? [pullRequest] : [];
          })
        )
      )
    );
  });

  it("writes MERGED, mergedAt and closedAt onto a placeholder for a merged PR", async () => {
    const scope = await seedPlaceholders([MERGED_PR]);

    await runSweep(scope);

    const row = await readRow(scope, MERGED_PR);
    expect(row.prState).toBe(GitHubPRState.Merged);
    expect(row.mergedAt).toEqual(new Date(CLOSED_ON_GITHUB_AT));
    expect(row.closedAt).toEqual(new Date(CLOSED_ON_GITHUB_AT));
    expect(row.githubUpdatedAt).toEqual(new Date(GITHUB_UPDATED_AT));
  });

  it("writes CLOSED and closedAt, and no mergedAt, onto a placeholder for a closed PR", async () => {
    const scope = await seedPlaceholders([CLOSED_PR]);

    await runSweep(scope);

    const row = await readRow(scope, CLOSED_PR);
    expect(row.prState).toBe(GitHubPRState.Closed);
    expect(row.closedAt).toEqual(new Date(CLOSED_ON_GITHUB_AT));
    expect(row.mergedAt).toBeNull();
  });

  it("keeps a placeholder for an open PR OPEN, verified, and out of the arm", async () => {
    const scope = await seedPlaceholders([OPEN_PR]);

    await runSweep(scope);

    const row = await readRow(scope, OPEN_PR);
    expect(row.prState).toBe(GitHubPRState.Open);
    expect(row.closedAt).toBeNull();
    expect(row.mergedAt).toBeNull();
    expect(row.githubUpdatedAt).toEqual(new Date(OPEN_UPDATED_AT));
    expect(row.lastVerifiedAt).toEqual(NOW);
    // One read is enough: the next sweep must not spend a request on it again.
    expect(await selectUnverified(scope)).toEqual([]);
  });

  it("asks for every placeholder in one by-number read", async () => {
    const scope = await seedPlaceholders([MERGED_PR, CLOSED_PR, OPEN_PR]);

    await runSweep(scope);

    expect(mockByNumber).toHaveBeenCalledTimes(1);
    expect(mockByNumber.mock.calls[0]?.[3]).toEqual(
      expect.arrayContaining([MERGED_PR, CLOSED_PR, OPEN_PR])
    );
    const states = await Promise.all(
      [MERGED_PR, CLOSED_PR, OPEN_PR].map(async (prNumber) => {
        const row = await readRow(scope, prNumber);
        return row.prState;
      })
    );
    expect(states).toEqual([
      GitHubPRState.Merged,
      GitHubPRState.Closed,
      GitHubPRState.Open,
    ]);
  });

  it("stamps a placeholder the provider cannot find and retries it only after the debounce", async () => {
    const scope = await seedPlaceholders([MISSING_PR]);

    await runSweep(scope);

    const row = await readRow(scope, MISSING_PR);
    expect(row.prState).toBe(GitHubPRState.Open);
    expect(row.githubUpdatedAt).toBeNull();
    expect(row.lastRefreshAttemptAt).toEqual(NOW);
    expect(await selectUnverified(scope)).toEqual([]);
    const afterDebounce = new Date(
      NOW.getTime() + RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS + 1
    );
    expect(await selectUnverified(scope, afterDebounce)).toEqual([MISSING_PR]);
  });

  it("does not select an OPEN row a GitHub read already observed", async () => {
    const scope = await seedPlaceholders([OPEN_PR]);
    expect(await selectUnverified(scope)).toEqual([OPEN_PR]);

    await patchRow(scope, OPEN_PR, {
      githubUpdatedAt: new Date(OPEN_UPDATED_AT),
    });

    expect(await selectUnverified(scope)).toEqual([]);
  });

  it("does not select a row whose stored state is no longer OPEN", async () => {
    const scope = await seedPlaceholders([MERGED_PR]);
    expect(await selectUnverified(scope)).toEqual([MERGED_PR]);

    await patchRow(scope, MERGED_PR, { prState: GitHubPRState.Merged });

    expect(await selectUnverified(scope)).toEqual([]);
  });

  it("selects only the swept repository's rows, in the swept org", async () => {
    const scope = await seedPlaceholders([MERGED_PR]);
    const otherOrg = await seedPlaceholders([CLOSED_PR]);
    // The other org's row becomes repo-less under the SAME full name, so only
    // the org filter keeps it out of this org's repo-less selection.
    await withDb((db) =>
      db.pullRequestDetail.update({
        where: { id: detailId(otherOrg, CLOSED_PR) },
        data: { repositoryId: null },
      })
    );
    await insertPlaceholderRow(scope, {
      number: CLOSED_PR,
      repositoryId: await addSiblingRepository(scope),
      fullName: SIBLING_REPOSITORY,
    });
    await insertPlaceholderRow(scope, {
      number: OPEN_PR,
      repositoryId: null,
      fullName: NORMALIZED,
    });

    expect(await selectUnverified(scope)).toEqual([MERGED_PR]);
    expect(
      await selectUnverifiedPullRequestTargets({
        organizationId: scope.organizationId,
        repositoryId: null,
        repositoryFullName: NORMALIZED,
        now: NOW,
      })
    ).toEqual([OPEN_PR]);
  });
});

/**
 * These cases commit: the sweep opens its own transactions. Every org they
 * seed is deleted after each case, so no open placeholder PR is left for a
 * later suite's global scan (the PR-comment reconcile batch) to pick up.
 */
const committedOrganizations = createCommittedTestOrganizationTracker();
