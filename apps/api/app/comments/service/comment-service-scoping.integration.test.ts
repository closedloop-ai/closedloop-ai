/**
 * ISS-11212 (PLN-2121, acceptance criterion 4): the comment service against a
 * real database. Every command and read on another org's artifact, thread or
 * comment is `not_found`, and each source policy's allowed and denied actions
 * hold, including the staff-only `parsing_bug` kind.
 */
import { ThreadStatus, TraceCommentKind } from "@repo/api/src/types/comment";
import { CommentAnchorState } from "@repo/api/src/types/comment-anchor";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import type { CommentThreadDto } from "@repo/api/src/types/comment-thread-dto";
import { withDb } from "@repo/database";
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
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { commentsService } from "@/app/comments/service";
import {
  type CommentViewer,
  createCommentLiveState,
} from "./comment-capabilities";
import { presentCommentThreadDto } from "./comment-read";
import { type CommentTarget, resolveCommentTarget } from "./comment-target";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const tracker = createCommittedTestOrganizationTracker();
let clientCounter = 0;

function presenter(viewer: CommentViewer, target: CommentTarget) {
  return presentCommentThreadDto({
    viewer,
    target,
    liveState: createCommentLiveState(viewer),
  });
}

async function openThread(
  org: CommentTestOrg,
  input: {
    viewer?: CommentViewer;
    target?: CommentTarget;
    kind?: TraceCommentKind;
  } = {}
): Promise<CommentThreadDto> {
  const viewer = input.viewer ?? org.author;
  const target = input.target ?? org.session;
  clientCounter += 1;
  const result = await commentsService.createThread({
    viewer,
    target,
    anchor: commentTraceAnchor(clientCounter),
    body: "root",
    clientId: `scoping-${clientCounter}-${org.organizationId}`,
    ...(input.kind ? { kind: input.kind } : {}),
    present: presenter(viewer, target),
  });
  if (!result.ok) {
    throw new Error(`seed thread failed: ${result.error}`);
  }
  return result.value;
}

const notFound = { ok: false, error: CommentErrorCode.NotFound };
const denied = { ok: false, error: CommentErrorCode.CapabilityDenied };

describeIfDb("comment service: two-org scoping", () => {
  let orgA: CommentTestOrg;
  let orgB: CommentTestOrg;
  let foreignThread: CommentThreadDto;

  beforeAll(async () => {
    orgA = await seedCommentTestOrg(tracker);
    orgB = await seedCommentTestOrg(tracker);
    foreignThread = await openThread(orgB);
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  it("resolves no target, list or thread in another org", async () => {
    const viewer = orgA.author;
    await expect(
      resolveCommentTarget({
        organizationId: viewer.organizationId,
        artifactId: orgB.session.artifactId,
      })
    ).resolves.toEqual(notFound);
    await expect(
      commentsService.listArtifactComments({
        viewer,
        artifactId: orgB.session.artifactId,
      })
    ).resolves.toEqual(notFound);
    await expect(
      commentsService.getThread({ viewer, threadId: foreignThread.id })
    ).resolves.toEqual(notFound);
  });

  it("answers not_found to every command addressed at another org's thread or comment", async () => {
    const viewer = orgA.author;
    // A target that names org B's artifact under org A's id: every lookup
    // inside the command must still carry the org predicate.
    const forged: CommentTarget = {
      ...orgB.session,
      organizationId: viewer.organizationId,
    };
    const rootId = foreignThread.comments[0]?.id as string;
    const present = presenter(viewer, forged);

    const outcomes = await Promise.all([
      commentsService.reply({
        viewer,
        target: forged,
        thread: { threadId: foreignThread.id },
        body: "reply",
        clientId: null,
        present,
      }),
      commentsService.reply({
        viewer,
        target: forged,
        thread: { rootCommentId: rootId },
        body: "reply",
        clientId: null,
        present,
      }),
      commentsService.editComment({
        viewer,
        target: forged,
        commentId: rootId,
        body: "edit",
        present,
      }),
      commentsService.deleteComment({
        viewer,
        target: forged,
        commentId: rootId,
      }),
      commentsService.retrySync({
        viewer,
        target: forged,
        comment: { threadId: foreignThread.id },
        present,
      }),
      commentsService.markSyncAbandoned({
        viewer,
        target: forged,
        comment: { commentId: rootId },
        present,
      }),
      commentsService.resolveCommentThread({
        viewer,
        threadId: foreignThread.id,
        present,
      }),
      commentsService.reopenCommentThread({
        viewer,
        threadId: foreignThread.id,
        present,
      }),
      commentsService.reanchor({
        organizationId: viewer.organizationId,
        threadId: foreignThread.id,
        anchor: commentTraceAnchor(99),
        anchorState: CommentAnchorState.Moved,
        liveState: createCommentLiveState(viewer),
      }),
    ]);

    expect(outcomes).toEqual(outcomes.map(() => notFound));
    const stored = await withDb((db) =>
      db.commentThread.findUniqueOrThrow({
        where: { id: foreignThread.id },
        select: {
          revision: true,
          comments: { select: { plainText: true, deletedAt: true } },
        },
      })
    );
    expect(stored).toEqual({
      revision: 0,
      comments: [{ plainText: "root", deletedAt: null }],
    });
  });
});

describeIfDb("comment service: source policies", () => {
  let org: CommentTestOrg;

  beforeAll(async () => {
    org = await seedCommentTestOrg(tracker);
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  it("lets staff, and only staff, open a parsing_bug thread on a Session", async () => {
    const staffThread = await openThread(org, {
      viewer: org.staff,
      kind: TraceCommentKind.ParsingBug,
    });
    expect(staffThread.kind).toBe(TraceCommentKind.ParsingBug);

    const refused = await commentsService.createThread({
      viewer: org.author,
      target: org.session,
      anchor: commentTraceAnchor(1),
      body: "not staff",
      kind: TraceCommentKind.ParsingBug,
      clientId: `parsing-bug-denied-${org.organizationId}`,
      present: presenter(org.author, org.session),
    });
    expect(refused).toEqual(denied);
    const stored = await withDb((db) =>
      db.commentThread.count({
        where: { externalId: `parsing-bug-denied-${org.organizationId}` },
      })
    );
    expect(stored).toBe(0);
  });

  it("refuses a parsing_bug thread on a Branch even from staff", async () => {
    const refused = await commentsService.createThread({
      viewer: org.staff,
      target: org.branch,
      anchor: commentTraceAnchor(2),
      body: "branch bug",
      kind: TraceCommentKind.ParsingBug,
      clientId: null,
      present: presenter(org.staff, org.branch),
    });
    expect(refused).toEqual(denied);
  });

  it("keeps edit, delete and retry-sync to the comment's own author", async () => {
    const thread = await openThread(org);
    const rootId = thread.comments[0]?.id as string;
    const present = presenter(org.other, org.session);

    const outcomes = await Promise.all([
      commentsService.editComment({
        viewer: org.other,
        target: org.session,
        commentId: rootId,
        body: "not mine",
        present,
      }),
      commentsService.deleteComment({
        viewer: org.other,
        target: org.session,
        commentId: rootId,
      }),
      commentsService.retrySync({
        viewer: org.other,
        target: org.session,
        comment: { commentId: rootId },
        present,
      }),
    ]);
    expect(outcomes).toEqual([denied, denied, denied]);

    const edited = await commentsService.editComment({
      viewer: org.author,
      target: org.session,
      commentId: rootId,
      body: "mine",
      present: presenter(org.author, org.session),
    });
    expect(edited.ok && edited.value.comments[0]?.body).toBe("mine");
    expect(edited.ok && edited.value.permissions).toEqual({
      canEdit: true,
      canDelete: true,
      canResolve: true,
      canReopen: true,
      canRetrySync: true,
    });
  });

  it("lets any org member resolve and reopen a Session thread they never joined", async () => {
    const thread = await openThread(org);
    const present = presenter(org.other, org.session);
    const readStatus = () =>
      withDb((db) =>
        db.commentThread.findUniqueOrThrow({
          where: { id: thread.id },
          select: { status: true, resolvedById: true },
        })
      );

    const resolved = await commentsService.resolveCommentThread({
      viewer: org.other,
      threadId: thread.id,
      present,
    });
    expect(resolved.ok).toBe(true);
    await expect(readStatus()).resolves.toEqual({
      status: ThreadStatus.Resolved,
      resolvedById: org.other.userId,
    });

    // A second resolve, from a pane that had not refreshed, keeps the first resolver.
    const repeated = await commentsService.resolveCommentThread({
      viewer: org.author,
      threadId: thread.id,
      present: presenter(org.author, org.session),
    });
    expect(repeated.ok).toBe(true);
    await expect(readStatus()).resolves.toEqual({
      status: ThreadStatus.Resolved,
      resolvedById: org.other.userId,
    });

    const reopened = await commentsService.reopenCommentThread({
      viewer: org.other,
      threadId: thread.id,
      present,
    });
    expect(reopened.ok).toBe(true);
    await expect(readStatus()).resolves.toEqual({
      status: ThreadStatus.Open,
      resolvedById: null,
    });
  });

  it("answers capability_denied to resolve and reopen on a native Branch thread", async () => {
    const branchThread = await openThread(org, { target: org.branch });
    const present = presenter(org.author, org.branch);
    await expect(
      commentsService.resolveCommentThread({
        viewer: org.author,
        threadId: branchThread.id,
        present,
      })
    ).resolves.toEqual(denied);
    await expect(
      commentsService.reopenCommentThread({
        viewer: org.author,
        threadId: branchThread.id,
        present,
      })
    ).resolves.toEqual(denied);
    const stored = await withDb((db) =>
      db.commentThread.findUniqueOrThrow({
        where: { id: branchThread.id },
        select: { status: true },
      })
    );
    expect(stored).toEqual({ status: ThreadStatus.Open });
  });
});
