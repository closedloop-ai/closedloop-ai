import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { exchangeCodeForTokens, getTeams, getViewer } from "@repo/linear";
import { afterEach, type Mock, vi } from "vitest";
import { linearService } from "@/app/integrations/linear/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "../utils/db-helpers";

// Skip integration tests if no DATABASE_URL is configured
const env = keys();
const hasDatabase = !!env.DATABASE_URL;

// Mock Linear API functions
vi.mock("@repo/linear", async () => {
  const actual = await vi.importActual("@repo/linear");
  return {
    ...actual,
    exchangeCodeForTokens: vi.fn(),
    getViewer: vi.fn(),
    getTeams: vi.fn(),
    refreshAccessToken: vi.fn(),
  };
});

const mockExchangeCodeForTokens = exchangeCodeForTokens as Mock;
const mockGetViewer = getViewer as Mock;
const mockGetTeams = getTeams as Mock;

describe.skipIf(!hasDatabase)("Linear OAuth Callback Integration", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("successfully exchanges code for tokens and stores encrypted", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization({
        clerkId: "org_oauth_test",
      });
      const user = await createTestUser(orgId, {
        clerkId: "clerk_oauth_test",
      });

      // Mock Linear API responses
      mockExchangeCodeForTokens.mockResolvedValue({
        accessToken: "lin_test_access_token",
        refreshToken: "lin_test_refresh_token",
        expiresIn: 3600,
        tokenType: "Bearer",
        scope: ["read", "write", "issues:create"],
      });

      mockGetViewer.mockResolvedValue({
        id: "linear_org_123",
        name: "Test Linear Org",
      });

      // Mock with single team so default team is set (only set if teams.length === 1)
      mockGetTeams.mockResolvedValue([
        { id: "team_1", name: "Engineering", key: "ENG" },
      ]);

      // Complete OAuth callback
      const result = await linearService.completeOAuthCallback(
        "test_code",
        "test_verifier",
        orgId,
        user.id
      );

      // Verify success
      expect(result.success).toBe(true);

      // Verify integration was created in database
      const integration = await withDb((db) =>
        db.linearIntegration.findUnique({
          where: { organizationId: orgId },
        })
      );

      expect(integration).not.toBeNull();
      expect(integration?.organizationId).toBe(orgId);
      expect(integration?.linearOrgId).toBe("linear_org_123");
      expect(integration?.linearOrgName).toBe("Test Linear Org");
      expect(integration?.defaultTeamId).toBe("team_1"); // First team as default
      expect(integration?.tokenExpiresAt).toBeDefined();

      // Verify tokens are stored correctly
      expect(integration?.accessToken).toBe("lin_test_access_token");
      expect(integration?.refreshToken).toBe("lin_test_refresh_token");

      // Verify API calls were made
      expect(mockExchangeCodeForTokens).toHaveBeenCalledWith(
        "test_code",
        "test_verifier"
      );
      expect(mockGetViewer).toHaveBeenCalled();
      expect(mockGetTeams).toHaveBeenCalled();
    });
  });

  it("handles missing organization gracefully", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);

      // Mock getViewer to return null
      mockExchangeCodeForTokens.mockResolvedValue({
        accessToken: "test_token",
        refreshToken: "test_refresh",
        expiresIn: 3600,
        tokenType: "Bearer",
        scope: ["read"],
      });

      mockGetViewer.mockResolvedValue(null);

      const result = await linearService.completeOAuthCallback(
        "test_code",
        "test_verifier",
        orgId,
        user.id
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Failed to get Linear organization");
      }

      // Verify no integration was created
      const integration = await withDb((db) =>
        db.linearIntegration.findUnique({
          where: { organizationId: orgId },
        })
      );
      expect(integration).toBeNull();
    });
  });

  it("handles token exchange failure", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);

      // Mock token exchange to throw
      mockExchangeCodeForTokens.mockRejectedValue(
        new Error("Token exchange failed: 401")
      );

      const result = await linearService.completeOAuthCallback(
        "invalid_code",
        "test_verifier",
        orgId,
        user.id
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Failed to exchange authorization code");
      }

      // Verify no integration was created
      const integration = await withDb((db) =>
        db.linearIntegration.findUnique({
          where: { organizationId: orgId },
        })
      );
      expect(integration).toBeNull();
    });
  });

  it("updates existing integration on re-authorization", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);

      // Create initial integration
      await withDb((db) =>
        db.linearIntegration.create({
          data: {
            organizationId: orgId,
            accessToken: "old_access_token",
            refreshToken: "old_refresh_token",
            linearOrgId: "old_org_123",
            linearOrgName: "Old Org",
            defaultTeamId: "old_team",
            tokenExpiresAt: new Date(Date.now() + 3_600_000),
          },
        })
      );

      // Mock new token exchange
      mockExchangeCodeForTokens.mockResolvedValue({
        accessToken: "new_access_token",
        refreshToken: "new_refresh_token",
        expiresIn: 7200,
        tokenType: "Bearer",
        scope: ["read", "write", "issues:create"],
      });

      mockGetViewer.mockResolvedValue({
        id: "new_org_456",
        name: "New Linear Org",
      });

      mockGetTeams.mockResolvedValue([
        { id: "new_team_1", name: "New Team", key: "NEW" },
      ]);

      // Re-authorize
      const result = await linearService.completeOAuthCallback(
        "new_code",
        "new_verifier",
        orgId,
        user.id
      );

      expect(result.success).toBe(true);

      // Verify integration was updated
      const integration = await withDb((db) =>
        db.linearIntegration.findUnique({
          where: { organizationId: orgId },
        })
      );

      expect(integration?.linearOrgId).toBe("new_org_456");
      expect(integration?.linearOrgName).toBe("New Linear Org");
      expect(integration?.defaultTeamId).toBe("new_team_1");

      // Verify tokens were updated
      expect(integration?.accessToken).toBe("new_access_token");
      expect(integration?.refreshToken).toBe("new_refresh_token");
    });
  });

  it("handles missing teams list", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);

      mockExchangeCodeForTokens.mockResolvedValue({
        accessToken: "test_token",
        refreshToken: "test_refresh",
        expiresIn: 3600,
        tokenType: "Bearer",
        scope: ["read"],
      });

      mockGetViewer.mockResolvedValue({
        id: "org_123",
        name: "Test Org",
      });

      // Mock empty teams list
      mockGetTeams.mockResolvedValue([]);

      const result = await linearService.completeOAuthCallback(
        "test_code",
        "test_verifier",
        orgId,
        user.id
      );

      expect(result.success).toBe(true);

      // Verify integration was created with no default team
      const integration = await withDb((db) =>
        db.linearIntegration.findUnique({
          where: { organizationId: orgId },
        })
      );

      expect(integration?.defaultTeamId).toBeNull();
    });
  });
});
