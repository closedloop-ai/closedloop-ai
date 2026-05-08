import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
  send: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

vi.mock("@repo/aws/credentials", () => ({
  getAwsCredentials: vi.fn(() => undefined),
}));

vi.mock("@aws-sdk/client-kms", () => {
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
  class KMSClient {
    send = mocks.send;
  }
  return { KMSClient, EncryptCommand, DecryptCommand };
});

import { apiKeyService } from "./api-key-service";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const PLAINTEXT_KEY = "sk-ant-test-1234567890abcd";
const PLAINTEXT_KEY_LAST_FOUR = "abcd";
const ENCRYPTED_BASE64 = Buffer.from("ciphertext-bytes", "utf-8").toString(
  "base64"
);

function installDb(db: Record<string, unknown>) {
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(db)
  );
}

beforeAll(() => {
  process.env.KMS_KEY_ARN = "arn:aws:kms:us-east-1:123:key/test-key";
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.send.mockImplementation((command: { input: unknown }) => {
    if (
      (command as { constructor: { name: string } }).constructor.name ===
      "EncryptCommand"
    ) {
      return Promise.resolve({
        CiphertextBlob: Buffer.from("ciphertext-bytes", "utf-8"),
      });
    }
    return Promise.resolve({
      Plaintext: Buffer.from(PLAINTEXT_KEY, "utf-8"),
    });
  });
});

describe("apiKeyService.setOrgKey", () => {
  it("encrypts the key and stores ciphertext + last-four metadata", async () => {
    const update = vi.fn().mockResolvedValue({});
    installDb({ organization: { update } });

    await apiKeyService.setOrgKey(ORG_ID, PLAINTEXT_KEY);

    expect(update).toHaveBeenCalledTimes(1);
    const call = update.mock.calls[0][0];
    expect(call.where).toEqual({ id: ORG_ID });
    expect(call.data.claudeApiKeyEncrypted).toBe(ENCRYPTED_BASE64);
    expect(call.data.claudeApiKeyLastFour).toBe(PLAINTEXT_KEY_LAST_FOUR);
    expect(call.data.claudeApiKeySetAt).toBeInstanceOf(Date);
    expect(call.data).not.toHaveProperty("anthropicApiKey");
  });
});

describe("apiKeyService.removeOrgKey", () => {
  it("clears all encrypted-key fields without referencing anthropicApiKey", async () => {
    const update = vi.fn().mockResolvedValue({});
    installDb({ organization: { update } });

    await apiKeyService.removeOrgKey(ORG_ID);

    expect(update).toHaveBeenCalledWith({
      where: { id: ORG_ID },
      data: {
        claudeApiKeyEncrypted: null,
        claudeApiKeyLastFour: null,
        claudeApiKeySetAt: null,
      },
    });
  });
});

describe("apiKeyService.getOrgKeyInfo", () => {
  it("returns isSet=true with metadata when an encrypted key exists", async () => {
    const setAt = new Date("2026-04-30T00:00:00.000Z");
    const findUnique = vi.fn().mockResolvedValue({
      claudeApiKeyEncrypted: ENCRYPTED_BASE64,
      claudeApiKeyLastFour: PLAINTEXT_KEY_LAST_FOUR,
      claudeApiKeySetAt: setAt,
    });
    installDb({ organization: { findUnique } });

    const info = await apiKeyService.getOrgKeyInfo(ORG_ID);

    expect(info).toEqual({
      isSet: true,
      lastFour: PLAINTEXT_KEY_LAST_FOUR,
      setAt,
    });
  });

  it("returns isSet=false when no encrypted key is stored", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      claudeApiKeyEncrypted: null,
      claudeApiKeyLastFour: null,
      claudeApiKeySetAt: null,
    });
    installDb({ organization: { findUnique } });

    const info = await apiKeyService.getOrgKeyInfo(ORG_ID);

    expect(info).toEqual({ isSet: false, lastFour: null, setAt: null });
  });
});

describe("apiKeyService.setUserKey", () => {
  it("encrypts the key and stores ciphertext + last-four metadata", async () => {
    const update = vi.fn().mockResolvedValue({});
    installDb({ user: { update } });

    await apiKeyService.setUserKey(USER_ID, PLAINTEXT_KEY);

    expect(update).toHaveBeenCalledTimes(1);
    const call = update.mock.calls[0][0];
    expect(call.where).toEqual({ id: USER_ID });
    expect(call.data.claudeApiKeyEncrypted).toBe(ENCRYPTED_BASE64);
    expect(call.data.claudeApiKeyLastFour).toBe(PLAINTEXT_KEY_LAST_FOUR);
    expect(call.data.claudeApiKeySetAt).toBeInstanceOf(Date);
    expect(call.data).not.toHaveProperty("anthropicApiKey");
  });
});

describe("apiKeyService.removeUserKey", () => {
  it("clears all encrypted-key fields without referencing anthropicApiKey", async () => {
    const update = vi.fn().mockResolvedValue({});
    installDb({ user: { update } });

    await apiKeyService.removeUserKey(USER_ID);

    expect(update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: {
        claudeApiKeyEncrypted: null,
        claudeApiKeyLastFour: null,
        claudeApiKeySetAt: null,
      },
    });
  });
});

describe("apiKeyService.getUserKeyInfo", () => {
  it("returns isSet=true with metadata when an encrypted key exists", async () => {
    const setAt = new Date("2026-04-30T00:00:00.000Z");
    const findUnique = vi.fn().mockResolvedValue({
      claudeApiKeyEncrypted: ENCRYPTED_BASE64,
      claudeApiKeyLastFour: PLAINTEXT_KEY_LAST_FOUR,
      claudeApiKeySetAt: setAt,
    });
    installDb({ user: { findUnique } });

    const info = await apiKeyService.getUserKeyInfo(USER_ID);

    expect(info).toEqual({
      isSet: true,
      lastFour: PLAINTEXT_KEY_LAST_FOUR,
      setAt,
    });
  });

  it("returns isSet=false when no encrypted key is stored", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      claudeApiKeyEncrypted: null,
      claudeApiKeyLastFour: null,
      claudeApiKeySetAt: null,
    });
    installDb({ user: { findUnique } });

    const info = await apiKeyService.getUserKeyInfo(USER_ID);

    expect(info).toEqual({ isSet: false, lastFour: null, setAt: null });
  });
});

describe("apiKeyService.resolveApiKey", () => {
  it("returns the user key (decrypted) when a user key exists", async () => {
    const userFindUnique = vi.fn().mockResolvedValue({
      claudeApiKeyEncrypted: ENCRYPTED_BASE64,
    });
    const orgFindUnique = vi.fn();
    installDb({
      user: { findUnique: userFindUnique },
      organization: { findUnique: orgFindUnique },
    });

    const resolved = await apiKeyService.resolveApiKey(USER_ID, ORG_ID);

    expect(resolved).toBe(PLAINTEXT_KEY);
    expect(userFindUnique).toHaveBeenCalledWith({
      where: { id: USER_ID },
      select: { claudeApiKeyEncrypted: true },
    });
    expect(orgFindUnique).not.toHaveBeenCalled();
  });

  it("falls back to the org key when no user key is set", async () => {
    const userFindUnique = vi
      .fn()
      .mockResolvedValue({ claudeApiKeyEncrypted: null });
    const orgFindUnique = vi
      .fn()
      .mockResolvedValue({ claudeApiKeyEncrypted: ENCRYPTED_BASE64 });
    installDb({
      user: { findUnique: userFindUnique },
      organization: { findUnique: orgFindUnique },
    });

    const resolved = await apiKeyService.resolveApiKey(USER_ID, ORG_ID);

    expect(resolved).toBe(PLAINTEXT_KEY);
    expect(orgFindUnique).toHaveBeenCalledWith({
      where: { id: ORG_ID },
      select: { claudeApiKeyEncrypted: true },
    });
  });

  it("returns null when neither user nor org has an encrypted key", async () => {
    installDb({
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      organization: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    const resolved = await apiKeyService.resolveApiKey(USER_ID, ORG_ID);

    expect(resolved).toBeNull();
  });
});
