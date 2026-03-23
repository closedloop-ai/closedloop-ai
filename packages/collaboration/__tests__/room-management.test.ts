import { beforeEach, describe, expect, it, vi } from "vitest";
import { createArtifactThread } from "../room-management";

// Mock @liveblocks/node
const mockCreateThread = vi.fn();

vi.mock("@liveblocks/node", () => {
  class MockLiveblocks {
    createThread = mockCreateThread;
  }

  return {
    Liveblocks: MockLiveblocks,
  };
});

// Mock keys
vi.mock("../keys", () => ({
  keys: () => ({ LIVEBLOCKS_SECRET: "sk_test-secret-key" }),
}));

describe("createArtifactThread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      });

      expect(result).toStrictEqual(fakeThread);
    });
  });

  describe("secret not configured", () => {
    it("throws a descriptive error when LIVEBLOCKS_SECRET is not set", async () => {
      vi.resetModules();
      vi.doMock("../keys", () => ({
        keys: () => ({ LIVEBLOCKS_SECRET: undefined }),
      }));

      const { createArtifactThread: createArtifactThreadNoSecret } =
        await import("../room-management");

      await expect(
        createArtifactThreadNoSecret({
          roomId: "org:artifact:slug",
          userId: "user-1",
          bodyText: "Hello world",
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
        })
      ).rejects.toThrow("Liveblocks API error");
    });
  });
});
