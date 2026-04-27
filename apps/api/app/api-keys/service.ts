import { createHash, randomBytes } from "node:crypto";
import type {
  ApiKey,
  ApiKeyScope,
  CreateApiKeyInput,
  CreateApiKeyResponse,
  VerifiedApiKeyContext,
  VerifiedApiKeyContextWithMetadata,
} from "@repo/api/src/types/api-key";
import { API_KEY_SCOPES } from "@repo/api/src/types/api-key";
import { ApiKeySource, withDb } from "@repo/database";
import { log } from "@repo/observability/log";

const FULL_ACCESS_SCOPES = [
  "read",
  "write",
  "delete",
] as const satisfies readonly ApiKeyScope[];

export class DesktopManagedKeyRotationConflictError extends Error {
  constructor() {
    super("Concurrent desktop-managed key rotation conflict");
    this.name = "DesktopManagedKeyRotationConflictError";
  }
}

type StoredApiKeyRecord = {
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
};

/**
 * Inputs for rotating the single active desktop-managed key bound to a gateway.
 */
type RotateDesktopManagedKeyInput = {
  organizationId: string;
  userId: string;
  gatewayId: string;
  /** PEM-encoded Ed25519 SPKI public key bound to the managed desktop key. */
  boundPublicKey?: string | null;
  name?: string;
};

type VerifyApiKeyOptions = {
  /**
   * Controls when callers apply the last-used side effect. PoP-enabled routes
   * defer this until after enforcement accepts the request.
   */
  updateLastUsedAt?: boolean;
};

function createPlaintextKey(): string {
  return `sk_live_${randomBytes(32).toString("hex")}`;
}

function hashApiKey(plaintextKey: string): string {
  return createHash("sha256").update(plaintextKey).digest("hex");
}

function defaultDesktopManagedKeyName(gatewayId: string): string {
  return `Desktop ${gatewayId}`;
}

function scheduleLastUsedAtUpdate(apiKeyId: string, lastUsedAt: Date): void {
  withDb((db) =>
    db.apiKey.update({
      where: { id: apiKeyId },
      data: { lastUsedAt },
    })
  ).catch((error: unknown) => {
    log.error("Failed to update API key lastUsedAt", {
      apiKeyId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * Map a Prisma ApiKey record to the ApiKey API type (excludes keyHash).
 */
function toApiKey(record: StoredApiKeyRecord): ApiKey {
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
    const plaintextKey = createPlaintextKey();
    const hash = hashApiKey(plaintextKey);

    const record = await withDb((db) =>
      db.apiKey.create({
        data: {
          organizationId,
          userId,
          name: input.name,
          scopes: [...FULL_ACCESS_SCOPES],
          keyHash: hash,
          keyPrefix: "sk_live_",
          expiresAt: input.expiresAt ?? null,
          source: ApiKeySource.USER_CREATED,
          gatewayId: null,
          boundPublicKey: null,
        },
      })
    );

    return {
      ...toApiKey(record),
      plaintext: plaintextKey,
    };
  },

  /**
   * Ensures a gateway has exactly one active desktop-managed key per user by
   * revoking any existing key for the same org/user/gateway before minting the replacement.
   *
   * Concurrent claims rely on the partial unique index added in the matching
   * migration to reject duplicate active rows with Prisma `P2002`.
   */
  async rotateDesktopManagedKey(
    input: RotateDesktopManagedKeyInput
  ): Promise<CreateApiKeyResponse> {
    const plaintextKey = createPlaintextKey();
    const hash = hashApiKey(plaintextKey);
    const now = new Date();

    try {
      const record = await withDb.tx(async (tx) => {
        await tx.apiKey.updateMany({
          where: {
            organizationId: input.organizationId,
            userId: input.userId,
            source: ApiKeySource.DESKTOP_MANAGED,
            gatewayId: input.gatewayId,
            revokedAt: null,
          },
          data: { revokedAt: now },
        });

        return tx.apiKey.create({
          data: {
            organizationId: input.organizationId,
            userId: input.userId,
            name: input.name ?? defaultDesktopManagedKeyName(input.gatewayId),
            scopes: [...FULL_ACCESS_SCOPES],
            keyHash: hash,
            keyPrefix: "sk_live_",
            expiresAt: null,
            source: ApiKeySource.DESKTOP_MANAGED,
            gatewayId: input.gatewayId,
            boundPublicKey: input.boundPublicKey ?? null,
          },
        });
      });
      return {
        ...toApiKey(record),
        plaintext: plaintextKey,
      };
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        throw new DesktopManagedKeyRotationConflictError();
      }
      throw error;
    }
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
   * Verify a plaintext API key and return internal provenance metadata used by
   * desktop-managed PoP policy. By default this updates lastUsedAt on success;
   * PoP-enabled callers can defer that side effect until after enforcement.
   */
  async verifyKeyWithMetadata(
    plaintextKey: string,
    options: VerifyApiKeyOptions = {}
  ): Promise<VerifiedApiKeyContextWithMetadata | null> {
    const hash = hashApiKey(plaintextKey);
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

    if (options.updateLastUsedAt !== false) {
      scheduleLastUsedAtUpdate(record.id, now);
    }

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
      apiKeyId: record.id,
      userId: record.userId,
      organizationId: record.organizationId,
      scopes,
      source: record.source,
      gatewayId: record.gatewayId,
      boundPublicKey: record.boundPublicKey,
    };
  },

  /**
   * Verify a plaintext API key.
   * Returns the userId and organizationId if valid, null otherwise.
   * Updates lastUsedAt on successful verification.
   */
  async verifyKey(plaintextKey: string): Promise<VerifiedApiKeyContext | null> {
    const context = await apiKeysService.verifyKeyWithMetadata(plaintextKey);
    if (!context) {
      return null;
    }

    return {
      userId: context.userId,
      organizationId: context.organizationId,
      scopes: context.scopes,
    };
  },

  /**
   * Mark an already accepted API-key request as used without blocking the
   * response path.
   */
  touchLastUsedAt(apiKeyId: string): void {
    scheduleLastUsedAtUpdate(apiKeyId, new Date());
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
