import { GitHubCommentThreadKind } from "@repo/api/src/types/branch-view";
import {
  DocumentThreadAnchorStatus,
  ThreadSource,
  ThreadStatus,
} from "@repo/api/src/types/comment";
import { CommentAnchorState } from "@repo/api/src/types/comment-anchor";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
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
        source: ThreadSource.Github,
        metadata: null,
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
        source: ThreadSource.Github,
        anchorStatus: null,
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

  it("lists native document comments in the MCP read output (PLN-2187 Q-003)", async () => {
    apiClient.get.mockResolvedValue([
      {
        id: "thread-2",
        status: ThreadStatus.Open,
        source: ThreadSource.Native,
        metadata: null,
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

    expect(apiClient.get).toHaveBeenCalledWith("/documents/FEA-7/threads", {});
    expect(JSON.parse(text)).toEqual([
      {
        id: "thread-2",
        status: ThreadStatus.Open,
        source: ThreadSource.Native,
        anchorStatus: null,
        artifactId: "artifact-2",
        createdAt: "2026-02-01T00:00:00.000Z",
        comments: [
          {
            id: "comment-2",
            plainText: "triage note",
            createdAt: "2026-02-01T00:00:00.000Z",
            author: "user-2",
          },
        ],
      },
    ]);
  });

  it.each([
    [
      CommentAnchorKind.Text,
      CommentAnchorState.Anchored,
      DocumentThreadAnchorStatus.Anchored,
    ],
    [
      CommentAnchorKind.Text,
      CommentAnchorState.Moved,
      DocumentThreadAnchorStatus.Anchored,
    ],
    [
      CommentAnchorKind.Text,
      CommentAnchorState.Orphaned,
      DocumentThreadAnchorStatus.Floating,
    ],
    [
      CommentAnchorKind.Artifact,
      CommentAnchorState.Anchored,
      DocumentThreadAnchorStatus.ArtifactLevel,
    ],
  ])(
    "derives anchorStatus from a typed %s anchor in state %s, over metadata",
    async (kind, anchorState, expected) => {
      apiClient.get.mockResolvedValue([
        typedAnchorThread({
          anchor: kind === CommentAnchorKind.Text ? TEXT_ANCHOR : { kind },
          anchorState,
          metadata: {
            anchorStatus:
              expected === DocumentThreadAnchorStatus.Floating
                ? DocumentThreadAnchorStatus.Anchored
                : DocumentThreadAnchorStatus.Floating,
          },
        }),
      ]);

      expect(await readAnchorStatus()).toBe(expected);
    }
  );

  it.each([
    ["an older API that sends no typed anchor", {}],
    ["a null anchor", { anchor: null, anchorState: null }],
    ["an anchor kind this build does not know", { anchor: { kind: "canvas" } }],
    [
      "an anchor state this build does not know",
      { anchor: TEXT_ANCHOR, anchorState: "DRIFTED" },
    ],
    ["a text anchor with no state", { anchor: TEXT_ANCHOR, anchorState: null }],
    [
      "an outdated text anchor",
      { anchor: TEXT_ANCHOR, anchorState: CommentAnchorState.Outdated },
    ],
    ["an anchor that is not an object", { anchor: "text" }],
  ])("falls back to the metadata path for %s", async (_label, typed) => {
    apiClient.get.mockResolvedValue([
      typedAnchorThread({
        ...typed,
        metadata: { anchorStatus: METADATA_FALLBACK_STATUS },
      }),
    ]);

    expect(await readAnchorStatus()).toBe(METADATA_FALLBACK_STATUS);
  });

  it("reads an artifact anchor as artifact-level in a state this build does not know", async () => {
    apiClient.get.mockResolvedValue([
      typedAnchorThread({
        anchor: { kind: CommentAnchorKind.Artifact },
        anchorState: UNKNOWN_ANCHOR_STATE,
      }),
    ]);

    expect(await readAnchorStatus()).toBe(
      DocumentThreadAnchorStatus.ArtifactLevel
    );
  });

  it("leaves a metadata-less text anchor in a state this build does not know without a status", async () => {
    apiClient.get.mockResolvedValue([
      typedAnchorThread({
        anchor: TEXT_ANCHOR,
        anchorState: UNKNOWN_ANCHOR_STATE,
      }),
    ]);

    expect(await readAnchorStatus()).toBeNull();
  });

  it("keeps the typed anchor fields out of the MCP output", async () => {
    apiClient.get.mockResolvedValue([
      typedAnchorThread({
        anchor: TEXT_ANCHOR,
        anchorState: CommentAnchorState.Anchored,
        metadata: null,
      }),
    ]);

    const response = await registeredHandler()?.({ documentId: "PRD-7" });
    const [thread] = JSON.parse(response?.content?.[0]?.text ?? "[]") as Record<
      string,
      unknown
    >[];

    expect(Object.keys(thread ?? {}).sort()).toEqual(
      [
        "anchorStatus",
        "artifactId",
        "comments",
        "createdAt",
        "id",
        "source",
        "status",
      ].sort()
    );
  });

  it("exposes artifact-level status for unanchored Liveblocks document comments", async () => {
    apiClient.get.mockResolvedValue([
      {
        id: "thread-3",
        status: ThreadStatus.Open,
        source: ThreadSource.Liveblocks,
        metadata: {
          anchorStatus: DocumentThreadAnchorStatus.ArtifactLevel,
          version: 3,
        },
        artifactId: "artifact-3",
        createdAt: "2026-03-01T00:00:00.000Z",
        comments: [
          {
            id: "comment-3",
            plainText: "document-level note",
            createdAt: "2026-03-01T00:00:00.000Z",
            authorId: "user-3",
          },
        ],
      },
    ]);

    const response = await registeredHandler()?.({
      documentId: "FEA-7",
    });
    const text = response?.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text) as { anchorStatus?: string }[];

    expect(parsed[0]?.anchorStatus).toBe(
      DocumentThreadAnchorStatus.ArtifactLevel
    );
    expect(text).not.toContain('"metadata"');
  });

  it("exposes anchored status for anchored Liveblocks document comments", async () => {
    apiClient.get.mockResolvedValue([
      {
        id: "thread-4",
        status: ThreadStatus.Open,
        source: ThreadSource.Liveblocks,
        metadata: {
          anchorStatus: DocumentThreadAnchorStatus.Anchored,
          version: 3,
        },
        artifactId: "artifact-4",
        createdAt: "2026-03-02T00:00:00.000Z",
        comments: [
          {
            id: "comment-4",
            plainText: "anchored note",
            createdAt: "2026-03-02T00:00:00.000Z",
            authorId: "user-4",
          },
        ],
      },
    ]);

    const response = await registeredHandler()?.({
      documentId: "FEA-7",
    });
    const text = response?.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text) as { anchorStatus?: string }[];

    expect(parsed[0]?.anchorStatus).toBe(DocumentThreadAnchorStatus.Anchored);
  });

  it("keeps unknown Liveblocks anchor status unknown when no explicit metadata exists", async () => {
    apiClient.get.mockResolvedValue([
      {
        id: "thread-5",
        status: ThreadStatus.Open,
        source: ThreadSource.Liveblocks,
        metadata: {
          version: 3,
        },
        artifactId: "artifact-5",
        createdAt: "2026-03-03T00:00:00.000Z",
        comments: [
          {
            id: "comment-5",
            plainText: "legacy liveblocks note",
            createdAt: "2026-03-03T00:00:00.000Z",
            authorId: "user-5",
          },
        ],
      },
    ]);

    const response = await registeredHandler()?.({
      documentId: "FEA-7",
    });
    const text = response?.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text) as { anchorStatus?: string | null }[];

    expect(parsed[0]?.anchorStatus).toBeNull();
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

const TEXT_ANCHOR = {
  kind: CommentAnchorKind.Text,
  documentVersion: 3,
  quote: { exact: "quoted", prefix: "", suffix: "" },
};

/** No text anchor maps here, so reading it proves the metadata path ran. */
const METADATA_FALLBACK_STATUS = DocumentThreadAnchorStatus.ArtifactLevel;

/** A state a newer API could send that this build's schema does not know. */
const UNKNOWN_ANCHOR_STATE = "DRIFTED";

function typedAnchorThread(fields: Record<string, unknown>) {
  return {
    id: "thread-typed",
    status: ThreadStatus.Open,
    source: ThreadSource.Native,
    artifactId: "artifact-typed",
    createdAt: "2026-04-01T00:00:00.000Z",
    comments: [],
    ...fields,
  };
}

async function readAnchorStatus(): Promise<unknown> {
  const response = await registeredHandler()?.({ documentId: "PRD-7" });
  const [thread] = JSON.parse(response?.content?.[0]?.text ?? "[]") as {
    anchorStatus?: unknown;
  }[];
  return thread?.anchorStatus;
}

function registeredHandler():
  | ((input: { documentId: string; status?: string }) => Promise<{
      content?: { text?: string }[];
    }>)
  | undefined {
  return registerTool.mock.calls[0]?.[2];
}
