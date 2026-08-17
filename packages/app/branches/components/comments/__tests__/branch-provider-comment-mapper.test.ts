import {
  BranchCommentsState,
  type BranchPrComment,
  BranchPrCommentKind,
  type BranchPrCommentsResponse,
} from "@repo/api/src/types/branch";
import { describe, expect, it } from "vitest";
import { mapSelectedProviderComments } from "../branch-provider-comment-mapper";

describe("mapSelectedProviderComments", () => {
  it("carries root, reply, and independent availability evidence", () => {
    const response = makeResponse();

    const result = mapSelectedProviderComments(
      response,
      "branch-1",
      "ClosedLoop-AI/Symphony-Alpha#42"
    );

    expect(result?.availability).toEqual({
      bodyTruncatedCount: 2,
      mixedProjection: true,
      omittedComments: 3,
      providerTruncated: true,
      responseTruncated: true,
      stale: true,
      state: BranchCommentsState.StaleMixed,
    });
    expect(result?.threads).toHaveLength(1);
    expect(result?.threads[0]).toMatchObject({
      author: {
        avatarUrl: "https://avatars.example/root.png",
        id: "root-login",
        name: "Root Reviewer",
      },
      provider: {
        bodyTruncated: true,
        inReplyToId: null,
        kind: BranchPrCommentKind.Review,
        line: 42,
        login: "root-login",
        path: "packages/app/root.tsx",
        providerUrl:
          "https://github.com/closedloop-ai/symphony-alpha/pull/42#discussion_r1",
        resolved: false,
        stale: true,
        threadId: "thread-1",
      },
      pullRequestKey: "ClosedLoop-AI/Symphony-Alpha#42",
    });
    expect(result?.threads[0]?.replies[0]).toMatchObject({
      author: {
        avatarUrl: "https://avatars.example/reply.png",
        id: "reply-login",
        name: "reply-login",
      },
      provider: {
        bodyTruncated: true,
        inReplyToId: "root-1",
        kind: BranchPrCommentKind.ReviewReply,
        login: "reply-login",
        providerUrl:
          "https://github.com/closedloop-ai/symphony-alpha/pull/42#discussion_r2",
        resolved: true,
        stale: true,
        threadId: "thread-1",
      },
    });
  });

  it("fails closed for absent, malformed, or mismatched selection", () => {
    const response = makeResponse();

    expect(mapSelectedProviderComments(response, "branch-1", null)).toBeNull();
    expect(
      mapSelectedProviderComments(response, "branch-1", "malformed")
    ).toBeNull();
    expect(
      mapSelectedProviderComments(response, "branch-1", "other/repo#42")
    ).toBeNull();
    expect(
      mapSelectedProviderComments(
        response,
        "branch-1",
        "closedloop-ai/symphony-alpha#41"
      )
    ).toBeNull();
    expect(
      mapSelectedProviderComments(
        response,
        "branch-2",
        "closedloop-ai/symphony-alpha#42"
      )
    ).toBeNull();
  });

  it("omits unsafe or selection-mismatched provider links", () => {
    const response = makeResponse();
    response.comments[0]!.providerUrl = "javascript:alert(1)";
    response.comments[1]!.providerUrl =
      "https://github.example/closedloop-ai/symphony-alpha/pull/42#discussion_r2";

    const result = mapSelectedProviderComments(
      response,
      "branch-1",
      "closedloop-ai/symphony-alpha#42"
    );

    expect(result?.threads[0]?.provider?.providerUrl).toBeNull();
    expect(result?.threads[0]?.replies[0]?.provider?.providerUrl).toBeNull();

    response.comments[0]!.providerUrl =
      "https://github.com/closedloop-ai/other-repo/pull/42#issuecomment-1";
    response.comments[1]!.providerUrl =
      "https://github.com/closedloop-ai/symphony-alpha/pull/41#discussion_r2";

    const mismatchedPathResult = mapSelectedProviderComments(
      response,
      "branch-1",
      "closedloop-ai/symphony-alpha#42"
    );

    expect(mismatchedPathResult?.threads[0]?.provider?.providerUrl).toBeNull();
    expect(
      mismatchedPathResult?.threads[0]?.replies[0]?.provider?.providerUrl
    ).toBeNull();
  });

  it("renders every returned orphan reply exactly once", () => {
    const response = makeResponse();
    response.comments = [
      response.comments[0]!,
      response.comments[1]!,
      makeComment({
        id: "orphan-reply",
        inReplyToId: "omitted-root",
        kind: BranchPrCommentKind.ReviewReply,
        providerNodeId: "orphan-node",
        providerUrl:
          "https://github.com/closedloop-ai/symphony-alpha/pull/42#discussion_r3",
        threadId: "omitted-thread",
      }),
    ];

    const result = mapSelectedProviderComments(
      response,
      "branch-1",
      "closedloop-ai/symphony-alpha#42"
    );

    expect(result?.threads).toHaveLength(2);
    expect(result?.threads[0]?.replies).toHaveLength(1);
    expect(result?.threads[1]).toMatchObject({
      id: "provider:orphan-node",
      provider: {
        inReplyToId: "omitted-root",
        kind: BranchPrCommentKind.ReviewReply,
      },
      replies: [],
    });
  });

  it("does not attach one reply to duplicate roots sharing a thread", () => {
    const response = makeResponse();
    response.comments.splice(
      1,
      0,
      makeComment({
        id: "root-2",
        providerNodeId: "root-2-node",
        threadId: "thread-1",
      })
    );

    const result = mapSelectedProviderComments(
      response,
      "branch-1",
      "closedloop-ai/symphony-alpha#42"
    );

    expect(result?.threads).toHaveLength(2);
    expect(result?.threads.flatMap((thread) => thread.replies)).toHaveLength(1);
  });

  it("keeps issue and review comment ID namespaces distinct", () => {
    const response = makeResponse();
    response.comments = [
      makeComment({
        id: "shared-id",
        kind: BranchPrCommentKind.Issue,
        providerCommentId: "shared-id",
        providerNodeId: "issue-node",
        threadId: null,
      }),
      makeComment({
        id: "shared-id",
        kind: BranchPrCommentKind.Review,
        providerCommentId: "shared-id",
        providerNodeId: "review-node",
        threadId: "review-thread",
      }),
      makeComment({
        id: "reply-id",
        inReplyToId: "shared-id",
        kind: BranchPrCommentKind.ReviewReply,
        providerCommentId: "reply-id",
        providerNodeId: "reply-node",
        threadId: "review-thread",
      }),
    ];

    const result = mapSelectedProviderComments(
      response,
      "branch-1",
      "closedloop-ai/symphony-alpha#42"
    );

    expect(result?.threads.map((thread) => thread.id)).toEqual([
      "provider:issue-node",
      "provider:review-node",
    ]);
    expect(result?.threads[0]?.replies).toHaveLength(0);
    expect(result?.threads[1]?.replies[0]?.id).toBe("provider:reply-node");
  });
});

function makeResponse(): BranchPrCommentsResponse {
  return {
    branchId: "branch-1",
    budget: {
      bodyTruncatedCount: 2,
      maxBodyBytes: 16_384,
      maxComments: 100,
      maxResponseBytes: 524_288,
      omittedComments: 3,
      pageSize: 50,
      providerTruncated: true,
      responseTruncated: true,
    },
    comments: [
      makeComment({
        author: {
          avatarUrl: "https://avatars.example/root.png",
          displayName: "Root Reviewer",
          login: "root-login",
          profileUrl: "https://github.com/root-login",
        },
        id: "root-1",
        kind: BranchPrCommentKind.Review,
        line: 42,
        path: "packages/app/root.tsx",
        providerNodeId: "root-node",
        providerUrl:
          "https://github.com/closedloop-ai/symphony-alpha/pull/42#discussion_r1",
        resolved: false,
      }),
      makeComment({
        author: {
          avatarUrl: "https://avatars.example/reply.png",
          displayName: null,
          login: "reply-login",
          profileUrl: "https://github.com/reply-login",
        },
        id: "reply-1",
        inReplyToId: "root-1",
        kind: BranchPrCommentKind.ReviewReply,
        providerNodeId: "reply-node",
        providerUrl:
          "https://github.com/closedloop-ai/symphony-alpha/pull/42#discussion_r2",
        resolved: true,
      }),
    ],
    mixedProjection: true,
    prNumber: 42,
    prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
    providerProofedAt: "2026-08-10T12:00:00.000Z",
    repositoryFullName: "closedloop-ai/symphony-alpha",
    stale: true,
    state: BranchCommentsState.StaleMixed,
  };
}

function makeComment(overrides: Partial<BranchPrComment>): BranchPrComment {
  return {
    author: {
      avatarUrl: null,
      displayName: null,
      login: "reviewer",
      profileUrl: null,
    },
    body: "Provider Markdown",
    bodyTruncated: true,
    createdAt: "2026-08-10T10:00:00.000Z",
    id: "comment-1",
    inReplyToId: null,
    kind: BranchPrCommentKind.Issue,
    line: null,
    path: null,
    providerCommentId: "1",
    providerNodeId: "node-1",
    providerUrl: null,
    resolved: null,
    stale: true,
    threadId: "thread-1",
    updatedAt: null,
    ...overrides,
  };
}
