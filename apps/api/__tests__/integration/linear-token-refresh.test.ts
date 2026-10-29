import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { getTeams, refreshAccessToken } from "@repo/linear";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { linearService } from "@/app/integrations/linear/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
} from "../utils/db-helpers";

// Skip integration tests if no DATABASE_URL is configured
const env = keys();
const hasDatabase = !!env.DATABASE_URL;

// Mock Linear API functions
vi.mock("@repo/linear", async () => {
  const actual = await vi.importActual("@repo/linear");
  return {
    ...actual,
    refreshAccessToken: vi.fn(),
    getTeams: vi.fn(),
  };
});

// Mock encryption to avoid requiring AWS_REGION / KMS in CI
vi.mock("@/lib/integration-encryption", () => ({
  encryptIntegrationToken: vi.fn().mockResolvedValue("mock-encrypted-token"),
  decryptIntegrationToken: vi
    .fn()
    .mockImplementation((token: string) => Promise.resolve(token)),
  // Identity "decryption": a row's stored ciphertext IS its token here.
  resolveEncryptedIntegrationToken: vi
    .fn()
    .mockImplementation((encrypted: string | null) =>
      Promise.resolve(encrypted)
    ),
  encryptTokenPair: vi.fn().mockResolvedValue({
    encryptedAccessToken: "mock-encrypted-access",
    encryptedRefreshToken: "mock-encrypted-refresh",
  }),
  // Mirrors the real helper's encrypt-succeeded path: ciphertext stored, and
  // the refresh half omitted entirely when the caller has no refresh token to
  // store.
  buildIntegrationTokenColumns: vi
    .fn()
    .mockImplementation(
      (_accessToken: string, refreshToken: string | null | undefined) =>
        Promise.resolve({
          accessTokenEncrypted: "mock-encrypted-access",
          ...(refreshToken
            ? { refreshTokenEncrypted: "mock-encrypted-refresh" }
            : {}),
        })
    ),
}));

const mockRefreshAccessToken = refreshAccessToken as Mock;
const mockGetTeams = getTeams as Mock;
const PINNED_NOW_MS = Date.parse("2026-07-01T00:00:00.000Z");

describe.skipIf(!hasDatabase)("Linear Token Refresh Integration", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns valid token when not expired", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();

      // Create integration with non-expired token
      const accessToken = "valid_access_token";

      await withDb((db) =>
        db.linearIntegration.create({
          data: {
            organizationId: orgId,
            accessTokenEncrypted: accessToken,
            refreshTokenEncrypted: "refresh_token",
            linearOrgId: "org_123",
            linearOrgName: "Test Org",
            defaultTeamId: "team_1",
            tokenExpiresAt: new Date(Date.now() + 3_600_000), // Expires in 1 hour
          },
        })
      );

      // Get integration status (which calls ensureValidAccessToken internally)
      const result = await linearService.getIntegrationStatus(orgId);

      expect(result.success).toBe(true);
      expect(result.connected).toBe(true);

      // Verify refresh was NOT called
      expect(mockRefreshAccessToken).not.toHaveBeenCalled();

      // Verify token was not updated in database
      const integration = await withDb((db) =>
        db.linearIntegration.findUnique({
          where: { organizationId: orgId },
        })
      );

      expect(integration?.accessTokenEncrypted).toBe(accessToken);
    });
  });

  it("refreshes expired token and stores new tokens", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();

      // Create integration with expired token
      const oldAccessToken = "expired_access_token";
      const oldRefreshToken = "valid_refresh_token";

      await withDb((db) =>
        db.linearIntegration.create({
          data: {
            organizationId: orgId,
            accessTokenEncrypted: oldAccessToken,
            refreshTokenEncrypted: oldRefreshToken,
            linearOrgId: "org_123",
            linearOrgName: "Test Org",
            defaultTeamId: "team_1",
            tokenExpiresAt: new Date(Date.now() - 3_600_000), // Expired 1 hour ago
          },
        })
      );

      // Mock successful token refresh
      mockRefreshAccessToken.mockResolvedValue({
        accessToken: "new_access_token",
        refreshToken: "new_refresh_token",
        expiresIn: 7200,
        tokenType: "Bearer",
        scope: ["read", "write", "issues:create"],
      });

      // Try to get integration status (will trigger refresh). `Date.now` is
      // pinned across the call so the refreshed expiry is exact rather than
      // merely "in the future" — see the sibling expiry test.
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(PINNED_NOW_MS);
      let result: Awaited<
        ReturnType<typeof linearService.getIntegrationStatus>
      >;
      try {
        result = await linearService.getIntegrationStatus(orgId);
      } finally {
        nowSpy.mockRestore();
      }

      expect(result.success).toBe(true);
      expect(result.connected).toBe(true);

      // Verify refresh was called with the old refresh token
      expect(mockRefreshAccessToken).toHaveBeenCalledWith(oldRefreshToken);

      // Verify tokens were updated in database
      const integration = await withDb((db) =>
        db.linearIntegration.findUnique({
          where: { organizationId: orgId },
        })
      );

      // The refreshed credential lands as ciphertext.
      expect(integration?.accessTokenEncrypted).toBe("mock-encrypted-access");
      expect(integration?.refreshTokenEncrypted).toBe("mock-encrypted-refresh");

      // Token expiry should be updated to exactly the refresh TTL past the
      // pinned clock.
      expect(integration?.tokenExpiresAt?.getTime()).toBe(
        PINNED_NOW_MS + 7200 * 1000
      );
    });
  });

  it("returns error when refresh fails", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();

      // Create integration with expired token
      await withDb((db) =>
        db.linearIntegration.create({
          data: {
            organizationId: orgId,
            accessTokenEncrypted: "expired_access_token",
            refreshTokenEncrypted: "invalid_refresh_token",
            linearOrgId: "org_123",
            linearOrgName: "Test Org",
            defaultTeamId: "team_1",
            tokenExpiresAt: new Date(Date.now() - 3_600_000), // Expired
          },
        })
      );

      // Mock refresh failure
      mockRefreshAccessToken.mockRejectedValue(
        new Error("Token refresh failed: 401")
      );

      // Try to get integration status
      const result = await linearService.getIntegrationStatus(orgId);

      // Should return disconnected when refresh fails
      expect(result.success).toBe(true);
      expect(result.connected).toBe(false);

      // Verify refresh was called
      expect(mockRefreshAccessToken).toHaveBeenCalled();
    });
  });

  it("handles missing refresh token gracefully", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();

      // Create integration with expired token but no refresh token
      await withDb((db) =>
        db.linearIntegration.create({
          data: {
            organizationId: orgId,
            accessTokenEncrypted: "expired_access_token",
            refreshTokenEncrypted: null, // No refresh token
            linearOrgId: "org_123",
            linearOrgName: "Test Org",
            defaultTeamId: "team_1",
            tokenExpiresAt: new Date(Date.now() - 3_600_000), // Expired
          },
        })
      );

      // getTeams would succeed, so a status that reads connected could only
      // come from serving the expired access token.
      mockGetTeams.mockResolvedValue([
        { id: "team_1", name: "Team", key: "TM" },
      ]);

      const result = await linearService.getIntegrationStatus(orgId);

      // ISS-11096: an expired row with nothing to refresh with fails the read
      // rather than serving its expired access token.
      expect(result.success).toBe(true);
      expect(result.connected).toBe(false);

      // Verify refresh was NOT called (no token to refresh with)
      expect(mockRefreshAccessToken).not.toHaveBeenCalled();

      // The expired token was never used
      expect(mockGetTeams).not.toHaveBeenCalled();
    });
  });

  it("handles null tokenExpiresAt as not expired", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();

      // Create integration with null expiry
      const accessToken = "access_token";

      await withDb((db) =>
        db.linearIntegration.create({
          data: {
            organizationId: orgId,
            accessTokenEncrypted: accessToken,
            refreshTokenEncrypted: "refresh_token",
            linearOrgId: "org_123",
            linearOrgName: "Test Org",
            defaultTeamId: "team_1",
            tokenExpiresAt: null, // No expiry set
          },
        })
      );

      // Try to get integration status
      const result = await linearService.getIntegrationStatus(orgId);

      expect(result.success).toBe(true);
      expect(result.connected).toBe(true);

      // Should NOT attempt refresh when expiry is null (treats as valid)
      expect(mockRefreshAccessToken).not.toHaveBeenCalled();

      // Token should remain unchanged
      const integration = await withDb((db) =>
        db.linearIntegration.findUnique({
          where: { organizationId: orgId },
        })
      );

      expect(integration?.accessTokenEncrypted).toBe(accessToken);
    });
  });

  it("updates tokenExpiresAt correctly after refresh", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();

      // Create integration with expired token
      await withDb((db) =>
        db.linearIntegration.create({
          data: {
            organizationId: orgId,
            accessTokenEncrypted: "expired_token",
            refreshTokenEncrypted: "refresh_token",
            linearOrgId: "org_123",
            linearOrgName: "Test Org",
            defaultTeamId: "team_1",
            tokenExpiresAt: new Date(Date.now() - 1000), // Just expired
          },
        })
      );

      // Mock refresh with specific expiry
      mockRefreshAccessToken.mockResolvedValue({
        accessToken: "new_token",
        refreshToken: "new_refresh",
        expiresIn: 7200, // 2 hours
        tokenType: "Bearer",
        scope: ["read"],
      });

      // Pin only `Date.now` — not the timers a live pg pool depends on — so the
      // stored expiry can be asserted exactly instead of inside a ±5 s window
      // that a slow round-trip on a loaded runner can breach.
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(PINNED_NOW_MS);
      try {
        await linearService.getIntegrationStatus(orgId);
      } finally {
        nowSpy.mockRestore();
      }

      const integration = await withDb((db) =>
        db.linearIntegration.findUnique({
          where: { organizationId: orgId },
        })
      );

      expect(integration).toBeDefined();
      expect(integration?.tokenExpiresAt).not.toBeNull();
      expect(integration?.tokenExpiresAt).toBeDefined();

      if (!integration?.tokenExpiresAt) {
        throw new Error("Token expiry not found");
      }

      expect(integration.tokenExpiresAt.getTime()).toBe(
        PINNED_NOW_MS + 7200 * 1000
      );
    });
  });
});
