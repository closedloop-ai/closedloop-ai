import { GitHubCommentThreadKind } from "@repo/api/src/types/branch-view";
import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
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
        status: ThreadStatus.Open,
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

    expect(apiClient.get).toHaveBeenCalledWith("/documents/PRD-7/threads", {});
    expect(JSON.parse(text)).toEqual([
      {
        id: "thread-1",
        status: ThreadStatus.Open,
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

  it("includes source in the output for threads that have a source value", async () => {
    apiClient.get.mockResolvedValue([
      {
        id: "thread-2",
        status: ThreadStatus.Open,
        source: ThreadSource.Native,
        artifactId: "artifact-2",
        createdAt: "2026-02-01T00:00:00.000Z",
        comments: [
          {
            id: "comment-2",
            plainText: "triage note",
            createdAt: "2026-02-01T00:00:00.000Z",
            authorId: "user-2",
          },
        ],
      },
    ]);

    const response = await registeredHandler()?.({
      documentId: "FEA-7",
    });
    const text = response?.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text) as { source?: string }[];

    expect(apiClient.get).toHaveBeenCalledWith("/documents/FEA-7/threads", {});
    expect(parsed[0]?.source).toBe(ThreadSource.Native);
    expect(text).toContain('"source"');
    expect(text).toContain(ThreadSource.Native);
  });

  it("passes the status filter through apiClient.get's query parameter", async () => {
    apiClient.get.mockResolvedValue([]);

    await registeredHandler()?.({
      documentId: "PRD-7",
      status: ThreadStatus.Open,
    });

    expect(apiClient.get).toHaveBeenCalledWith("/documents/PRD-7/threads", {
      status: ThreadStatus.Open,
    });
  });
});

function registeredHandler():
  | ((input: { documentId: string; status?: string }) => Promise<{
      content?: { text?: string }[];
    }>)
  | undefined {
  return registerTool.mock.calls[0]?.[2];
}
