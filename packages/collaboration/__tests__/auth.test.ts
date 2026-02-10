import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticate } from "../auth";

// Mock @liveblocks/node
const mockAuthorize = vi.fn();
const mockAllow = vi.fn();
const mockPrepareSession = vi.fn();

vi.mock("@liveblocks/node", () => {
  class MockLiveblocks {
    prepareSession = mockPrepareSession;
  }

  return {
    Liveblocks: MockLiveblocks,
  };
});

// Mock keys
vi.mock("../keys", () => ({
  keys: () => ({ LIVEBLOCKS_SECRET: "test-secret-key" }),
}));

// Mock parseArtifactRoomId
vi.mock("../room-utils", () => ({
  parseArtifactRoomId: (roomId: string) => {
    const parts = roomId.split(":");
    if (parts.length !== 3 || parts[1] !== "artifact") {
      throw new Error("Invalid room ID format");
    }
    return {
      organizationId: parts[0],
      documentSlug: parts[2],
    };
  },
}));

describe("authenticate", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default mock implementation
    mockPrepareSession.mockReturnValue({
      allow: mockAllow,
      FULL_ACCESS: "full-access-constant",
      authorize: mockAuthorize,
    });

    mockAuthorize.mockResolvedValue({
      status: 200,
      body: "mock-liveblocks-token",
    });
  });

  describe("basic authentication", () => {
    it("authenticates user without roomId", async () => {
      const result = await authenticate({
        userId: "user-123",
        userInfo: {
          name: "John Doe",
          avatar: "https://example.com/avatar.jpg",
          color: "var(--color-blue)",
        },
      });

      expect(result.token).toBe("mock-liveblocks-token");
      expect(result.status).toBe(200);
      expect(mockPrepareSession).toHaveBeenCalledWith("user-123", {
        userInfo: {
          name: "John Doe",
          avatar: "https://example.com/avatar.jpg",
          color: "var(--color-blue)",
        },
        tenantId: undefined,
      });
      expect(mockAllow).not.toHaveBeenCalled();
    });

    it("authenticates user with roomId", async () => {
      const result = await authenticate({
        userId: "user-123",
        roomId: "org-456:artifact:doc-789",
        userInfo: {
          name: "Jane Smith",
          avatar: undefined,
          color: "var(--color-red)",
        },
      });

      expect(result.token).toBe("mock-liveblocks-token");
      expect(result.status).toBe(200);
      expect(mockPrepareSession).toHaveBeenCalledWith("user-123", {
        userInfo: {
          name: "Jane Smith",
          avatar: undefined,
          color: "var(--color-red)",
        },
        tenantId: "org-456",
      });
      expect(mockAllow).toHaveBeenCalledWith(
        "org-456:artifact:doc-789",
        "full-access-constant"
      );
    });
  });

  describe("tenant ID extraction", () => {
    it("extracts tenant ID from valid room ID", async () => {
      await authenticate({
        userId: "user-123",
        roomId: "org-abc:artifact:my-doc",
        userInfo: {
          name: "User Name",
          color: "var(--color-green)",
        },
      });

      expect(mockPrepareSession).toHaveBeenCalledWith(
        "user-123",
        expect.objectContaining({
          tenantId: "org-abc",
        })
      );
    });

    it("sets tenantId to undefined when roomId is invalid", async () => {
      await authenticate({
        userId: "user-123",
        roomId: "invalid-room-format",
        userInfo: {
          name: "User Name",
          color: "var(--color-green)",
        },
      });

      expect(mockPrepareSession).toHaveBeenCalledWith(
        "user-123",
        expect.objectContaining({
          tenantId: undefined,
        })
      );
      // Note: allow() is still called even though parsing failed, with the invalid roomId
      expect(mockAllow).toHaveBeenCalledWith(
        "invalid-room-format",
        "full-access-constant"
      );
    });

    it("sets tenantId to undefined when roomId has wrong type", async () => {
      await authenticate({
        userId: "user-123",
        roomId: "org-123:invalid-type:doc",
        userInfo: {
          name: "User Name",
          color: "var(--color-green)",
        },
      });

      expect(mockPrepareSession).toHaveBeenCalledWith(
        "user-123",
        expect.objectContaining({
          tenantId: undefined,
        })
      );
      // Note: allow() is still called even though parsing failed, with the invalid roomId
      expect(mockAllow).toHaveBeenCalledWith(
        "org-123:invalid-type:doc",
        "full-access-constant"
      );
    });
  });

  describe("room-scoped vs user-scoped tokens", () => {
    it("creates room-scoped token when roomId is provided", async () => {
      await authenticate({
        userId: "user-123",
        roomId: "org-456:artifact:test-doc",
        userInfo: {
          name: "Test User",
          color: "var(--color-blue)",
        },
      });

      expect(mockAllow).toHaveBeenCalledTimes(1);
      expect(mockAllow).toHaveBeenCalledWith(
        "org-456:artifact:test-doc",
        "full-access-constant"
      );
    });

    it("creates user-scoped token when roomId is not provided", async () => {
      await authenticate({
        userId: "user-123",
        userInfo: {
          name: "Test User",
          color: "var(--color-blue)",
        },
      });

      expect(mockAllow).not.toHaveBeenCalled();
    });

    it("creates room-scoped token when roomId parsing fails", async () => {
      await authenticate({
        userId: "user-123",
        roomId: "malformed:room",
        userInfo: {
          name: "Test User",
          color: "var(--color-blue)",
        },
      });

      // Note: allow() is still called even though parsing failed
      // The authenticate function checks if roomId is truthy, not if parsing succeeds
      expect(mockAllow).toHaveBeenCalledWith(
        "malformed:room",
        "full-access-constant"
      );
    });
  });

  describe("userInfo handling", () => {
    it("passes userInfo with all fields", async () => {
      const userInfo = {
        name: "Complete User",
        avatar: "https://example.com/avatar.png",
        color: "var(--color-purple)",
      };

      await authenticate({
        userId: "user-123",
        userInfo,
      });

      expect(mockPrepareSession).toHaveBeenCalledWith(
        "user-123",
        expect.objectContaining({
          userInfo,
        })
      );
    });

    it("passes userInfo without avatar", async () => {
      const userInfo = {
        name: "No Avatar User",
        color: "var(--color-orange)",
      };

      await authenticate({
        userId: "user-123",
        userInfo,
      });

      expect(mockPrepareSession).toHaveBeenCalledWith(
        "user-123",
        expect.objectContaining({
          userInfo,
        })
      );
    });

    it("passes userInfo with avatar as undefined", async () => {
      const userInfo = {
        name: "Undefined Avatar",
        avatar: undefined,
        color: "var(--color-yellow)",
      };

      await authenticate({
        userId: "user-123",
        userInfo,
      });

      expect(mockPrepareSession).toHaveBeenCalledWith(
        "user-123",
        expect.objectContaining({
          userInfo,
        })
      );
    });
  });

  describe("error handling", () => {
    it("throws error when LIVEBLOCKS_SECRET is not set", async () => {
      vi.resetModules();
      vi.doMock("../keys", () => ({
        keys: () => ({ LIVEBLOCKS_SECRET: undefined }),
      }));

      const { authenticate: authenticateNoSecret } = await import("../auth");

      await expect(
        authenticateNoSecret({
          userId: "user-123",
          userInfo: { name: "Test", color: "red" },
        })
      ).rejects.toThrow("LIVEBLOCKS_SECRET is not set");
    });

    it("propagates authorization errors", async () => {
      mockAuthorize.mockRejectedValueOnce(new Error("Authorization failed"));

      await expect(
        authenticate({
          userId: "user-123",
          userInfo: { name: "Test", color: "red" },
        })
      ).rejects.toThrow("Authorization failed");
    });

    it("returns error status from Liveblocks", async () => {
      mockAuthorize.mockResolvedValueOnce({
        status: 403,
        body: "Forbidden",
      });

      const result = await authenticate({
        userId: "user-123",
        userInfo: { name: "Test", color: "red" },
      });

      expect(result.status).toBe(403);
      expect(result.token).toBe("Forbidden");
    });
  });

  describe("session configuration", () => {
    it("configures session with correct userId", async () => {
      await authenticate({
        userId: "unique-user-id-789",
        userInfo: { name: "Test", color: "blue" },
      });

      expect(mockPrepareSession).toHaveBeenCalledWith(
        "unique-user-id-789",
        expect.any(Object)
      );
    });

    it("grants FULL_ACCESS to room when roomId is provided", async () => {
      const session = {
        allow: mockAllow,
        FULL_ACCESS: "full-access-constant",
        authorize: mockAuthorize,
      };
      mockPrepareSession.mockReturnValueOnce(session);

      await authenticate({
        userId: "user-123",
        roomId: "org-123:artifact:doc",
        userInfo: { name: "Test", color: "red" },
      });

      expect(mockAllow).toHaveBeenCalledWith(
        "org-123:artifact:doc",
        "full-access-constant"
      );
    });
  });

  describe("dual-mode behavior", () => {
    it("handles inbox mode (no roomId, has tenantId via undefined)", async () => {
      await authenticate({
        userId: "user-123",
        userInfo: { name: "Inbox User", color: "var(--color-gray)" },
      });

      expect(mockPrepareSession).toHaveBeenCalledWith("user-123", {
        userInfo: { name: "Inbox User", color: "var(--color-gray)" },
        tenantId: undefined,
      });
      expect(mockAllow).not.toHaveBeenCalled();
    });

    it("handles room mode (with roomId, tenantId extracted)", async () => {
      await authenticate({
        userId: "user-123",
        roomId: "org-999:artifact:my-room",
        userInfo: { name: "Room User", color: "var(--color-teal)" },
      });

      expect(mockPrepareSession).toHaveBeenCalledWith("user-123", {
        userInfo: { name: "Room User", color: "var(--color-teal)" },
        tenantId: "org-999",
      });
      expect(mockAllow).toHaveBeenCalledWith(
        "org-999:artifact:my-room",
        "full-access-constant"
      );
    });
  });
});
