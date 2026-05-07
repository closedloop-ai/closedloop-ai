import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { getTeams, refreshAccessToken } from "@repo/linear";
import { afterEach, type Mock, vi } from "vitest";
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
  resolveIntegrationToken: vi
    .fn()
    .mockImplementation(
      (_encrypted: string | null | undefined, plaintext: string | null) =>
        Promise.resolve(plaintext)
    ),
  encryptTokenPair: vi.fn().mockResolvedValue({
    encryptedAccessToken: "mock-encrypted-access",
    encryptedRefreshToken: "mock-encrypted-refresh",
  }),
}));

const mockRefreshAccessToken = refreshAccessToken as Mock;
const mockGetTeams = getTeams as Mock;

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
            accessToken,
            refreshToken: "refresh_token",
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

      expect(integration?.accessToken).toBe(accessToken);
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
            accessToken: oldAccessToken,
            refreshToken: oldRefreshToken,
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

      // Try to get integration status (will trigger refresh)
      const result = await linearService.getIntegrationStatus(orgId);

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

      // Token should be updated to new token
      expect(integration?.accessToken).toBe("new_access_token");
      expect(integration?.refreshToken).toBe("new_refresh_token");

      // Token expiry should be updated
      expect(integration?.tokenExpiresAt).not.toBeNull();
      if (integration?.tokenExpiresAt) {
        expect(integration.tokenExpiresAt.getTime()).toBeGreaterThan(
          Date.now()
        );
      }
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
            accessToken: "expired_access_token",
            refreshToken: "invalid_refresh_token",
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
            accessToken: "expired_access_token",
            refreshToken: null, // No refresh token
            linearOrgId: "org_123",
            linearOrgName: "Test Org",
            defaultTeamId: "team_1",
            tokenExpiresAt: new Date(Date.now() - 3_600_000), // Expired
          },
        })
      );

      // When there's no refresh token, the service returns the expired token anyway
      // and attempts to use it. We need to mock getTeams to succeed or fail.
      // In this case, we'll mock success to show the service attempts to use it.
      mockGetTeams.mockResolvedValue([
        { id: "team_1", name: "Team", key: "TM" },
      ]);

      // Try to get integration status
      const result = await linearService.getIntegrationStatus(orgId);

      // Without a refresh token, service returns the expired token and tries to use it
      // If getTeams succeeds (as we mocked), it returns connected: true
      expect(result.success).toBe(true);
      expect(result.connected).toBe(true);

      // Verify refresh was NOT called (no token to refresh with)
      expect(mockRefreshAccessToken).not.toHaveBeenCalled();

      // Verify getTeams was called (service tried to use the expired token)
      expect(mockGetTeams).toHaveBeenCalled();
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
            accessToken,
            refreshToken: "refresh_token",
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

      expect(integration?.accessToken).toBe(accessToken);
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
            accessToken: "expired_token",
            refreshToken: "refresh_token",
            linearOrgId: "org_123",
            linearOrgName: "Test Org",
            defaultTeamId: "team_1",
            tokenExpiresAt: new Date(Date.now() - 1000), // Just expired
          },
        })
      );

      const beforeRefresh = Date.now();

      // Mock refresh with specific expiry
      mockRefreshAccessToken.mockResolvedValue({
        accessToken: "new_token",
        refreshToken: "new_refresh",
        expiresIn: 7200, // 2 hours
        tokenType: "Bearer",
        scope: ["read"],
      });

      await linearService.getIntegrationStatus(orgId);

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

      // Verify expiry is approximately 2 hours from now
      const expectedExpiry = beforeRefresh + 7200 * 1000;
      const actualExpiry = integration.tokenExpiresAt.getTime();

      // Allow 5 second margin
      expect(Math.abs(actualExpiry - expectedExpiry)).toBeLessThan(5000);
    });
  });
});
