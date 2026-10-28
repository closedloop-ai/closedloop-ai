import {
  GitHubAccessDenialReason,
  GitHubBackfillStatus,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  GitHubProviderBudgetState,
} from "@repo/api/src/types/github-read-model";
import {
  GitHubCommentThreadKind,
  PullRequestCommentLane,
  PullRequestCommentLaneStatus,
} from "@repo/database/generated/enums";
import type * as GitHubModule from "@repo/github";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  backfillBundledPullRequests,
  backfillInstallationRepositories,
  backfillIssueComments,
  backfillProjectionDiff,
  backfillReviewComments,
  backfillReviews,
  backfillStatusCheckRollup,
  bundledPullRequest,
  makeCanonicalDetailRow,
} from "@/__tests__/support/integrations/github/backfill-service.test-fixtures";
import type { RenderedSqlStatement } from "@/__tests__/support/organizations/render-settings-sql";
import { renderedWhereClause } from "@/__tests__/support/organizations/render-settings-sql";

const getBranchesMock = vi.fn();
const getPullRequestsMock = vi.fn();
const artifactFindManyMock = vi.fn();
const findManyMock = vi.fn();
const organizationFindUniqueMock = vi.fn();
const organizationUpdateMock = vi.fn();
const executeRawMock = vi.fn();
const queryBundledPullRequestsMock = vi.fn();
const listIssueCommentsMock = vi.fn();
const listReviewCommentsMock = vi.fn();
const listReviewsMock = vi.fn();
const queryStatusCheckRollupMock = vi.fn();
const projectionDiffMock = vi.fn();
const projectionWriteMock = vi.fn();
const getGitHubSyncClientMock = vi.fn();
const recordRateLimitMock = vi.fn();
const recordRepoAccessMock = vi.fn();
// Marker object the mocked resolver mints; provider read functions must
// receive it as their first argument (PLN-1525: resolve once, thread down).
const installationOctokit = { kind: "installation-octokit" };
const NOT_PERSISTED_PATTERN = /not persisted/;

vi.mock("@repo/database", () => ({
  GitHubCommentThreadKind,
  PullRequestCommentLane,
  PullRequestCommentLaneStatus,

  ArtifactType: {
    BRANCH: "BRANCH",
  },
  GitHubInstallationStatus: {
    ACTIVE: "ACTIVE",
  },
  // ISS-7142: `$executeRaw` is deliberately ABSENT from the non-transactional
  // client and present only on `tx`. Every raw statement this service issues —
  // the run-gate advisory lock and all three settings writes — now runs inside
  // `withDb.tx`, and the settings writes' `> 1` refusal is a rollback only
  // because of that. The shared writer's not-found message is byte-identical to
  // the private one this service used to throw, so a message assertion cannot
  // tell the two apart; withholding `$executeRaw` here makes a revert to the
  // non-transactional path fail loudly instead.
  withDb: Object.assign(
    (callback: (db: unknown) => unknown) =>
      callback({
        gitHubInstallationRepository: {
          findMany: findManyMock,
        },
        artifact: {
          findMany: artifactFindManyMock,
        },
        organization: {
          findUnique: organizationFindUniqueMock,
        },
      }),
    {
      tx: (callback: (db: unknown) => unknown) =>
        callback({
          $executeRaw: executeRawMock,
          organization: {
            findUnique: organizationFindUniqueMock,
            update: organizationUpdateMock,
          },
        }),
    }
  ),
  // ISS-7142 routed this writer's statement through the shared settings writer,
  // which takes a `Prisma.Sql` rather than a bare tagged template. The stub
  // keeps the static segments and the interpolated values so the existing
  // statement assertions still see the same shape.
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: [...strings],
      text: strings.join("?"),
      values,
    }),
  },
}));

// The provider reads are stubbed, but the status contract and the failure
// classifier are the real ones: the summary's failure entries must carry the
// same statuses the bundled reads report.
vi.mock("@repo/github", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubModule>();
  return {
    GitHubProviderResultStatus: actual.GitHubProviderResultStatus,
    queryBundledPullRequestsWithProviderResult: queryBundledPullRequestsMock,
    queryStatusCheckRollupWithProviderResult: queryStatusCheckRollupMock,
  };
});

// ISS-7721 moved this sweep onto the sync pool. Tier 1 still resolves the org's
// covering installation first, so an App-installed org draws the same
// credential it always did — which is why every case below still receives the
// installation octokit marker.
// PLN-2122: the sweep reads complete comment and review lists.
vi.mock("@repo/github/pull-request-comment-lists", () => ({
  listAllPullRequestIssueComments: listIssueCommentsMock,
  listAllPullRequestReviewComments: listReviewCommentsMock,
  listAllPullRequestReviews: listReviewsMock,
}));

vi.mock("@/lib/github/github-sync-client-pool", () => ({
  getGitHubSyncClient: getGitHubSyncClientMock,
}));

vi.mock("./backfill-projection-writer", () => ({
  githubBackfillProjectionWriter: {
    diff: projectionDiffMock,
    write: projectionWriteMock,
  },
}));

vi.mock("./service", () => ({
  githubService: {
    getBranches: getBranchesMock,
    getPullRequests: getPullRequestsMock,
  },
}));

const {
  BACKFILL_RUN_GATE_SETTINGS_KEY,
  BACKFILL_SETTINGS_KEY,
  PULL_REQUEST_BACKFILL_MAX_ITEMS,
  PULL_REQUEST_BACKFILL_MAX_PAGES,
  PULL_REQUEST_METADATA_CONCURRENCY,
  PULL_REQUEST_METADATA_READS_PER_PULL_REQUEST,
  githubBackfillService,
} = await import("./backfill-service");
const { GitHubProviderResultStatus } = await import("@repo/github");

describe("githubBackfillService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGitHubSyncClientMock.mockResolvedValue({
      ok: true,
      value: {
        octokit: installationOctokit,
        kind: GitHubCredentialKind.Installation,
        actingAs: { installationId: "123" },
        credentialOwnerId: null,
        rateLimitTier: null,
        recordRateLimit: recordRateLimitMock,
        recordRepoAccess: recordRepoAccessMock,
      },
    });
    artifactFindManyMock.mockResolvedValue([]);
    findManyMock.mockResolvedValue(backfillInstallationRepositories());
    getBranchesMock.mockResolvedValue({ branches: [{ name: "main" }] });
    getPullRequestsMock.mockResolvedValue({
      pullRequests: [{ number: 1 }, { number: 2 }],
    });
    queryBundledPullRequestsMock.mockResolvedValue(
      backfillBundledPullRequests()
    );
    listIssueCommentsMock.mockResolvedValue(backfillIssueComments());
    listReviewCommentsMock.mockResolvedValue(backfillReviewComments());
    listReviewsMock.mockResolvedValue(backfillReviews());
    queryStatusCheckRollupMock.mockResolvedValue(backfillStatusCheckRollup());
    projectionDiffMock.mockResolvedValue(backfillProjectionDiff());
    projectionWriteMock.mockResolvedValue(backfillProjectionDiff());
    organizationFindUniqueMock.mockResolvedValue({
      settings: { unrelated: "keep" },
    });
    organizationUpdateMock.mockResolvedValue({});
    executeRawMock.mockResolvedValue(1);
  });

  it("returns shared-writer dry-run blast-radius counts without visible writes", async () => {
    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
      repositoryLimit: 1,
    });

    expect(summary).toEqual({
      status: GitHubBackfillStatus.OwnerApprovalRequired,
      repositoryCount: 1,
      branchCount: 1,
      pullRequestCount: 2,
      branchProjectionChangeCount: 1,
      pullRequestProjectionChangeCount: 1,
      lifecycleAtomProjectionChangeCount: 1,
      branchLastActivityProjectionChangeCount: 1,
      reviewDecisionProjectionChangeCount: 1,
      checkProjectionChangeCount: 1,
      issueCommentProjectionChangeCount: 1,
      reviewCommentProjectionChangeCount: 1,
      reviewThreadProjectionChangeCount: 1,
      reviewProjectionChangeCount: 1,
      statusCheckProjectionChangeCount: 1,
      skippedBranchCount: 0,
      dryRun: true,
      ownerApprovalRequired: true,
      failures: [],
    });
    expect(projectionDiffMock).toHaveBeenCalledTimes(1);
    expect(projectionWriteMock).not.toHaveBeenCalled();
    // One client minted for the repository sweep, threaded into the bundled
    // read and every per-PR metadata read (PLN-1525: resolve once, thread down).
    expect(getGitHubSyncClientMock).toHaveBeenCalledTimes(1);
    expect(getGitHubSyncClientMock).toHaveBeenCalledWith({
      organizationId: "org-1",
      target: { owner: "closedloop-ai", repo: "closedloop-ai" },
    });
    expect(queryBundledPullRequestsMock).toHaveBeenCalledWith(
      installationOctokit,
      "closedloop-ai",
      "closedloop-ai",
      [],
      {
        maxItems: undefined,
        maxPages: undefined,
        targetNumbers: [],
      },
      // PLN-1535 M0: backfill passes a read-cost observer (labeled backfill).
      expect.any(Function),
      expect.objectContaining({
        credentialType: GitHubFetchCredentialType.GitHubApp,
        mechanism: GitHubFetchMechanism.Graphql,
        observationKey: expect.any(String),
        trigger: GitHubFetchTrigger.Backfill,
      })
    );
    for (const lister of [
      listIssueCommentsMock,
      listReviewCommentsMock,
      listReviewsMock,
    ]) {
      expect(lister).toHaveBeenCalledWith(
        installationOctokit,
        "closedloop-ai",
        "closedloop-ai",
        1
      );
    }
    expect(queryStatusCheckRollupMock).toHaveBeenCalledWith(
      installationOctokit,
      "closedloop-ai",
      "closedloop-ai",
      "abc"
    );
    // ISS-7111: the summary lands as ONE atomic statement that patches only its
    // own key in the live column. The blob is never read into JS and written
    // back, so a concurrent write to a sibling key cannot be lost. What Postgres
    // actually does with the statement is proved in
    // `__tests__/integration/github-backfill-settings-race.integration.test.ts`;
    // a mock cannot execute `jsonb_set`.
    const summaryWrite = lastSettingsWrite(BACKFILL_SETTINGS_KEY);
    expect(summaryWrite?.text).toContain('UPDATE "organizations"');
    // The patch target is the LIVE column, not a fresh object: rewriting the
    // base as a bare `'{}'::jsonb` would wipe every sibling settings key.
    expect(summaryWrite?.text).toContain('COALESCE("settings"');
    expect(summaryWrite?.value).toMatchObject({
      repositoryCount: 1,
      dryRun: true,
    });
    // Scoped to ONE organization, asserted as predicate AND binding together,
    // as the WHOLE clause. ISS-7141 replaced a `sql).toContain('WHERE "id" = ')`
    // here: a substring check rejects a widening that REPLACES the equality
    // (`WHERE "id" IS NOT NULL`) but stays green under one that ADDS to it
    // (`… ::uuid OR TRUE`) — the dangerous form, which keeps the equality as a
    // prefix while rewriting every organization's row — and it never tied the
    // clause to the id actually bound into it.
    expect(renderedWhereClause(summaryWrite)).toBe('"id" = "org-1"::uuid');
    expect(summaryWrite?.organizationId).toBe("org-1");
    expect(
      lastSettingsWrite(BACKFILL_RUN_GATE_SETTINGS_KEY)?.organizationId
    ).toBe("org-1");
    // The read-modify-write this replaced would reappear as an `update` call.
    expect(organizationUpdateMock).not.toHaveBeenCalled();
    expect(organizationFindUniqueMock).toHaveBeenCalledTimes(1);
  });

  it("runs owner-approved input through visible projection writes", async () => {
    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
      repositoryLimit: 1,
      approvedForVisibleWrites: true,
    });

    expect(summary.status).toBe(GitHubBackfillStatus.Completed);
    expect(summary.dryRun).toBe(false);
    expect(summary.ownerApprovalRequired).toBe(false);
    expect(projectionWriteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        repository: expect.objectContaining({
          fullName: "closedloop-ai/closedloop-ai",
        }),
        pullRequestMetadata: [
          expect.objectContaining({
            number: 1,
            issueComments: expect.any(Array),
            issueCommentsComplete: true,
            reviewComments: expect.any(Array),
            reviewCommentsComplete: true,
            reviews: expect.any(Array),
            statusCheckRollup: expect.objectContaining({
              ok: true,
              totalCount: 1,
            }),
          }),
        ],
      })
    );
    expect(projectionDiffMock).not.toHaveBeenCalled();
    expect(lastSettingsWrite(BACKFILL_SETTINGS_KEY)?.value).toMatchObject({
      status: GitHubBackfillStatus.Completed,
      dryRun: false,
      ownerApprovalRequired: false,
    });
    // The run gate is written by its own atomic statement, never merged into
    // the summary's blob, so neither key can clobber the other.
    expect(
      lastSettingsWrite(BACKFILL_RUN_GATE_SETTINGS_KEY)?.value
    ).toMatchObject({
      inFlightUntil: 0,
    });
    expect(organizationUpdateMock).not.toHaveBeenCalled();
  });

  it("persists the summary before a failing run-gate release rejects the run", async () => {
    // The release runs in a `finally`, so its throw replaces the run's return
    // value. The summary must already be durable by then — otherwise a caller
    // that sees the rejection would also have lost the completed run's result.
    // Keyed off the statement rather than a call index, so the advisory-lock
    // SELECTs that share this mock cannot shift which write reports zero rows.
    let settingsWriteCount = 0;
    executeRawMock.mockImplementation((...call: unknown[]) => {
      if (
        !normalizeExecuteRawCall(call).strings.join("?").includes("jsonb_set")
      ) {
        return Promise.resolve(1);
      }
      settingsWriteCount += 1;
      // Third settings write: claim, then summary persist, then release.
      return Promise.resolve(settingsWriteCount === 3 ? 0 : 1);
    });

    await expect(
      githubBackfillService.runPostConnectBackfill({
        organizationId: "org-1",
        repositoryLimit: 1,
        approvedForVisibleWrites: true,
      })
    ).rejects.toThrow(NOT_PERSISTED_PATTERN);

    // Committed by its own statement before the release was even attempted.
    expect(lastSettingsWrite(BACKFILL_SETTINGS_KEY)?.value).toMatchObject({
      status: GitHubBackfillStatus.Completed,
    });
  });

  // ISS-8522: the sweep targets each branch's DERIVED canonical PR. The pointer
  // read it replaced named PR 900 here — a merged sibling the branch had already
  // moved off — so the self-heal fetched a dead PR and never touched the live one.
  it("pages bundled PR backfill for existing branch canonical PR targets", async () => {
    artifactFindManyMock.mockResolvedValue([
      {
        id: "branch-1",
        branch: {
          currentPullRequestDetailId: "pr-merged",
          repositoryId: "repo-1",
          repositoryFullName: "closedloop-ai/closedloop-ai",
          repository: { fullName: "closedloop-ai/closedloop-ai" },
        },
        pullRequestDetails: [
          makeCanonicalDetailRow({
            id: "pr-merged",
            number: 900,
            htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/900",
            prState: "MERGED",
            mergedAt: new Date("2026-07-01T00:00:00.000Z"),
          }),
          makeCanonicalDetailRow({
            id: "pr-live",
            number: 150,
            htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/150",
          }),
        ],
      },
    ]);

    await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
      repositoryLimit: 1,
    });

    expect(queryBundledPullRequestsMock).toHaveBeenCalledWith(
      installationOctokit,
      "closedloop-ai",
      "closedloop-ai",
      [150],
      {
        // ISS-7891: the constants, not literals — the page budget has to move
        // with the shared default page size for the item budget to be reachable.
        maxItems: PULL_REQUEST_BACKFILL_MAX_ITEMS,
        maxPages: PULL_REQUEST_BACKFILL_MAX_PAGES,
        targetNumbers: [150],
      },
      expect.any(Function),
      expect.objectContaining({
        credentialType: GitHubFetchCredentialType.GitHubApp,
        mechanism: GitHubFetchMechanism.Graphql,
        observationKey: expect.any(String),
        trigger: GitHubFetchTrigger.Backfill,
      })
    );
  });

  // PR #6453 review. The branch query is repository-scoped but the candidate
  // list was not, and the canonical population keys on `branchArtifactId`
  // alone — so a LIVE PR row belonging to another repository outranked this
  // branch's own terminal PR, `extractTrackedPullRequestNumbers` then dropped
  // that foreign URL, and the sweep silently self-healed nothing.
  it("scopes canonical PR candidates to the swept repository", async () => {
    const ownRow = makeCanonicalDetailRow({
      id: "pr-merged",
      number: 900,
      htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/900",
      prState: "MERGED",
      mergedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    const foreignRow = makeCanonicalDetailRow({
      id: "pr-foreign",
      number: 777,
      htmlUrl: "https://github.com/stranger/other-repo/pull/777",
      repositoryId: "repo-foreign",
      repositoryFullName: "stranger/other-repo",
      repository: { fullName: "stranger/other-repo" },
    });
    // Honors the nested relation filter the production query passes, so a
    // dropped `where` really does widen the candidate list here.
    artifactFindManyMock.mockImplementation(
      (query: {
        select?: {
          pullRequestDetails?: { where?: { repositoryId?: string | null } };
        };
      }) => {
        const scope = query.select?.pullRequestDetails?.where;
        const rows = [ownRow, foreignRow].filter((row) =>
          scope?.repositoryId === undefined
            ? true
            : row.repositoryId === scope.repositoryId
        );
        return Promise.resolve([
          {
            id: "branch-1",
            branch: {
              currentPullRequestDetailId: "pr-merged",
              repositoryId: "repo-1",
              repositoryFullName: "closedloop-ai/closedloop-ai",
              repository: { fullName: "closedloop-ai/closedloop-ai" },
            },
            pullRequestDetails: rows,
          },
        ]);
      }
    );

    await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
      repositoryLimit: 1,
    });

    // The branch's OWN merged PR is the target. Unscoped, the live foreign row
    // wins the arbitration and the extractor filters its URL back out, leaving
    // an empty target list — the under-read this scoping exists to stop.
    expect(queryBundledPullRequestsMock).toHaveBeenCalledWith(
      installationOctokit,
      "closedloop-ai",
      "closedloop-ai",
      [900],
      expect.objectContaining({ targetNumbers: [900] }),
      expect.any(Function),
      expect.anything()
    );
  });

  it("marks nested PR comment metadata incomplete when a list stops at its page ceiling", async () => {
    listIssueCommentsMock.mockResolvedValue({
      status: "success",
      value: {
        complete: false,
        items: Array.from({ length: 25 }, (_, index) => ({
          id: 10_000 + index,
          node_id: `issue-node-${index}`,
          user: {
            id: 501,
            login: "octocat",
            node_id: "user-node-501",
            avatar_url: "https://avatars.githubusercontent.com/u/501",
          },
          body: "Issue comment",
          author_association: "MEMBER",
          created_at: "2026-07-05T00:00:00.000Z",
          updated_at: "2026-07-05T00:01:00.000Z",
          html_url: `https://github.com/closedloop-ai/closedloop-ai/pull/1#issuecomment-${index}`,
          deleted_at: null,
          is_deleted: false,
          is_updated: true,
        })),
      },
    });
    listReviewCommentsMock.mockResolvedValue({
      status: "success",
      value: {
        complete: false,
        items: Array.from({ length: 25 }, (_, index) => ({
          id: 20_000 + index,
          node_id: `review-node-${index}`,
          path: "app.ts",
          line: 10,
          side: "RIGHT",
          start_line: null,
          start_side: null,
          original_line: 10,
          original_start_line: null,
          body: "Review comment",
          user: {
            id: 502,
            login: "reviewer",
            node_id: "user-node-502",
            avatar_url: "https://avatars.githubusercontent.com/u/502",
          },
          author_association: "MEMBER",
          created_at: "2026-07-05T00:02:00.000Z",
          updated_at: "2026-07-05T00:03:00.000Z",
          html_url: `https://github.com/closedloop-ai/closedloop-ai/pull/1#discussion_r${index}`,
          commit_id: "abc",
          pull_request_review_id: 3001,
          review_thread_node_id: `thread-node-${index}`,
          review_thread_is_resolved: false,
          in_reply_to_id: null,
          deleted_at: null,
          is_deleted: false,
          is_updated: true,
        })),
      },
    });

    await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
      repositoryLimit: 1,
    });

    expect(projectionDiffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pullRequestMetadata: [
          expect.objectContaining({
            issueCommentsComplete: false,
            reviewCommentsComplete: false,
          }),
        ],
      })
    );
  });

  it("returns the latest summary without provider fan-out while a durable run gate is active", async () => {
    organizationFindUniqueMock.mockResolvedValueOnce({
      settings: {
        [BACKFILL_RUN_GATE_SETTINGS_KEY]: {
          inFlightUntil: Date.now() + 60_000,
          cooldownUntil: 0,
        },
        [BACKFILL_SETTINGS_KEY]: {
          status: GitHubBackfillStatus.Degraded,
          repositoryCount: 1,
          branchCount: 2,
          pullRequestCount: 3,
          branchProjectionChangeCount: 4,
          pullRequestProjectionChangeCount: 5,
          reviewDecisionProjectionChangeCount: 6,
          checkProjectionChangeCount: 7,
          issueCommentProjectionChangeCount: 8,
          reviewCommentProjectionChangeCount: 9,
          reviewThreadProjectionChangeCount: 10,
          reviewProjectionChangeCount: 11,
          statusCheckProjectionChangeCount: 12,
          skippedBranchCount: 13,
          dryRun: false,
          ownerApprovalRequired: false,
          failures: ["repo:provider_rate_limit"],
        },
      },
    });

    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
      approvedForVisibleWrites: true,
    });

    expect(summary.status).toBe(GitHubBackfillStatus.Degraded);
    expect(summary.failures).toEqual(["repo:provider_rate_limit"]);
    expect(findManyMock).not.toHaveBeenCalled();
    expect(getBranchesMock).not.toHaveBeenCalled();
    expect(getGitHubSyncClientMock).not.toHaveBeenCalled();
    expect(queryBundledPullRequestsMock).not.toHaveBeenCalled();
    expect(projectionWriteMock).not.toHaveBeenCalled();
    // A blocked claim writes nothing at all — neither the atomic statement nor
    // the read-modify-write it replaced.
    expect(settingsWrites()).toHaveLength(0);
    expect(organizationUpdateMock).not.toHaveBeenCalled();
  });

  it("bypasses only cooldown for trusted post-connect continuations", async () => {
    const latestSummary = {
      status: GitHubBackfillStatus.OwnerApprovalRequired,
      repositoryCount: 1,
      branchCount: 2,
      pullRequestCount: 3,
      branchProjectionChangeCount: 4,
      pullRequestProjectionChangeCount: 5,
      reviewDecisionProjectionChangeCount: 6,
      checkProjectionChangeCount: 7,
      issueCommentProjectionChangeCount: 8,
      reviewCommentProjectionChangeCount: 9,
      reviewThreadProjectionChangeCount: 10,
      reviewProjectionChangeCount: 11,
      statusCheckProjectionChangeCount: 12,
      skippedBranchCount: 13,
      dryRun: false,
      ownerApprovalRequired: false,
      failures: [],
    };
    organizationFindUniqueMock.mockResolvedValueOnce({
      settings: {
        [BACKFILL_RUN_GATE_SETTINGS_KEY]: {
          inFlightUntil: 0,
          cooldownUntil: Date.now() + 60_000,
        },
        [BACKFILL_SETTINGS_KEY]: latestSummary,
      },
    });

    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
      approvedForVisibleWrites: true,
      bypassCooldown: true,
    });

    expect(summary.status).toBe(GitHubBackfillStatus.Completed);
    expect(findManyMock).toHaveBeenCalled();
    expect(projectionWriteMock).toHaveBeenCalled();
  });

  it("still blocks trusted continuations while another backfill is in flight", async () => {
    const latestSummary = {
      status: GitHubBackfillStatus.OwnerApprovalRequired,
      repositoryCount: 1,
      branchCount: 2,
      pullRequestCount: 3,
      branchProjectionChangeCount: 4,
      pullRequestProjectionChangeCount: 5,
      reviewDecisionProjectionChangeCount: 6,
      checkProjectionChangeCount: 7,
      issueCommentProjectionChangeCount: 8,
      reviewCommentProjectionChangeCount: 9,
      reviewThreadProjectionChangeCount: 10,
      reviewProjectionChangeCount: 11,
      statusCheckProjectionChangeCount: 12,
      skippedBranchCount: 13,
      dryRun: false,
      ownerApprovalRequired: false,
      failures: [],
    };
    organizationFindUniqueMock.mockResolvedValueOnce({
      settings: {
        [BACKFILL_RUN_GATE_SETTINGS_KEY]: {
          inFlightUntil: Date.now() + 60_000,
          cooldownUntil: 0,
        },
        [BACKFILL_SETTINGS_KEY]: latestSummary,
      },
    });

    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
      approvedForVisibleWrites: true,
      bypassCooldown: true,
    });

    expect(summary.status).toBe(GitHubBackfillStatus.OwnerApprovalRequired);
    expect(findManyMock).not.toHaveBeenCalled();
    expect(projectionWriteMock).not.toHaveBeenCalled();
  });

  it("marks failed comment metadata pages incomplete before invoking the writer", async () => {
    listIssueCommentsMock.mockResolvedValueOnce({
      status: "provider_unavailable",
    });
    listReviewCommentsMock.mockResolvedValueOnce({
      status: "provider_rate_limit",
    });

    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
      repositoryLimit: 1,
      approvedForVisibleWrites: true,
    });

    expect(summary.status).toBe(GitHubBackfillStatus.Degraded);
    expect(summary.failures).toEqual([
      "closedloop-ai/closedloop-ai#1:issueComments:provider_unavailable",
      "closedloop-ai/closedloop-ai#1:reviewComments:provider_rate_limit",
    ]);
    expect(projectionWriteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pullRequestMetadata: [
          expect.objectContaining({
            issueComments: [],
            issueCommentsComplete: false,
            reviewComments: [],
            reviewCommentsComplete: false,
          }),
        ],
      })
    );
  });

  it("keeps projecting a repository whose summary counts could not be read", async () => {
    getBranchesMock
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce({ branches: [{ name: "main" }] });

    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
    });

    expect(summary.status).toBe(GitHubBackfillStatus.Degraded);
    // Named, not the bare repository name the generic catch produces: the
    // counts are summary decoration, and a reader has to be able to tell a
    // short count from a repository that failed outright.
    expect(summary.failures).toEqual([
      "closedloop-ai/closedloop-ai:list_counts_unavailable",
    ]);
    expect(summary.repositoryCount).toBe(2);
    // Only the second repository contributed a count; the first reports 0
    // alongside its failure entry rather than a measured zero.
    expect(summary.branchCount).toBe(1);
    // #6038 review: the bundled read for that repository SUCCEEDED, so its
    // projection still runs. Letting the count failure reject the pair would
    // discard a good fetch and leave the repository stale — the staleness this
    // lane exists to remove. Both repositories reach the writer.
    expect(projectionDiffMock).toHaveBeenCalledTimes(2);
    // One credential draw per repository in the loop, even when a repository
    // fails.
    expect(getGitHubSyncClientMock).toHaveBeenCalledTimes(2);
    expect(getGitHubSyncClientMock).toHaveBeenCalledWith({
      organizationId: "org-1",
      target: { owner: "closedloop-ai", repo: "closedloop-ai" },
    });
  });

  it("reports the coverage the bounded search did not reach", async () => {
    queryBundledPullRequestsMock.mockResolvedValue({
      ...backfillBundledPullRequests(),
      value: {
        ...backfillBundledPullRequests().value,
        truncated: true,
        missingTargetNumbers: [41, 42],
      },
    });

    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
      repositoryLimit: 1,
      approvedForVisibleWrites: true,
    });

    // Without these the run reports `completed` while specific tracked PRs got
    // no deeper read at all — a status that reads as full coverage.
    expect(summary.failures).toEqual([
      "closedloop-ai/closedloop-ai:target_search_truncated",
      "closedloop-ai/closedloop-ai:targets_missing:2",
    ]);
    expect(summary.status).toBe(GitHubBackfillStatus.Degraded);
  });

  it("reports a fully-covered sweep as completed", async () => {
    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
      repositoryLimit: 1,
      approvedForVisibleWrites: true,
    });

    // The counterfactual for the case above: absent truncation and absent
    // missing targets must NOT degrade an otherwise clean run.
    expect(summary.failures).toEqual([]);
    expect(summary.status).toBe(GitHubBackfillStatus.Completed);
  });

  it("records the denial reason when the credential draw is refused", async () => {
    getGitHubSyncClientMock.mockResolvedValueOnce({
      ok: false,
      error: { reason: GitHubAccessDenialReason.RateLimited },
    });

    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
    });

    expect(summary.status).toBe(GitHubBackfillStatus.Degraded);
    expect(summary.failures).toEqual([
      `closedloop-ai/closedloop-ai:${GitHubAccessDenialReason.RateLimited}`,
    ]);
    expect(summary.repositoryCount).toBe(2);
    // The sweep continues: only the second repository reaches the reads.
    expect(summary.branchCount).toBe(1);
    expect(queryBundledPullRequestsMock).toHaveBeenCalledTimes(1);
    expect(queryBundledPullRequestsMock).toHaveBeenCalledWith(
      installationOctokit,
      "closedloop-ai",
      "other",
      [],
      { maxItems: undefined, maxPages: undefined, targetNumbers: [] },
      expect.any(Function),
      expect.objectContaining({
        credentialType: GitHubFetchCredentialType.GitHubApp,
        mechanism: GitHubFetchMechanism.Graphql,
        observationKey: expect.any(String),
        trigger: GitHubFetchTrigger.Backfill,
      })
    );
  });

  it("reads per-PR metadata concurrently rather than one PR at a time", async () => {
    queryBundledPullRequestsMock.mockResolvedValue({
      status: "success",
      value: {
        pullRequests: Array.from({ length: 12 }, (_, index) =>
          bundledPullRequest(index + 1)
        ),
        rateLimit: {
          cost: 1,
          remaining: 1000,
          resetAt: null,
          state: GitHubProviderBudgetState.Available,
        },
      },
    });

    // Counted across EVERY provider read, not just one of them (#5689 review).
    // Tracking a single mock measures task concurrency and would report 5 while
    // the process actually has 20 calls in flight — a bound that reads as
    // rate-limit protection without being it.
    let inFlight = 0;
    let peakInFlight = 0;
    const trackConcurrency = (result: unknown) => async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      // Yield so sibling reads the limiter has already started can be observed
      // in flight alongside this one.
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return result;
    };
    const emptyList = {
      status: GitHubProviderResultStatus.Success,
      value: { items: [], complete: true },
    };
    listIssueCommentsMock.mockImplementation(trackConcurrency(emptyList));
    listReviewCommentsMock.mockImplementation(trackConcurrency(emptyList));
    listReviewsMock.mockImplementation(trackConcurrency(emptyList));
    queryStatusCheckRollupMock.mockImplementation(
      trackConcurrency({
        status: GitHubProviderResultStatus.Success,
        value: null,
      })
    );

    await githubBackfillService.runPostConnectBackfill({
      organizationId: "org-1",
      repositoryLimit: 1,
    });

    // ISS-7408: the serial `for` this replaced pinned the peak at one PR's worth
    // of reads and paid one round trip per PR, which is where the 90s-180s came
    // from.
    expect(peakInFlight).toBeGreaterThan(
      PULL_REQUEST_METADATA_READS_PER_PULL_REQUEST
    );
    // The real ceiling: tasks x reads-per-task. Bounded, and bounded at the
    // number the constant's docstring actually claims.
    expect(peakInFlight).toBeLessThanOrEqual(
      PULL_REQUEST_METADATA_CONCURRENCY *
        PULL_REQUEST_METADATA_READS_PER_PULL_REQUEST
    );
    expect(listIssueCommentsMock).toHaveBeenCalledTimes(12);
  });
});

/**
 * A captured settings write, carrying the shape
 * `@/__tests__/support/organizations/render-settings-sql` renders (ISS-7148)
 * plus the decoded bindings this suite asserts on directly.
 */
type SettingsWriteStatement = RenderedSqlStatement & {
  key: string;
  value: unknown;
  /**
   * The bound organization the write is scoped to. Captured because the SQL
   * text alone cannot show it: widening the `WHERE "id" = …::uuid` predicate to
   * one that matches every row would leave the statement text and the other
   * value bindings intact, and rewrite the settings of every organization.
   */
  organizationId: string;
};

/**
 * ISS-7111: the settings writes issued through `$executeRaw`, which the
 * advisory-lock SELECT also shares. Keyed off `jsonb_set` so a regression that
 * reverts one of them to a read-modify-write drops out of this list rather than
 * silently satisfying an assertion about a different write.
 */
function settingsWrites(): SettingsWriteStatement[] {
  const statements: SettingsWriteStatement[] = [];
  for (const call of executeRawMock.mock.calls) {
    const { strings: segments, values } = normalizeExecuteRawCall(call);
    const text = segments.join("?");
    if (!text.includes("jsonb_set")) {
      continue;
    }
    statements.push({
      // The tag's own segments, so the renderer never has to re-split `text` on
      // `?` and cannot be thrown off by a jsonb key-exists operator in the SQL.
      strings: segments,
      text,
      values,
      key: String(values[0]),
      value: JSON.parse(String(values[1])),
      // Read from the END, not a fixed index. The predicate's binding is always
      // the statement's last, whereas its ordinal is not: ISS-7157 added a
      // bound `updated_at` between the patched value and the predicate, which
      // silently shifted a `values[2]` read onto the timestamp.
      organizationId: String(values.at(-1)),
    });
  }
  return statements;
}

function lastSettingsWrite(key: string): SettingsWriteStatement | undefined {
  return settingsWrites()
    .filter((statement) => statement.key === key)
    .at(-1);
}

/**
 * `$executeRaw` is reached two ways in this service and both share one mock.
 * The advisory-lock SELECT still uses the tagged-template call form
 * (`strings, ...values`); ISS-7142 routed the settings writes through the
 * shared writer, which passes a single pre-built `Prisma.Sql`. Normalizing both
 * to segments-plus-values keeps every assertion here reading one shape.
 */
function normalizeExecuteRawCall(call: unknown[]): {
  strings: string[];
  values: unknown[];
} {
  const [first, ...rest] = call;
  const prebuilt = first as { strings?: unknown; values?: unknown } | undefined;
  if (Array.isArray(prebuilt?.strings) && Array.isArray(prebuilt?.values)) {
    return {
      strings: prebuilt.strings.map(String),
      values: prebuilt.values,
    };
  }
  return {
    strings: Array.from(first as ArrayLike<string>).map(String),
    values: rest,
  };
}

/** One owned PR row in the shape the branch-canonical arbitration reads. */
