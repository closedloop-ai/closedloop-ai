import { GitHubCommentThreadKind } from "@repo/api/src/types/branch-view";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerGetDocumentComments } from "../tools/get-document-comments.js";

const registerTool = vi.fn();
const apiClient = {
  get: vi.fn(),
};

describe("get-document-comments MCP tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerGetDocumentComments({ registerTool } as never, apiClient as never);
  });

  it("maps document comments to the narrow MCP output shape without GitHub projection fields", async () => {
    apiClient.get.mockResolvedValue([
      {
        id: "thread-1",
        status: "OPEN",
        artifactId: "artifact-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        githubProjection: {
          pullRequestDetailId: "pr-detail-1",
          threadKind: GitHubCommentThreadKind.ReviewThread,
          rootCommentId: "root-comment-1",
          reviewThreadId: "review-thread-1",
          deletedAt: "2026-01-02T00:00:00.000Z",
          lastSyncedAt: "2026-01-03T00:00:00.000Z",
        },
        comments: [
          {
            id: "comment-1",
            plainText: "hello",
            createdAt: "2026-01-01T00:00:00.000Z",
            authorId: "user-1",
            githubProjection: {
              githubCommentId: "github-comment-1",
              githubInReplyToCommentId: "github-parent-1",
              githubDeletedAt: "2026-01-02T00:00:00.000Z",
            },
          },
        ],
      },
    ]);

    const response = await registeredHandler()?.({
      documentId: "PRD-7",
    });
    const text = response?.content?.[0]?.text ?? "";

    expect(apiClient.get).toHaveBeenCalledWith("/documents/PRD-7/threads");
    expect(JSON.parse(text)).toEqual([
      {
        id: "thread-1",
        status: "OPEN",
        artifactId: "artifact-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        comments: [
          {
            id: "comment-1",
            plainText: "hello",
            createdAt: "2026-01-01T00:00:00.000Z",
            author: "user-1",
          },
        ],
      },
    ]);
    expect(text).not.toContain("githubProjection");
    expect(text).not.toContain("pullRequestDetailId");
    expect(text).not.toContain("threadKind");
    expect(text).not.toContain("rootCommentId");
    expect(text).not.toContain("reviewThreadId");
    expect(text).not.toContain("githubCommentId");
    expect(text).not.toContain("githubInReplyToCommentId");
    expect(text).not.toContain("githubDeletedAt");
    expect(text).not.toContain("lastSyncedAt");
  });
});

function registeredHandler():
  | ((input: { documentId: string; status?: string }) => Promise<{
      content?: { text?: string }[];
    }>)
  | undefined {
  return registerTool.mock.calls[0]?.[2];
}
