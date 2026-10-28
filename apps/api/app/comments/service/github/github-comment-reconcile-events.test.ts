import { GitHubCommentThreadKind, ThreadStatus } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
  externalComment,
  issueCommentEvent,
  providerIssueComment,
  providerReviewComment,
  reviewThreadEvent,
} from "@/__tests__/support/comments/github-apply-external.test-fixtures";
import { GitHubExternalEventKind } from "./apply-external-events";
import {
  chunkReconcileEvents,
  RECONCILE_COMMENTS_PER_APPLY,
  type ReconcileLists,
  reconcileCleanupEvents,
  reconcileUpsertEvents,
} from "./github-comment-reconcile-events";

const LISTED_AT = new Date("2026-09-01T12:00:00.000Z");

function lists(over: Partial<ReconcileLists> = {}): ReconcileLists {
  return {
    issueComments: { items: [], complete: true },
    reviewComments: { items: [], complete: true },
    reviews: { items: [], complete: true },
    listedAt: LISTED_AT,
    ...over,
  };
}

describe("reconcileUpsertEvents", () => {
  it("groups review comments into one thread per review thread, root first, positioned at the root", () => {
    const reply = providerReviewComment(12, {
      in_reply_to_id: 11,
      review_thread_node_id: "PRRT_11",
      line: 99,
      created_at: "2026-09-01T00:05:00.000Z",
    });
    const root = providerReviewComment(11, {
      line: null,
      original_line: 7,
      created_at: "2026-09-01T00:00:00.000Z",
    });

    const events = reconcileUpsertEvents(
      lists({ reviewComments: { items: [reply, root], complete: true } })
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        kind: GitHubExternalEventKind.ReviewThreadUpsert,
        reviewThreadId: "PRRT_11",
        rootCommentId: 11,
        position: expect.objectContaining({ line: null, originalLine: 7 }),
        comments: [
          expect.objectContaining({ githubCommentId: 11 }),
          expect.objectContaining({ githubCommentId: 12 }),
        ],
      })
    );
  });

  it("groups a reply whose thread metadata was not read with its root", () => {
    const root = providerReviewComment(11, {
      review_thread_node_id: "PRRT_11",
      review_thread_is_resolved: true,
    });
    const reply = providerReviewComment(12, {
      in_reply_to_id: 11,
      review_thread_node_id: null,
      review_thread_is_resolved: null,
      created_at: "2026-09-01T00:05:00.000Z",
    });

    const events = reconcileUpsertEvents(
      lists({ reviewComments: { items: [root, reply], complete: true } })
    );

    expect(events).toEqual([
      expect.objectContaining({
        reviewThreadId: "PRRT_11",
        rootCommentId: 11,
        resolutionStatus: ThreadStatus.RESOLVED,
        comments: [
          expect.objectContaining({ githubCommentId: 11 }),
          expect.objectContaining({ githubCommentId: 12 }),
        ],
      }),
    ]);
  });

  it("takes the thread metadata from a reply when its root's was not read", () => {
    const root = providerReviewComment(11, {
      review_thread_node_id: null,
      review_thread_is_resolved: null,
    });
    const reply = providerReviewComment(12, {
      in_reply_to_id: 11,
      review_thread_node_id: "PRRT_11",
      review_thread_is_resolved: false,
      created_at: "2026-09-01T00:05:00.000Z",
    });

    const events = reconcileUpsertEvents(
      lists({ reviewComments: { items: [reply, root], complete: true } })
    );

    expect(events).toEqual([
      expect.objectContaining({
        reviewThreadId: "PRRT_11",
        rootCommentId: 11,
        resolutionStatus: ThreadStatus.OPEN,
      }),
    ]);
  });

  it("revives only from a complete list, and only deletions before the list was read", () => {
    const [complete] = reconcileUpsertEvents(
      lists({
        reviewComments: { items: [providerReviewComment(1)], complete: true },
      })
    );
    const [ceiling] = reconcileUpsertEvents(
      lists({
        reviewComments: { items: [providerReviewComment(1)], complete: false },
      })
    );

    expect(complete?.reviveDeletedBefore).toEqual(LISTED_AT);
    expect(ceiling).not.toHaveProperty("reviveDeletedBefore");
  });

  it("stamps every event, complete list or not, with when the lists were read", () => {
    const events = reconcileUpsertEvents(
      lists({
        issueComments: {
          items: [providerIssueComment(1)],
          complete: false,
        },
        reviewComments: { items: [providerReviewComment(2)], complete: true },
      })
    );

    expect(events.map((event) => event.listedAt)).toEqual([
      LISTED_AT,
      LISTED_AT,
    ]);
  });
});

describe("reconcileCleanupEvents", () => {
  it("cleans up after each complete list and never after an incomplete one", () => {
    const events = reconcileCleanupEvents(
      lists({
        issueComments: { items: [], complete: false },
        reviewComments: { items: [providerReviewComment(5)], complete: true },
      })
    );

    expect(events.map((event) => event.threadKind)).toEqual([
      GitHubCommentThreadKind.REVIEW_THREAD,
      GitHubCommentThreadKind.REVIEW_SUMMARY,
    ]);
    expect([...(events[0]?.liveGithubCommentIds ?? [])]).toEqual(["5"]);
    expect(events.map((event) => event.listedAt)).toEqual([
      LISTED_AT,
      LISTED_AT,
    ]);
    expect(events.map((event) => event.maxComments)).toEqual([
      RECONCILE_COMMENTS_PER_APPLY,
      RECONCILE_COMMENTS_PER_APPLY,
    ]);
  });
});

describe("chunkReconcileEvents", () => {
  it("puts at most 50 comments in each applyExternal call", () => {
    const chunks = chunkReconcileEvents(
      Array.from({ length: 2 * RECONCILE_COMMENTS_PER_APPLY + 1 }, (_, i) =>
        issueCommentEvent(i)
      )
    );

    expect(chunks.map((chunk) => chunk.length)).toEqual([50, 50, 1]);
  });

  it("counts a thread's comments, and splits a thread larger than the budget", () => {
    const replies = (root: number, count: number) =>
      Array.from({ length: count }, (_, i) => externalComment(root + i));
    const chunks = chunkReconcileEvents([
      reviewThreadEvent(1000, { comments: replies(1000, 30) }),
      reviewThreadEvent(2000, { comments: replies(2000, 30) }),
      reviewThreadEvent(3000, { comments: replies(3000, 120) }),
    ]);

    const commentsPerChunk = chunks.map((chunk) =>
      chunk.flatMap((event) =>
        event.kind === GitHubExternalEventKind.ReviewThreadUpsert
          ? event.comments.map((comment) => comment.githubCommentId)
          : []
      )
    );
    expect(commentsPerChunk.map((ids) => ids.length)).toEqual([
      30, 30, 50, 50, 20,
    ]);
    expect(commentsPerChunk.slice(2).flat()).toEqual(
      replies(3000, 120).map((comment) => comment.githubCommentId)
    );
  });
});
