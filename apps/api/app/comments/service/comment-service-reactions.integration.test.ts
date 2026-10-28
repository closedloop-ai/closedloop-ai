/**
 * PLN-2187 T-2.2: reactions through the comment command pipeline against a
 * real database: the React grant, idempotent add and remove, and the thread
 * revision each change bumps.
 */
import {
  CapabilityGrant,
  COMMENT_SOURCE_POLICIES,
  CommentCapability,
  CommentPolicyKey,
} from "@repo/api/src/types/comment-capabilities";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import {
  CommentReactionEmoji,
  type CommentThreadDto,
} from "@repo/api/src/types/comment-thread-dto";
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
  type CommentSourcePolicies,
  type CommentViewer,
  createCommentLiveState,
} from "./comment-capabilities";
import { presentCommentThreadDto } from "./comment-read";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const tracker = createCommittedTestOrganizationTracker();

/** No shipped source grants React on a Session; this grants it to anyone. */
const SESSION_REACT_POLICIES: CommentSourcePolicies = {
  ...COMMENT_SOURCE_POLICIES,
  [CommentPolicyKey.NativeSession]: {
    ...COMMENT_SOURCE_POLICIES[CommentPolicyKey.NativeSession],
    capabilities: {
      ...COMMENT_SOURCE_POLICIES[CommentPolicyKey.NativeSession].capabilities,
      [CommentCapability.React]: CapabilityGrant.Any,
    },
  },
};

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: string }
): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error}`);
  }
  return result.value;
}

describeIfDb("comment service: reactions", () => {
  let org: CommentTestOrg;
  let row = 0;

  beforeAll(async () => {
    org = await seedCommentTestOrg(tracker);
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  async function openThread(): Promise<CommentThreadDto> {
    row += 1;
    return unwrap(
      await commentsService.createThread({
        viewer: org.author,
        target: org.session,
        anchor: commentTraceAnchor(row),
        body: `root ${row}`,
        clientId: null,
        present: presentCommentThreadDto({
          viewer: org.author,
          target: org.session,
          liveState: createCommentLiveState(org.author),
        }),
      })
    );
  }

  function react(
    command: "addReaction" | "removeReaction",
    viewer: CommentViewer,
    commentId: string,
    policies?: CommentSourcePolicies
  ) {
    return commentsService[command]({
      viewer,
      target: org.session,
      commentId,
      emoji: CommentReactionEmoji.ThumbsUp,
      policies,
      present: presentCommentThreadDto({
        viewer,
        target: org.session,
        liveState: createCommentLiveState(viewer),
      }),
    });
  }

  function reactionRows(commentId: string) {
    return withDb((db) =>
      db.commentReaction.findMany({
        where: { commentId },
        select: { userId: true, emoji: true },
      })
    );
  }

  it("refuses a reaction where the source grants none, writing nothing", async () => {
    const thread = await openThread();
    const commentId = thread.comments[0]?.id as string;

    const denied = await react("addReaction", org.other, commentId);

    expect(denied).toEqual({
      ok: false,
      error: CommentErrorCode.CapabilityDenied,
    });
    await expect(reactionRows(commentId)).resolves.toEqual([]);
  });

  it("adds a reaction once and bumps the revision only on the first add", async () => {
    const thread = await openThread();
    const commentId = thread.comments[0]?.id as string;

    const first = unwrap(
      await react("addReaction", org.other, commentId, SESSION_REACT_POLICIES)
    );
    const repeat = unwrap(
      await react("addReaction", org.other, commentId, SESSION_REACT_POLICIES)
    );

    expect(first.revision).toBe(thread.revision + 1);
    expect(repeat.revision).toBe(first.revision);
    expect(repeat.comments[0]?.reactions).toEqual([
      {
        emoji: CommentReactionEmoji.ThumbsUp,
        userIds: [org.other.userId],
        viewerReacted: true,
      },
    ]);
    await expect(reactionRows(commentId)).resolves.toEqual([
      { userId: org.other.userId, emoji: CommentReactionEmoji.ThumbsUp },
    ]);
  });

  it("removes only the viewer's reaction, and a repeat changes nothing", async () => {
    const thread = await openThread();
    const commentId = thread.comments[0]?.id as string;
    unwrap(
      await react("addReaction", org.other, commentId, SESSION_REACT_POLICIES)
    );
    const added = unwrap(
      await react("addReaction", org.author, commentId, SESSION_REACT_POLICIES)
    );

    const removed = unwrap(
      await react(
        "removeReaction",
        org.other,
        commentId,
        SESSION_REACT_POLICIES
      )
    );
    const repeat = unwrap(
      await react(
        "removeReaction",
        org.other,
        commentId,
        SESSION_REACT_POLICIES
      )
    );

    expect(removed.revision).toBe(added.revision + 1);
    expect(repeat.revision).toBe(removed.revision);
    await expect(reactionRows(commentId)).resolves.toEqual([
      { userId: org.author.userId, emoji: CommentReactionEmoji.ThumbsUp },
    ]);
  });

  it("answers not_found for a deleted comment", async () => {
    const thread = await openThread();
    const commentId = thread.comments[0]?.id as string;
    unwrap(
      await commentsService.deleteComment({
        viewer: org.author,
        target: org.session,
        commentId,
      })
    );

    const missing = await react(
      "addReaction",
      org.other,
      commentId,
      SESSION_REACT_POLICIES
    );

    expect(missing).toEqual({ ok: false, error: CommentErrorCode.NotFound });
    await expect(reactionRows(commentId)).resolves.toEqual([]);
  });
});
