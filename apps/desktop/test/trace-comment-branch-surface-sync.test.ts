import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  ThreadStatus,
  type TraceComment,
  TraceCommentKind,
  TraceCommentSurface,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import {
  coerceTraceCommentStoreTarget,
  getTraceCommentStoreScope,
  runTraceCommentCloudSync,
} from "../src/main/dashboard/agent-dashboard-trace-comment-sync.js";
import type { SharedTraceCommentStoreTarget } from "../src/shared/shared-trace-comments-contract.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Desktop Branch trace-comment surface sync", () => {
  test("coercion defaults legacy Branch targets and preserves timeline", () => {
    const target = { type: TraceCommentTargetType.Branch, id: "branch-1" };
    assert.deepEqual(coerceTraceCommentStoreTarget(target, undefined), {
      ...target,
      surface: TraceCommentSurface.BranchDetail,
    });
    assert.deepEqual(
      coerceTraceCommentStoreTarget(target, {
        surface: TraceCommentSurface.BranchTimeline,
        futureOption: true,
      }),
      { ...target, surface: TraceCommentSurface.BranchTimeline }
    );
    assert.equal(
      coerceTraceCommentStoreTarget(target, { surface: "future_surface" }),
      null
    );
  });

  test("coercion rejects malformed targets and preserves legacy Session targets", () => {
    assert.equal(coerceTraceCommentStoreTarget(null, undefined), null);
    const sessionTarget = {
      type: TraceCommentTargetType.Session,
      id: "session-1",
    };
    assert.deepEqual(
      coerceTraceCommentStoreTarget(sessionTarget, {
        surface: TraceCommentSurface.BranchTimeline,
      }),
      sessionTarget
    );
  });

  test("cloud sync remains a no-op without authenticated Desktop cloud access", async () => {
    let storeCalls = 0;
    let fetchCalls = 0;
    const target: SharedTraceCommentStoreTarget = {
      type: TraceCommentTargetType.Branch,
      id: "branch-1",
      surface: TraceCommentSurface.BranchDetail,
    };
    globalThis.fetch = () => {
      fetchCalls += 1;
      return Promise.reject(new Error("unexpected fetch"));
    };

    await runTraceCommentCloudSync(
      () => {
        storeCalls += 1;
        return Promise.resolve(undefined);
      },
      null,
      target,
      {
        ...cloudOptions(),
        hasDesktopSessionAuth: () => false,
      }
    );

    assert.equal(storeCalls, 0);
    assert.equal(fetchCalls, 0);
  });

  test("store scope preserves every authenticated Desktop identity dimension", () => {
    assert.deepEqual(
      getTraceCommentStoreScope({
        ...cloudOptions(),
        getProfileId: () => "profile-1",
        getComputeTargetId: () => "target-1",
        getUserIdentity: () => ({
          userId: "user-1",
          organizationId: "org-1",
        }),
      }),
      {
        profileId: "profile-1",
        computeTargetId: "target-1",
        userId: "user-1",
        organizationId: "org-1",
      }
    );
  });

  test("cloud list uses the timeline query and keeps it in the sync key", async () => {
    const urls: string[] = [];
    const comment = timelineComment();
    globalThis.fetch = (input, init) => {
      urls.push(String(input));
      return Promise.resolve(
        Response.json({
          success: true,
          data: init?.method === "POST" ? comment : [],
        })
      );
    };
    const target: SharedTraceCommentStoreTarget = {
      type: TraceCommentTargetType.Branch,
      id: "branch-1",
      surface: TraceCommentSurface.BranchTimeline,
    };
    const storeCalls: Array<{ name: string; args: unknown[] | undefined }> = [];

    await runTraceCommentCloudSync(
      (name, args) => {
        storeCalls.push({ name, args });
        return Promise.resolve(
          name === "traceComments.listPendingOperations"
            ? [{ operation: "create", comment, cloudCommentId: null }]
            : undefined
        );
      },
      null,
      target,
      cloudOptions()
    );

    assert.deepEqual(urls, [
      "https://api.example.test/branches/branch-1/trace-comments?surface=branch_timeline",
      "https://api.example.test/branches/branch-1/trace-comments?surface=branch_timeline",
    ]);
    assert.equal(
      (storeCalls[0]?.args?.[0] as SharedTraceCommentStoreTarget).surface,
      TraceCommentSurface.BranchTimeline
    );
  });

  test("keeps mismatched create, update, and reply responses retryable", async () => {
    const urls: string[] = [];
    const baseComment = timelineComment();
    globalThis.fetch = (input, init) => {
      const url = String(input);
      urls.push(url);
      if (init?.method === "GET") {
        return Promise.resolve(Response.json({ success: true, data: [] }));
      }
      if (init?.method === "PATCH") {
        return Promise.resolve(
          Response.json({
            success: true,
            data: { ...baseComment, artifactId: "wrong-artifact" },
          })
        );
      }
      if (url.includes("/replies")) {
        return Promise.resolve(
          Response.json({
            success: true,
            data: {
              ...baseComment,
              target: { ...baseComment.target, id: "wrong-branch" },
            },
          })
        );
      }
      return Promise.resolve(
        Response.json({
          success: true,
          data: {
            ...baseComment,
            surface: TraceCommentSurface.BranchDetail,
          },
        })
      );
    };
    const target: SharedTraceCommentStoreTarget = {
      type: TraceCommentTargetType.Branch,
      id: "branch-1",
      surface: TraceCommentSurface.BranchTimeline,
    };
    const storeCalls: Array<{ name: string; args: unknown[] | undefined }> = [];

    await runTraceCommentCloudSync(
      (name, args) => {
        storeCalls.push({ name, args });
        return Promise.resolve(
          name === "traceComments.listPendingOperations"
            ? [
                {
                  operation: "create",
                  comment: baseComment,
                  cloudCommentId: null,
                },
                {
                  operation: "update",
                  comment: baseComment,
                  cloudCommentId: "cloud-update",
                },
                {
                  operation: "reply",
                  comment: baseComment,
                  cloudCommentId: "cloud-reply",
                  localReplyId: "local-reply",
                  reply: {
                    id: "local-reply",
                    threadId: baseComment.threadId,
                    body: "Reply",
                    createdAt: baseComment.createdAt,
                    updatedAt: baseComment.updatedAt,
                    editedAt: null,
                    authorId: "user-1",
                    authorName: "User",
                    authorAvatarUrl: null,
                    canEdit: true,
                    canDelete: true,
                  },
                },
              ]
            : undefined
        );
      },
      null,
      target,
      cloudOptions()
    );

    assert.deepEqual(urls, [
      "https://api.example.test/branches/branch-1/trace-comments?surface=branch_timeline",
      "https://api.example.test/branches/branch-1/trace-comments?surface=branch_timeline",
      "https://api.example.test/branches/branch-1/trace-comments/cloud-update?surface=branch_timeline",
      "https://api.example.test/branches/branch-1/trace-comments/cloud-reply/replies?surface=branch_timeline",
    ]);
    assert.equal(
      storeCalls.filter(({ name }) => name === "traceComments.markSyncFailed")
        .length,
      2
    );
    assert.equal(
      storeCalls.filter(
        ({ name }) => name === "traceComments.markReplySyncFailed"
      ).length,
      1
    );
    assert.equal(
      storeCalls.some(
        ({ name }) =>
          name === "traceComments.markUploaded" ||
          name === "traceComments.markReplyUploaded"
      ),
      false
    );
  });
});

function timelineComment(): TraceComment {
  const createdAt = "2026-08-07T12:00:00.000Z";
  return {
    id: "local-1",
    threadId: "local-thread-1",
    target: { type: TraceCommentTargetType.Branch, id: "branch-1" },
    artifactId: "branch-1",
    surface: TraceCommentSurface.BranchTimeline,
    status: ThreadStatus.Open,
    resolvedAt: null,
    resolvedById: null,
    resolvedByName: null,
    resolvedByAvatarUrl: null,
    kind: TraceCommentKind.Comment,
    anchor: {
      traceId: "trace-1",
      turnId: "turn-1",
      row: 1,
      selectedText: "selected",
      sourceText: "selected text",
      startOffset: 0,
      endOffset: 8,
    },
    body: "Timeline comment",
    createdAt,
    updatedAt: createdAt,
    editedAt: null,
    authorId: "user-1",
    authorName: "User",
    authorAvatarUrl: null,
    canEdit: true,
    canDelete: true,
    replies: [],
  };
}

function cloudOptions(): AgentDashboardDesignSystemRuntimeOptions {
  return {
    getWindow: () => null,
    isTrustedSender: () => true,
    onTerminalFailure: () => undefined,
    getAccessToken: () => Promise.resolve("token"),
    getApiOrigin: () => "https://api.example.test",
    hasDesktopSessionAuth: () => true,
  };
}
