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
  resolveEncryptedIntegrationToken: vi.fn(),
  encryptTokenPair: vi.fn(),
  buildIntegrationTokenColumns: vi.fn(),
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
  buildIntegrationTokenColumns,
  decryptIntegrationToken,
  encryptIntegrationToken,
  encryptTokenPair,
  resolveEncryptedIntegrationToken,
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
    /** The provider half of a connect: the exchange, the viewer, the client. */
    function arrangeConnect(refreshToken: string | undefined) {
      mockExchangeCodeForTokens.mockResolvedValue({
        accessToken: "raw-access-token",
        refreshToken,
        expiresIn: 3600,
        tokenType: "Bearer",
        scope: [],
      });
      mockGetViewer.mockResolvedValue({ id: "linear-org-1", name: "Test Org" });
      mockCreateLinearClient.mockReturnValue({});
    }

    it("encrypts access token and refresh token before storing", async () => {
      arrangeConnect("raw-refresh-token");
      mockBuildTokenColumns.mockResolvedValueOnce(
        encryptedColumns("encrypted-access-token", "encrypted-refresh-token")
      );

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

      // The connect path routes through the ONE shared builder, tagged so the
      // monitored plaintext-write event can name which write produced a row.
      expect(mockBuildTokenColumns).toHaveBeenCalledWith(
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

      // ISS-11096: neither upsert branch writes the legacy plaintext columns.
      for (const branch of [upsertCall.create, upsertCall.update]) {
        expect(branch).not.toHaveProperty("accessToken");
        expect(branch).not.toHaveProperty("refreshToken");
      }
    });

    it("stores null for refreshTokenEncrypted when no refresh token is returned", async () => {
      arrangeConnect(undefined);
      mockBuildTokenColumns.mockResolvedValueOnce(
        accessOnlyColumns("encrypted-access-token")
      );

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

      // The builder is called with the undefined refresh token
      expect(mockBuildTokenColumns).toHaveBeenCalledWith(
        "raw-access-token",
        undefined
      );

      const upsertCall = mockDb.linearIntegration.upsert.mock.calls[0][0];
      expect(upsertCall.create.accessTokenEncrypted).toBe(
        "encrypted-access-token"
      );
      // ISS-7781: no refresh token was issued, so the builder omits BOTH
      // refresh keys and Prisma leaves the stored ones untouched. `null` here
      // would delete the org's only means of refreshing.
      expect(upsertCall.create).not.toHaveProperty("refreshTokenEncrypted");
      expect(upsertCall.create).not.toHaveProperty("refreshToken");
    });

    /**
     * ISS-11096: a reconnect with no reissued refresh token no longer reads the
     * stored row to rescue a legacy plaintext refresh token.
     */
    it("does not read the stored row on a reconnect that reissues no refresh token", async () => {
      arrangeConnect(undefined);
      mockBuildTokenColumns.mockResolvedValueOnce(
        accessOnlyColumns("encrypted-access-token")
      );

      const mockDb = {
        linearIntegration: {
          upsert: vi.fn().mockResolvedValue({}),
          findUnique: vi.fn(),
        },
      };
      mockWithDbCall(mockDb);

      await linearService.completeOAuthCallback(
        "auth-code",
        "code-verifier",
        "https://app.example.com/callback",
        ORG_ID,
        "clerk-user-1"
      );

      expect(mockDb.linearIntegration.upsert).toHaveBeenCalledTimes(1);
      expect(mockDb.linearIntegration.findUnique).not.toHaveBeenCalled();
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
      expect(mockBuildTokenColumns).not.toHaveBeenCalled();
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
      // The token builder runs in parallel with getViewer inside Promise.all —
      // it must resolve so that the null-org check can be reached
      mockBuildTokenColumns.mockResolvedValueOnce(
        encryptedColumns("encrypted-access-token", "encrypted-refresh-token")
      );

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
        accessTokenEncrypted: "old-encrypted-access-token",
        refreshTokenEncrypted: "old-encrypted-refresh-token",
        tokenExpiresAt: new Date(Date.now() - 3_600_000), // expired 1h ago
        linearOrgId: "linear-org-1",
        linearOrgName: "Test Org",
        defaultTeamId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockResolveEncryptedToken.mockResolvedValueOnce(
        "decrypted-refresh-token"
      ); // refreshToken — accessToken decrypt skipped when needsRefresh
      mockRefreshAccessToken.mockResolvedValue({
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        expiresIn: 3600,
        tokenType: "Bearer",
        scope: [],
      });
      mockBuildTokenColumns.mockResolvedValueOnce(
        encryptedColumns(
          "new-encrypted-access-token",
          "new-encrypted-refresh-token"
        )
      );
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
      const updateCall = mockDb.linearIntegration.update.mock.calls[0][0];
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
     * ISS-5081: a decrypt failure no longer falls back to the plaintext
     * column beside the ciphertext; the status reports disconnected.
     */
    it("reports disconnected instead of using plaintext when decryption throws", async () => {
      mockResolveEncryptedToken.mockRejectedValueOnce(
        new Error("kms unavailable")
      );
      const mockDb = {
        linearIntegration: {
          findUnique: vi.fn().mockResolvedValue({
            id: "integ-1",
            accessTokenEncrypted: "encrypted-access-token",
            refreshTokenEncrypted: null,
            tokenExpiresAt: null,
            linearOrgName: "Test Org",
            defaultTeamId: null,
          }),
        },
      };
      mockWithDbCall(mockDb);

      const result = await linearService.getIntegrationStatus(ORG_ID);

      expect(result).toEqual({ success: true, connected: false });
      expect(mockCreateLinearClient).not.toHaveBeenCalled();
    });

    /**
     * ISS-11096: only a refresh-token CIPHERTEXT makes an expired row
     * refreshable. Without one the read fails and the status reports
     * disconnected: it neither serves the expired access token nor spends a
     * legacy plaintext refresh token.
     */
    it("reports disconnected for an expired row that has no refresh-token ciphertext", async () => {
      mockResolveEncryptedToken.mockImplementation((encrypted) =>
        Promise.resolve(encrypted ? "decrypted-access-token" : null)
      );
      mockGetTeams.mockResolvedValue([]);
      mockCreateLinearClient.mockReturnValue({});
      const mockDb = {
        linearIntegration: {
          findUnique: vi.fn().mockResolvedValue({
            id: "integ-1",
            accessTokenEncrypted: "old-encrypted-access-token",
            refreshTokenEncrypted: null,
            tokenExpiresAt: new Date(Date.now() - 3_600_000), // expired
            linearOrgName: "Test Org",
            defaultTeamId: null,
          }),
          update: vi.fn(),
        },
      };
      mockWithDbCall(mockDb);

      const result = await linearService.getIntegrationStatus(ORG_ID);

      expect(result).toEqual({ success: true, connected: false });
      expect(mockResolveEncryptedToken).not.toHaveBeenCalledWith(
        "old-encrypted-access-token"
      );
      expect(mockCreateLinearClient).not.toHaveBeenCalled();
      expect(mockRefreshAccessToken).not.toHaveBeenCalled();
      expect(mockDb.linearIntegration.update).not.toHaveBeenCalled();
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
      mockWithDbAll(mockDb);

      await linearService.disconnect(ORG_ID);

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
      mockWithDbAll(mockDb);

      // Should not throw even if revoke failed
      await expect(linearService.disconnect(ORG_ID)).resolves.toBeUndefined();

      expect(mockRevokeToken).toHaveBeenCalled();
      expect(mockDb.linearIntegration.delete).toHaveBeenCalledWith({
        where: { id: "integ-1" },
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
      mockWithDbAll(mockDb);

      await expect(linearService.disconnect(ORG_ID)).resolves.toBeUndefined();

      expect(mockRevokeToken).not.toHaveBeenCalled();
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
      mockWithDbAll(mockDb);

      await linearService.disconnect(ORG_ID);

      expect(mockResolveEncryptedToken).not.toHaveBeenCalled();
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

    /** Everything an approved-plan export needs except the token resolution. */
    function arrangeExport(
      integration: ReturnType<typeof makeLinearIntegration>
    ) {
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
      mockCreateLinearClient.mockReturnValue({});
      mockDocumentVersionServiceGetLatest.mockResolvedValue({
        content: "# Implementation Plan\n\n## Tasks",
      });
      const mockDb = {
        artifact: { findFirst: vi.fn().mockResolvedValue(makeArtifact()) },
        linearIntegration: {
          findUnique: vi.fn().mockResolvedValue(integration),
        },
        linearSubtask: {
          createMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      mockWithDbCall(mockDb);
      return mockDb;
    }

    it("decrypts accessTokenEncrypted before creating Linear client for export", async () => {
      mockResolveEncryptedToken.mockResolvedValue("decrypted-access-token");
      const mockDb = arrangeExport(makeLinearIntegration());

      const result = await linearService.exportImplementationPlan(
        DOCUMENT_ID,
        TEAM_ID,
        ORG_ID,
        USER_ID
      );

      expect(result).toMatchObject({ success: true, issuesCreated: 1 });

      // resolveEncryptedIntegrationToken must be called with the encrypted access token field
      expect(mockResolveEncryptedToken).toHaveBeenCalledWith(
        "encrypted-access-token"
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

    /** ISS-11096: no access-token ciphertext fails the export before Linear. */
    it("fails the export when the row has no access-token ciphertext", async () => {
      mockResolveEncryptedToken.mockResolvedValue(null);
      arrangeExport(makeLinearIntegration({ accessTokenEncrypted: null }));

      const result = await linearService.exportImplementationPlan(
        DOCUMENT_ID,
        TEAM_ID,
        ORG_ID,
        USER_ID
      );

      expect(result).toEqual({
        success: false,
        error: "Linear access token is unavailable. Please reconnect Linear.",
        status: 502,
      });
      expect(mockResolveEncryptedToken).toHaveBeenCalledWith(null);
      expect(mockCreateLinearClient).not.toHaveBeenCalled();
    });
  });
});

/**
 * ISS-6319. Both Linear integration writes pin `select: { id: true }` so
 * Postgres RETURNINGs one primary-key cell instead of every column — the row
 * carries four `@db.Text` token columns whose values are discarded by both
 * call sites.
 *
 * The source gate cannot see the shape of a write issued inside a `withDb`
 * callback, and the encryption suite above reads only `data`/`create`/`update`.
 * Without these two assertions either site can drop its `select` and silently
 * go back to `RETURNING *` with every existing test still green.
 */
describe("Linear service discarded-write narrowing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("RETURNINGs only the id from the OAuth-callback upsert", async () => {
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
    mockBuildTokenColumns.mockResolvedValueOnce(
      encryptedColumns("encrypted-access-token", "encrypted-refresh-token")
    );

    const mockDb = {
      linearIntegration: {
        upsert: vi.fn().mockResolvedValue({ id: "integ-1" }),
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
    expect(mockDb.linearIntegration.upsert.mock.calls[0][0].select).toEqual({
      id: true,
    });
  });

  it("RETURNINGs only the id from the token-refresh update", async () => {
    mockResolveEncryptedToken.mockResolvedValueOnce("decrypted-refresh-token");
    mockRefreshAccessToken.mockResolvedValue({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresIn: 3600,
      tokenType: "Bearer",
      scope: [],
    });
    mockBuildTokenColumns.mockResolvedValueOnce(
      encryptedColumns(
        "new-encrypted-access-token",
        "new-encrypted-refresh-token"
      )
    );
    mockGetTeams.mockResolvedValue([]);
    mockCreateLinearClient.mockReturnValue({});

    const mockDb = {
      linearIntegration: {
        findUnique: vi.fn().mockResolvedValue({
          id: "integ-1",
          organizationId: ORG_ID,
          accessTokenEncrypted: "old-encrypted-access-token",
          refreshTokenEncrypted: "old-encrypted-refresh-token",
          tokenExpiresAt: new Date(Date.now() - 3_600_000),
          linearOrgId: "linear-org-1",
          linearOrgName: "Test Org",
          defaultTeamId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        update: vi.fn().mockResolvedValue({ id: "integ-1" }),
      },
    };
    mockWithDbCall(mockDb);

    await linearService.getIntegrationStatus(ORG_ID);

    expect(mockRefreshAccessToken).toHaveBeenCalledWith(
      "decrypted-refresh-token"
    );
    expect(mockDb.linearIntegration.update.mock.calls[0][0].select).toEqual({
      id: true,
    });
  });
});
