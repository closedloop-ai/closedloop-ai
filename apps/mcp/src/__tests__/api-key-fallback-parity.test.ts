import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifiedApiKeyContext } from "../api-key-contract.js";

type ApiKeyRecord = {
  id: string;
  userId: string;
  organizationId: string;
  scopes: string[];
  keyHash: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
};

type ApiKeyFindFirstArgs = {
  where: {
    keyHash: string;
    revokedAt: null;
    OR: [{ expiresAt: null }, { expiresAt: { gt: Date } }];
  };
  select?: Record<string, true>;
};

type ApiKeyUpdateArgs = {
  where: { id: string };
  data: { lastUsedAt: Date };
};

const apiKeyRecords: ApiKeyRecord[] = [];
const findFirstCalls: ApiKeyFindFirstArgs[] = [];
const updateCalls: ApiKeyUpdateArgs[] = [];

const logErrorMock = vi.fn();

vi.mock("@repo/observability/log", () => ({
  log: {
    error: logErrorMock,
  },
}));

vi.mock("@repo/database", () => {
  const withDb = Object.assign(
    async <T>(
      fn: (db: { apiKey: Record<string, unknown> }) => Promise<T> | T
    ) =>
      fn({
        apiKey: {
          findFirst: ({
            where,
            select,
          }: ApiKeyFindFirstArgs): Promise<Record<string, unknown> | null> => {
            findFirstCalls.push({ where, select });
            const gtDate = where.OR[1].expiresAt.gt;
            const record =
              apiKeyRecords.find(
                (candidate) =>
                  candidate.keyHash === where.keyHash &&
                  candidate.revokedAt === where.revokedAt &&
                  (candidate.expiresAt === null || candidate.expiresAt > gtDate)
              ) ?? null;
            if (!record) {
              return Promise.resolve(null);
            }
            if (!select) {
              return Promise.resolve(record);
            }
            const projected = Object.fromEntries(
              Object.entries(select).map(([key]) => [
                key,
                record[key as keyof ApiKeyRecord],
              ])
            );
            return Promise.resolve(projected);
          },
          update: ({
            where,
            data,
          }: ApiKeyUpdateArgs): Promise<ApiKeyRecord> => {
            updateCalls.push({ where, data });
            const record = apiKeyRecords.find(
              (candidate) => candidate.id === where.id
            );
            if (!record) {
              throw new Error(`ApiKey ${where.id} not found`);
            }
            record.lastUsedAt = data.lastUsedAt;
            return Promise.resolve(record);
          },
        },
      }),
    {
      tx: async <T>(
        fn: (db: { apiKey: Record<string, unknown> }) => Promise<T>
      ): Promise<T> =>
        fn({
          apiKey: {
            findFirst: () => Promise.resolve(null),
            update: () => Promise.resolve(null),
          },
        }),
    }
  );

  return { withDb };
});

function makeApiKeyRecord(
  plaintextKey: string,
  overrides: Partial<ApiKeyRecord> = {}
): ApiKeyRecord {
  return {
    id: overrides.id ?? "key_1",
    userId: overrides.userId ?? "user_1",
    organizationId: overrides.organizationId ?? "org_1",
    scopes: overrides.scopes ?? ["read", "write"],
    keyHash:
      overrides.keyHash ??
      createHash("sha256").update(plaintextKey, "utf8").digest("hex"),
    revokedAt: overrides.revokedAt ?? null,
    expiresAt: overrides.expiresAt ?? null,
    lastUsedAt: overrides.lastUsedAt ?? null,
  };
}

function resetMockState(): void {
  apiKeyRecords.length = 0;
  findFirstCalls.length = 0;
  updateCalls.length = 0;
  logErrorMock.mockReset();
}

async function loadVerifiers(): Promise<{
  verifyFallbackLocally: (
    plaintextKey: string
  ) => Promise<VerifiedApiKeyContext | null>;
  verifyViaApiService: (
    plaintextKey: string
  ) => Promise<VerifiedApiKeyContext | null>;
}> {
  process.env.INTERNAL_API_SECRET = "test-internal-secret";
  vi.resetModules();

  const [mcpModule, apiModule] = await Promise.all([
    import("../index.js"),
    import("../../../api/app/api-keys/service"),
  ]);

  return {
    verifyFallbackLocally: mcpModule.__testables.verifyApiKeyLocally as (
      plaintextKey: string
    ) => Promise<VerifiedApiKeyContext | null>,
    verifyViaApiService: apiModule.apiKeysService.verifyKey,
  };
}

describe.sequential("API key fallback parity", () => {
  beforeEach(() => {
    resetMockState();
  });

  it("returns the same verified context for a valid key", async () => {
    const plaintextKey = "sk_live_valid";
    apiKeyRecords.push(
      makeApiKeyRecord(plaintextKey, {
        userId: "user_verified",
        organizationId: "org_verified",
        scopes: ["read", "write", "unknown", "read"],
      })
    );

    const { verifyFallbackLocally, verifyViaApiService } =
      await loadVerifiers();

    await expect(verifyViaApiService(plaintextKey)).resolves.toEqual({
      userId: "user_verified",
      organizationId: "org_verified",
      scopes: ["read", "write"],
    });
    await expect(verifyFallbackLocally(plaintextKey)).resolves.toEqual({
      userId: "user_verified",
      organizationId: "org_verified",
      scopes: ["read", "write"],
    });
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0]?.where.id).toBe(apiKeyRecords[0]?.id);
    expect(updateCalls[1]?.where.id).toBe(apiKeyRecords[0]?.id);
  });

  it("returns null for revoked, expired, or unknown keys in both paths", async () => {
    const plaintextKey = "sk_live_revoked";
    apiKeyRecords.push(
      makeApiKeyRecord(plaintextKey, {
        revokedAt: new Date(),
      }),
      makeApiKeyRecord("sk_live_expired", {
        id: "key_2",
        expiresAt: new Date(Date.now() - 60_000),
      })
    );

    const { verifyFallbackLocally, verifyViaApiService } =
      await loadVerifiers();

    await expect(verifyViaApiService(plaintextKey)).resolves.toBeNull();
    await expect(verifyFallbackLocally(plaintextKey)).resolves.toBeNull();
    await expect(verifyViaApiService("sk_live_expired")).resolves.toBeNull();
    await expect(verifyFallbackLocally("sk_live_expired")).resolves.toBeNull();
    await expect(verifyViaApiService("sk_live_unknown")).resolves.toBeNull();
    await expect(verifyFallbackLocally("sk_live_unknown")).resolves.toBeNull();
    expect(updateCalls).toHaveLength(0);
  });

  it("queries with the same key validity guards in both paths", async () => {
    const plaintextKey = "sk_live_guarded";
    apiKeyRecords.push(makeApiKeyRecord(plaintextKey));

    const { verifyFallbackLocally, verifyViaApiService } =
      await loadVerifiers();

    await verifyViaApiService(plaintextKey);
    await verifyFallbackLocally(plaintextKey);

    expect(findFirstCalls).toHaveLength(2);
    for (const call of findFirstCalls) {
      expect(call.where.keyHash).toBe(
        createHash("sha256").update(plaintextKey, "utf8").digest("hex")
      );
      expect(call.where.revokedAt).toBeNull();
      expect(call.where.OR).toHaveLength(2);
      expect(call.where.OR[0]).toEqual({ expiresAt: null });
      expect(call.where.OR[1]?.expiresAt.gt).toBeInstanceOf(Date);
    }
  });
});
