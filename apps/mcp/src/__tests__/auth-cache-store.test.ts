import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthKeyCipher, SerializedMcpAuth } from "../auth-cache-store.js";

// Real AES-256-GCM cipher mirroring the production OAuth key cipher, so the
// regression assertions exercise genuine encryption rather than a passthrough.
const TEST_ENCRYPTION_KEY = randomBytes(32);
const TEST_KID = "test-kid";

const testCipher: AuthKeyCipher = {
  encrypt(plaintext: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", TEST_ENCRYPTION_KEY, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return {
      ciphertext: `${iv.toString("base64url")}.${authTag.toString("base64url")}.${ciphertext.toString("base64url")}`,
      kid: TEST_KID,
    };
  },
  decrypt(ciphertext: string, kid: string) {
    if (kid !== TEST_KID) {
      return null;
    }
    const parts = ciphertext.split(".");
    if (parts.length !== 3) {
      return null;
    }
    try {
      const [ivPart, tagPart, ctPart] = parts;
      const decipher = createDecipheriv(
        "aes-256-gcm",
        TEST_ENCRYPTION_KEY,
        Buffer.from(ivPart, "base64url")
      );
      decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ctPart, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      return null;
    }
  },
};

function encodeStored(auth: SerializedMcpAuth): string {
  const { ciphertext, kid } = testCipher.encrypt(auth.plaintextKey);
  return JSON.stringify({
    apiKeyCiphertext: ciphertext,
    kid,
    context: auth.context,
    grantedScopes: auth.grantedScopes,
    createdAt: auth.createdAt,
  });
}

const mockRedisClient = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  pexpire: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
};

vi.mock("@repo/redis", () => ({
  createRedisClient: vi.fn(() => mockRedisClient),
}));

vi.mock("../api-client.js", () => ({
  verifyApiKey: vi.fn(),
  checkApiReachable: vi.fn(),
  createApiClient: vi.fn(() => ({})),
}));

vi.mock("@repo/database", () => {
  const withDb = Object.assign(
    async <T>(fn: (db: Record<string, never>) => Promise<T> | T): Promise<T> =>
      fn({}),
    {
      tx: async <T>(
        fn: (db: Record<string, never>) => Promise<T>
      ): Promise<T> => fn({}),
    }
  );
  return { withDb };
});

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

const sampleAuth: SerializedMcpAuth = {
  plaintextKey: "sk_test_abc123",
  context: {
    userId: "user_1",
    organizationId: "org_1",
    scopes: ["read", "write"],
  },
  grantedScopes: ["read", "write"],
  createdAt: Date.now(),
};

describe("RedisAuthCacheStore", () => {
  let store: InstanceType<
    typeof import("../auth-cache-store.js").RedisAuthCacheStore
  >;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { RedisAuthCacheStore } = await import("../auth-cache-store.js");
    store = new RedisAuthCacheStore(mockRedisClient as any, testCipher);
  });

  describe("set", () => {
    it("encrypts the API key and calls Redis SET with PX ttl", async () => {
      mockRedisClient.set.mockResolvedValueOnce("OK");

      await store.set("session-1", sampleAuth, 300_000);

      expect(mockRedisClient.set).toHaveBeenCalledTimes(1);
      const [key, value, mode, ttl] = mockRedisClient.set.mock.calls[0];
      expect(key).toBe("auth:session-1");
      expect(mode).toBe("PX");
      expect(ttl).toBe(300_000);

      const stored = JSON.parse(value as string);
      expect(stored).toMatchObject({
        kid: TEST_KID,
        context: sampleAuth.context,
        grantedScopes: sampleAuth.grantedScopes,
        createdAt: sampleAuth.createdAt,
      });
      expect(typeof stored.apiKeyCiphertext).toBe("string");
      expect(stored).not.toHaveProperty("plaintextKey");
    });

    // Regression for the review finding: the bearer API key must never be
    // persisted to Redis in a form that exposes a reusable credential.
    it("never writes the plaintext API key or sk_ material to Redis", async () => {
      mockRedisClient.set.mockResolvedValueOnce("OK");

      await store.set("session-1", sampleAuth, 300_000);

      const value = mockRedisClient.set.mock.calls[0][1] as string;
      expect(value).not.toContain(sampleAuth.plaintextKey);
      expect(value).not.toContain("sk_");
      expect(value).not.toContain("plaintextKey");
    });

    it("does not throw when Redis SET fails", async () => {
      mockRedisClient.set.mockRejectedValueOnce(new Error("connection lost"));

      await expect(
        store.set("session-1", sampleAuth, 300_000)
      ).resolves.toBeUndefined();
    });
  });

  describe("get", () => {
    it("decrypts stored auth back to the original shape", async () => {
      mockRedisClient.get.mockResolvedValueOnce(encodeStored(sampleAuth));

      const result = await store.get("session-1");

      expect(mockRedisClient.get).toHaveBeenCalledWith("auth:session-1");
      expect(result).toEqual(sampleAuth);
    });

    it("returns null on cache miss", async () => {
      mockRedisClient.get.mockResolvedValueOnce(null);

      const result = await store.get("session-1");

      expect(result).toBeNull();
    });

    it("returns null when the stored ciphertext cannot be decrypted", async () => {
      mockRedisClient.get.mockResolvedValueOnce(
        JSON.stringify({
          apiKeyCiphertext: "garbage.cipher.text",
          kid: "rotated-out-kid",
          context: sampleAuth.context,
          grantedScopes: sampleAuth.grantedScopes,
          createdAt: sampleAuth.createdAt,
        })
      );

      const result = await store.get("session-1");

      expect(result).toBeNull();
    });

    it("returns null when Redis GET throws", async () => {
      mockRedisClient.get.mockRejectedValueOnce(new Error("timeout"));

      const result = await store.get("session-1");

      expect(result).toBeNull();
    });
  });

  describe("delete", () => {
    it("calls Redis DEL with the correct key", async () => {
      mockRedisClient.del.mockResolvedValueOnce(1);

      await store.delete("session-1");

      expect(mockRedisClient.del).toHaveBeenCalledWith("auth:session-1");
    });

    it("does not throw when Redis DEL fails", async () => {
      mockRedisClient.del.mockRejectedValueOnce(new Error("connection reset"));

      await expect(store.delete("session-1")).resolves.toBeUndefined();
    });
  });

  describe("touch", () => {
    it("calls Redis PEXPIRE with the correct key and ttl", async () => {
      mockRedisClient.pexpire.mockResolvedValueOnce(1);

      await store.touch("session-1", 600_000);

      expect(mockRedisClient.pexpire).toHaveBeenCalledWith(
        "auth:session-1",
        600_000
      );
    });

    it("does not throw when Redis PEXPIRE fails", async () => {
      mockRedisClient.pexpire.mockRejectedValueOnce(new Error("not connected"));

      await expect(store.touch("session-1", 600_000)).resolves.toBeUndefined();
    });
  });
});

describe.sequential("MCP_SESSION_STORE env var", () => {
  it("leaves authCacheStore null when MCP_SESSION_STORE is unset (memory mode)", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    delete process.env.MCP_SESSION_STORE;

    const mod = await import("../index.js");

    expect(mod.__testables.authCacheStore).toBeNull();
  });

  it("leaves authCacheStore null when MCP_SESSION_STORE is 'memory'", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    process.env.MCP_SESSION_STORE = "memory";

    const mod = await import("../index.js");

    expect(mod.__testables.authCacheStore).toBeNull();
  });

  it("creates authCacheStore when MCP_SESSION_STORE is 'redis' and REDIS_URL is set", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    process.env.MCP_SESSION_STORE = "redis";
    process.env.REDIS_URL = "redis://localhost:6379";

    const mod = await import("../index.js");

    expect(mod.__testables.authCacheStore).not.toBeNull();
  });

  it("leaves authCacheStore null when MCP_SESSION_STORE is 'redis' but REDIS_URL is missing", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    process.env.MCP_SESSION_STORE = "redis";
    delete process.env.REDIS_URL;

    const mod = await import("../index.js");

    expect(mod.__testables.authCacheStore).toBeNull();
  });

  it("degrades to memory-only when the redis connection fails", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    process.env.MCP_SESSION_STORE = "redis";
    process.env.REDIS_URL = "redis://localhost:6379";
    mockRedisClient.connect.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const mod = await import("../index.js");
    // connect() rejection is handled on a later microtask; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mod.__testables.authCacheStore).toBeNull();
  });
});

describe.sequential("handleCachedAuthRequest", () => {
  const stubReq = {} as import("node:http").IncomingMessage;
  const stubRes = {} as import("node:http").ServerResponse;

  it("returns false when no auth cache store is configured", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    delete process.env.MCP_SESSION_STORE;

    const mod = await import("../index.js");
    expect(mod.__testables.authCacheStore).toBeNull();

    const handled = await mod.__testables.handleCachedAuthRequest(
      stubReq,
      stubRes,
      "session-x"
    );

    expect(handled).toBe(false);
  });

  it("returns false on a cache miss", async () => {
    process.env.INTERNAL_API_SECRET = "test-internal-secret";
    process.env.MCP_SESSION_STORE = "redis";
    process.env.REDIS_URL = "redis://localhost:6379";
    mockRedisClient.get.mockResolvedValue(null);

    const mod = await import("../index.js");
    expect(mod.__testables.authCacheStore).not.toBeNull();

    const handled = await mod.__testables.handleCachedAuthRequest(
      stubReq,
      stubRes,
      "missing-session"
    );

    expect(handled).toBe(false);
    expect(mockRedisClient.get).toHaveBeenCalledWith("auth:missing-session");
  });
});
