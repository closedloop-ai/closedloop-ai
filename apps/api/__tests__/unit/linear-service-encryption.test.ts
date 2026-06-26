import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { mockWithDbCall } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
  ArtifactSubtype: {
    PRD: "PRD",
    IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN",
    TEMPLATE: "TEMPLATE",
    FEATURE: "FEATURE",
  },
}));

vi.mock("@repo/linear", () => ({
  createLinearClient: vi.fn(),
  createIssues: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  extractTasksWithLLM: vi.fn(),
  formatTaskForLinear: vi.fn(),
  getTeams: vi.fn(),
  getViewer: vi.fn(),
  refreshAccessToken: vi.fn(),
  revokeToken: vi.fn(),
}));

vi.mock("@/lib/integration-encryption", () => ({
  encryptIntegrationToken: vi.fn(),
  decryptIntegrationToken: vi.fn(),
  resolveIntegrationToken: vi.fn(),
  encryptTokenPair: vi.fn(),
}));

vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: {
    getLatest: vi.fn(),
  },
}));

import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactSubtype, ArtifactType } from "@repo/database";
import {
  createIssues,
  createLinearClient,
  exchangeCodeForTokens,
  extractTasksWithLLM,
  formatTaskForLinear,
  getTeams,
  getViewer,
  refreshAccessToken,
  revokeToken,
} from "@repo/linear";
import { documentVersionService } from "@/app/documents/document-version-service";
import { linearService } from "@/app/integrations/linear/service";
import {
  decryptIntegrationToken,
  encryptIntegrationToken,
  encryptTokenPair,
  resolveIntegrationToken,
} from "@/lib/integration-encryption";

const mockCreateLinearClient = createLinearClient as Mock;
const mockCreateIssues = createIssues as Mock;
const mockExchangeCodeForTokens = exchangeCodeForTokens as Mock;
const mockExtractTasksWithLLM = extractTasksWithLLM as Mock;
const mockFormatTaskForLinear = formatTaskForLinear as Mock;
const mockGetTeams = getTeams as Mock;
const mockGetViewer = getViewer as Mock;
const mockRefreshAccessToken = refreshAccessToken as Mock;
const mockRevokeToken = revokeToken as Mock;
const _mockEncryptIntegrationToken = encryptIntegrationToken as Mock;
const _mockDecryptIntegrationToken = decryptIntegrationToken as Mock;
const mockResolveIntegrationToken = resolveIntegrationToken as Mock;
const mockEncryptTokenPair = encryptTokenPair as Mock;
const mockDocumentVersionServiceGetLatest =
  documentVersionService.getLatest as Mock;

const ORG_ID = "org-test-123";

describe("Linear service encryption paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // completeOAuthCallback — encryption on storage
  // ---------------------------------------------------------------------------

  describe("completeOAuthCallback", () => {
    it("encrypts access token and refresh token before storing", async () => {
      mockExchangeCodeForTokens.mockResolvedValue({
        accessToken: "raw-access-token",
        refreshToken: "raw-refresh-token",
        expiresIn: 3600,
        tokenType: "Bearer",
        scope: [],
      });
      mockGetViewer.mockResolvedValue({
        id: "linear-org-1",
        name: "Test Org",
      });
      mockCreateLinearClient.mockReturnValue({});
      mockEncryptTokenPair.mockResolvedValueOnce({
        encryptedAccessToken: "encrypted-access-token",
        encryptedRefreshToken: "encrypted-refresh-token",
      });

      const mockDb = {
        linearIntegration: {
          upsert: vi.fn().mockResolvedValue({}),
        },
      };
      mockWithDbCall(mockDb);

      const result = await linearService.completeOAuthCallback(
        "auth-code",
        "code-verifier",
        "https://app.example.com/callback",
        ORG_ID,
        "clerk-user-1"
      );

      expect(result).toEqual({ success: true });

      // encryptTokenPair must be called with both tokens
      expect(mockEncryptTokenPair).toHaveBeenCalledWith(
        "raw-access-token",
        "raw-refresh-token"
      );

      // Encrypted values must be stored in the upsert
      const upsertCall = mockDb.linearIntegration.upsert.mock.calls[0][0];
      expect(upsertCall.create.accessTokenEncrypted).toBe(
        "encrypted-access-token"
      );
      expect(upsertCall.create.refreshTokenEncrypted).toBe(
        "encrypted-refresh-token"
      );
      expect(upsertCall.update.accessTokenEncrypted).toBe(
        "encrypted-access-token"
      );
      expect(upsertCall.update.refreshTokenEncrypted).toBe(
        "encrypted-refresh-token"
      );
    });

    it("stores null for refreshTokenEncrypted when no refresh token is returned", async () => {
      mockExchangeCodeForTokens.mockResolvedValue({
        accessToken: "raw-access-token",
        refreshToken: undefined,
        expiresIn: 3600,
        tokenType: "Bearer",
        scope: [],
      });
      mockGetViewer.mockResolvedValue({
        id: "linear-org-1",
        name: "Test Org",
      });
      mockCreateLinearClient.mockReturnValue({});
      mockEncryptTokenPair.mockResolvedValueOnce({
        encryptedAccessToken: "encrypted-access-token",
        encryptedRefreshToken: null,
      });

      const mockDb = {
        linearIntegration: {
          upsert: vi.fn().mockResolvedValue({}),
        },
      };
      mockWithDbCall(mockDb);

      const result = await linearService.completeOAuthCallback(
        "auth-code",
        "code-verifier",
        "https://app.example.com/callback",
        ORG_ID,
        "clerk-user-1"
      );

      expect(result).toEqual({ success: true });

      // encryptTokenPair called with undefined refresh token
      expect(mockEncryptTokenPair).toHaveBeenCalledWith(
        "raw-access-token",
        undefined
      );

      const upsertCall = mockDb.linearIntegration.upsert.mock.calls[0][0];
      expect(upsertCall.create.accessTokenEncrypted).toBe(
        "encrypted-access-token"
      );
      // null from encryptTokenPair → ?? undefined → stored as undefined
      expect(upsertCall.create.refreshTokenEncrypted).toBeUndefined();
    });

    it("returns error result when token exchange fails", async () => {
      mockExchangeCodeForTokens.mockRejectedValue(
        new Error("OAuth exchange failed")
      );

      const result = await linearService.completeOAuthCallback(
        "bad-code",
        "code-verifier",
        "https://app.example.com/callback",
        ORG_ID,
        "clerk-user-1"
      );

      expect(result).toEqual({
        success: false,
        error: "Failed to complete Linear connection",
      });
      expect(mockEncryptTokenPair).not.toHaveBeenCalled();
    });

    it("returns error result when getViewer returns null", async () => {
      mockExchangeCodeForTokens.mockResolvedValue({
        accessToken: "raw-access-token",
        refreshToken: "raw-refresh-token",
        expiresIn: 3600,
        tokenType: "Bearer",
        scope: [],
      });
      mockGetViewer.mockResolvedValue(null);
      mockCreateLinearClient.mockReturnValue({});
      // encryptTokenPair runs in parallel with getViewer inside Promise.all —
      // it must resolve so that the null-org check can be reached
      mockEncryptTokenPair.mockResolvedValueOnce({
        encryptedAccessToken: "encrypted-access-token",
        encryptedRefreshToken: "encrypted-refresh-token",
      });

      const result = await linearService.completeOAuthCallback(
        "auth-code",
        "code-verifier",
        "https://app.example.com/callback",
        ORG_ID,
        "clerk-user-1"
      );

      expect(result).toEqual({
        success: false,
        error: "Failed to get Linear organization info",
      });
    });
  });

  // ---------------------------------------------------------------------------
  // token refresh path (via ensureValidAccessToken in getIntegrationStatus)
  // ---------------------------------------------------------------------------

  describe("token refresh path", () => {
    it("decrypts refreshTokenEncrypted before calling refreshAccessToken, encrypts new tokens before storing", async () => {
      const storedIntegration = {
        id: "integ-1",
        organizationId: ORG_ID,
        accessToken: "old-plaintext-access-token",
        refreshToken: "old-plaintext-refresh-token",
        accessTokenEncrypted: "old-encrypted-access-token",
        refreshTokenEncrypted: "old-encrypted-refresh-token",
        tokenExpiresAt: new Date(Date.now() - 3_600_000), // expired 1h ago
        linearOrgId: "linear-org-1",
        linearOrgName: "Test Org",
        defaultTeamId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockResolveIntegrationToken.mockResolvedValueOnce(
        "decrypted-refresh-token"
      ); // refreshToken — accessToken decrypt skipped when needsRefresh
      mockRefreshAccessToken.mockResolvedValue({
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        expiresIn: 3600,
        tokenType: "Bearer",
        scope: [],
      });
      mockEncryptTokenPair.mockResolvedValueOnce({
        encryptedAccessToken: "new-encrypted-access-token",
        encryptedRefreshToken: "new-encrypted-refresh-token",
      });
      mockGetTeams.mockResolvedValue([]);
      mockCreateLinearClient.mockReturnValue({});

      const mockDb = {
        linearIntegration: {
          findUnique: vi.fn().mockResolvedValue(storedIntegration),
          update: vi.fn().mockResolvedValue({}),
        },
      };
      mockWithDbCall(mockDb);

      await linearService.getIntegrationStatus(ORG_ID);

      // resolveIntegrationToken called for refresh token with encrypted field
      expect(mockResolveIntegrationToken).toHaveBeenCalledWith(
        "old-encrypted-refresh-token",
        "old-plaintext-refresh-token"
      );
      expect(mockRefreshAccessToken).toHaveBeenCalledWith(
        "decrypted-refresh-token"
      );

      // New tokens are encrypted together via encryptTokenPair
      expect(mockEncryptTokenPair).toHaveBeenCalledWith(
        "new-access-token",
        "new-refresh-token"
      );

      // Encrypted values are saved to the database
      const updateCall = mockDb.linearIntegration.update.mock.calls[0][0];
      expect(updateCall.data.accessTokenEncrypted).toBe(
        "new-encrypted-access-token"
      );
      expect(updateCall.data.refreshTokenEncrypted).toBe(
        "new-encrypted-refresh-token"
      );
    });

    it("falls back to plaintext refreshToken when refreshTokenEncrypted is null", async () => {
      const storedIntegration = {
        id: "integ-1",
        organizationId: ORG_ID,
        accessToken: "old-plaintext-access-token",
        refreshToken: "plaintext-refresh-token",
        accessTokenEncrypted: "old-encrypted-access-token",
        refreshTokenEncrypted: null,
        tokenExpiresAt: new Date(Date.now() - 3_600_000), // expired
        linearOrgId: "linear-org-1",
        linearOrgName: "Test Org",
        defaultTeamId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockResolveIntegrationToken.mockResolvedValueOnce(
        "plaintext-refresh-token"
      ); // fallback: refreshTokenEncrypted is null — accessToken decrypt skipped when needsRefresh
      mockRefreshAccessToken.mockResolvedValue({
        accessToken: "new-access-token",
        refreshToken: null,
        expiresIn: 3600,
        tokenType: "Bearer",
        scope: [],
      });
      mockEncryptTokenPair.mockResolvedValueOnce({
        encryptedAccessToken: "new-encrypted-access-token",
        encryptedRefreshToken: null,
      });
      mockGetTeams.mockResolvedValue([]);
      mockCreateLinearClient.mockReturnValue({});

      const mockDb = {
        linearIntegration: {
          findUnique: vi.fn().mockResolvedValue(storedIntegration),
          update: vi.fn().mockResolvedValue({}),
        },
      };
      mockWithDbCall(mockDb);

      await linearService.getIntegrationStatus(ORG_ID);

      // resolveIntegrationToken called for refresh with null encrypted field →
      // returns plaintext directly without KMS
      expect(mockResolveIntegrationToken).toHaveBeenCalledWith(
        null,
        "plaintext-refresh-token"
      );
      expect(mockRefreshAccessToken).toHaveBeenCalledWith(
        "plaintext-refresh-token"
      );

      // encryptTokenPair called with null new refresh token
      expect(mockEncryptTokenPair).toHaveBeenCalledWith(
        "new-access-token",
        null
      );
    });
  });

  // ---------------------------------------------------------------------------
  // disconnect — decryption before revoke
  // ---------------------------------------------------------------------------

  describe("disconnect", () => {
    it("decrypts accessTokenEncrypted before revoking when encrypted token is present", async () => {
      mockResolveIntegrationToken.mockResolvedValue("decrypted-access-token");
      mockRevokeToken.mockResolvedValue(undefined);

      const storedIntegration = {
        id: "integ-1",
        organizationId: ORG_ID,
        accessToken: "plaintext-access-token",
        refreshToken: null,
        accessTokenEncrypted: "encrypted-access-token",
        refreshTokenEncrypted: null,
        tokenExpiresAt: null,
        linearOrgId: "linear-org-1",
        linearOrgName: "Test Org",
        defaultTeamId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDb = {
        linearIntegration: {
          findUnique: vi.fn().mockResolvedValue(storedIntegration),
          delete: vi.fn().mockResolvedValue(storedIntegration),
        },
      };
      mockWithDbCall(mockDb);

      await linearService.disconnect(ORG_ID);

      expect(mockResolveIntegrationToken).toHaveBeenCalledWith(
        "encrypted-access-token",
        "plaintext-access-token"
      );
      expect(mockRevokeToken).toHaveBeenCalledWith("decrypted-access-token");
    });

    it("falls back to plaintext accessToken when accessTokenEncrypted is null", async () => {
      mockResolveIntegrationToken.mockResolvedValue("plaintext-access-token");
      mockRevokeToken.mockResolvedValue(undefined);

      const storedIntegration = {
        id: "integ-1",
        organizationId: ORG_ID,
        accessToken: "plaintext-access-token",
        refreshToken: null,
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        tokenExpiresAt: null,
        linearOrgId: "linear-org-1",
        linearOrgName: "Test Org",
        defaultTeamId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDb = {
        linearIntegration: {
          findUnique: vi.fn().mockResolvedValue(storedIntegration),
          delete: vi.fn().mockResolvedValue(storedIntegration),
        },
      };
      mockWithDbCall(mockDb);

      await linearService.disconnect(ORG_ID);

      // resolveIntegrationToken handles the null-encrypted fallback internally
      expect(mockResolveIntegrationToken).toHaveBeenCalledWith(
        null,
        "plaintext-access-token"
      );
      expect(mockRevokeToken).toHaveBeenCalledWith("plaintext-access-token");
    });

    it("still deletes integration record when revokeToken throws", async () => {
      mockResolveIntegrationToken.mockResolvedValue("decrypted-access-token");
      mockRevokeToken.mockRejectedValue(new Error("Token already revoked"));

      const storedIntegration = {
        id: "integ-1",
        organizationId: ORG_ID,
        accessToken: "plaintext-access-token",
        refreshToken: null,
        accessTokenEncrypted: "encrypted-access-token",
        refreshTokenEncrypted: null,
        tokenExpiresAt: null,
        linearOrgId: "linear-org-1",
        linearOrgName: "Test Org",
        defaultTeamId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDb = {
        linearIntegration: {
          findUnique: vi.fn().mockResolvedValue(storedIntegration),
          delete: vi.fn().mockResolvedValue(storedIntegration),
        },
      };
      mockWithDbCall(mockDb);

      // Should not throw even if revoke failed
      await expect(linearService.disconnect(ORG_ID)).resolves.toBeUndefined();

      expect(mockRevokeToken).toHaveBeenCalled();
      expect(mockDb.linearIntegration.delete).toHaveBeenCalledWith({
        where: { id: "integ-1" },
      });
    });

    it("returns immediately when no integration exists without calling revokeToken", async () => {
      const mockDb = {
        linearIntegration: {
          findUnique: vi.fn().mockResolvedValue(null),
          delete: vi.fn(),
        },
      };
      mockWithDbCall(mockDb);

      await linearService.disconnect(ORG_ID);

      expect(mockResolveIntegrationToken).not.toHaveBeenCalled();
      expect(mockRevokeToken).not.toHaveBeenCalled();
      expect(mockDb.linearIntegration.delete).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // exportImplementationPlan — decryption before use
  // ---------------------------------------------------------------------------

  describe("exportImplementationPlan — token decryption", () => {
    const DOCUMENT_ID = "doc-test-456";
    const TEAM_ID = "team-test-789";
    const USER_ID = "user-test-001";

    function makeArtifact(overrides: Record<string, unknown> = {}) {
      return {
        id: DOCUMENT_ID,
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.IMPLEMENTATION_PLAN,
        status: DocumentStatus.Approved,
        ...overrides,
      };
    }

    function makeLinearIntegration(overrides: Record<string, unknown> = {}) {
      return {
        id: "integ-1",
        organizationId: ORG_ID,
        accessToken: "plaintext-access-token",
        refreshToken: null,
        accessTokenEncrypted: "encrypted-access-token",
        refreshTokenEncrypted: null,
        tokenExpiresAt: null,
        linearOrgId: "linear-org-1",
        linearOrgName: "Test Org",
        defaultTeamId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
      };
    }

    it("decrypts accessTokenEncrypted before creating Linear client for export", async () => {
      mockResolveIntegrationToken.mockResolvedValue("decrypted-access-token");
      mockExtractTasksWithLLM.mockResolvedValue([
        { title: "Task 1", description: "Do task 1", isCompleted: false },
      ]);
      mockFormatTaskForLinear.mockReturnValue({
        title: "Task 1",
        description: "Do task 1",
      });
      mockGetTeams.mockResolvedValue([
        { id: TEAM_ID, name: "Eng", key: "ENG" },
      ]);
      mockCreateIssues.mockResolvedValue([
        {
          id: "issue-1",
          identifier: "ENG-1",
          url: "https://linear.app/issue/ENG-1",
          title: "Task 1",
        },
      ]);
      const fakeClient = {};
      mockCreateLinearClient.mockReturnValue(fakeClient);

      const artifact = makeArtifact();
      const integration = makeLinearIntegration();

      mockDocumentVersionServiceGetLatest.mockResolvedValue({
        content: "# Implementation Plan\n\n## Tasks",
      });

      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(artifact),
        },
        linearIntegration: {
          findUnique: vi.fn().mockResolvedValue(integration),
        },
        linearSubtask: {
          createMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      mockWithDbCall(mockDb);

      const result = await linearService.exportImplementationPlan(
        DOCUMENT_ID,
        TEAM_ID,
        ORG_ID,
        USER_ID
      );

      expect(result).toMatchObject({ success: true, issuesCreated: 1 });

      // resolveIntegrationToken must be called with the encrypted access token field
      expect(mockResolveIntegrationToken).toHaveBeenCalledWith(
        "encrypted-access-token",
        "plaintext-access-token"
      );

      // Linear client must be created with the resolved (decrypted) token
      expect(mockCreateLinearClient).toHaveBeenCalledWith(
        "decrypted-access-token"
      );

      // PLN-787: linear_subtasks rows must be anchored to the document +
      // organization, not the (deleted) workstream. Regression guard.
      const createManyArgs = mockDb.linearSubtask.createMany.mock.calls[0][0];
      expect(createManyArgs.data[0]).toMatchObject({
        documentId: DOCUMENT_ID,
        organizationId: ORG_ID,
      });
    });

    it("falls back to plaintext accessToken when accessTokenEncrypted is null for export", async () => {
      mockResolveIntegrationToken.mockResolvedValue("plaintext-access-token");
      mockExtractTasksWithLLM.mockResolvedValue([
        { title: "Task 1", description: "Do task 1", isCompleted: false },
      ]);
      mockFormatTaskForLinear.mockReturnValue({
        title: "Task 1",
        description: "Do task 1",
      });
      mockGetTeams.mockResolvedValue([
        { id: TEAM_ID, name: "Eng", key: "ENG" },
      ]);
      mockCreateIssues.mockResolvedValue([
        {
          id: "issue-1",
          identifier: "ENG-1",
          url: "https://linear.app/issue/ENG-1",
          title: "Task 1",
        },
      ]);
      const fakeClient = {};
      mockCreateLinearClient.mockReturnValue(fakeClient);

      const artifact = makeArtifact();
      const integration = makeLinearIntegration({
        accessTokenEncrypted: null,
        accessToken: "plaintext-access-token",
      });

      mockDocumentVersionServiceGetLatest.mockResolvedValue({
        content: "# Implementation Plan\n\n## Tasks",
      });

      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(artifact),
        },
        linearIntegration: {
          findUnique: vi.fn().mockResolvedValue(integration),
        },
        linearSubtask: {
          createMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      mockWithDbCall(mockDb);

      const result = await linearService.exportImplementationPlan(
        DOCUMENT_ID,
        TEAM_ID,
        ORG_ID,
        USER_ID
      );

      expect(result).toMatchObject({ success: true, issuesCreated: 1 });

      // resolveIntegrationToken called with null encrypted — falls back to plaintext
      expect(mockResolveIntegrationToken).toHaveBeenCalledWith(
        null,
        "plaintext-access-token"
      );

      // Linear client must be created with plaintext token
      expect(mockCreateLinearClient).toHaveBeenCalledWith(
        "plaintext-access-token"
      );
    });
  });
});
