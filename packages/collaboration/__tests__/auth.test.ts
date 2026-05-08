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

    it("prepares session with userId, userInfo, and tenantId", async () => {
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
        tenantId: "org-456",
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
      vi.doMock("../keys", () => ({
        keys: () => ({ LIVEBLOCKS_SECRET: undefined }),
      }));

      const { authenticate: authenticateNoSecret } = await import("../auth");

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

    it("uses organizationId as tenantId", async () => {
      await authenticate({
        userId: "user-123",
        organizationId: "org-tenant-test",
        userInfo: { name: "Tenant User", color: "var(--color-gray)" },
      });

      expect(mockPrepareSession).toHaveBeenCalledWith("user-123", {
        userInfo: { name: "Tenant User", color: "var(--color-gray)" },
        tenantId: "org-tenant-test",
      });
    });
  });
});
