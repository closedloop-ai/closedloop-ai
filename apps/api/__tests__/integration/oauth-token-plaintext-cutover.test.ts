import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import {
  exchangeCodeForTokens as exchangeGoogleCode,
  getUserInfo,
  refreshAccessToken as refreshGoogleToken,
} from "@repo/google";
import {
  createLinearClient,
  exchangeCodeForTokens as exchangeLinearCode,
  getTeams,
  getViewer,
  refreshAccessToken as refreshLinearToken,
} from "@repo/linear";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { checkIntegrationTokenEncryption } from "@/app/cron/audit-data-invariants/integration-token-encryption";
import {
  ensureValidAccessToken,
  googleService,
} from "@/app/integrations/google/service";
import { linearService } from "@/app/integrations/linear/service";
import {
  decryptIntegrationToken,
  encryptIntegrationToken,
} from "@/lib/integration-encryption";
import { IntegrationTokenOwner } from "@/lib/observability/integration-token-plaintext-telemetry";
import {
  autoRollbackTransaction,
  createTestOrganization,
} from "../utils/db-helpers";

/**
 * ISS-5081 and ISS-11096, through the real service path: the real
 * `integration-encryption` builder and resolver, the real telemetry, and a real
 * Postgres row. Only the KMS transport and the two OAuth providers are faked.
 * The fake KMS is reversible, so a stored ciphertext really decrypts back to
 * its token.
 *
 * ISS-11096 dropped the legacy `access_token` / `refresh_token` columns, so a
 * row without ciphertext holds no credential at all and must fail closed.
 */

const hasDatabase = !!keys().DATABASE_URL;

const kms = vi.hoisted(() => ({ failEncrypt: false, failDecrypt: false }));

vi.mock("@repo/aws/credentials", () => ({
  getAwsCredentials: vi.fn().mockReturnValue(undefined),
}));

vi.mock("@aws-sdk/client-kms", () => {
  const MARKER = Buffer.from("fake-kms:");
  class EncryptCommand {
    input: { Plaintext: Uint8Array };
    constructor(input: { Plaintext: Uint8Array }) {
      this.input = input;
    }
  }
  class DecryptCommand {
    input: { CiphertextBlob: Uint8Array };
    constructor(input: { CiphertextBlob: Uint8Array }) {
      this.input = input;
    }
  }
  class KMSClient {
    send(command: EncryptCommand | DecryptCommand) {
      if (command instanceof EncryptCommand) {
        if (kms.failEncrypt) {
          return Promise.reject(new Error("kms unavailable"));
        }
        const reversed = Buffer.from(command.input.Plaintext).reverse();
        return Promise.resolve({
          CiphertextBlob: Buffer.concat([MARKER, reversed]),
        });
      }
      if (kms.failDecrypt) {
        return Promise.reject(new Error("kms unavailable"));
      }
      const blob = Buffer.from(command.input.CiphertextBlob);
      return Promise.resolve({
        Plaintext: blob.subarray(MARKER.length).reverse(),
      });
    }
  }
  return { KMSClient, EncryptCommand, DecryptCommand };
});

vi.mock("@repo/google", async () => ({
  ...(await vi.importActual<object>("@repo/google")),
  exchangeCodeForTokens: vi.fn(),
  getUserInfo: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

vi.mock("@repo/linear", async () => ({
  ...(await vi.importActual<object>("@repo/linear")),
  createLinearClient: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  getTeams: vi.fn(),
  getViewer: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

const EXPIRED = new Date("2000-01-01T00:00:00.000Z");
const NOT_EXPIRED = new Date("2999-01-01T00:00:00.000Z");
const NEW_ACCESS = "freshly-issued-access-token";
const NEW_REFRESH = "freshly-issued-refresh-token";

const originalKmsKeyArn = process.env.KMS_KEY_ARN;

beforeEach(() => {
  kms.failEncrypt = false;
  kms.failDecrypt = false;
  process.env.KMS_KEY_ARN = "arn:aws:kms:us-east-1:000000000000:key/test";
});

afterEach(() => {
  vi.clearAllMocks();
  if (originalKmsKeyArn === undefined) {
    Reflect.deleteProperty(process.env, "KMS_KEY_ARN");
  } else {
    process.env.KMS_KEY_ARN = originalKmsKeyArn;
  }
});

async function unencryptedCount(owner: IntegrationTokenOwner) {
  const backlog = await checkIntegrationTokenEncryption();
  return backlog.byOwner.find((entry) => entry.owner === owner)?.unencrypted;
}

function createGoogleRow(data: {
  organizationId: string;
  accessTokenEncrypted?: string;
  refreshTokenEncrypted?: string;
  tokenExpiresAt: Date;
}) {
  return withDb((db) =>
    db.googleIntegration.create({
      data: { googleUserId: "a@example.com", ...data },
      select: { id: true },
    })
  );
}

describe.skipIf(!hasDatabase)("Google OAuth token cutover (ISS-5081)", () => {
  it("stores a connect's tokens as ciphertext only", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      (exchangeGoogleCode as Mock).mockResolvedValue({
        accessToken: NEW_ACCESS,
        refreshToken: NEW_REFRESH,
        expiresIn: 3600,
      });
      (getUserInfo as Mock).mockResolvedValue({ email: "a@example.com" });

      const result = await googleService.completeOAuthCallback(
        "code",
        "verifier",
        "https://app.example.com/callback",
        orgId
      );

      expect(result).toEqual({ success: true });
      const row = await withDb((db) =>
        db.googleIntegration.findUniqueOrThrow({
          where: { organizationId: orgId },
        })
      );
      expect(
        await decryptIntegrationToken(row.accessTokenEncrypted ?? "")
      ).toBe(NEW_ACCESS);
      expect(
        await decryptIntegrationToken(row.refreshTokenEncrypted ?? "")
      ).toBe(NEW_REFRESH);

      // And the read path recovers the token from the ciphertext.
      const read = await ensureValidAccessToken(
        { ...row, tokenExpiresAt: NOT_EXPIRED },
        orgId
      );
      expect(read).toEqual({ success: true, accessToken: NEW_ACCESS });
    });
  });

  it("reads an encrypted-only row", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      await createGoogleRow({
        organizationId: orgId,
        accessTokenEncrypted: await encryptIntegrationToken(NEW_ACCESS),
        tokenExpiresAt: NOT_EXPIRED,
      });
      const integration = await googleService.getIntegration(orgId);

      const result = await ensureValidAccessToken(
        integration ?? expect.fail("integration missing"),
        orgId
      );

      expect(result).toEqual({ success: true, accessToken: NEW_ACCESS });
    });
  });

  /**
   * The ISS-11096 contract: a row with no access-token ciphertext holds no
   * credential. It fails the read with the existing reconnect error, and the
   * `integration_tokens_unencrypted` gauge counts the row, which is what a
   * monitor watches. EXPIRED, so the refresh branch is exercised too.
   */
  it("fails a row with no ciphertext closed, and the gauge counts it", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const before = await unencryptedCount(IntegrationTokenOwner.Google);
      await createGoogleRow({
        organizationId: orgId,
        tokenExpiresAt: EXPIRED,
      });
      const integration = await googleService.getIntegration(orgId);

      const result = await ensureValidAccessToken(
        integration ?? expect.fail("integration missing"),
        orgId
      );

      expect(result).toEqual({
        success: false,
        error:
          "Google refresh token is unavailable. Please reconnect Google Drive.",
      });
      expect(refreshGoogleToken).not.toHaveBeenCalled();
      expect(await unencryptedCount(IntegrationTokenOwner.Google)).toBe(
        (before ?? 0) + 1
      );
    });
  });

  /** The resolver reads an empty ciphertext as missing, so the gauge counts it. */
  it("fails an empty-ciphertext row closed, and the gauge counts it", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const before = await unencryptedCount(IntegrationTokenOwner.Google);
      await createGoogleRow({
        organizationId: orgId,
        accessTokenEncrypted: "",
        tokenExpiresAt: NOT_EXPIRED,
      });
      const integration = await googleService.getIntegration(orgId);

      const result = await ensureValidAccessToken(
        integration ?? expect.fail("integration missing"),
        orgId
      );

      expect(result).toEqual({
        success: false,
        error:
          "Google access token is unavailable. Please reconnect Google Drive.",
      });
      expect(await unencryptedCount(IntegrationTokenOwner.Google)).toBe(
        (before ?? 0) + 1
      );
    });
  });

  it("persists nothing when a connect cannot encrypt", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      kms.failEncrypt = true;
      (exchangeGoogleCode as Mock).mockResolvedValue({
        accessToken: NEW_ACCESS,
        refreshToken: NEW_REFRESH,
        expiresIn: 3600,
      });
      (getUserInfo as Mock).mockResolvedValue({ email: "a@example.com" });

      const result = await googleService.completeOAuthCallback(
        "code",
        "verifier",
        "https://app.example.com/callback",
        orgId
      );

      expect(result.success).toBe(false);
      const row = await withDb((db) =>
        db.googleIntegration.findUnique({ where: { organizationId: orgId } })
      );
      expect(row).toBeNull();
    });
  });

  it("does not store a refreshed token when it cannot encrypt", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const accessTokenEncrypted = await encryptIntegrationToken(NEW_ACCESS);
      const refreshTokenEncrypted = await encryptIntegrationToken(NEW_REFRESH);
      await createGoogleRow({
        organizationId: orgId,
        accessTokenEncrypted,
        refreshTokenEncrypted,
        tokenExpiresAt: EXPIRED,
      });
      kms.failEncrypt = true;
      (refreshGoogleToken as Mock).mockResolvedValue({
        accessToken: "rotated-access-token",
        expiresIn: 3600,
      });
      const integration = await googleService.getIntegration(orgId);

      const result = await ensureValidAccessToken(
        integration ?? expect.fail("integration missing"),
        orgId
      );

      expect(refreshGoogleToken).toHaveBeenCalledWith(NEW_REFRESH);
      expect(result.success).toBe(false);
      const row = await withDb((db) =>
        db.googleIntegration.findUniqueOrThrow({
          where: { organizationId: orgId },
        })
      );
      expect([row.accessTokenEncrypted, row.refreshTokenEncrypted]).toEqual([
        accessTokenEncrypted,
        refreshTokenEncrypted,
      ]);
    });
  });

  /**
   * Google omits `refresh_token` on a refresh once consent is granted, so the
   * write must leave the stored refresh ciphertext exactly where it is.
   */
  it("refreshes a ciphertext row, keeping the refresh token Google did not reissue", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const refreshTokenEncrypted = await encryptIntegrationToken(NEW_REFRESH);
      await createGoogleRow({
        organizationId: orgId,
        accessTokenEncrypted: await encryptIntegrationToken("expired-access"),
        refreshTokenEncrypted,
        tokenExpiresAt: EXPIRED,
      });
      (refreshGoogleToken as Mock).mockResolvedValue({
        accessToken: NEW_ACCESS,
        expiresIn: 3600,
      });
      const integration = await googleService.getIntegration(orgId);

      const result = await ensureValidAccessToken(
        integration ?? expect.fail("integration missing"),
        orgId
      );

      expect(result).toEqual({ success: true, accessToken: NEW_ACCESS });
      const row = await withDb((db) =>
        db.googleIntegration.findUniqueOrThrow({
          where: { organizationId: orgId },
        })
      );
      expect(
        await decryptIntegrationToken(row.accessTokenEncrypted ?? "")
      ).toBe(NEW_ACCESS);
      expect(row.refreshTokenEncrypted).toBe(refreshTokenEncrypted);
    });
  });

  /**
   * Fail-closed on the READ side: ciphertext present, KMS unable to decrypt.
   */
  it("refuses a row whose ciphertext will not decrypt", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      await createGoogleRow({
        organizationId: orgId,
        accessTokenEncrypted: await encryptIntegrationToken(NEW_ACCESS),
        tokenExpiresAt: NOT_EXPIRED,
      });
      const integration = await googleService.getIntegration(orgId);
      kms.failDecrypt = true;

      const result = await ensureValidAccessToken(
        integration ?? expect.fail("integration missing"),
        orgId
      );

      expect(result.success).toBe(false);
    });
  });
});

describe.skipIf(!hasDatabase)("Linear OAuth token cutover (ISS-5081)", () => {
  function createLinearRow(
    orgId: string,
    data: {
      accessTokenEncrypted?: string;
      refreshTokenEncrypted?: string;
      tokenExpiresAt: Date;
    }
  ) {
    return withDb((db) =>
      db.linearIntegration.create({
        data: {
          organizationId: orgId,
          linearOrgId: "lin-org-1",
          linearOrgName: "Acme",
          ...data,
        },
        select: { id: true },
      })
    );
  }

  beforeEach(() => {
    (getTeams as Mock).mockResolvedValue([]);
    (createLinearClient as Mock).mockReturnValue({});
  });

  it("stores a connect's tokens as ciphertext only", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      (exchangeLinearCode as Mock).mockResolvedValue({
        accessToken: NEW_ACCESS,
        refreshToken: NEW_REFRESH,
        expiresIn: 3600,
      });
      (getViewer as Mock).mockResolvedValue({
        id: "lin-org-1",
        name: "Acme",
      });

      const result = await linearService.completeOAuthCallback(
        "code",
        "verifier",
        "https://app.example.com/callback",
        orgId,
        "clerk-user-1"
      );

      expect(result).toEqual({ success: true });
      const row = await withDb((db) =>
        db.linearIntegration.findUniqueOrThrow({
          where: { organizationId: orgId },
        })
      );
      expect(
        await decryptIntegrationToken(row.accessTokenEncrypted ?? "")
      ).toBe(NEW_ACCESS);
      expect(
        await decryptIntegrationToken(row.refreshTokenEncrypted ?? "")
      ).toBe(NEW_REFRESH);
    });
  });

  it("persists nothing when a connect cannot encrypt", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      kms.failEncrypt = true;
      (exchangeLinearCode as Mock).mockResolvedValue({
        accessToken: NEW_ACCESS,
        refreshToken: NEW_REFRESH,
        expiresIn: 3600,
      });
      (getViewer as Mock).mockResolvedValue({
        id: "lin-org-1",
        name: "Acme",
      });

      const result = await linearService.completeOAuthCallback(
        "code",
        "verifier",
        "https://app.example.com/callback",
        orgId,
        "clerk-user-1"
      );

      expect(result.success).toBe(false);
      const row = await withDb((db) =>
        db.linearIntegration.findUnique({ where: { organizationId: orgId } })
      );
      expect(row).toBeNull();
    });
  });

  it("reads an encrypted-only row", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      await createLinearRow(orgId, {
        accessTokenEncrypted: await encryptIntegrationToken(NEW_ACCESS),
        tokenExpiresAt: NOT_EXPIRED,
      });

      const result = await linearService.getIntegrationStatus(orgId);

      expect(result).toMatchObject({ success: true, connected: true });
      expect(createLinearClient).toHaveBeenCalledWith(NEW_ACCESS);
    });
  });

  /** The Linear half of the ISS-11096 contract. */
  it("fails a row with no ciphertext closed, and the gauge counts it", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const before = await unencryptedCount(IntegrationTokenOwner.Linear);
      await createLinearRow(orgId, {
        tokenExpiresAt: EXPIRED,
      });

      const result = await linearService.getIntegrationStatus(orgId);

      expect(result).toEqual({ success: true, connected: false });
      expect(refreshLinearToken).not.toHaveBeenCalled();
      expect(createLinearClient).not.toHaveBeenCalled();
      expect(await unencryptedCount(IntegrationTokenOwner.Linear)).toBe(
        (before ?? 0) + 1
      );
    });
  });

  it("refreshes a ciphertext row to the rotated tokens' ciphertext", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      await createLinearRow(orgId, {
        accessTokenEncrypted: await encryptIntegrationToken("expired-access"),
        refreshTokenEncrypted: await encryptIntegrationToken("old-refresh"),
        tokenExpiresAt: EXPIRED,
      });
      (refreshLinearToken as Mock).mockResolvedValue({
        accessToken: NEW_ACCESS,
        refreshToken: NEW_REFRESH,
        expiresIn: 3600,
      });

      const result = await linearService.getIntegrationStatus(orgId);

      expect(refreshLinearToken).toHaveBeenCalledWith("old-refresh");
      expect(result).toMatchObject({ success: true, connected: true });
      const row = await withDb((db) =>
        db.linearIntegration.findUniqueOrThrow({
          where: { organizationId: orgId },
        })
      );
      expect(
        await decryptIntegrationToken(row.accessTokenEncrypted ?? "")
      ).toBe(NEW_ACCESS);
      expect(
        await decryptIntegrationToken(row.refreshTokenEncrypted ?? "")
      ).toBe(NEW_REFRESH);
    });
  });

  it("does not store a refreshed token when it cannot encrypt", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const accessTokenEncrypted = await encryptIntegrationToken("expired");
      const refreshTokenEncrypted =
        await encryptIntegrationToken("old-refresh");
      await createLinearRow(orgId, {
        accessTokenEncrypted,
        refreshTokenEncrypted,
        tokenExpiresAt: EXPIRED,
      });
      kms.failEncrypt = true;
      (refreshLinearToken as Mock).mockResolvedValue({
        accessToken: NEW_ACCESS,
        refreshToken: NEW_REFRESH,
        expiresIn: 3600,
      });

      const result = await linearService.getIntegrationStatus(orgId);

      expect(refreshLinearToken).toHaveBeenCalledWith("old-refresh");
      expect(result).toEqual({ success: true, connected: false });
      const row = await withDb((db) =>
        db.linearIntegration.findUniqueOrThrow({
          where: { organizationId: orgId },
        })
      );
      expect([row.accessTokenEncrypted, row.refreshTokenEncrypted]).toEqual([
        accessTokenEncrypted,
        refreshTokenEncrypted,
      ]);
    });
  });

  /** The Linear half of the same fail-closed read. */
  it("refuses a row whose ciphertext will not decrypt", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      await createLinearRow(orgId, {
        accessTokenEncrypted: await encryptIntegrationToken(NEW_ACCESS),
        tokenExpiresAt: NOT_EXPIRED,
      });
      kms.failDecrypt = true;

      const result = await linearService.getIntegrationStatus(orgId);

      expect(result).toEqual({ success: true, connected: false });
      expect(createLinearClient).not.toHaveBeenCalled();
    });
  });
});
