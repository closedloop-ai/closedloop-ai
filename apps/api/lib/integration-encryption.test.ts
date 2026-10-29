import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @repo/aws/credentials before any imports that transitively load it
vi.mock("@repo/aws/credentials", () => ({
  getAwsCredentials: vi.fn().mockReturnValue(undefined),
}));

// The monitored plaintext-read event is asserted through the logger it is
// emitted on, not through the telemetry module — mocking the module under
// assertion would prove only that the test mocked it.
vi.mock("@repo/observability/log", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// mockSend is the single shared send function injected into the KMSClient mock.
// Because integration-encryption.ts uses a module-level singleton for the KMS
// client, we cannot replace it per-test. Instead we reset mockSend before each
// test via vi.clearAllMocks() and control its return value with mockResolvedValueOnce.
const mockSend = vi.fn();

vi.mock("@aws-sdk/client-kms", () => {
  class KMSClient {
    send = mockSend;
  }

  class EncryptCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }

  class DecryptCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }

  return { KMSClient, EncryptCommand, DecryptCommand };
});

import {
  buildIntegrationTokenColumns,
  decryptIntegrationToken,
  encryptIntegrationToken,
  encryptTokenPair,
  resolveEncryptedIntegrationToken,
} from "./integration-encryption";

const KMS_KEY_ARN = "arn:aws:kms:us-east-1:123456789012:key/test-key-id";
const PLAINTEXT_TOKEN = "ya29.a0AfH6SMBxyz-test-access-token";
const ENCRYPTED_BASE64 = Buffer.from("fake-ciphertext-bytes").toString(
  "base64"
);

function setupEnv() {
  process.env.KMS_KEY_ARN = KMS_KEY_ARN;
}

function clearEnv() {
  // Set to empty string — env vars are always strings; "" is falsy and triggers
  // the requireKmsKeyArn() guard without using the delete operator
  process.env.KMS_KEY_ARN = "";
}

describe("encryptIntegrationToken", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupEnv();
  });

  it("returns a base64-encoded ciphertext when KMS responds with CiphertextBlob", async () => {
    const fakeCiphertext = Buffer.from("encrypted-bytes");
    mockSend.mockResolvedValueOnce({ CiphertextBlob: fakeCiphertext });

    const result = await encryptIntegrationToken(PLAINTEXT_TOKEN);

    expect(result).toBe(fakeCiphertext.toString("base64"));
  });

  it("sends the token as UTF-8 Plaintext to KMS", async () => {
    const fakeCiphertext = Buffer.from("encrypted-bytes");
    mockSend.mockResolvedValueOnce({ CiphertextBlob: fakeCiphertext });

    await encryptIntegrationToken(PLAINTEXT_TOKEN);

    const [[encryptCmd]] = mockSend.mock.calls;
    expect(
      (encryptCmd as { input: { Plaintext: Buffer } }).input.Plaintext
    ).toEqual(Buffer.from(PLAINTEXT_TOKEN, "utf-8"));
  });

  it("uses the configured KMS key ARN from KMS_KEY_ARN env var", async () => {
    const fakeCiphertext = Buffer.from("encrypted-bytes");
    mockSend.mockResolvedValueOnce({ CiphertextBlob: fakeCiphertext });

    await encryptIntegrationToken(PLAINTEXT_TOKEN);

    const [[encryptCmd]] = mockSend.mock.calls;
    expect((encryptCmd as { input: { KeyId: string } }).input.KeyId).toBe(
      KMS_KEY_ARN
    );
  });

  it("uses an integration-token encryption context for cryptographic separation", async () => {
    const fakeCiphertext = Buffer.from("encrypted-bytes");
    mockSend.mockResolvedValueOnce({ CiphertextBlob: fakeCiphertext });

    await encryptIntegrationToken(PLAINTEXT_TOKEN);

    const [[encryptCmd]] = mockSend.mock.calls;
    const context = (
      encryptCmd as { input: { EncryptionContext: Record<string, string> } }
    ).input.EncryptionContext;
    expect(context).toMatchObject({ purpose: "integration-token" });
  });

  it("throws when KMS_KEY_ARN is not configured (fail-closed)", async () => {
    clearEnv();

    await expect(encryptIntegrationToken(PLAINTEXT_TOKEN)).rejects.toThrow(
      "KMS_KEY_ARN is not configured"
    );
  });

  it("throws when KMS returns empty CiphertextBlob (fail-closed)", async () => {
    mockSend.mockResolvedValueOnce({ CiphertextBlob: undefined });

    await expect(encryptIntegrationToken(PLAINTEXT_TOKEN)).rejects.toThrow(
      "KMS encryption failed: empty ciphertext"
    );
  });

  it("propagates KMS client errors (fail-closed)", async () => {
    mockSend.mockRejectedValueOnce(new Error("KMS service unavailable"));

    await expect(encryptIntegrationToken(PLAINTEXT_TOKEN)).rejects.toThrow(
      "KMS service unavailable"
    );
  });
});

describe("decryptIntegrationToken", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupEnv();
  });

  it("returns the plaintext token when KMS responds with Plaintext", async () => {
    const fakePlaintext = Buffer.from(PLAINTEXT_TOKEN, "utf-8");
    mockSend.mockResolvedValueOnce({ Plaintext: fakePlaintext });

    const result = await decryptIntegrationToken(ENCRYPTED_BASE64);

    expect(result).toBe(PLAINTEXT_TOKEN);
  });

  it("passes the base64-decoded ciphertext to KMS as CiphertextBlob", async () => {
    const fakePlaintext = Buffer.from(PLAINTEXT_TOKEN, "utf-8");
    mockSend.mockResolvedValueOnce({ Plaintext: fakePlaintext });

    await decryptIntegrationToken(ENCRYPTED_BASE64);

    const [[decryptCmd]] = mockSend.mock.calls;
    expect(
      (decryptCmd as { input: { CiphertextBlob: Buffer } }).input.CiphertextBlob
    ).toEqual(Buffer.from(ENCRYPTED_BASE64, "base64"));
  });

  it("uses the same integration-token encryption context that was used during encryption", async () => {
    const fakePlaintext = Buffer.from(PLAINTEXT_TOKEN, "utf-8");
    mockSend.mockResolvedValueOnce({ Plaintext: fakePlaintext });

    await decryptIntegrationToken(ENCRYPTED_BASE64);

    const [[decryptCmd]] = mockSend.mock.calls;
    const context = (
      decryptCmd as { input: { EncryptionContext: Record<string, string> } }
    ).input.EncryptionContext;
    expect(context).toMatchObject({ purpose: "integration-token" });
  });

  it("throws when KMS returns empty Plaintext (fail-closed)", async () => {
    mockSend.mockResolvedValueOnce({ Plaintext: undefined });

    await expect(decryptIntegrationToken(ENCRYPTED_BASE64)).rejects.toThrow(
      "KMS decryption failed: empty plaintext"
    );
  });

  it("propagates KMS client errors (fail-closed)", async () => {
    mockSend.mockRejectedValueOnce(new Error("KMS InvalidCiphertextException"));

    await expect(decryptIntegrationToken(ENCRYPTED_BASE64)).rejects.toThrow(
      "KMS InvalidCiphertextException"
    );
  });
});

describe("encrypt/decrypt round-trip", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupEnv();
  });

  it("produces a base64 ciphertext that can be decrypted back to the original token", async () => {
    const fakeCiphertext = Buffer.from("round-trip-cipher-bytes");
    const fakePlaintext = Buffer.from(PLAINTEXT_TOKEN, "utf-8");

    mockSend
      .mockResolvedValueOnce({ CiphertextBlob: fakeCiphertext })
      .mockResolvedValueOnce({ Plaintext: fakePlaintext });

    const encrypted = await encryptIntegrationToken(PLAINTEXT_TOKEN);
    const decrypted = await decryptIntegrationToken(encrypted);

    expect(decrypted).toBe(PLAINTEXT_TOKEN);
  });

  it("uses a consistent encryption context across encrypt and decrypt calls", async () => {
    const fakeCiphertext = Buffer.from("cipher-bytes");
    const fakePlaintext = Buffer.from(PLAINTEXT_TOKEN, "utf-8");

    mockSend
      .mockResolvedValueOnce({ CiphertextBlob: fakeCiphertext })
      .mockResolvedValueOnce({ Plaintext: fakePlaintext });

    await encryptIntegrationToken(PLAINTEXT_TOKEN);
    const encrypted = fakeCiphertext.toString("base64");
    await decryptIntegrationToken(encrypted);

    const calls = mockSend.mock.calls;
    const encryptContext = (
      calls[0][0] as { input: { EncryptionContext: unknown } }
    ).input.EncryptionContext;
    const decryptContext = (
      calls[1][0] as { input: { EncryptionContext: unknown } }
    ).input.EncryptionContext;

    // Both encrypt and decrypt must use the same context so KMS can validate the AEAD
    expect(encryptContext).toEqual(decryptContext);
  });
});

describe("distinct encryption contexts per integration type", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupEnv();
  });

  it("uses a context that scopes tokens to the integration-token purpose, preventing cross-domain decryption", async () => {
    const fakeCiphertext = Buffer.from("cipher-bytes");
    mockSend.mockResolvedValueOnce({ CiphertextBlob: fakeCiphertext });

    await encryptIntegrationToken(PLAINTEXT_TOKEN);

    const [[encryptCmd]] = mockSend.mock.calls;
    // The encryption context must include a 'purpose' key that scopes this
    // ciphertext to integration tokens — a token encrypted with a different
    // context (e.g., api-key context) cannot be decrypted by this utility
    const context = (
      encryptCmd as { input: { EncryptionContext: Record<string, string> } }
    ).input.EncryptionContext;
    expect(context).toHaveProperty("purpose");
    expect(context.purpose).toContain("integration");
  });

  it("does not use an empty or absent encryption context (ensures AEAD binding)", async () => {
    const fakeCiphertext = Buffer.from("cipher-bytes");
    mockSend.mockResolvedValueOnce({ CiphertextBlob: fakeCiphertext });

    await encryptIntegrationToken(PLAINTEXT_TOKEN);

    const [[encryptCmd]] = mockSend.mock.calls;
    const context = (
      encryptCmd as { input: { EncryptionContext: Record<string, string> } }
    ).input.EncryptionContext;
    expect(context).toBeDefined();
    expect(Object.keys(context).length).toBeGreaterThan(0);
  });
});

describe("encryptTokenPair", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupEnv();
  });

  it("encrypts both access and refresh tokens and returns them by name", async () => {
    const accessCiphertext = Buffer.from("access-cipher-bytes");
    const refreshCiphertext = Buffer.from("refresh-cipher-bytes");
    mockSend
      .mockResolvedValueOnce({ CiphertextBlob: accessCiphertext })
      .mockResolvedValueOnce({ CiphertextBlob: refreshCiphertext });

    const result = await encryptTokenPair(PLAINTEXT_TOKEN, "refresh-token");

    expect(result.encryptedAccessToken).toBe(
      accessCiphertext.toString("base64")
    );
    expect(result.encryptedRefreshToken).toBe(
      refreshCiphertext.toString("base64")
    );
  });

  it("issues exactly two KMS encrypt calls when both tokens are present", async () => {
    // encryptTokenPair uses Promise.all — both calls are issued before either
    // resolves. Asserting call count of 2 is the observable evidence of this.
    mockSend
      .mockResolvedValueOnce({ CiphertextBlob: Buffer.from("a") })
      .mockResolvedValueOnce({ CiphertextBlob: Buffer.from("b") });

    await encryptTokenPair(PLAINTEXT_TOKEN, "refresh-token");

    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("returns null for encryptedRefreshToken when refreshToken is null", async () => {
    mockSend.mockResolvedValueOnce({
      CiphertextBlob: Buffer.from("access-cipher-bytes"),
    });

    const result = await encryptTokenPair(PLAINTEXT_TOKEN, null);

    expect(result.encryptedRefreshToken).toBeNull();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("returns null for encryptedRefreshToken when refreshToken is undefined", async () => {
    mockSend.mockResolvedValueOnce({
      CiphertextBlob: Buffer.from("access-cipher-bytes"),
    });

    const result = await encryptTokenPair(PLAINTEXT_TOKEN, undefined);

    expect(result.encryptedRefreshToken).toBeNull();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

/**
 * The write-path half of the encryption migration. ISS-11096: the columns are
 * ciphertext only, with no legacy plaintext key. ISS-5081: a failed encrypt
 * throws instead of returning plaintext columns to store.
 */
describe("buildIntegrationTokenColumns", () => {
  const REFRESH_TOKEN = "1//0g-test-refresh-token";

  beforeEach(() => {
    vi.resetAllMocks();
    setupEnv();
  });

  it("stores ciphertext only, with no plaintext column, when encryption succeeds", async () => {
    mockSend.mockResolvedValue({
      CiphertextBlob: Buffer.from("fake-ciphertext-bytes"),
    });

    const columns = await buildIntegrationTokenColumns(
      PLAINTEXT_TOKEN,
      REFRESH_TOKEN
    );

    expect(columns).toEqual({
      accessTokenEncrypted: ENCRYPTED_BASE64,
      refreshTokenEncrypted: ENCRYPTED_BASE64,
    });
  });

  it("throws when encryption fails rather than returning plaintext columns", async () => {
    mockSend.mockRejectedValue(new Error("kms unavailable"));

    await expect(
      buildIntegrationTokenColumns(PLAINTEXT_TOKEN, REFRESH_TOKEN)
    ).rejects.toThrow("kms unavailable");
  });

  it("throws when only the refresh token fails to encrypt", async () => {
    mockSend
      .mockResolvedValueOnce({ CiphertextBlob: Buffer.from("access-cipher") })
      .mockRejectedValueOnce(new Error("kms unavailable"));

    await expect(
      buildIntegrationTokenColumns(PLAINTEXT_TOKEN, REFRESH_TOKEN)
    ).rejects.toThrow("kms unavailable");
  });

  /**
   * Google ordinarily reissues NO refresh token on a refresh. Writing `null`
   * there would delete the organization's only means of refreshing, so the
   * refresh key must be ABSENT — Prisma leaves an omitted column alone.
   */
  it("omits the refresh column when there is no refresh token to store", async () => {
    mockSend.mockResolvedValue({
      CiphertextBlob: Buffer.from("fake-ciphertext-bytes"),
    });

    const columns = await buildIntegrationTokenColumns(
      PLAINTEXT_TOKEN,
      undefined
    );

    expect(columns).toEqual({ accessTokenEncrypted: ENCRYPTED_BASE64 });
  });
});

/**
 * ISS-11096: the Google and Linear read path. Ciphertext only — a row without
 * one resolves to null, so its caller fails the read instead of falling back.
 */
describe("resolveEncryptedIntegrationToken", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupEnv();
  });

  it("decrypts and returns the token when the row has ciphertext", async () => {
    mockSend.mockResolvedValueOnce({
      Plaintext: Buffer.from(PLAINTEXT_TOKEN, "utf-8"),
    });

    await expect(
      resolveEncryptedIntegrationToken(ENCRYPTED_BASE64)
    ).resolves.toBe(PLAINTEXT_TOKEN);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("resolves null without calling KMS when the row has no ciphertext", async () => {
    await expect(resolveEncryptedIntegrationToken(null)).resolves.toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("propagates a decrypt failure", async () => {
    mockSend.mockRejectedValueOnce(new Error("kms unavailable"));

    await expect(
      resolveEncryptedIntegrationToken(ENCRYPTED_BASE64)
    ).rejects.toThrow("kms unavailable");
  });
});
