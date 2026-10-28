/**
 * ISS-9190: the `integrations/github` backfill and `branches` reads asked
 * Postgres for every column of `BranchDetail` (~50), `PullRequestDetail` (~60,
 * `body` a `@db.Text`), `GitHubInstallationRepository` (~30),
 * `GitHubPRReview` (17) and `OAuthRateLimit` (7) and then used a handful.
 *
 * These assertions run against `createModelDouble`, which projects the stored
 * row through the `select` the way Postgres does. That is the point: a
 * characterization suite over a plain `vi.fn()` returns the superset no matter
 * what the query asked for, so it passes with the whole narrowing reverted
 * (`review-soul` on PR #5216). Here a wrong-or-absent `select` is an observable
 * change in the object the consumer receives.
 *
 * THREE PAIRS OF PATHS MEANT TO BE EQUIVALENT are the reason this file exists
 * rather than one assertion per read. Each pair gets an assertion that the two
 * members agree, not just that each is narrow:
 *
 *  1. `branchDetail` singular vs batched — one `BackfillBranch` type, two
 *     statements; a column on one only is a field a caller sees or not
 *     depending on which read served it.
 *  2. `pullRequestDetail` App vs repo-less — TWO ARMS INSIDE ONE FUNCTION,
 *     returning through one signature, so the caller cannot tell which ran.
 *  3. `pullRequestDetail` dry-run batch vs write-path lookup — the dry run
 *     previews the write, and the two feed the same comparison helpers.
 */

import { BranchBaseBranchSource } from "@repo/api/src/types/artifact";
import { GitHubPRState } from "@repo/api/src/types/github";
import type { GitHubReadModelPullRequest } from "@repo/api/src/types/github-read-model";
import { GitHubReadModelSource } from "@repo/api/src/types/github-read-model";
import type { TransactionClient } from "@repo/database";
import {
  ChecksStatus,
  GitHubInstallationStatus,
  ReviewDecision,
} from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@/app/branches/pull-request-branch-relink", () => ({
  lockPullRequestActivityIdentityInTransaction: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/app/comments/service/github/relink-pull-request-comments", () => ({
  relinkPullRequestComments: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/app/branches/pull-request-provider-lock", () => ({
  acquirePullRequestProviderIdentityLockInTransaction: vi
    .fn()
    .mockResolvedValue(null),
}));
vi.mock("@/app/branches/pull-request-session-link-relink", () => ({
  relinkPullRequestSessionLinksInTransaction: vi.fn().mockResolvedValue(null),
}));

import {
  createModelDouble,
  type ModelDouble,
  type Row,
} from "@/__tests__/support/read-narrowing-projection.test-db";
import { mockWithDbAll } from "@/__tests__/utils/db-helpers";
import { consumeRefreshBudget } from "@/app/branches/branch-refresh-support";
import { reconcilePullRequestProviderIdentityInTransaction } from "@/app/branches/pull-request-provider-identity";
import {
  GitHubBackfillLane,
  getBackfillCandidates,
} from "@/app/integrations/github/backfill-candidates";
import {
  findBackfillBranch,
  findExistingPullRequestDetail,
  loadBackfillBranchesByName,
} from "@/app/integrations/github/backfill-projection-reads";
import { githubBackfillProjectionWriter } from "@/app/integrations/github/backfill-projection-writer";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const REPO_ID = "22222222-2222-4222-8222-222222222222";
const BRANCH_ARTIFACT_ID = "33333333-3333-4333-8333-333333333333";
const PR_ID = "44444444-4444-4444-8444-444444444444";
const DUPLICATE_PR_ID = "55555555-5555-4555-8555-555555555555";
const REPO_FULL_NAME = "acme/iss9190";
const BRANCH_NAME = "feat/iss9190";
const AT = new Date("2026-01-01T00:00:00.000Z");

/** Independently written, NOT re-derived from the constants under test. */
const CANDIDATE_COLUMNS = ["id", "fullName", "owner", "name"];
const BACKFILL_BRANCH_COLUMNS = [
  "artifactId",
  "branchName",
  "baseBranch",
  "baseBranchSource",
  "checksStatus",
  "currentPullRequestDetailId",
  "headSha",
  "lastActivityAt",
];
const BACKFILL_PULL_REQUEST_COLUMNS = [
  "id",
  "number",
  "branchArtifactId",
  "githubId",
  "title",
  "htmlUrl",
  "prState",
  "isDraft",
  "reviewDecision",
  "additions",
  "deletions",
  "changedFiles",
  "githubCreatedAt",
  "closedAt",
  "mergedAt",
  "mergeCommitSha",
];
const RATE_LIMIT_COLUMNS = ["id", "windowExpiresAt"];
const CONVERGENCE_REVIEW_COLUMNS = [
  "id",
  "githubReviewId",
  "authorLogin",
  "state",
  "body",
  "htmlUrl",
  "submittedAt",
];

/**
 * Every column the table carries, with a DISTINCT non-null value in each one a
 * narrowed read must not return. A `null` placeholder would serialize the same
 * whether the column was omitted or selected-and-empty, which is precisely how
 * a widened select survives a suite that looks green.
 */
function installationRepositoryRow(overrides: Row = {}): Row {
  return {
    id: REPO_ID,
    installationId: "install-1",
    githubRepoId: "gh-repo-1",
    fullName: REPO_FULL_NAME,
    name: "iss9190",
    owner: "acme",
    private: true,
    installation: {
      organizationId: ORG_ID,
      status: GitHubInstallationStatus.ACTIVE,
    },
    lastPushedAt: AT,
    defaultBranchName: "main",
    defaultBranchAvailability: "available",
    defaultBranchSource: "installation",
    defaultBranchObservedAt: AT,
    removedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

/** `artifact` is the joined row the read's org-scope filter matches against. */
function branchDetailRow(overrides: Row = {}): Row {
  return {
    artifactId: BRANCH_ARTIFACT_ID,
    artifact: { organizationId: ORG_ID },
    organizationId: ORG_ID,
    repositoryId: null,
    repositoryFullName: REPO_FULL_NAME,
    branchName: BRANCH_NAME,
    baseBranch: "main",
    baseBranchSource: BranchBaseBranchSource.PullRequestBase,
    headSha: "sha-branch",
    headShaSource: "webhook",
    headShaObservedAt: AT,
    lastActivityAt: AT,
    currentPullRequestDetailId: PR_ID,
    checksStatus: ChecksStatus.PASSING,
    checksDetailHeadSha: "sha-checks",
    fileCacheStatus: "fresh",
    fileCacheHeadSha: "sha-cache",
    syncStatus: "idle",
    lastSyncErrorMessage: "a stored sync error nobody on this path reads",
    fetchCredentialType: "user_oauth",
    fetchMechanism: "graphql",
    deletedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function pullRequestDetailRow(overrides: Row = {}): Row {
  return {
    id: PR_ID,
    artifactId: null,
    branchArtifactId: BRANCH_ARTIFACT_ID,
    branchArtifact: { organizationId: ORG_ID },
    organizationId: ORG_ID,
    repositoryId: null,
    repositoryFullName: REPO_FULL_NAME,
    githubId: "gh-pr-1",
    number: 7,
    title: "Add the thing",
    htmlUrl: "https://github.com/acme/iss9190/pull/7",
    body: "the @db.Text column this read used to drag per pull request",
    prState: GitHubPRState.Open,
    isDraft: false,
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    reviewDecision: ReviewDecision.APPROVED,
    isCurrent: true,
    githubCreatedAt: AT,
    githubUpdatedAt: AT,
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: "sha-merge",
    headRefOid: "sha-head",
    headRefName: BRANCH_NAME,
    baseRefName: "main",
    headRepositoryFullName: REPO_FULL_NAME,
    headRepositoryDefaultBranchName: "main",
    authorLogin: "octocat",
    lastVerifiedAt: AT,
    fetchCredentialType: "user_oauth",
    fetchMechanism: "graphql",
    desktopOriginated: false,
    provider: "github",
    providerDetail: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function rateLimitRow(overrides: Row = {}): Row {
  return {
    id: "rate-limit-1",
    bucket: "branch_refresh:actor",
    subject: `${ORG_ID}:session:user-1`,
    requestCount: 0,
    windowStartedAt: AT,
    windowExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    updatedAt: AT,
    ...overrides,
  };
}

/** `pullRequestDetail` is the joined row the read's org-scope filter matches. */
function reviewRow(overrides: Row = {}): Row {
  return {
    id: "review-1",
    pullRequestDetail: { organizationId: ORG_ID },
    pullRequestId: PR_ID,
    githubReviewId: "gh-review-1",
    authorLogin: "octocat",
    authorAvatarUrl: "https://avatars.example/octocat.png",
    state: ReviewDecision.APPROVED,
    body: "looks good",
    htmlUrl: "https://github.com/acme/iss9190/pull/7#r1",
    submittedAt: AT,
    fetchCredentialType: "user_oauth",
    fetchCredentialOwnerId: null,
    fetchMechanism: "graphql",
    fetchTrigger: "backfill",
    fetchObservedAt: AT,
    fetchResultReason: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function providerPullRequest(
  overrides: Partial<GitHubReadModelPullRequest> = {}
): GitHubReadModelPullRequest {
  return {
    githubId: "gh-pr-1",
    number: 7,
    title: "Add the thing",
    htmlUrl: "https://github.com/acme/iss9190/pull/7",
    headBranch: BRANCH_NAME,
    baseBranch: "main",
    headSha: "sha-branch",
    state: GitHubPRState.Open,
    isDraft: false,
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    checksStatus: null,
    statusCheckRollup: null,
    reviewDecision: ReviewDecision.APPROVED,
    openedAt: AT.toISOString(),
    updatedAt: AT.toISOString(),
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: "sha-merge",
    author: "octocat",
    source: GitHubReadModelSource.Provider,
    ...overrides,
  };
}

/** The doubles are the `db` argument these helpers already take. */
function asClient(models: Record<string, ModelDouble>): TransactionClient {
  return models as unknown as TransactionClient;
}

const APP_SCOPE = {
  organizationId: ORG_ID,
  repository: { id: REPO_ID, fullName: REPO_FULL_NAME },
};
const REPO_LESS_SCOPE = {
  organizationId: ORG_ID,
  repository: { id: null, fullName: REPO_FULL_NAME },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("post-connect backfill candidate read", () => {
  it("serves the candidate list without the default-branch authority columns", async () => {
    const gitHubInstallationRepository = createModelDouble([
      installationRepositoryRow(),
    ]);
    mockWithDbAll({ gitHubInstallationRepository });

    const candidates = await getBackfillCandidates(ORG_ID);

    expect(candidates).toEqual([
      {
        lane: GitHubBackfillLane.Installation,
        repositoryId: REPO_ID,
        fullName: REPO_FULL_NAME,
        owner: "acme",
        name: "iss9190",
      },
    ]);
    expect(gitHubInstallationRepository.returnedColumns).toEqual([
      CANDIDATE_COLUMNS,
    ]);
  });

  it("drops a tombstoned repository without widening the surviving read", async () => {
    // The live row is what makes this falsifiable: with only the tombstoned
    // one, the read returns nothing, `returnedColumns` is `[]` whatever the
    // query selected, and the column assertion could not fail.
    const gitHubInstallationRepository = createModelDouble([
      installationRepositoryRow({ id: "removed-repo", removedAt: AT }),
      installationRepositoryRow(),
    ]);
    mockWithDbAll({ gitHubInstallationRepository });

    const candidates = await getBackfillCandidates(ORG_ID);

    expect(candidates.map((candidate) => candidate.repositoryId)).toEqual([
      REPO_ID,
    ]);
    expect(gitHubInstallationRepository.returnedColumns).toEqual([
      CANDIDATE_COLUMNS,
    ]);
  });
});

describe("backfill branch reads — singular and batched", () => {
  it("returns the same eight columns through both shapes", async () => {
    const branchDetail = createModelDouble([branchDetailRow()]);
    const client = asClient({ branchDetail });

    const singular = await findBackfillBranch(
      client,
      REPO_LESS_SCOPE,
      BRANCH_NAME
    );
    const batched = await loadBackfillBranchesByName(client, REPO_LESS_SCOPE, [
      providerPullRequest(),
    ]);

    // The row itself, not the recorded argument: `lastSyncErrorMessage` and the
    // fetch-provenance columns are absent from what the consumer receives.
    expect(singular).toEqual({
      artifactId: BRANCH_ARTIFACT_ID,
      branchName: BRANCH_NAME,
      baseBranch: "main",
      baseBranchSource: BranchBaseBranchSource.PullRequestBase,
      checksStatus: ChecksStatus.PASSING,
      currentPullRequestDetailId: PR_ID,
      headSha: "sha-branch",
      lastActivityAt: AT,
    });
    // The pair agreement, stated as an assertion rather than as a claim: if one
    // read narrowed and the other did not, these two objects would differ.
    expect(batched.get(BRANCH_NAME)).toEqual(singular);
    expect(branchDetail.returnedColumns).toEqual([
      BACKFILL_BRANCH_COLUMNS,
      BACKFILL_BRANCH_COLUMNS,
    ]);
  });

  it("issues no branch read at all for an empty payload", async () => {
    const branchDetail = createModelDouble([branchDetailRow()]);

    expect(
      (
        await loadBackfillBranchesByName(
          asClient({ branchDetail }),
          REPO_LESS_SCOPE,
          []
        )
      ).size
    ).toBe(0);
    expect(branchDetail.findMany).not.toHaveBeenCalled();
  });
});

describe("backfill pull-request identity read — both arms of one signature", () => {
  it("returns the same sixteen columns on the App and repo-less arms", async () => {
    const appRow = pullRequestDetailRow({ repositoryId: REPO_ID });
    const app = createModelDouble([appRow]);
    const repoLess = createModelDouble([pullRequestDetailRow()]);
    const target = { number: 7, githubId: "gh-pr-1" };

    const viaUnique = await findExistingPullRequestDetail(
      asClient({ pullRequestDetail: app }),
      APP_SCOPE,
      target
    );
    const viaFirst = await findExistingPullRequestDetail(
      asClient({ pullRequestDetail: repoLess }),
      REPO_LESS_SCOPE,
      target
    );

    expect(app.findUnique).toHaveBeenCalledTimes(1);
    expect(repoLess.findFirst).toHaveBeenCalledTimes(1);
    // `body` is the one that matters most: a `@db.Text` column dragged behind
    // every pull request of a 500-item payload, inside the 30 s transaction.
    expect(viaUnique).not.toHaveProperty("body");
    expect(viaFirst).not.toHaveProperty("body");
    // Both arms return through ONE signature, so a caller cannot tell which ran
    // — which is exactly why they must not be able to differ.
    expect(Object.keys(viaFirst ?? {})).toEqual(Object.keys(viaUnique ?? {}));
    expect(app.returnedColumns).toEqual([BACKFILL_PULL_REQUEST_COLUMNS]);
    expect(repoLess.returnedColumns).toEqual([BACKFILL_PULL_REQUEST_COLUMNS]);
  });
});

describe("backfill dry run", () => {
  it("previews the write from the same pull-request columns the write reads", async () => {
    const branchDetail = createModelDouble([branchDetailRow()]);
    const pullRequestDetail = createModelDouble([pullRequestDetailRow()]);
    const branchActivityAtom = createModelDouble([]);
    mockWithDbAll({ branchDetail, pullRequestDetail, branchActivityAtom });

    const diff = await githubBackfillProjectionWriter.diff({
      organizationId: ORG_ID,
      repository: { id: null, fullName: REPO_FULL_NAME },
      pullRequests: [providerPullRequest()],
    });

    // The projection matched, so the dry run reached every comparison that
    // consumes these columns rather than skipping past them.
    expect(diff.skippedBranchCount).toBe(0);
    expect(pullRequestDetail.returnedColumns).toEqual([
      BACKFILL_PULL_REQUEST_COLUMNS,
    ]);
    expect(branchDetail.returnedColumns).toEqual([BACKFILL_BRANCH_COLUMNS]);
  });
});

describe("branch refresh budget", () => {
  it("decides the window from the id and expiry alone", async () => {
    const oAuthRateLimit = createModelDouble([
      rateLimitRow(),
      rateLimitRow({
        id: "rate-limit-2",
        bucket: "branch_refresh:org",
        subject: ORG_ID,
      }),
    ]);
    mockWithDbAll({ oAuthRateLimit });

    const result = await consumeRefreshBudget(
      ORG_ID,
      { authMethod: "session", userId: "user-1" },
      AT
    );

    expect(result).toEqual({ ok: true });
    // `requestCount` is compared inside the conditional `updateMany` predicate,
    // never against a snapshot a concurrent consumer could stale, so the read
    // has no reason to carry it.
    expect(oAuthRateLimit.returnedColumns).toEqual([
      RATE_LIMIT_COLUMNS,
      RATE_LIMIT_COLUMNS,
    ]);
  });
});

describe("pull-request provider-identity review convergence", () => {
  it("compares canonical and duplicate reviews over one identical column set", async () => {
    const gitHubPRReview = createModelDouble([
      reviewRow(),
      reviewRow({
        id: "review-2",
        pullRequestId: DUPLICATE_PR_ID,
        githubReviewId: "gh-review-2",
        authorLogin: "hubot",
      }),
    ]);
    const pullRequestDetail = createModelDouble([
      pullRequestDetailRow({ repositoryId: REPO_ID }),
      pullRequestDetailRow({ id: DUPLICATE_PR_ID, githubId: null }),
    ]);
    const client = asClient({
      gitHubPRReview,
      pullRequestDetail,
      branchDetail: createModelDouble([branchDetailRow()]),
      branchActivityAtom: createModelDouble([]),
    });

    await reconcilePullRequestProviderIdentityInTransaction(
      { ...client, $executeRaw: vi.fn() } as unknown as Parameters<
        typeof reconcilePullRequestProviderIdentityInTransaction
      >[0],
      {
        organizationId: ORG_ID,
        repositoryId: REPO_ID,
        repositoryFullName: REPO_FULL_NAME,
        githubId: "gh-pr-1",
        number: 7,
      }
    );

    // Two reads, one column set. These author logins do NOT match, so this
    // case takes the move branch and never reaches `sameReview` — all it
    // establishes is that both sides were read over the same columns. The
    // comparison itself is the next test.
    expect(gitHubPRReview.returnedColumns).toEqual([
      CONVERGENCE_REVIEW_COLUMNS,
      CONVERGENCE_REVIEW_COLUMNS,
    ]);
  });

  it("runs the field-for-field comparison over the narrowed columns", async () => {
    // Same author on both PRs — reachable, because the uniqueness constraint
    // on a review is `(pullRequestId, authorLogin)`, so one reviewer can hold
    // a review on each. That match is what routes the row into `sameReview`.
    const gitHubPRReview = createModelDouble([
      reviewRow(),
      reviewRow({
        id: "review-2",
        pullRequestId: DUPLICATE_PR_ID,
        githubReviewId: "gh-review-2",
      }),
    ]);
    const client = asClient({
      gitHubPRReview,
      pullRequestDetail: createModelDouble([
        pullRequestDetailRow({ repositoryId: REPO_ID }),
        pullRequestDetailRow({ id: DUPLICATE_PR_ID, githubId: null }),
      ]),
      branchDetail: createModelDouble([branchDetailRow()]),
      branchActivityAtom: createModelDouble([]),
    });

    await expect(
      reconcilePullRequestProviderIdentityInTransaction(
        { ...client, $executeRaw: vi.fn() } as unknown as Parameters<
          typeof reconcilePullRequestProviderIdentityInTransaction
        >[0],
        {
          organizationId: ORG_ID,
          repositoryId: REPO_ID,
          repositoryFullName: REPO_FULL_NAME,
          githubId: "gh-pr-1",
          number: 7,
        }
      )
      // Only `sameReview` raises this, and only after comparing all six of its
      // fields on rows the narrowed select produced. So the conflict IS the
      // evidence the comparison ran against the projected columns rather than
      // against whole rows: were a compared column missing from one side, the
      // two sides would read `undefined` on it and agree by accident.
    ).rejects.toThrow("pull request review convergence conflict");

    expect(gitHubPRReview.returnedColumns).toEqual([
      CONVERGENCE_REVIEW_COLUMNS,
      CONVERGENCE_REVIEW_COLUMNS,
    ]);
  });
});
