import { DocumentThreadAnchorStatus } from "@repo/api/src/types/comment";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  broadcastRoomEvent,
  createArtifactLevelThread,
  createArtifactThread,
  deleteArtifactThread,
  markArtifactThreadResolved,
  markArtifactThreadUnresolved,
  replyToArtifactThread,
} from "../server/room-management";
import { RoomEventType } from "../shared/room-events";

// Mock yjs-anchor
const mockFindAnchorText = vi.fn();
const mockAnchorThreadToText = vi.fn();

vi.mock("../server/yjs-anchor", () => ({
  findAnchorText: (...args: unknown[]) => mockFindAnchorText(...args),
  anchorThreadToText: (...args: unknown[]) => mockAnchorThreadToText(...args),
}));

// Mock @liveblocks/node
const mockCreateThread = vi.fn();
const mockDeleteThread = vi.fn();
const mockBroadcastEvent = vi.fn();
const mockCreateComment = vi.fn();
const mockMarkThreadAsResolved = vi.fn();
const mockMarkThreadAsUnresolved = vi.fn();

vi.mock("@liveblocks/node", () => {
  class MockLiveblocks {
    createThread = mockCreateThread;
    deleteThread = mockDeleteThread;
    broadcastEvent = mockBroadcastEvent;
    createComment = mockCreateComment;
    markThreadAsResolved = mockMarkThreadAsResolved;
    markThreadAsUnresolved = mockMarkThreadAsUnresolved;
  }

  return {
    Liveblocks: MockLiveblocks,
  };
});

// Mock keys
vi.mock("../server/keys", () => ({
  keys: () => ({ LIVEBLOCKS_SECRET: "sk_test-secret-key" }),
}));

describe("createArtifactThread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindAnchorText.mockResolvedValue(undefined);
    mockAnchorThreadToText.mockResolvedValue(undefined);
  });

  describe("success path", () => {
    it("calls createThread with correct roomId, userId, body, and metadata", async () => {
      const fakeThread = {
        type: "thread",
        id: "thread-123",
        roomId: "org:artifact:slug",
        createdAt: new Date(),
        updatedAt: new Date(),
        comments: [],
        metadata: { resolved: false },
      };
      mockCreateThread.mockResolvedValueOnce(fakeThread);

      const result = await createArtifactThread({
        roomId: "org:artifact:slug",
        userId: "user-1",
        bodyText: "Hello world",
        anchorText: "some anchor text",
      });

      expect(mockCreateThread).toHaveBeenCalledWith({
        roomId: "org:artifact:slug",
        data: {
          comment: {
            userId: "user-1",
            body: {
              version: 1,
              content: [
                {
                  type: "paragraph",
                  children: [{ text: "Hello world" }],
                },
              ],
            },
          },
          metadata: {
            resolved: false,
            anchorStatus: DocumentThreadAnchorStatus.Anchored,
          },
        },
      });

      expect(result).toBe(fakeThread);
    });

    it("propagates the returned ThreadData to the caller", async () => {
      const fakeThread = {
        type: "thread",
        id: "thread-456",
        roomId: "org:artifact:other",
        createdAt: new Date(),
        updatedAt: new Date(),
        comments: [{ id: "comment-1", userId: "user-1" }],
        metadata: { resolved: false },
      };
      mockCreateThread.mockResolvedValueOnce(fakeThread);

      const result = await createArtifactThread({
        roomId: "org:artifact:other",
        userId: "user-1",
        bodyText: "Test comment",
        anchorText: "some anchor text",
      });

      expect(result).toStrictEqual(fakeThread);
    });
  });

  describe("secret not configured", () => {
    it("throws a descriptive error when LIVEBLOCKS_SECRET is not set", async () => {
      vi.resetModules();
      vi.doMock("../server/keys", () => ({
        keys: () => ({ LIVEBLOCKS_SECRET: undefined }),
      }));

      const { createArtifactThread: createArtifactThreadNoSecret } =
        await import("../server/room-management");

      await expect(
        createArtifactThreadNoSecret({
          roomId: "org:artifact:slug",
          userId: "user-1",
          bodyText: "Hello world",
          anchorText: "some anchor text",
        })
      ).rejects.toThrow("LIVEBLOCKS_SECRET is not configured");
    });
  });

  describe("SDK error propagation", () => {
    it("propagates errors thrown by the Liveblocks SDK", async () => {
      mockCreateThread.mockRejectedValueOnce(new Error("Liveblocks API error"));

      await expect(
        createArtifactThread({
          roomId: "org:artifact:slug",
          userId: "user-1",
          bodyText: "Hello world",
          anchorText: "some anchor text",
        })
      ).rejects.toThrow("Liveblocks API error");
    });
  });

  describe("anchor rollback", () => {
    it("creates thread, anchor fails, deleteThread is called, error is rethrown", async () => {
      const fakeThread = {
        type: "thread",
        id: "thread-789",
        roomId: "org:artifact:slug",
        createdAt: new Date(),
        updatedAt: new Date(),
        comments: [],
        metadata: { resolved: false },
      };
      mockCreateThread.mockResolvedValueOnce(fakeThread);
      const anchorError = {
        message: "Anchor text not found in document",
        status: 400,
      };
      mockAnchorThreadToText.mockRejectedValueOnce(anchorError);
      mockDeleteThread.mockResolvedValueOnce(undefined);

      await expect(
        createArtifactThread({
          roomId: "org:artifact:slug",
          userId: "user-1",
          bodyText: "Hello world",
          anchorText: "some anchor text",
        })
      ).rejects.toEqual(anchorError);

      expect(mockDeleteThread).toHaveBeenCalledWith({
        roomId: "org:artifact:slug",
        threadId: fakeThread.id,
      });
    });

    it("anchor fails with status: 400, deleteThread error is suppressed, original 400 propagates", async () => {
      const fakeThread = {
        type: "thread",
        id: "thread-101",
        roomId: "org:artifact:slug",
        createdAt: new Date(),
        updatedAt: new Date(),
        comments: [],
        metadata: { resolved: false },
      };
      mockCreateThread.mockResolvedValueOnce(fakeThread);
      const anchorError = {
        message: "Anchor text not found in document",
        status: 400,
      };
      mockAnchorThreadToText.mockRejectedValueOnce(anchorError);
      mockDeleteThread.mockRejectedValueOnce(new Error("Delete failed"));

      await expect(
        createArtifactThread({
          roomId: "org:artifact:slug",
          userId: "user-1",
          bodyText: "Hello world",
          anchorText: "some anchor text",
        })
      ).rejects.toEqual(anchorError);

      expect(mockDeleteThread).toHaveBeenCalledWith({
        roomId: "org:artifact:slug",
        threadId: fakeThread.id,
      });
    });

    it("findAnchorText failure prevents thread creation", async () => {
      const anchorError = { message: "Anchor text not found", status: 400 };
      mockFindAnchorText.mockRejectedValueOnce(anchorError);

      await expect(
        createArtifactThread({
          roomId: "org:artifact:slug",
          userId: "user-1",
          bodyText: "Hello world",
          anchorText: "some anchor text",
        })
      ).rejects.toEqual(anchorError);

      expect(mockCreateThread).not.toHaveBeenCalled();
    });
  });
});

describe("createArtifactLevelThread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an artifact-level thread with version metadata and no anchor operations", async () => {
    const fakeThread = {
      type: "thread",
      id: "thread-artifact-level",
      roomId: "org:artifact:slug",
      createdAt: new Date(),
      updatedAt: new Date(),
      comments: [],
      metadata: {
        resolved: false,
        anchorStatus: DocumentThreadAnchorStatus.ArtifactLevel,
        version: 7,
      },
    };
    mockCreateThread.mockResolvedValueOnce(fakeThread);

    const result = await createArtifactLevelThread({
      roomId: "org:artifact:slug",
      userId: "user-1",
      bodyText: "Artifact-wide note",
      version: 7,
    });

    expect(mockCreateThread).toHaveBeenCalledWith({
      roomId: "org:artifact:slug",
      data: {
        comment: {
          userId: "user-1",
          body: {
            version: 1,
            content: [
              {
                type: "paragraph",
                children: [{ text: "Artifact-wide note" }],
              },
            ],
          },
        },
        metadata: {
          resolved: false,
          anchorStatus: DocumentThreadAnchorStatus.ArtifactLevel,
          version: 7,
        },
      },
    });
    expect(mockFindAnchorText).not.toHaveBeenCalled();
    expect(mockAnchorThreadToText).not.toHaveBeenCalled();
    expect(mockDeleteThread).not.toHaveBeenCalled();
    expect(result).toBe(fakeThread);
  });

  it("throws a descriptive error when LIVEBLOCKS_SECRET is not set", async () => {
    vi.resetModules();
    vi.doMock("../server/keys", () => ({
      keys: () => ({ LIVEBLOCKS_SECRET: undefined }),
    }));

    const { createArtifactLevelThread: createArtifactLevelThreadNoSecret } =
      await import("../server/room-management");

    await expect(
      createArtifactLevelThreadNoSecret({
        roomId: "org:artifact:slug",
        userId: "user-1",
        bodyText: "Hello world",
      })
    ).rejects.toThrow("LIVEBLOCKS_SECRET is not configured");
  });
});

describe("deleteArtifactThread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the Liveblocks thread for the supplied room", async () => {
    mockDeleteThread.mockResolvedValueOnce(undefined);

    await deleteArtifactThread({
      roomId: "org:artifact:slug",
      threadId: "thread-artifact-level",
    });

    expect(mockDeleteThread).toHaveBeenCalledWith({
      roomId: "org:artifact:slug",
      threadId: "thread-artifact-level",
    });
  });

  it("no-ops when LIVEBLOCKS_SECRET is not configured", async () => {
    vi.resetModules();
    vi.doMock("../server/keys", () => ({
      keys: () => ({ LIVEBLOCKS_SECRET: undefined }),
    }));

    const { deleteArtifactThread: deleteArtifactThreadNoSecret } = await import(
      "../server/room-management"
    );

    await expect(
      deleteArtifactThreadNoSecret({
        roomId: "org:artifact:slug",
        threadId: "thread-artifact-level",
      })
    ).resolves.toBeUndefined();
    expect(mockDeleteThread).not.toHaveBeenCalled();
  });
});

describe("broadcastRoomEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls Liveblocks.broadcastEvent with the room id and payload", async () => {
    mockBroadcastEvent.mockResolvedValueOnce(undefined);

    const result = await broadcastRoomEvent("org:artifact:slug", {
      type: RoomEventType.DocumentVersionPublished,
      version: 7,
      publisherId: "user-1",
      publishedAt: "2026-05-26T18:00:00.000Z",
    });

    expect(mockBroadcastEvent).toHaveBeenCalledWith("org:artifact:slug", {
      type: "document-version-published",
      version: 7,
      publisherId: "user-1",
      publishedAt: "2026-05-26T18:00:00.000Z",
    });
    expect(result).toEqual({ success: true });
  });

  it("returns an error result when the SDK throws (does not propagate)", async () => {
    mockBroadcastEvent.mockRejectedValueOnce(
      new Error("Liveblocks rate limit")
    );

    const result = await broadcastRoomEvent("org:artifact:slug", {
      type: RoomEventType.DocumentVersionPublished,
      version: 1,
      publisherId: null,
      publishedAt: "2026-05-26T18:00:00.000Z",
    });

    expect(result).toEqual({
      success: false,
      error: "Liveblocks rate limit",
    });
  });

  it("no-ops successfully when LIVEBLOCKS_SECRET is not configured", async () => {
    vi.resetModules();
    vi.doMock("../server/keys", () => ({
      keys: () => ({ LIVEBLOCKS_SECRET: undefined }),
    }));

    const { broadcastRoomEvent: broadcastNoSecret } = await import(
      "../server/room-management"
    );

    const result = await broadcastNoSecret("org:artifact:slug", {
      type: RoomEventType.DocumentVersionPublished,
      version: 1,
      publisherId: null,
      publishedAt: "2026-05-26T18:00:00.000Z",
    });

    expect(result).toEqual({ success: true });
    expect(mockBroadcastEvent).not.toHaveBeenCalled();
  });
});

describe("replyToArtifactThread (FEA-3950)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a flat reply comment on the thread and returns it", async () => {
    const fakeComment = { type: "comment", id: "cm_reply", threadId: "th_1" };
    mockCreateComment.mockResolvedValueOnce(fakeComment);

    const result = await replyToArtifactThread({
      roomId: "org:artifact:slug",
      threadId: "th_1",
      userId: "user-1",
      bodyText: "A reply",
    });

    expect(mockCreateComment).toHaveBeenCalledWith({
      roomId: "org:artifact:slug",
      threadId: "th_1",
      data: {
        userId: "user-1",
        body: {
          version: 1,
          content: [{ type: "paragraph", children: [{ text: "A reply" }] }],
        },
      },
    });
    expect(result).toBe(fakeComment);
  });
});

describe("markArtifactThreadResolved / markArtifactThreadUnresolved (FEA-3950)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks the thread resolved, attributing to the acting user", async () => {
    const resolvedThread = { type: "thread", id: "th_1" };
    mockMarkThreadAsResolved.mockResolvedValueOnce(resolvedThread);

    const result = await markArtifactThreadResolved({
      roomId: "org:artifact:slug",
      threadId: "th_1",
      userId: "user-1",
    });

    expect(mockMarkThreadAsResolved).toHaveBeenCalledWith({
      roomId: "org:artifact:slug",
      threadId: "th_1",
      data: { userId: "user-1" },
    });
    expect(result).toBe(resolvedThread);
  });

  it("marks the thread unresolved, attributing to the acting user", async () => {
    const openThread = { type: "thread", id: "th_1" };
    mockMarkThreadAsUnresolved.mockResolvedValueOnce(openThread);

    const result = await markArtifactThreadUnresolved({
      roomId: "org:artifact:slug",
      threadId: "th_1",
      userId: "user-1",
    });

    expect(mockMarkThreadAsUnresolved).toHaveBeenCalledWith({
      roomId: "org:artifact:slug",
      threadId: "th_1",
      data: { userId: "user-1" },
    });
    expect(result).toBe(openThread);
  });
});
