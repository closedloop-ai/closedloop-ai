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

vi.mock("@repo/google", () => ({
  exchangeCodeForTokens: vi.fn(),
  getUserInfo: vi.fn(),
  refreshAccessToken: vi.fn(),
  revokeToken: vi.fn(),
  exportDocAsMarkdown: vi.fn(),
  listDocsInFolder: vi.fn(),
}));

vi.mock("@/lib/integration-encryption", () => ({
  encryptIntegrationToken: vi.fn(),
  decryptIntegrationToken: vi.fn(),
  resolveIntegrationToken: vi.fn(),
  encryptTokenPair: vi.fn(),
}));

// Mock transitive service dependencies pulled in by the google service
vi.mock("@/app/documents/document-service", () => ({
  documentService: {
    create: vi.fn(),
  },
}));

vi.mock("@/app/projects/service", () => ({
  projectsService: {
    findById: vi.fn(),
  },
}));

import {
  exchangeCodeForTokens,
  getUserInfo,
  refreshAccessToken,
  revokeToken,
} from "@repo/google";
import {
  ensureValidAccessToken,
  googleService,
} from "@/app/integrations/google/service";
import {
  decryptIntegrationToken,
  encryptIntegrationToken,
  encryptTokenPair,
  resolveIntegrationToken,
} from "@/lib/integration-encryption";

const mockExchangeCodeForTokens = exchangeCodeForTokens as Mock;
const mockGetUserInfo = getUserInfo as Mock;
const mockRefreshAccessToken = refreshAccessToken as Mock;
const mockRevokeToken = revokeToken as Mock;
const _mockEncryptIntegrationToken = encryptIntegrationToken as Mock;
const _mockDecryptIntegrationToken = decryptIntegrationToken as Mock;
const mockResolveIntegrationToken = resolveIntegrationToken as Mock;
const mockEncryptTokenPair = encryptTokenPair as Mock;

const ORG_ID = "org-test-123";

function makeIntegration(
  overrides: Record<string, unknown> = {}
): Parameters<typeof ensureValidAccessToken>[0] {
  return {
    id: "integ-1",
    organizationId: ORG_ID,
    googleUserId: "user@example.com",
    googleEmail: "user@example.com",
    accessToken: "plaintext-access-token",
    refreshToken: "plaintext-refresh-token",
    accessTokenEncrypted: null,
    refreshTokenEncrypted: null,
    tokenExpiresAt: null,
    lastUsedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Parameters<typeof ensureValidAccessToken>[0];
}

describe("Google service encryption paths", () => {
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
      });
      mockGetUserInfo.mockResolvedValue({
        email: "user@example.com",
        sub: "google-uid-1",
      });
      mockEncryptTokenPair.mockResolvedValueOnce({
        encryptedAccessToken: "encrypted-access-token",
        encryptedRefreshToken: "encrypted-refresh-token",
      });

      const mockDb = {
        googleIntegration: {
          upsert: vi.fn().mockResolvedValue({}),
        },
      };
      mockWithDbCall(mockDb);

      const result = await googleService.completeOAuthCallback(
        "auth-code",
        "code-verifier",
        "https://app.example.com/callback",
        ORG_ID
      );

      expect(result).toEqual({ success: true });

      // encryptTokenPair must be called with both tokens
      expect(mockEncryptTokenPair).toHaveBeenCalledWith(
        "raw-access-token",
        "raw-refresh-token"
      );

      // Encrypted values must be stored in the upsert
      const upsertCall = mockDb.googleIntegration.upsert.mock.calls[0][0];
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

    it("stores encrypted tokens in the update path of upsert", async () => {
      mockExchangeCodeForTokens.mockResolvedValue({
        accessToken: "raw-access-token",
        refreshToken: undefined,
        expiresIn: 3600,
      });
      mockGetUserInfo.mockResolvedValue({
        email: "user@example.com",
        sub: "google-uid-1",
      });
      mockEncryptTokenPair.mockResolvedValueOnce({
        encryptedAccessToken: "encrypted-access-token",
        encryptedRefreshToken: null,
      });

      const mockDb = {
        googleIntegration: {
          upsert: vi.fn().mockResolvedValue({}),
        },
      };
      mockWithDbCall(mockDb);

      await googleService.completeOAuthCallback(
        "auth-code",
        "code-verifier",
        "https://app.example.com/callback",
        ORG_ID
      );

      const upsertCall = mockDb.googleIntegration.upsert.mock.calls[0][0];
      expect(upsertCall.update.accessTokenEncrypted).toBe(
        "encrypted-access-token"
      );
      // null from encryptTokenPair → ?? undefined → stored as undefined
      expect(upsertCall.update.refreshTokenEncrypted).toBeUndefined();
    });

    it("stores null for refreshTokenEncrypted when no refresh token is returned", async () => {
      mockExchangeCodeForTokens.mockResolvedValue({
        accessToken: "raw-access-token",
        refreshToken: undefined,
        expiresIn: 3600,
      });
      mockGetUserInfo.mockResolvedValue({
        email: "user@example.com",
        sub: "google-uid-1",
      });
      mockEncryptTokenPair.mockResolvedValueOnce({
        encryptedAccessToken: "encrypted-access-token",
        encryptedRefreshToken: null,
      });

      const mockDb = {
        googleIntegration: {
          upsert: vi.fn().mockResolvedValue({}),
        },
      };
      mockWithDbCall(mockDb);

      const result = await googleService.completeOAuthCallback(
        "auth-code",
        "code-verifier",
        "https://app.example.com/callback",
        ORG_ID
      );

      expect(result).toEqual({ success: true });

      // encryptTokenPair called with undefined refresh token
      expect(mockEncryptTokenPair).toHaveBeenCalledWith(
        "raw-access-token",
        undefined
      );

      const upsertCall = mockDb.googleIntegration.upsert.mock.calls[0][0];
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

      const result = await googleService.completeOAuthCallback(
        "bad-code",
        "code-verifier",
        "https://app.example.com/callback",
        ORG_ID
      );

      expect(result).toEqual({
        success: false,
        error: "Failed to complete Google Drive connection",
      });
      expect(mockEncryptTokenPair).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // ensureValidAccessToken — decryption on read, encryption on refresh
  // ---------------------------------------------------------------------------

  describe("ensureValidAccessToken", () => {
    describe("token read path — no refresh needed", () => {
      it("decrypts accessTokenEncrypted when present and token is not expired", async () => {
        mockResolveIntegrationToken.mockResolvedValue("decrypted-access-token");

        const integration = makeIntegration({
          accessTokenEncrypted: "encrypted-access-token",
          // tokenExpiresAt null → treated as valid (no refresh)
        });

        const result = await ensureValidAccessToken(integration, ORG_ID);

        expect(result).toEqual({
          success: true,
          accessToken: "decrypted-access-token",
        });
        expect(mockResolveIntegrationToken).toHaveBeenCalledWith(
          "encrypted-access-token",
          "plaintext-access-token"
        );
      });

      it("falls back to plaintext accessToken when accessTokenEncrypted is null", async () => {
        mockResolveIntegrationToken.mockResolvedValue("plaintext-access-token");

        const integration = makeIntegration({
          accessToken: "plaintext-access-token",
          accessTokenEncrypted: null,
          // tokenExpiresAt null → treated as valid (no refresh)
        });

        const result = await ensureValidAccessToken(integration, ORG_ID);

        expect(result).toEqual({
          success: true,
          accessToken: "plaintext-access-token",
        });
        // resolveIntegrationToken handles the null-encrypted case — called once for access token
        expect(mockResolveIntegrationToken).toHaveBeenCalledWith(
          null,
          "plaintext-access-token"
        );
      });
    });

    describe("token refresh path", () => {
      it("decrypts refreshTokenEncrypted before calling refreshAccessToken", async () => {
        mockResolveIntegrationToken.mockResolvedValueOnce(
          "decrypted-refresh-token"
        ); // refreshToken — accessToken decrypt skipped when needsRefresh
        mockRefreshAccessToken.mockResolvedValue({
          accessToken: "new-access-token",
          refreshToken: "new-refresh-token",
          expiresIn: 3600,
        });
        mockEncryptTokenPair.mockResolvedValueOnce({
          encryptedAccessToken: "new-encrypted-access-token",
          encryptedRefreshToken: "new-encrypted-refresh-token",
        });

        const mockDb = {
          googleIntegration: {
            update: vi.fn().mockResolvedValue({}),
          },
        };
        mockWithDbCall(mockDb);

        const integration = makeIntegration({
          accessTokenEncrypted: "old-encrypted-access-token",
          refreshTokenEncrypted: "old-encrypted-refresh-token",
          tokenExpiresAt: new Date(Date.now() - 3_600_000), // expired 1h ago
        });

        const result = await ensureValidAccessToken(integration, ORG_ID);

        expect(result).toEqual({
          success: true,
          accessToken: "new-access-token",
        });

        // resolveIntegrationToken called for refresh token with encrypted field
        expect(mockResolveIntegrationToken).toHaveBeenCalledWith(
          "old-encrypted-refresh-token",
          "plaintext-refresh-token"
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
        const updateCall = mockDb.googleIntegration.update.mock.calls[0][0];
        expect(updateCall.data.accessTokenEncrypted).toBe(
          "new-encrypted-access-token"
        );
        expect(updateCall.data.refreshTokenEncrypted).toBe(
          "new-encrypted-refresh-token"
        );
      });

      it("falls back to plaintext refreshToken when refreshTokenEncrypted is null", async () => {
        mockResolveIntegrationToken.mockResolvedValueOnce(
          "plaintext-refresh-token"
        ); // fallback for null encrypted refresh — accessToken decrypt skipped when needsRefresh
        mockRefreshAccessToken.mockResolvedValue({
          accessToken: "new-access-token",
          refreshToken: null,
          expiresIn: 3600,
        });
        mockEncryptTokenPair.mockResolvedValueOnce({
          encryptedAccessToken: "new-encrypted-access-token",
          encryptedRefreshToken: null,
        });

        const mockDb = {
          googleIntegration: {
            update: vi.fn().mockResolvedValue({}),
          },
        };
        mockWithDbCall(mockDb);

        const integration = makeIntegration({
          accessToken: "old-access-token",
          accessTokenEncrypted: "old-encrypted-access-token",
          refreshToken: "plaintext-refresh-token",
          refreshTokenEncrypted: null,
          tokenExpiresAt: new Date(Date.now() - 3_600_000), // expired
        });

        const result = await ensureValidAccessToken(integration, ORG_ID);

        expect(result).toEqual({
          success: true,
          accessToken: "new-access-token",
        });

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

      it("returns error when token refresh API call fails", async () => {
        mockResolveIntegrationToken.mockResolvedValue("decrypted-token");
        mockRefreshAccessToken.mockRejectedValue(new Error("401 Unauthorized"));

        const integration = makeIntegration({
          accessTokenEncrypted: "old-encrypted-access-token",
          refreshTokenEncrypted: "old-encrypted-refresh-token",
          tokenExpiresAt: new Date(Date.now() - 3_600_000), // expired
        });

        const result = await ensureValidAccessToken(integration, ORG_ID);

        expect(result).toEqual({
          success: false,
          error: "Google token expired. Please reconnect Google Drive.",
        });
        expect(mockEncryptTokenPair).not.toHaveBeenCalled();
      });
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
        googleUserId: "user@example.com",
        googleEmail: "user@example.com",
        accessToken: "plaintext-access-token",
        refreshToken: null,
        accessTokenEncrypted: "encrypted-access-token",
        refreshTokenEncrypted: null,
        tokenExpiresAt: null,
        lastUsedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDb = {
        googleIntegration: {
          findUnique: vi.fn().mockResolvedValue(storedIntegration),
          delete: vi.fn().mockResolvedValue(storedIntegration),
        },
      };
      mockWithDbCall(mockDb);

      const result = await googleService.disconnect(ORG_ID);

      expect(result).toEqual({ success: true });
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
        googleUserId: "user@example.com",
        googleEmail: "user@example.com",
        accessToken: "plaintext-access-token",
        refreshToken: null,
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        tokenExpiresAt: null,
        lastUsedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDb = {
        googleIntegration: {
          findUnique: vi.fn().mockResolvedValue(storedIntegration),
          delete: vi.fn().mockResolvedValue(storedIntegration),
        },
      };
      mockWithDbCall(mockDb);

      const result = await googleService.disconnect(ORG_ID);

      expect(result).toEqual({ success: true });
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
        googleUserId: "user@example.com",
        googleEmail: "user@example.com",
        accessToken: "plaintext-access-token",
        refreshToken: null,
        accessTokenEncrypted: "encrypted-access-token",
        refreshTokenEncrypted: null,
        tokenExpiresAt: null,
        lastUsedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDb = {
        googleIntegration: {
          findUnique: vi.fn().mockResolvedValue(storedIntegration),
          delete: vi.fn().mockResolvedValue(storedIntegration),
        },
      };
      mockWithDbCall(mockDb);

      const result = await googleService.disconnect(ORG_ID);

      // Should still succeed even if revoke failed
      expect(result).toEqual({ success: true });
      expect(mockRevokeToken).toHaveBeenCalled();
      expect(mockDb.googleIntegration.delete).toHaveBeenCalledWith({
        where: { organizationId: ORG_ID },
      });
    });

    it("returns success immediately when no integration exists", async () => {
      const mockDb = {
        googleIntegration: {
          findUnique: vi.fn().mockResolvedValue(null),
          delete: vi.fn(),
        },
      };
      mockWithDbCall(mockDb);

      const result = await googleService.disconnect(ORG_ID);

      expect(result).toEqual({ success: true });
      expect(mockResolveIntegrationToken).not.toHaveBeenCalled();
      expect(mockRevokeToken).not.toHaveBeenCalled();
      expect(mockDb.googleIntegration.delete).not.toHaveBeenCalled();
    });
  });
});
