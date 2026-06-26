import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  broadcastRoomEvent,
  createArtifactThread,
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

vi.mock("@liveblocks/node", () => {
  class MockLiveblocks {
    createThread = mockCreateThread;
    deleteThread = mockDeleteThread;
    broadcastEvent = mockBroadcastEvent;
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
          metadata: { resolved: false },
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
