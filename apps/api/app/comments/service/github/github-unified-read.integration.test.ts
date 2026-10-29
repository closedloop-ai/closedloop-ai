/**
 * ISS-11212 (PLN-2122 Step 7): a Branch's GitHub threads in the unified read,
 * beside its native threads, with typed anchors, link-out, the GitHub author
 * and the `github_branch` policy's per-item permissions.
 */
import {
  CommentSurface,
  ThreadSource,
  ThreadStatus,
  TraceCommentKind,
} from "@repo/api/src/types/comment";
import { CommentAnchorState } from "@repo/api/src/types/comment-anchor";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import {
  artifactCommentsResponseSchema,
  CommentBodyFormat,
  CommentSyncDirection,
  CommentSyncProvider,
  CommentSyncStatus,
  type CommentThreadDto,
} from "@repo/api/src/types/comment-thread-dto";
import { GitHubCommentThreadKind, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mention-notifications", () => ({
  dispatchMentionNotifications: vi.fn(),
}));

vi.mock("@/app/search/search-index-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/search/search-index-service")>();
  return {
    ...actual,
    searchIndexService: {
      ...actual.searchIndexService,
      indexAfterCommit: vi.fn(),
      removeAfterCommit: vi.fn(),
    },
  };
});

import {
  type CommentTestOrg,
  commentTraceAnchor,
  seedCommentTestOrg,
} from "@/__tests__/support/comments/comment-service.test-fixtures";
import {
  applyInput,
  at,
  externalComment,
  GITHUB_TEST_AUTHOR,
  GITHUB_TEST_REPOSITORY,
  type GitHubCommentScope,
  issueCommentEvent,
  reviewThreadEvent,
} from "@/__tests__/support/comments/github-apply-external.test-fixtures";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { commentsService } from "@/app/comments/service";
import { createCommentLiveState } from "../comment-capabilities";
import {
  decodeCommentListCursor,
  presentCommentThreadDto,
} from "../comment-read";
import { applyExternal } from "./apply-external";
import { GitHubExternalEventKind } from "./apply-external-events";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;
const SECOND_GITHUB_TEST_REPOSITORY = "acme/api";
const tracker = createCommittedTestOrganizationTracker();

const NO_PERMISSIONS = {
  canEdit: false,
  canDelete: false,
  canResolve: false,
  canReopen: false,
  canRetrySync: false,
};

describeIfDb("unified read: GitHub threads on a Branch", () => {
  let org: CommentTestOrg;
  let foreign: CommentTestOrg;
  let nativeThreadId: string;
  let pullRequestDetailId: string;

  beforeAll(async () => {
    org = await seedCommentTestOrg(tracker);
    foreign = await seedCommentTestOrg(tracker);
    const scope = await seedPullRequest(org);
    pullRequestDetailId = scope.pullRequestDetailId;
    await applyExternal(
      applyInput(scope, [
        issueCommentEvent(11),
        reviewThreadEvent(501, {
          comments: [
            externalComment(501),
            externalComment(502, {
              githubInReplyToCommentId: 501,
              createdAt: at(1),
              providerUpdatedAt: at(3),
            }),
          ],
        }),
      ])
    );
    const reviewThread = await withDb((db) =>
      db.commentThread.findFirstOrThrow({
        where: {
          githubProjection: {
            is: {
              branchArtifactId: org.branch.artifactId,
              threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
            },
          },
        },
        select: { externalId: true },
      })
    );
    await applyExternal(
      applyInput(scope, [
        {
          kind: GitHubExternalEventKind.ThreadStatus,
          threadExternalId: reviewThread.externalId ?? "",
          resolved: true,
          resolvedAt: at(5),
          resolvedById: org.other.userId,
        },
      ])
    );
    const native = await commentsService.createThread({
      viewer: org.author,
      target: org.branch,
      anchor: commentTraceAnchor(1),
      body: "native root",
      clientId: null,
      present: presentCommentThreadDto({
        viewer: org.author,
        target: org.branch,
        liveState: createCommentLiveState(org.author),
      }),
    });
    if (!native.ok) {
      throw new Error(`seed native thread failed: ${native.error}`);
    }
    nativeThreadId = native.value.id;
    // Older than the GitHub threads, but with the newest id: only an order on
    // `createdAt` first puts it first.
    await withDb((db) =>
      db.commentThread.update({
        where: { id: nativeThreadId },
        data: { createdAt: at(-60) },
        select: { id: true },
      })
    );
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  function list(
    over: Partial<
      Parameters<typeof commentsService.listArtifactComments>[0]
    > = {}
  ) {
    return commentsService.listArtifactComments({
      viewer: org.author,
      artifactId: org.branch.artifactId,
      ...over,
    });
  }

  async function threads(
    over: Parameters<typeof list>[0] = {}
  ): Promise<CommentThreadDto[]> {
    const result = await list(over);
    if (!result.ok) {
      throw new Error(`list failed: ${result.error}`);
    }
    return result.value.threads;
  }

  function bySource(all: CommentThreadDto[], source: ThreadSource) {
    return all.filter((thread) => thread.source === source);
  }

  it("lists the GitHub threads beside the native one, in (createdAt, id) order", async () => {
    const all = await threads();

    expect(all).toHaveLength(3);
    expect(bySource(all, ThreadSource.Github)).toHaveLength(2);
    expect(bySource(all, ThreadSource.Native).map(({ id }) => id)).toEqual([
      nativeThreadId,
    ]);
    const ordered = [...all].sort(
      (a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        (a.id < b.id ? -1 : 1)
    );
    expect(all.map(({ id }) => id)).toEqual(ordered.map(({ id }) => id));
  });

  it("pages across both sources with no thread lost or repeated", async () => {
    const all = await threads();
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const result = await list({
        limit: 1,
        ...(cursor
          ? { after: decodeCommentListCursor(cursor) ?? undefined }
          : {}),
      });
      if (!result.ok) {
        throw new Error(`page failed: ${result.error}`);
      }
      paged.push(...result.value.threads.map(({ id }) => id));
      cursor = result.value.nextCursor;
    } while (cursor);

    expect(paged).toEqual(all.map(({ id }) => id));
  });

  it("maps an issue comment thread with its artifact anchor, link-out, GitHub author and no permissions", async () => {
    const [issue] = bySource(await threads(), ThreadSource.Github).filter(
      (thread) => thread.anchor?.kind === CommentAnchorKind.Artifact
    );

    expect(issue).toMatchObject({
      artifactId: org.branch.artifactId,
      source: ThreadSource.Github,
      anchor: { kind: CommentAnchorKind.Artifact },
      anchorState: CommentAnchorState.Anchored,
      status: ThreadStatus.Open,
      resolvedAt: null,
      resolvedBy: null,
      kind: TraceCommentKind.Comment,
      permissions: NO_PERMISSIONS,
      provider: {
        linkOut: `https://github.com/${GITHUB_TEST_REPOSITORY}/pull/42#c11`,
        author: {
          login: GITHUB_TEST_AUTHOR.login,
          avatarUrl: GITHUB_TEST_AUTHOR.avatar_url,
        },
      },
      sync: {
        provider: CommentSyncProvider.Github,
        direction: CommentSyncDirection.Inbound,
        state: CommentSyncStatus.Synced,
      },
    });
    expect(issue?.comments).toEqual([
      expect.objectContaining({
        body: "body 11",
        bodyFormat: CommentBodyFormat.Markdown,
        updatedAt: at(0).toISOString(),
        author: expect.objectContaining({ name: GITHUB_TEST_AUTHOR.login }),
        permissions: NO_PERMISSIONS,
      }),
    ]);
  });

  it("maps a resolved review thread with its code anchor and both comments", async () => {
    const [review] = bySource(await threads(), ThreadSource.Github).filter(
      (thread) => thread.anchor?.kind === CommentAnchorKind.Code
    );
    const stored = await withDb((db) =>
      db.commentThread.findUniqueOrThrow({
        where: { id: review?.id ?? "" },
        select: { resolvedAt: true },
      })
    );

    expect(stored.resolvedAt).toEqual(at(5));
    expect(review).toMatchObject({
      status: ThreadStatus.Resolved,
      resolvedAt: at(5).toISOString(),
      resolvedBy: { id: org.other.userId, name: expect.any(String) },
      anchor: {
        kind: CommentAnchorKind.Code,
        repository: GITHUB_TEST_REPOSITORY,
        path: "src/app.ts",
        endLine: 10,
      },
      provider: {
        linkOut: `https://github.com/${GITHUB_TEST_REPOSITORY}/pull/42#c501`,
      },
    });
    expect(
      review?.comments.map(({ body, updatedAt }) => ({ body, updatedAt }))
    ).toEqual([
      { body: "body 501", updatedAt: at(0).toISOString() },
      { body: "body 502", updatedAt: at(3).toISOString() },
    ]);
  });

  it("denies edit and delete on a GitHub comment even to the user its GitHub author maps to", async () => {
    const [issue] = bySource(await threads(), ThreadSource.Github);
    const githubAuthorUserId = issue?.comments[0]?.author.id ?? "";

    const asGitHubAuthor = await threads({
      viewer: {
        organizationId: org.organizationId,
        userId: githubAuthorUserId,
      },
    });
    const sameThread = asGitHubAuthor.find(({ id }) => id === issue?.id);

    expect(sameThread?.permissions).toEqual(NO_PERMISSIONS);
    expect(sameThread?.comments[0]?.permissions).toEqual(NO_PERMISSIONS);
  });

  it("keeps the collection capabilities the native Branch policy's", async () => {
    const result = await list();

    expect(result.ok && result.value.capabilities.createThread).toBe(true);
  });

  it("filters GitHub threads by status, and leaves them out of a surface-filtered list", async () => {
    const resolved = await threads({ status: ThreadStatus.Resolved });
    const onSurface = await threads({
      surface: CommentSurface.BranchDetail,
    });

    expect(resolved.map(({ source }) => source)).toEqual([ThreadSource.Github]);
    expect(onSurface.map(({ id }) => id)).toEqual([nativeThreadId]);
  });

  it("reads one GitHub thread by id as the list maps it, and only in its organization", async () => {
    const [listed] = bySource(await threads(), ThreadSource.Github);
    const own = await commentsService.getThread({
      viewer: org.author,
      threadId: listed?.id ?? "",
    });
    const other = await commentsService.getThread({
      viewer: foreign.author,
      threadId: listed?.id ?? "",
    });

    expect(own).toEqual({ ok: true, value: listed });
    expect(other).toEqual({ ok: false, error: CommentErrorCode.NotFound });
  });

  it("names each GitHub thread's pull request number, and omits it on a native thread", async () => {
    const all = await threads();
    const wire = JSON.parse(JSON.stringify(all)) as CommentThreadDto[];

    expect(
      bySource(wire, ThreadSource.Github).map(
        (thread) => thread.provider.pullRequestNumber
      )
    ).toEqual([42, 42]);
    for (const thread of bySource(wire, ThreadSource.Native)) {
      expect(thread.provider).not.toHaveProperty("pullRequestNumber");
    }
  });

  it("names each GitHub thread's own pull request on a Branch with two", async () => {
    const twoPrs = await seedCommentTestOrg(tracker);
    const first = await seedPullRequest(twoPrs, 43);
    const second = await seedPullRequest(twoPrs, 44);
    await applyExternal(applyInput(first, [issueCommentEvent(31)]));
    await applyExternal(applyInput(second, [issueCommentEvent(32)]));

    const result = await commentsService.listArtifactComments({
      viewer: twoPrs.author,
      artifactId: twoPrs.branch.artifactId,
    });
    if (!result.ok) {
      throw new Error(`list failed: ${result.error}`);
    }

    expect(
      Object.fromEntries(
        result.value.threads.map((thread) => [
          thread.comments[0]?.body,
          thread.provider.pullRequestNumber,
        ])
      )
    ).toEqual({ "body 31": 43, "body 32": 44 });
  });

  it("names each GitHub thread's repository, and omits it on a native thread", async () => {
    const wire = JSON.parse(
      JSON.stringify(await threads())
    ) as CommentThreadDto[];

    expect(
      bySource(wire, ThreadSource.Github).map(
        (thread) => thread.provider.repositoryFullName
      )
    ).toEqual([GITHUB_TEST_REPOSITORY, GITHUB_TEST_REPOSITORY]);
    for (const thread of bySource(wire, ThreadSource.Native)) {
      expect(thread.provider).not.toHaveProperty("repositoryFullName");
    }
  });

  it("names each GitHub thread's repository on a Branch with one PR number in two repositories", async () => {
    const twoRepositories = await seedCommentTestOrg(tracker);
    const onWeb = await seedPullRequest(twoRepositories, 45);
    const onApi = await seedPullRequest(
      twoRepositories,
      45,
      SECOND_GITHUB_TEST_REPOSITORY
    );
    await applyExternal(applyInput(onWeb, [issueCommentEvent(33)]));
    await applyExternal(applyInput(onApi, [issueCommentEvent(34)]));

    const result = await commentsService.listArtifactComments({
      viewer: twoRepositories.author,
      artifactId: twoRepositories.branch.artifactId,
    });
    if (!result.ok) {
      throw new Error(`list failed: ${result.error}`);
    }

    expect(
      Object.fromEntries(
        result.value.threads.map((thread) => [
          thread.comments[0]?.body,
          [
            thread.provider.repositoryFullName,
            thread.provider.pullRequestNumber,
          ],
        ])
      )
    ).toEqual({
      "body 33": [GITHUB_TEST_REPOSITORY, 45],
      "body 34": [SECOND_GITHUB_TEST_REPOSITORY, 45],
    });
  });

  it("round-trips GitHub threads through the client schema (PLN-2162 M1)", async () => {
    const result = await list();
    const wire = JSON.parse(JSON.stringify(result.ok && result.value));

    expect(bySource(wire.threads, ThreadSource.Github)).toHaveLength(2);
    expect(artifactCommentsResponseSchema.parse(wire)).toEqual(wire);
  });

  it("marks a GitHub thread stale for an unconfirmed comment sync, or its PR's failed latest reconcile", async () => {
    const staleById = async () =>
      Object.fromEntries(
        bySource(await threads(), ThreadSource.Github).map((thread) => [
          thread.id,
          thread.provider.stale,
        ])
      );
    const fresh = await staleById();
    const [pendingThreadId, otherThreadId] = Object.keys(fresh);
    const syncState = await withDb((db) =>
      db.commentSyncState.findFirstOrThrow({
        where: { comment: { threadId: pendingThreadId } },
        select: { id: true },
      })
    );

    await withDb((db) =>
      db.commentSyncState.update({
        where: { id: syncState.id },
        data: { state: CommentSyncStatus.Pending },
        select: { id: true },
      })
    );
    const unconfirmed = await staleById();
    await withDb((db) =>
      db.commentSyncState.update({
        where: { id: syncState.id },
        data: { state: CommentSyncStatus.Synced },
        select: { id: true },
      })
    );
    await withDb((db) =>
      db.pullRequestDetail.update({
        where: { id: pullRequestDetailId },
        data: {
          commentsReconcileAttemptedAt: new Date(),
          commentsReconciledAt: null,
          commentsReconcileClaimedAt: null,
        },
        select: { id: true },
      })
    );
    const failedAttempt = await staleById();
    await withDb((db) =>
      db.pullRequestDetail.update({
        where: { id: pullRequestDetailId },
        data: { commentsReconcileAttemptedAt: null },
        select: { id: true },
      })
    );

    expect(Object.values(fresh)).toEqual([false, false]);
    expect(unconfirmed).toEqual({
      [pendingThreadId ?? ""]: true,
      [otherThreadId ?? ""]: false,
    });
    expect(Object.values(failedAttempt)).toEqual([true, true]);
  });
});

async function seedPullRequest(
  org: CommentTestOrg,
  number = 42,
  repositoryFullName = GITHUB_TEST_REPOSITORY
): Promise<GitHubCommentScope> {
  const pullRequest = await withDb((db) =>
    db.pullRequestDetail.create({
      data: {
        organizationId: org.organizationId,
        branchArtifactId: org.branch.artifactId,
        number,
        repositoryFullName,
      },
      select: { id: true },
    })
  );
  return {
    organizationId: org.organizationId,
    branchArtifactId: org.branch.artifactId,
    pullRequestDetailId: pullRequest.id,
    repositoryFullName,
  };
}
