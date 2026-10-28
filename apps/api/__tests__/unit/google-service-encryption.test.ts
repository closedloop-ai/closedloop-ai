import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { mockWithDbAll, mockWithDbCall } from "../utils/db-helpers";

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
  resolveEncryptedIntegrationToken: vi.fn(),
  encryptTokenPair: vi.fn(),
  buildIntegrationTokenColumns: vi.fn(),
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
  buildIntegrationTokenColumns,
  decryptIntegrationToken,
  encryptIntegrationToken,
  encryptTokenPair,
  resolveEncryptedIntegrationToken,
} from "@/lib/integration-encryption";

const mockExchangeCodeForTokens = exchangeCodeForTokens as Mock;
const mockGetUserInfo = getUserInfo as Mock;
const mockRefreshAccessToken = refreshAccessToken as Mock;
const mockRevokeToken = revokeToken as Mock;
const _mockEncryptIntegrationToken = encryptIntegrationToken as Mock;
const _mockDecryptIntegrationToken = decryptIntegrationToken as Mock;
const mockResolveEncryptedToken = resolveEncryptedIntegrationToken as Mock;
const _mockEncryptTokenPair = encryptTokenPair as Mock;
const mockBuildTokenColumns = buildIntegrationTokenColumns as Mock;

/** What the shared builder hands the service on its normal path: ciphertext only. */
function encryptedColumns(
  accessTokenEncrypted: string,
  refreshTokenEncrypted: string | null
) {
  return { accessTokenEncrypted, refreshTokenEncrypted };
}
/**
 * ISS-7781: what the builder returns when the provider issued NO refresh token
 * — the refresh key ABSENT, so Prisma leaves the stored one alone. Writing
 * `null` there would delete the org's only means of refreshing.
 */
function accessOnlyColumns(accessTokenEncrypted: string) {
  return { accessTokenEncrypted };
}

const ORG_ID = "org-test-123";

function makeIntegration(
  overrides: Record<string, unknown> = {}
): Parameters<typeof ensureValidAccessToken>[0] {
  return {
    id: "integ-1",
    organizationId: ORG_ID,
    googleUserId: "user@example.com",
    googleEmail: "user@example.com",
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
      mockBuildTokenColumns.mockResolvedValueOnce(
        encryptedColumns("encrypted-access-token", "encrypted-refresh-token")
      );

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

      // The connect path routes through the ONE shared builder, tagged so the
      // monitored plaintext-write event can name which write produced a row.
      expect(mockBuildTokenColumns).toHaveBeenCalledWith(
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

      // ISS-11096: neither upsert branch writes the legacy plaintext columns.
      for (const branch of [upsertCall.create, upsertCall.update]) {
        expect(branch).not.toHaveProperty("accessToken");
        expect(branch).not.toHaveProperty("refreshToken");
      }
    });

    /**
     * ISS-5081: a failed encrypt fails the connect and writes nothing. Before,
     * the builder handed back plaintext columns and the upsert stored them.
     */
    it("fails the connect and writes nothing when encryption throws", async () => {
      mockExchangeCodeForTokens.mockResolvedValue({
        accessToken: "raw-access-token",
        refreshToken: "raw-refresh-token",
        expiresIn: 3600,
      });
      mockGetUserInfo.mockResolvedValue({
        email: "user@example.com",
        sub: "google-uid-1",
      });
      mockBuildTokenColumns.mockRejectedValueOnce(new Error("kms unavailable"));

      const mockDb = {
        googleIntegration: {
          upsert: vi.fn().mockResolvedValue({}),
          findUnique: vi.fn().mockResolvedValue(null),
        },
      };
      mockWithDbCall(mockDb);

      const result = await googleService.completeOAuthCallback(
        "auth-code",
        "code-verifier",
        "https://app.example.com/callback",
        ORG_ID
      );

      expect(result).toEqual({
        success: false,
        error: "Failed to complete Google Drive connection",
      });
      expect(mockBuildTokenColumns).toHaveBeenCalled();
      expect(mockDb.googleIntegration.upsert).not.toHaveBeenCalled();
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
      mockBuildTokenColumns.mockResolvedValueOnce(
        accessOnlyColumns("encrypted-access-token")
      );

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
      // ISS-7781: Google issued no refresh token, so the builder omits BOTH
      // refresh keys and Prisma leaves the stored ones untouched. `null` here
      // would delete the org's only means of refreshing.
      expect(upsertCall.update).not.toHaveProperty("refreshTokenEncrypted");
      expect(upsertCall.update).not.toHaveProperty("refreshToken");
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
      mockBuildTokenColumns.mockResolvedValueOnce(
        accessOnlyColumns("encrypted-access-token")
      );

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

      expect(mockBuildTokenColumns).toHaveBeenCalledWith(
        "raw-access-token",
        undefined
      );

      const upsertCall = mockDb.googleIntegration.upsert.mock.calls[0][0];
      expect(upsertCall.create.accessTokenEncrypted).toBe(
        "encrypted-access-token"
      );
      // Same on the create branch: absent, not null.
      expect(upsertCall.create).not.toHaveProperty("refreshTokenEncrypted");
    });

    /**
     * ISS-11096: a reconnect with no reissued refresh token no longer reads the
     * stored row to rescue a legacy plaintext refresh token; the builder omits
     * the refresh column and the stored ciphertext stays.
     */
    it("does not read the stored row on a reconnect that reissues no refresh token", async () => {
      mockExchangeCodeForTokens.mockResolvedValue({
        accessToken: "raw-access-token",
        refreshToken: undefined,
        expiresIn: 3600,
      });
      mockGetUserInfo.mockResolvedValue({
        email: "user@example.com",
        sub: "google-uid-1",
      });
      mockBuildTokenColumns.mockResolvedValueOnce(
        accessOnlyColumns("encrypted-access-token")
      );

      const mockDb = {
        googleIntegration: {
          upsert: vi.fn().mockResolvedValue({}),
          findUnique: vi.fn(),
        },
      };
      mockWithDbCall(mockDb);

      await googleService.completeOAuthCallback(
        "auth-code",
        "code-verifier",
        "https://app.example.com/callback",
        ORG_ID
      );

      expect(mockDb.googleIntegration.upsert).toHaveBeenCalledTimes(1);
      expect(mockDb.googleIntegration.findUnique).not.toHaveBeenCalled();
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
      expect(mockBuildTokenColumns).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // ensureValidAccessToken — decryption on read, encryption on refresh
  // ---------------------------------------------------------------------------

  describe("ensureValidAccessToken", () => {
    describe("token read path — no refresh needed", () => {
      it("decrypts accessTokenEncrypted when present and token is not expired", async () => {
        mockResolveEncryptedToken.mockResolvedValue("decrypted-access-token");

        const integration = makeIntegration({
          accessTokenEncrypted: "encrypted-access-token",
          // tokenExpiresAt null → treated as valid (no refresh)
        });

        const result = await ensureValidAccessToken(integration, ORG_ID);

        expect(result).toEqual({
          success: true,
          accessToken: "decrypted-access-token",
        });
        expect(mockResolveEncryptedToken).toHaveBeenCalledWith(
          "encrypted-access-token"
        );
      });

      /**
       * ISS-11096: a row with no access-token ciphertext (a legacy
       * plaintext-only row included) fails the read and asks for a reconnect.
       */
      it("fails the read when the row has no access-token ciphertext", async () => {
        mockResolveEncryptedToken.mockResolvedValue(null);

        const result = await ensureValidAccessToken(
          makeIntegration({ accessTokenEncrypted: null }),
          ORG_ID
        );

        expect(result).toEqual({
          success: false,
          error:
            "Google access token is unavailable. Please reconnect Google Drive.",
        });
        expect(mockResolveEncryptedToken).toHaveBeenCalledWith(null);
      });
      /**
       * ISS-5081: a decrypt failure no longer falls back to the plaintext
       * column beside the ciphertext; the read fails and asks for a reconnect.
       */
      it("fails the read instead of using plaintext when decryption throws", async () => {
        mockResolveEncryptedToken.mockRejectedValueOnce(
          new Error("kms unavailable")
        );

        const result = await ensureValidAccessToken(
          makeIntegration({ accessTokenEncrypted: "encrypted-access-token" }),
          ORG_ID
        );

        expect(result).toEqual({
          success: false,
          error:
            "Google access token is unavailable. Please reconnect Google Drive.",
        });
      });
    });

    describe("token refresh path", () => {
      it("decrypts refreshTokenEncrypted before calling refreshAccessToken", async () => {
        mockResolveEncryptedToken.mockResolvedValueOnce(
          "decrypted-refresh-token"
        ); // refreshToken — accessToken decrypt skipped when needsRefresh
        mockRefreshAccessToken.mockResolvedValue({
          accessToken: "new-access-token",
          refreshToken: "new-refresh-token",
          expiresIn: 3600,
        });
        mockBuildTokenColumns.mockResolvedValueOnce(
          encryptedColumns(
            "new-encrypted-access-token",
            "new-encrypted-refresh-token"
          )
        );

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

        // resolveEncryptedIntegrationToken called for refresh token with encrypted field
        expect(mockResolveEncryptedToken).toHaveBeenCalledWith(
          "old-encrypted-refresh-token"
        );
        expect(mockRefreshAccessToken).toHaveBeenCalledWith(
          "decrypted-refresh-token"
        );

        // The refresh path routes through the same shared builder
        expect(mockBuildTokenColumns).toHaveBeenCalledWith(
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

        // ISS-11096: the refresh write does not touch the plaintext columns.
        expect(updateCall.data).not.toHaveProperty("accessToken");
        expect(updateCall.data).not.toHaveProperty("refreshToken");
      });

      /**
       * ISS-11096: only a refresh-token CIPHERTEXT makes an expired row
       * refreshable. Without one the read fails with the reconnect error: it
       * neither serves the expired access token nor spends a legacy plaintext
       * refresh token.
       */
      it("fails an expired row that has no refresh-token ciphertext", async () => {
        mockResolveEncryptedToken.mockImplementation((encrypted) =>
          Promise.resolve(encrypted ? "decrypted-access-token" : null)
        );

        const result = await ensureValidAccessToken(
          makeIntegration({
            accessTokenEncrypted: "old-encrypted-access-token",
            refreshTokenEncrypted: null,
            tokenExpiresAt: new Date(Date.now() - 3_600_000), // expired
          }),
          ORG_ID
        );

        expect(result).toEqual({
          success: false,
          error:
            "Google refresh token is unavailable. Please reconnect Google Drive.",
        });
        expect(mockResolveEncryptedToken).not.toHaveBeenCalledWith(
          "old-encrypted-access-token"
        );
        expect(mockRefreshAccessToken).not.toHaveBeenCalled();
      });

      it("returns error when token refresh API call fails", async () => {
        mockResolveEncryptedToken.mockResolvedValue("decrypted-token");
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
        expect(mockBuildTokenColumns).not.toHaveBeenCalled();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // disconnect — decryption before revoke
  // ---------------------------------------------------------------------------

  describe("disconnect", () => {
    it("decrypts accessTokenEncrypted before revoking when encrypted token is present", async () => {
      mockResolveEncryptedToken.mockResolvedValue("decrypted-access-token");
      mockRevokeToken.mockResolvedValue(undefined);

      const storedIntegration = {
        id: "integ-1",
        organizationId: ORG_ID,
        googleUserId: "user@example.com",
        googleEmail: "user@example.com",
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
      mockWithDbAll(mockDb);

      const result = await googleService.disconnect(ORG_ID);

      expect(result).toEqual({ success: true });
      expect(mockResolveEncryptedToken).toHaveBeenCalledWith(
        "encrypted-access-token"
      );
      expect(mockRevokeToken).toHaveBeenCalledWith("decrypted-access-token");
    });

    it("still deletes integration record when revokeToken throws", async () => {
      mockResolveEncryptedToken.mockResolvedValue("decrypted-access-token");
      mockRevokeToken.mockRejectedValue(new Error("Token already revoked"));

      const storedIntegration = {
        id: "integ-1",
        organizationId: ORG_ID,
        googleUserId: "user@example.com",
        googleEmail: "user@example.com",
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
      mockWithDbAll(mockDb);

      const result = await googleService.disconnect(ORG_ID);

      // Should still succeed even if revoke failed
      expect(result).toEqual({ success: true });
      expect(mockRevokeToken).toHaveBeenCalled();
      expect(mockDb.googleIntegration.delete).toHaveBeenCalledWith({
        where: { organizationId: ORG_ID },
      });
    });

    /**
     * A row with no ciphertext resolves no token. `revokeToken(null)` would no-op
     * and leave a live OAuth grant standing after the local row is deleted, so
     * the revoke is skipped explicitly rather than cast through. The sibling
     * case above is the positive control: with a token present, revoke IS
     * called, so this assertion is not vacuous.
     */
    it("skips the revoke when no token can be resolved, and still deletes", async () => {
      mockResolveEncryptedToken.mockResolvedValue(null);

      const storedIntegration = {
        id: "integ-1",
        organizationId: ORG_ID,
        googleUserId: "user@example.com",
        googleEmail: "user@example.com",
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
      mockWithDbAll(mockDb);

      const result = await googleService.disconnect(ORG_ID);

      expect(result).toEqual({ success: true });
      expect(mockRevokeToken).not.toHaveBeenCalled();
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
      mockWithDbAll(mockDb);

      const result = await googleService.disconnect(ORG_ID);

      expect(result).toEqual({ success: true });
      expect(mockResolveEncryptedToken).not.toHaveBeenCalled();
      expect(mockRevokeToken).not.toHaveBeenCalled();
      expect(mockDb.googleIntegration.delete).not.toHaveBeenCalled();
    });
  });
});

/**
 * ISS-6319. Both Google integration writes pin `select: { id: true }` so
 * Postgres RETURNINGs one primary-key cell instead of every column — the row
 * carries four `@db.Text` token columns whose values are discarded by both
 * call sites.
 *
 * The source gate cannot see the shape of a write issued inside a `withDb`
 * callback, and the encryption suite above reads only `data`/`create`/`update`.
 * Without these two assertions either site can drop its `select` and silently
 * go back to `RETURNING *` with every existing test still green.
 */
describe("Google service discarded-write narrowing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("RETURNINGs only the id from the OAuth-callback upsert", async () => {
    mockExchangeCodeForTokens.mockResolvedValue({
      accessToken: "raw-access-token",
      refreshToken: "raw-refresh-token",
      expiresIn: 3600,
    });
    mockGetUserInfo.mockResolvedValue({
      email: "user@example.com",
      sub: "google-uid-1",
    });
    mockBuildTokenColumns.mockResolvedValueOnce(
      encryptedColumns("encrypted-access-token", "encrypted-refresh-token")
    );

    const mockDb = {
      googleIntegration: {
        upsert: vi.fn().mockResolvedValue({ id: "integ-1" }),
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
    expect(mockDb.googleIntegration.upsert.mock.calls[0][0].select).toEqual({
      id: true,
    });
  });

  it("RETURNINGs only the id from the token-refresh update", async () => {
    mockResolveEncryptedToken.mockResolvedValueOnce("decrypted-refresh-token");
    mockRefreshAccessToken.mockResolvedValue({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresIn: 3600,
    });
    mockBuildTokenColumns.mockResolvedValueOnce(
      encryptedColumns(
        "new-encrypted-access-token",
        "new-encrypted-refresh-token"
      )
    );

    const mockDb = {
      googleIntegration: {
        update: vi.fn().mockResolvedValue({ id: "integ-1" }),
      },
    };
    mockWithDbCall(mockDb);

    const result = await ensureValidAccessToken(
      makeIntegration({
        accessTokenEncrypted: "old-encrypted-access-token",
        refreshTokenEncrypted: "old-encrypted-refresh-token",
        tokenExpiresAt: new Date(Date.now() - 3_600_000),
      }),
      ORG_ID
    );

    expect(result).toEqual({
      success: true,
      accessToken: "new-access-token",
    });
    expect(mockDb.googleIntegration.update.mock.calls[0][0].select).toEqual({
      id: true,
    });
  });
});
