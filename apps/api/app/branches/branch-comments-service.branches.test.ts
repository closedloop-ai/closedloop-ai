import {
  BranchCommentsFailureReason,
  BranchCommentsState,
  BranchPrCommentKind,
} from "@repo/api/src/types/branch";
import { CommentSyncStatus } from "@repo/api/src/types/comment-thread-dto";
import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { GitHubCommentThreadKind, ThreadStatus } from "@repo/database";
import { GitHubProviderResultStatus } from "@repo/github";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRANCH_ID,
  branchContextRow,
  projectionRow,
  pullRequestDetailFixture,
  reconcileMarker,
  reconcileResult,
  repositoryFixture,
  unsyncedMarker,
} from "@/__tests__/support/branches/branch-comments-service.test-helpers";
import { GitHubCommentReconcileStatus } from "../comments/service/github/github-comment-reconcile";

const mocks = vi.hoisted(() => ({
  artifactFindFirst: vi.fn(),
  commentFindMany: vi.fn(),
  repositoryFindFirst: vi.fn(),
  queryRaw: vi.fn(),
  readMarker: vi.fn(),
  reconcileOnView: vi.fn(),
  poolIsEmpty: vi.fn(),
  withDb: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: mocks.withDb,
}));

vi.mock(
  "@/app/comments/service/github/github-comment-reconcile-marker",
  () => ({ readPullRequestCommentsReconcileMarker: mocks.readMarker })
);

vi.mock(
  "@/app/comments/service/github/github-comment-on-demand-reconcile",
  () => ({ reconcilePullRequestCommentsOnView: mocks.reconcileOnView })
);

vi.mock("@/lib/github/github-sync-credential-probe", () => ({
  gitHubSyncPoolIsEmpty: mocks.poolIsEmpty,
}));

import { findBranchCommentsContext } from "./branch-comments-context";
import { branchCommentsService } from "./branch-comments-service";

describe("branchCommentsService branch coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback(fakeDb())
    );
    mocks.artifactFindFirst.mockResolvedValue(branchContextRow());
    mocks.commentFindMany.mockResolvedValue([]);
    mocks.queryRaw.mockResolvedValue([{ id: BRANCH_ID }]);
    mocks.readMarker.mockResolvedValue(reconcileMarker());
    mocks.reconcileOnView.mockResolvedValue(reconcileResult());
    mocks.poolIsEmpty.mockResolvedValue(false);
  });

  it("returns null without touching the database for a non-UUID branch id", async () => {
    const result = await branchCommentsService.getBranchComments(
      "org-1",
      "not-a-uuid"
    );

    expect(result).toBeNull();
    expect(mocks.withDb).not.toHaveBeenCalled();
  });

  it("falls back to the branch's literal repository full name when neither the selected PR nor the branch relation names one", async () => {
    mocks.artifactFindFirst.mockResolvedValue(
      branchContextRow({
        pullRequestDetails: [],
        branchRepository: null,
        branchRepositoryFullName: "closedloop-ai/fallback-repo",
      })
    );
    mocks.repositoryFindFirst.mockResolvedValue(
      repositoryFixture({ fullName: "closedloop-ai/fallback-repo" })
    );

    const result = await getComments();

    expect(result).toMatchObject({
      state: BranchCommentsState.UnsyncedUnknown,
      repositoryFullName: "closedloop-ai/fallback-repo",
      prNumber: null,
    });
    expect(mocks.repositoryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          fullName: {
            equals: "closedloop-ai/fallback-repo",
            mode: "insensitive",
          },
        }),
      })
    );
  });

  it("returns null when the branch has no repository identity from the selection, the branch relation, or the branch literal", async () => {
    mocks.artifactFindFirst.mockResolvedValue(
      branchContextRow({
        pullRequestDetails: [],
        branchRepository: null,
        branchRepositoryFullName: null,
      })
    );

    const result = await getComments();

    expect(result).toBeNull();
    // The blank repository name short-circuits before ever querying for an
    // exact-match installation repository.
    expect(mocks.repositoryFindFirst).not.toHaveBeenCalled();
    expect(mocks.commentFindMany).not.toHaveBeenCalled();
  });

  it("treats a projected comment with no GitHub thread projection as fresh, not stale", async () => {
    mocks.commentFindMany.mockResolvedValue([
      projectionRow({ threadGithubProjection: null }),
    ]);

    const result = await getComments();

    expect(result).toMatchObject({
      state: BranchCommentsState.Populated,
      mixedProjection: false,
    });
    expect(result?.comments[0]?.stale).toBe(false);
    expect(result?.comments[0]?.path).toBeNull();
    expect(result?.comments[0]?.line).toBeNull();
  });

  describe("a repository no installation lists (Kerensa, 2026-10-05)", () => {
    beforeEach(() => {
      mocks.artifactFindFirst.mockResolvedValue(installationlessBranchRow());
      mocks.repositoryFindFirst.mockResolvedValue(null);
    });

    it("resolves owner and repo from the repository full name", async () => {
      const context = await findBranchCommentsContext(
        fakeDb(),
        "org-1",
        BRANCH_ID,
        undefined
      );

      expect(context).toEqual({
        branchId: BRANCH_ID,
        repositoryFullName: "dev/local-repo",
        prNumber: 42,
        prUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
        owner: "dev",
        repo: "local-repo",
        pullRequestDetailId: "pr-detail-1",
      });
    });

    it("returns null when the repository full name is not owner/name", async () => {
      mocks.artifactFindFirst.mockResolvedValue(
        installationlessBranchRow("dev/local-repo/extra")
      );

      const result = await getComments();

      expect(result).toBeNull();
      expect(mocks.readMarker).not.toHaveBeenCalled();
    });

    it("reconciles on first view and serves the stored rows", async () => {
      mocks.readMarker
        .mockResolvedValueOnce(unsyncedMarker())
        .mockResolvedValueOnce(reconcileMarker());
      mocks.commentFindMany.mockResolvedValue([projectionRow()]);

      const result = await getComments();

      expect(mocks.reconcileOnView).toHaveBeenCalledWith("pr-detail-1");
      expect(result).toMatchObject({
        state: BranchCommentsState.Populated,
        repositoryFullName: "dev/local-repo",
        prNumber: 42,
        stale: false,
      });
      expect(result?.comments).toHaveLength(1);
    });

    it("serves UnsyncedUnknown when the first view's reconcile finds no credential to draw", async () => {
      mocks.poolIsEmpty.mockResolvedValue(true);
      mocks.readMarker
        .mockResolvedValueOnce(unsyncedMarker())
        .mockResolvedValueOnce(unsyncedMarker({ latestAttemptFailed: true }));
      mocks.reconcileOnView.mockResolvedValue(
        reconcileResult(
          GitHubCommentReconcileStatus.ProviderError,
          GitHubAccessDenialReason.NotConnected
        )
      );

      const result = await getComments();

      expect(result).toMatchObject({
        state: BranchCommentsState.UnsyncedUnknown,
        providerProofedAt: null,
        stale: false,
        comments: [],
      });
      expect(result).not.toHaveProperty("failureReason");
      expect(mocks.poolIsEmpty).toHaveBeenCalledWith({
        organizationId: "org-1",
        target: { owner: "dev", repo: "local-repo" },
      });
    });

    it("keeps UnsyncedUnknown on a later view after the failed attempt was stamped", async () => {
      mocks.poolIsEmpty.mockResolvedValue(true);
      mocks.readMarker.mockResolvedValue(
        unsyncedMarker({ latestAttemptFailed: true, attemptDue: false })
      );

      const result = await getComments();

      expect(mocks.reconcileOnView).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        state: BranchCommentsState.UnsyncedUnknown,
        stale: false,
      });
      expect(result).not.toHaveProperty("failureReason");
    });

    it("keeps the generic ProviderError on a later view while the org has a credential to draw", async () => {
      mocks.readMarker.mockResolvedValue(
        unsyncedMarker({ latestAttemptFailed: true, attemptDue: false })
      );

      const result = await getComments();

      expect(result).toMatchObject({
        state: BranchCommentsState.ProviderError,
        failureReason: BranchCommentsFailureReason.ProviderError,
      });
    });
  });

  it("returns an unsynced envelope without a reconcile when the pull request has no reconcile marker", async () => {
    mocks.readMarker.mockResolvedValue(null);

    const result = await getComments();

    expect(result?.state).toBe(BranchCommentsState.UnsyncedUnknown);
    expect(mocks.reconcileOnView).not.toHaveBeenCalled();
  });

  describe("first-view reconcile outcomes (PLN-2122 decisions 5 and 9)", () => {
    it("serves UnsyncedUnknown when another run holds the lease and nothing is stored", async () => {
      mocks.readMarker.mockResolvedValue(unsyncedMarker());
      mocks.reconcileOnView.mockResolvedValue(
        reconcileResult(GitHubCommentReconcileStatus.Claimed)
      );

      const result = await getComments();

      expect(result).toMatchObject({
        state: BranchCommentsState.UnsyncedUnknown,
        providerProofedAt: null,
      });
      expect(result).not.toHaveProperty("failureReason");
    });

    it("does not reconcile a pull request whose last attempt is within the freshness floor", async () => {
      mocks.readMarker.mockResolvedValue(
        unsyncedMarker({ latestAttemptFailed: true, attemptDue: false })
      );
      mocks.commentFindMany.mockResolvedValue([projectionRow()]);

      const result = await getComments();

      expect(mocks.reconcileOnView).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        state: BranchCommentsState.StaleMixed,
        stale: true,
      });
    });

    it("serves the stored rows when the reconcile is still running at its budget", async () => {
      mocks.readMarker.mockResolvedValue(unsyncedMarker());
      mocks.reconcileOnView.mockResolvedValue(null);
      mocks.commentFindMany.mockResolvedValue([projectionRow()]);

      const result = await getComments();

      expect(result).toMatchObject({
        state: BranchCommentsState.Populated,
        stale: false,
      });
      expect(result?.comments).toHaveLength(1);
    });

    it("serves stored rows as stale, not ProviderError, when a failed reconcile left rows", async () => {
      mocks.readMarker
        .mockResolvedValueOnce(unsyncedMarker())
        .mockResolvedValueOnce(unsyncedMarker({ latestAttemptFailed: true }));
      mocks.reconcileOnView.mockResolvedValue(
        reconcileResult(
          GitHubCommentReconcileStatus.ProviderError,
          GitHubProviderResultStatus.ProviderUnavailable
        )
      );
      mocks.commentFindMany.mockResolvedValue([projectionRow()]);

      const result = await getComments();

      expect(result).toMatchObject({
        state: BranchCommentsState.StaleMixed,
        stale: true,
      });
      expect(result).not.toHaveProperty("failureReason");
    });

    it.each([
      [
        GitHubProviderResultStatus.ProviderRateLimit,
        BranchCommentsFailureReason.RateLimit,
      ],
      [
        GitHubAccessDenialReason.RateLimited,
        BranchCommentsFailureReason.RateLimit,
      ],
      [
        GitHubAccessDenialReason.NotConnected,
        BranchCommentsFailureReason.ProviderUnavailable,
      ],
      [undefined, BranchCommentsFailureReason.ProviderUnavailable],
    ])(
      "maps a %s reconcile failure to the %s failure reason",
      async (errorCode, failureReason) => {
        mocks.readMarker.mockResolvedValue(unsyncedMarker());
        mocks.reconcileOnView.mockResolvedValue(
          reconcileResult(GitHubCommentReconcileStatus.ProviderError, errorCode)
        );

        const result = await getComments();

        expect(result).toMatchObject({
          state: BranchCommentsState.ProviderError,
          failureReason,
        });
      }
    );
  });

  it("falls back to safe defaults when a projected comment's optional GitHub evidence is missing", async () => {
    const updatedAt = new Date("2026-07-03T10:05:00.000Z");
    mocks.commentFindMany.mockResolvedValue([
      projectionRow({
        githubCommentId: null,
        githubUpdatedAt: null,
        externalAuthor: null,
        path: null,
        line: null,
        updatedAt,
      }),
    ]);

    const result = await getComments();

    expect(result?.comments[0]).toMatchObject({
      providerCommentId: null,
      path: null,
      line: null,
      updatedAt: updatedAt.toISOString(),
    });
    expect(result?.comments[0]?.author.login).toBe("unknown");
  });

  it("shows a stored outdated comment at its original line, and a current one at its line", async () => {
    mocks.commentFindMany.mockResolvedValue([
      projectionRow({ id: "outdated", line: null, originalLine: 9 }),
      projectionRow({ id: "current", line: 12, originalLine: 9 }),
    ]);

    const result = await getComments();

    expect(result?.comments.map(({ id, line }) => ({ id, line }))).toEqual([
      { id: "outdated", line: 9 },
      { id: "current", line: 12 },
    ]);
  });

  it("classifies a projected comment as an issue comment kind from its GitHub thread kind", async () => {
    mocks.commentFindMany.mockResolvedValue([
      projectionRow({ threadKind: GitHubCommentThreadKind.ISSUE_COMMENT }),
    ]);

    const result = await getComments();

    expect(result?.comments[0]?.kind).toBe(BranchPrCommentKind.Issue);
  });

  it("classifies a projected comment as a review reply when it carries an in-reply-to id on a non-issue thread", async () => {
    mocks.commentFindMany.mockResolvedValue([
      projectionRow({ githubInReplyToCommentId: "999" }),
    ]);

    const result = await getComments();

    expect(result?.comments[0]).toMatchObject({
      kind: BranchPrCommentKind.ReviewReply,
      inReplyToId: "999",
    });
  });

  it("falls back to a raw string comment body when there is no plain-text projection", async () => {
    mocks.commentFindMany.mockResolvedValue([
      projectionRow({ plainText: null, body: "Raw string body" }),
    ]);

    const result = await getComments();

    expect(result?.comments[0]?.body).toBe("Raw string body");
  });

  it("falls back to the markdown-wrapped comment body when there is no plain-text projection", async () => {
    mocks.commentFindMany.mockResolvedValue([
      projectionRow({ plainText: null, body: { markdown: "Wrapped text" } }),
    ]);

    const result = await getComments();

    expect(result?.comments[0]?.body).toBe("Wrapped text");
  });

  it("falls back to an empty comment body when there is neither plain text nor a recognized body shape", async () => {
    mocks.commentFindMany.mockResolvedValue([
      projectionRow({ plainText: null, body: null }),
    ]);

    const result = await getComments();

    expect(result?.comments[0]?.body).toBe("");
  });

  it("returns safe defaults without throwing when a projected comment carries no GitHub projection at all", async () => {
    mocks.commentFindMany.mockResolvedValue([
      projectionRow({ githubProjection: null }),
    ]);

    const result = await getComments();

    expect(result?.comments[0]).toMatchObject({
      providerCommentId: null,
      inReplyToId: null,
      author: {
        login: "unknown",
        displayName: null,
        avatarUrl: null,
        profileUrl: null,
      },
      providerUrl: null,
      updatedAt: new Date("2026-07-03T10:01:00.000Z").toISOString(),
    });
  });

  it("returns safe defaults without throwing when a projected comment's GitHub projection carries no external author", async () => {
    mocks.commentFindMany.mockResolvedValue([
      projectionRow({ externalAuthor: null }),
    ]);

    const result = await getComments();

    expect(result?.comments[0]).toMatchObject({
      providerCommentId: "123456",
      author: {
        login: "unknown",
        displayName: null,
        avatarUrl: null,
        profileUrl: null,
      },
    });
  });

  it("surfaces a projected comment's real author profile fields and provider url instead of defaulting them", async () => {
    mocks.commentFindMany.mockResolvedValue([
      projectionRow({
        displayName: "Ada Reviewer",
        avatarUrl: "https://example.com/ada.png",
        profileUrl: "https://github.com/ada",
        githubHtmlUrl:
          "https://github.com/closedloop-ai/closedloop-ai/pull/42#discussion_r777",
      }),
    ]);

    const result = await getComments();

    expect(result?.comments[0]).toMatchObject({
      author: {
        displayName: "Ada Reviewer",
        avatarUrl: "https://example.com/ada.png",
        profileUrl: "https://github.com/ada",
      },
      providerUrl:
        "https://github.com/closedloop-ai/closedloop-ai/pull/42#discussion_r777",
    });
  });

  it("marks a projected comment resolved when its thread status is RESOLVED", async () => {
    mocks.commentFindMany.mockResolvedValue([
      projectionRow({ threadStatus: ThreadStatus.RESOLVED }),
    ]);

    const result = await getComments();

    expect(result?.comments[0]?.resolved).toBe(true);
  });

  it("counts an ABANDONED GitHub sync state as unconfirmed", async () => {
    mocks.commentFindMany.mockResolvedValue([
      projectionRow({ syncStates: [CommentSyncStatus.Abandoned] }),
    ]);

    const result = await getComments();

    expect(result?.comments[0]?.stale).toBe(true);
  });

  it("prefers the plain-text projection over the markdown body when both are present", async () => {
    mocks.commentFindMany.mockResolvedValue([
      projectionRow({
        plainText: "Plain text version",
        body: { markdown: "Markdown version - should not be used" },
      }),
    ]);

    const result = await getComments();

    expect(result?.comments[0]?.body).toBe("Plain text version");
  });

  it("falls back to an empty comment body when the markdown field isn't a string", async () => {
    // The AND chain's `typeof value === "object"` check (forced-true mutant)
    // is equivalent for every legal Prisma.JsonValue: strings return earlier;
    // null short-circuits at the first `value &&` operand; arrays are
    // already typeof "object"; and for a truthy non-object primitive
    // (number/boolean), `value.markdown` autoboxes to `undefined` either
    // way, so the final `typeof value.markdown === "string"` check still
    // fails identically. This case instead targets that final check with a
    // real object whose `markdown` field is a number, not a string.
    mocks.commentFindMany.mockResolvedValue([
      projectionRow({ plainText: null, body: { markdown: 42 } }),
    ]);

    const result = await getComments();

    expect(result?.comments[0]?.body).toBe("");
  });
});

function getComments() {
  return branchCommentsService.getBranchComments("org-1", BRANCH_ID);
}

function fakeDb() {
  return {
    artifact: { findFirst: mocks.artifactFindFirst },
    comment: { findMany: mocks.commentFindMany },
    gitHubInstallationRepository: { findFirst: mocks.repositoryFindFirst },
    $queryRaw: mocks.queryRaw,
  } as unknown as Parameters<typeof findBranchCommentsContext>[0];
}

function installationlessBranchRow(repositoryFullName = "Dev/Local-Repo") {
  return branchContextRow({
    pullRequestDetails: [
      {
        ...pullRequestDetailFixture({ repository: null }),
        repositoryFullName,
      },
    ],
    branchRepository: null,
    branchRepositoryFullName: repositoryFullName,
  });
}
