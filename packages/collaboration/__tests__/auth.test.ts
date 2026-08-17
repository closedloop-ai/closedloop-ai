import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticate } from "../server/auth";
import { ROOM_NAMESPACES } from "../shared/room-utils";

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
vi.mock("../server/keys", () => ({
  keys: () => ({ LIVEBLOCKS_SECRET: "test-secret-key" }),
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
    it("authenticates user and returns token", async () => {
      const result = await authenticate({
        userId: "user-123",
        organizationId: "org-123",
        userInfo: {
          name: "John Doe",
          avatar: "https://example.com/avatar.jpg",
          color: "var(--color-blue)",
        },
      });

      expect(result.token).toBe("mock-liveblocks-token");
      expect(result.status).toBe(200);
    });

    it("prepares session with userId, userInfo, and organizationId", async () => {
      await authenticate({
        userId: "user-123",
        organizationId: "org-456",
        userInfo: {
          name: "Jane Smith",
          avatar: undefined,
          color: "var(--color-red)",
        },
      });

      expect(mockPrepareSession).toHaveBeenCalledWith("user-123", {
        userInfo: {
          name: "Jane Smith",
          avatar: undefined,
          color: "var(--color-red)",
        },
        organizationId: "org-456",
      });
    });

    it("grants wildcard access to organization artifact rooms", async () => {
      await authenticate({
        userId: "user-123",
        organizationId: "org-456",
        userInfo: {
          name: "Test User",
          color: "var(--color-blue)",
        },
      });

      expect(mockAllow).toHaveBeenCalledWith(
        "org-456:artifact:*",
        "full-access-constant"
      );
    });

    it("grants every namespace the room parser accepts, at the same org scope", async () => {
      // PR #4285 reviewer wongk: `parseDocumentRoomId` still accepts the
      // pre-rename `:document:` namespace (Liveblocks room IDs are immutable, so
      // that compatibility arm is permanent), but the session used to allow only
      // `:artifact:*`. A legacy room therefore parsed, authorized with a 200, and
      // returned a token with no permission for the room it was minted for.
      // Derived from ROOM_NAMESPACES rather than listed here, so the grant and
      // the parser cannot drift apart again.
      await authenticate({
        userId: "user-123",
        organizationId: "org-456",
        userInfo: { name: "Test User", color: "var(--color-blue)" },
      });

      for (const namespace of ROOM_NAMESPACES) {
        expect(mockAllow).toHaveBeenCalledWith(
          `org-456:${namespace}:*`,
          "full-access-constant"
        );
      }
      expect(mockAllow).toHaveBeenCalledTimes(ROOM_NAMESPACES.length);
    });

    it("scopes every grant to the caller's own organization", async () => {
      await authenticate({
        userId: "user-123",
        organizationId: "org-tenant-a",
        userInfo: { name: "Test User", color: "var(--color-blue)" },
      });

      for (const [room] of mockAllow.mock.calls) {
        expect(String(room).startsWith("org-tenant-a:")).toBe(true);
      }
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
        organizationId: "org-123",
        userInfo,
      });

      expect(mockPrepareSession).toHaveBeenCalledWith(
        "user-123",
        expect.objectContaining({ userInfo })
      );
    });

    it("passes userInfo without avatar", async () => {
      const userInfo = {
        name: "No Avatar User",
        color: "var(--color-orange)",
      };

      await authenticate({
        userId: "user-123",
        organizationId: "org-123",
        userInfo,
      });

      expect(mockPrepareSession).toHaveBeenCalledWith(
        "user-123",
        expect.objectContaining({ userInfo })
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
        organizationId: "org-123",
        userInfo,
      });

      expect(mockPrepareSession).toHaveBeenCalledWith(
        "user-123",
        expect.objectContaining({ userInfo })
      );
    });
  });

  describe("error handling", () => {
    it("throws error when LIVEBLOCKS_SECRET is not set", async () => {
      vi.resetModules();
      vi.doMock("../server/keys", () => ({
        keys: () => ({ LIVEBLOCKS_SECRET: undefined }),
      }));

      const { authenticate: authenticateNoSecret } = await import(
        "../server/auth"
      );

      await expect(
        authenticateNoSecret({
          userId: "user-123",
          organizationId: "org-123",
          userInfo: { name: "Test", color: "red" },
        })
      ).rejects.toThrow("LIVEBLOCKS_SECRET is not set");
    });

    it("propagates authorization errors", async () => {
      mockAuthorize.mockRejectedValueOnce(new Error("Authorization failed"));

      await expect(
        authenticate({
          userId: "user-123",
          organizationId: "org-123",
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
        organizationId: "org-123",
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
        organizationId: "org-123",
        userInfo: { name: "Test", color: "blue" },
      });

      expect(mockPrepareSession).toHaveBeenCalledWith(
        "unique-user-id-789",
        expect.any(Object)
      );
    });

    it("forwards organizationId to the Liveblocks session", async () => {
      await authenticate({
        userId: "user-123",
        organizationId: "org-tenant-test",
        userInfo: { name: "Tenant User", color: "var(--color-gray)" },
      });

      expect(mockPrepareSession).toHaveBeenCalledWith("user-123", {
        userInfo: { name: "Tenant User", color: "var(--color-gray)" },
        organizationId: "org-tenant-test",
      });
    });
  });
});
