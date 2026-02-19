/**
 * Unit tests for apiKeysService.
 *
 * All database calls are mocked via vi.mock("@repo/database").
 * Tests verify:
 *   - generate() key format, hash storage, and plaintext return
 *   - list() admin vs regular-user scoping
 *   - revoke() org-scoped update and boolean return value
 *   - verifyKey() null for missing/expired/revoked, context for valid keys
 */
import { createHash } from "node:crypto";
import { type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

import { withDb } from "@repo/database";
import { apiKeysService } from "../service";

const mockWithDb = withDb as unknown as Mock;

const SK_LIVE_REGEX = /^sk_live_[0-9a-f]{64}$/;
const SK_LIVE_PREFIX_REGEX = /^sk_live_/;

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "org-abc";
const USER_ID = "user-xyz";

function makeApiKeyRecord(
  overrides: Partial<{
    id: string;
    organizationId: string;
    userId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    createdAt: Date;
    revokedAt: Date | null;
  }> = {}
) {
  return {
    id: "key-1",
    organizationId: ORG_ID,
    userId: USER_ID,
    name: "My Key",
    keyPrefix: "sk_live_xxxx",
    keyHash: "abc123",
    expiresAt: null,
    lastUsedAt: null,
    createdAt: new Date("2024-01-01"),
    revokedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// generate()
// ---------------------------------------------------------------------------

describe("apiKeysService.generate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a plaintext key with sk_live_ prefix", async () => {
    let capturedData: Record<string, unknown> | undefined;

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        apiKey: {
          create: vi.fn((args: { data: Record<string, unknown> }) => {
            capturedData = args.data;
            return Promise.resolve(
              makeApiKeyRecord({
                keyPrefix: String(args.data.keyPrefix),
                keyHash: String(args.data.keyHash),
                name: String(args.data.name),
              })
            );
          }),
        },
      };
      return callback(mockDb);
    });

    const result = await apiKeysService.generate(ORG_ID, USER_ID, {
      name: "My Key",
    });

    expect(result.plaintext).toMatch(SK_LIVE_REGEX);
    expect(capturedData).toBeDefined();
  });

  it("stores the SHA-256 hash of the plaintext key, not the plaintext itself", async () => {
    let storedHash: string | undefined;

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        apiKey: {
          create: vi.fn((args: { data: Record<string, unknown> }) => {
            storedHash = String(args.data.keyHash);
            return Promise.resolve(makeApiKeyRecord({ keyHash: storedHash }));
          }),
        },
      };
      return callback(mockDb);
    });

    const result = await apiKeysService.generate(ORG_ID, USER_ID, {
      name: "Test",
    });
    const returnedPlaintext = result.plaintext;

    // The hash stored must equal sha256(plaintext)
    const expectedHash = createHash("sha256")
      .update(returnedPlaintext)
      .digest("hex");
    expect(storedHash).toBe(expectedHash);

    // The plaintext itself must not be stored as the keyHash
    expect(storedHash).not.toBe(returnedPlaintext);
  });

  it("stores keyPrefix as the first 12 characters of the plaintext key", async () => {
    let storedPrefix: string | undefined;

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        apiKey: {
          create: vi.fn((args: { data: Record<string, unknown> }) => {
            storedPrefix = String(args.data.keyPrefix);
            return Promise.resolve(
              makeApiKeyRecord({ keyPrefix: storedPrefix })
            );
          }),
        },
      };
      return callback(mockDb);
    });

    const result = await apiKeysService.generate(ORG_ID, USER_ID, {
      name: "Prefix Test",
    });
    const returnedPlaintext = result.plaintext;

    expect(storedPrefix).toBe(returnedPlaintext.slice(0, 12));
    // sk_live_ is 8 chars, so prefix always starts with "sk_live_"
    expect(storedPrefix).toMatch(SK_LIVE_PREFIX_REGEX);
  });

  it("stores the provided expiresAt when supplied", async () => {
    const expiresAt = new Date("2099-12-31");
    let storedExpiresAt: Date | null | undefined;

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        apiKey: {
          create: vi.fn((args: { data: Record<string, unknown> }) => {
            storedExpiresAt = args.data.expiresAt as Date | null;
            return Promise.resolve(makeApiKeyRecord({ expiresAt }));
          }),
        },
      };
      return callback(mockDb);
    });

    await apiKeysService.generate(ORG_ID, USER_ID, {
      name: "Expiring Key",
      expiresAt,
    });

    expect(storedExpiresAt).toEqual(expiresAt);
  });

  it("stores null expiresAt when not supplied", async () => {
    let storedExpiresAt: Date | null | undefined;

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        apiKey: {
          create: vi.fn((args: { data: Record<string, unknown> }) => {
            storedExpiresAt = args.data.expiresAt as Date | null;
            return Promise.resolve(makeApiKeyRecord({ expiresAt: null }));
          }),
        },
      };
      return callback(mockDb);
    });

    await apiKeysService.generate(ORG_ID, USER_ID, { name: "No Expiry" });

    expect(storedExpiresAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe("apiKeysService.list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters by organizationId only when caller is org:admin", async () => {
    let capturedWhere: Record<string, unknown> | undefined;

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        apiKey: {
          findMany: vi.fn((args: { where: Record<string, unknown> }) => {
            capturedWhere = args.where;
            return Promise.resolve([makeApiKeyRecord()]);
          }),
        },
      };
      return callback(mockDb);
    });

    await apiKeysService.list(ORG_ID, USER_ID, "org:admin");

    expect(capturedWhere).toEqual({ organizationId: ORG_ID });
    // userId must NOT be present so admins see all keys in the org
    expect(capturedWhere).not.toHaveProperty("userId");
  });

  it("filters by both organizationId and userId for non-admin users", async () => {
    let capturedWhere: Record<string, unknown> | undefined;

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        apiKey: {
          findMany: vi.fn((args: { where: Record<string, unknown> }) => {
            capturedWhere = args.where;
            return Promise.resolve([makeApiKeyRecord()]);
          }),
        },
      };
      return callback(mockDb);
    });

    await apiKeysService.list(ORG_ID, USER_ID, "org:member");

    expect(capturedWhere).toEqual({ organizationId: ORG_ID, userId: USER_ID });
  });

  it("filters by both organizationId and userId when orgRole is undefined", async () => {
    let capturedWhere: Record<string, unknown> | undefined;

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        apiKey: {
          findMany: vi.fn((args: { where: Record<string, unknown> }) => {
            capturedWhere = args.where;
            return Promise.resolve([]);
          }),
        },
      };
      return callback(mockDb);
    });

    await apiKeysService.list(ORG_ID, USER_ID);

    expect(capturedWhere).toEqual({ organizationId: ORG_ID, userId: USER_ID });
  });

  it("returns mapped ApiKey objects without keyHash field", async () => {
    const record = makeApiKeyRecord({ keyHash: "should-not-appear" });

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        apiKey: {
          findMany: vi.fn().mockResolvedValue([record]),
        },
      };
      return callback(mockDb);
    });

    const results = await apiKeysService.list(ORG_ID, USER_ID, "org:admin");

    expect(results).toHaveLength(1);
    expect(results[0]).not.toHaveProperty("keyHash");
    expect(results[0].id).toBe(record.id);
    expect(results[0].organizationId).toBe(record.organizationId);
  });
});

// ---------------------------------------------------------------------------
// revoke()
// ---------------------------------------------------------------------------

describe("apiKeysService.revoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls updateMany with id, organizationId, and revokedAt: null guard", async () => {
    let capturedArgs: Record<string, unknown> | undefined;

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        apiKey: {
          updateMany: vi.fn(
            (args: {
              where: Record<string, unknown>;
              data: Record<string, unknown>;
            }) => {
              capturedArgs = args;
              return Promise.resolve({ count: 1 });
            }
          ),
        },
      };
      return callback(mockDb);
    });

    await apiKeysService.revoke("key-1", ORG_ID, USER_ID);

    expect(capturedArgs?.where).toEqual({
      id: "key-1",
      organizationId: ORG_ID,
      userId: USER_ID,
      revokedAt: null,
    });
  });

  it("returns true when a key was updated (count > 0)", async () => {
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        apiKey: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      return callback(mockDb);
    });

    const result = await apiKeysService.revoke("key-1", ORG_ID, USER_ID);

    expect(result).toBe(true);
  });

  it("returns false when no key was found or already revoked (count === 0)", async () => {
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        apiKey: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      };
      return callback(mockDb);
    });

    const result = await apiKeysService.revoke(
      "nonexistent-key",
      ORG_ID,
      USER_ID
    );

    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyKey()
// ---------------------------------------------------------------------------

describe("apiKeysService.verifyKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no record matches the hash (revoked, expired, or unknown key)", async () => {
    // Two withDb calls: findFirst returns null, update is never called
    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) => {
      const mockDb = {
        apiKey: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      return callback(mockDb);
    });

    const result = await apiKeysService.verifyKey("sk_live_invalid");

    expect(result).toBeNull();
  });

  it("looks up the key by its SHA-256 hash, not the plaintext", async () => {
    const plaintext = "sk_live_testkey1234";
    const expectedHash = createHash("sha256").update(plaintext).digest("hex");
    let capturedWhere: Record<string, unknown> | undefined;

    mockWithDb
      .mockImplementationOnce((callback: (db: unknown) => unknown) => {
        const mockDb = {
          apiKey: {
            findFirst: vi.fn((args: { where: Record<string, unknown> }) => {
              capturedWhere = args.where;
              return Promise.resolve(
                makeApiKeyRecord({ keyHash: expectedHash })
              );
            }),
          },
        };
        return callback(mockDb);
      })
      .mockImplementationOnce((callback: (db: unknown) => unknown) => {
        const mockDb = {
          apiKey: { update: vi.fn().mockResolvedValue({}) },
        };
        return callback(mockDb);
      });

    await apiKeysService.verifyKey(plaintext);

    expect(capturedWhere).toEqual(
      expect.objectContaining({ keyHash: expectedHash })
    );
  });

  it("returns userId and organizationId for a valid key", async () => {
    const plaintext = "sk_live_validkey9999";
    const record = makeApiKeyRecord({
      userId: "user-verified",
      organizationId: "org-verified",
    });

    mockWithDb
      .mockImplementationOnce((callback: (db: unknown) => unknown) => {
        const mockDb = {
          apiKey: { findFirst: vi.fn().mockResolvedValue(record) },
        };
        return callback(mockDb);
      })
      .mockImplementationOnce((callback: (db: unknown) => unknown) => {
        const mockDb = {
          apiKey: { update: vi.fn().mockResolvedValue({}) },
        };
        return callback(mockDb);
      });

    const result = await apiKeysService.verifyKey(plaintext);

    expect(result).toEqual({
      userId: "user-verified",
      organizationId: "org-verified",
    });
  });

  it("updates lastUsedAt after successful verification", async () => {
    const plaintext = "sk_live_keywithlastused";
    const record = makeApiKeyRecord();
    let updateArgs: Record<string, unknown> | undefined;

    mockWithDb
      .mockImplementationOnce((callback: (db: unknown) => unknown) => {
        const mockDb = {
          apiKey: { findFirst: vi.fn().mockResolvedValue(record) },
        };
        return callback(mockDb);
      })
      .mockImplementationOnce((callback: (db: unknown) => unknown) => {
        const mockDb = {
          apiKey: {
            update: vi.fn(
              (args: {
                where: Record<string, unknown>;
                data: Record<string, unknown>;
              }) => {
                updateArgs = args;
                return Promise.resolve({});
              }
            ),
          },
        };
        return callback(mockDb);
      });

    await apiKeysService.verifyKey(plaintext);

    expect(updateArgs?.where).toEqual({ id: record.id });
    expect(updateArgs?.data).toHaveProperty("lastUsedAt");
    expect(
      (updateArgs?.data as Record<string, unknown>).lastUsedAt
    ).toBeInstanceOf(Date);
  });

  it("queries with revokedAt: null and expiresAt null-or-future guard", async () => {
    const plaintext = "sk_live_expirycheckkey";
    let capturedWhere: Record<string, unknown> | undefined;

    mockWithDb.mockImplementationOnce((callback: (db: unknown) => unknown) => {
      const mockDb = {
        apiKey: {
          findFirst: vi.fn((args: { where: Record<string, unknown> }) => {
            capturedWhere = args.where;
            return Promise.resolve(null);
          }),
        },
      };
      return callback(mockDb);
    });

    await apiKeysService.verifyKey(plaintext);

    expect(capturedWhere).toMatchObject({
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
    });
  });
});
