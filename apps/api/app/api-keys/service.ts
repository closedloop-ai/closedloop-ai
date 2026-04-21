import { createHash, randomBytes } from "node:crypto";
import type {
  ApiKey,
  ApiKeyScope,
  CreateApiKeyInput,
  CreateApiKeyResponse,
  VerifiedApiKeyContext,
} from "@repo/api/src/types/api-key";
import { API_KEY_SCOPES } from "@repo/api/src/types/api-key";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";

/**
 * Map a Prisma ApiKey record to the ApiKey API type (excludes keyHash).
 */
function toApiKey(record: {
  id: string;
  organizationId: string;
  userId: string;
  name: string;
  keyPrefix: string;
  expiresAt: Date | null;
  scopes: string[];
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}): ApiKey {
  const scopes = normalizeStoredScopes(
    sanitizeScopes(record.scopes),
    record.scopes.length
  );
  return {
    id: record.id,
    organizationId: record.organizationId,
    userId: record.userId,
    name: record.name,
    keyPrefix: record.keyPrefix,
    expiresAt: record.expiresAt,
    scopes,
    lastUsedAt: record.lastUsedAt,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
  };
}

export const apiKeysService = {
  /**
   * Generate a new API key for a user in an organization.
   * Returns the ApiKey record plus the plaintext key (shown once only).
   */
  async generate(
    organizationId: string,
    userId: string,
    input: CreateApiKeyInput
  ): Promise<CreateApiKeyResponse> {
    const plaintextKey = `sk_live_${randomBytes(32).toString("hex")}`;
    const hash = createHash("sha256").update(plaintextKey).digest("hex");

    const record = await withDb((db) =>
      db.apiKey.create({
        data: {
          organizationId,
          userId,
          name: input.name,
          scopes: ["read", "write", "delete"],
          keyHash: hash,
          keyPrefix: "sk_live_",
          expiresAt: input.expiresAt ?? null,
        },
      })
    );

    return {
      ...toApiKey(record),
      plaintext: plaintextKey,
    };
  },

  /**
   * List API keys for an organization.
   * Admins (org:admin) see all keys in the org; regular users see only their own.
   */
  list(
    organizationId: string,
    userId: string,
    orgRole?: string
  ): Promise<ApiKey[]> {
    return withDb(async (db) => {
      const records = await db.apiKey.findMany({
        where:
          orgRole === "org:admin"
            ? { organizationId }
            : { organizationId, userId },
        orderBy: { createdAt: "desc" },
      });
      return records.map(toApiKey);
    });
  },

  /**
   * Revoke an API key by setting revokedAt to the current time.
   * Admins can revoke any key in the org; regular users can only revoke their own.
   * Returns false if the key was not found or already revoked.
   */
  revoke(
    id: string,
    organizationId: string,
    userId: string,
    orgRole?: string
  ): Promise<boolean> {
    return withDb(async (db) => {
      const where =
        orgRole === "org:admin"
          ? { id, organizationId, revokedAt: null }
          : { id, organizationId, userId, revokedAt: null };

      const result = await db.apiKey.updateMany({
        where,
        data: {
          revokedAt: new Date(),
        },
      });
      return result.count > 0;
    });
  },

  /**
   * Verify a plaintext API key.
   * Returns the userId and organizationId if valid, null otherwise.
   * Updates lastUsedAt on successful verification.
   */
  async verifyKey(plaintextKey: string): Promise<VerifiedApiKeyContext | null> {
    const hash = createHash("sha256").update(plaintextKey).digest("hex");
    const now = new Date();

    const record = await withDb((db) =>
      db.apiKey.findFirst({
        where: {
          keyHash: hash,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
      })
    );

    if (!record) {
      return null;
    }

    // Update lastUsedAt asynchronously (best-effort, non-blocking)
    withDb((db) =>
      db.apiKey.update({
        where: { id: record.id },
        data: { lastUsedAt: now },
      })
    ).catch((error: unknown) => {
      log.error("Failed to update API key lastUsedAt", {
        apiKeyId: record.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    const scopes = normalizeStoredScopes(
      sanitizeScopes(record.scopes),
      record.scopes.length
    );
    if (scopes.length === 1 && scopes[0] === "read") {
      log.warn("legacy_read_only_api_key_used", {
        apiKeyId: record.id,
        userId: record.userId,
        organizationId: record.organizationId,
      });
    }
    return {
      userId: record.userId,
      organizationId: record.organizationId,
      scopes,
    };
  },
};

const API_KEY_SCOPE_SET = new Set<ApiKeyScope>(API_KEY_SCOPES);

function sanitizeScopes(scopes: string[] | undefined): ApiKeyScope[] {
  if (!Array.isArray(scopes)) {
    return [];
  }
  return scopes.filter((scope): scope is ApiKeyScope =>
    API_KEY_SCOPE_SET.has(scope as ApiKeyScope)
  );
}

function normalizeStoredScopes(
  scopes: ApiKeyScope[] | undefined,
  _sourceLength?: number
): ApiKeyScope[] {
  if (!(scopes && scopes.length > 0)) {
    return [];
  }
  return [...new Set(scopes)];
}
