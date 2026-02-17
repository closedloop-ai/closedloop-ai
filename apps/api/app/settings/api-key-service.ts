import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";

const ENCRYPTION_CONTEXT = { purpose: "claude-api-key" } as const;

let _kmsClient: KMSClient | null = null;
function getKmsClient(): KMSClient {
  if (!_kmsClient) {
    _kmsClient = new KMSClient({
      region: process.env.AWS_REGION ?? "us-east-1",
    });
  }
  return _kmsClient;
}

function requireKmsKeyArn(): string {
  const arn = process.env.KMS_KEY_ARN;
  if (!arn) {
    throw new Error("KMS_KEY_ARN is not configured");
  }
  return arn;
}

async function encryptApiKey(key: string): Promise<string> {
  const result = await getKmsClient().send(
    new EncryptCommand({
      KeyId: requireKmsKeyArn(),
      Plaintext: Buffer.from(key, "utf-8"),
      EncryptionContext: ENCRYPTION_CONTEXT,
    })
  );

  if (!result.CiphertextBlob) {
    throw new Error("KMS encryption failed: empty ciphertext");
  }

  return Buffer.from(result.CiphertextBlob).toString("base64");
}

async function decryptApiKey(encrypted: string): Promise<string> {
  const result = await getKmsClient().send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(encrypted, "base64"),
      EncryptionContext: ENCRYPTION_CONTEXT,
    })
  );

  if (!result.Plaintext) {
    throw new Error("KMS decryption failed: empty plaintext");
  }

  return Buffer.from(result.Plaintext).toString("utf-8");
}

function getLastFour(key: string): string {
  return key.slice(-4);
}

type ApiKeyInfo = {
  isSet: boolean;
  lastFour: string | null;
  setAt: Date | null;
};

export const apiKeyService = {
  /**
   * Validate a Claude API key format and optionally test it live.
   * Returns { valid: true } or { valid: false, error: string }
   */
  async validateClaudeApiKey(
    key: string
  ): Promise<{ valid: boolean; error?: string }> {
    // Format check: must start with sk-ant-
    if (!key.startsWith("sk-ant-")) {
      return { valid: false, error: "API key must start with 'sk-ant-'" };
    }

    // Live validation: call Claude API to verify key works
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      // 200: success, 400: bad request but authenticated, 429: rate limited but authenticated
      if (
        response.status === 200 ||
        response.status === 400 ||
        response.status === 429
      ) {
        return { valid: true };
      }

      // 401: invalid or missing API key
      if (response.status === 401) {
        return { valid: false, error: "Invalid API key" };
      }

      // 403: could be disabled account OR valid key with model permission restriction.
      // Parse the error body to distinguish.
      if (response.status === 403) {
        try {
          const body = (await response.json()) as {
            error?: { type?: string; message?: string };
          };
          const errorType = body?.error?.type;
          // permission_error with model-related message → key is valid but lacks model access
          if (
            errorType === "permission_error" &&
            body?.error?.message?.toLowerCase().includes("model")
          ) {
            return { valid: true };
          }
        } catch {
          // JSON parse failed — fall through to default
        }
        return { valid: false, error: "API key is disabled or unauthorized" };
      }

      // 5xx / other: Anthropic API issue — can't confirm key validity
      log.warn("Unexpected status from Claude API key validation", {
        status: response.status,
      });
      return {
        valid: false,
        error:
          "Could not verify key - Anthropic API returned an unexpected response",
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        log.warn("Claude API key validation timed out");
        return {
          valid: false,
          error:
            "Validation timed out - Anthropic API did not respond. Please try again.",
        };
      }
      log.error("Failed to validate Claude API key", { error });
      return {
        valid: false,
        error: "Failed to validate key - please try again",
      };
    }
  },

  /**
   * Set org-level API key.
   */
  async setOrgKey(organizationId: string, key: string): Promise<void> {
    const encrypted = await encryptApiKey(key);

    await withDb((db) =>
      db.organization.update({
        where: { id: organizationId },
        data: {
          anthropicApiKey: null,
          claudeApiKeyEncrypted: encrypted,
          claudeApiKeyLastFour: getLastFour(key),
          claudeApiKeySetAt: new Date(),
        },
      })
    );
  },

  /**
   * Remove org-level API key.
   */
  async removeOrgKey(organizationId: string): Promise<void> {
    await withDb((db) =>
      db.organization.update({
        where: { id: organizationId },
        data: {
          anthropicApiKey: null,
          claudeApiKeyEncrypted: null,
          claudeApiKeyLastFour: null,
          claudeApiKeySetAt: null,
        },
      })
    );
  },

  /**
   * Get org API key info (never returns full key).
   */
  async getOrgKeyInfo(organizationId: string): Promise<ApiKeyInfo> {
    const org = await withDb((db) =>
      db.organization.findUnique({
        where: { id: organizationId },
        select: {
          claudeApiKeyEncrypted: true,
          claudeApiKeyLastFour: true,
          claudeApiKeySetAt: true,
        },
      })
    );

    if (org?.claudeApiKeyEncrypted) {
      return {
        isSet: true,
        lastFour: org.claudeApiKeyLastFour ?? null,
        setAt: org.claudeApiKeySetAt ?? null,
      };
    }

    return { isSet: false, lastFour: null, setAt: null };
  },

  /**
   * Set user-level API key.
   */
  async setUserKey(userId: string, key: string): Promise<void> {
    const encrypted = await encryptApiKey(key);

    await withDb((db) =>
      db.user.update({
        where: { id: userId },
        data: {
          anthropicApiKey: null,
          claudeApiKeyEncrypted: encrypted,
          claudeApiKeyLastFour: getLastFour(key),
          claudeApiKeySetAt: new Date(),
        },
      })
    );
  },

  /**
   * Remove user-level API key.
   */
  async removeUserKey(userId: string): Promise<void> {
    await withDb((db) =>
      db.user.update({
        where: { id: userId },
        data: {
          anthropicApiKey: null,
          claudeApiKeyEncrypted: null,
          claudeApiKeyLastFour: null,
          claudeApiKeySetAt: null,
        },
      })
    );
  },

  /**
   * Get user API key info (never returns full key).
   */
  async getUserKeyInfo(userId: string): Promise<ApiKeyInfo> {
    const user = await withDb((db) =>
      db.user.findUnique({
        where: { id: userId },
        select: {
          claudeApiKeyEncrypted: true,
          claudeApiKeyLastFour: true,
          claudeApiKeySetAt: true,
        },
      })
    );

    if (user?.claudeApiKeyEncrypted) {
      return {
        isSet: true,
        lastFour: user.claudeApiKeyLastFour ?? null,
        setAt: user.claudeApiKeySetAt ?? null,
      };
    }

    return { isSet: false, lastFour: null, setAt: null };
  },

  /**
   * Resolve which API key to use for a given user+org.
   * User key takes precedence over org key.
   * Returns null if no key is configured.
   */
  async resolveApiKey(
    userId: string,
    organizationId: string
  ): Promise<string | null> {
    // Check user key first
    const user = await withDb((db) =>
      db.user.findUnique({
        where: { id: userId },
        select: {
          claudeApiKeyEncrypted: true,
          anthropicApiKey: true,
        },
      })
    );

    if (user?.claudeApiKeyEncrypted) {
      return decryptApiKey(user.claudeApiKeyEncrypted);
    }
    if (user?.anthropicApiKey) {
      // Auto-migrate legacy plaintext key to KMS-encrypted storage.
      // If migration fails (e.g., KMS unavailable), throw rather than returning
      // the plaintext key — prevents transmitting unencrypted secrets during KMS outages.
      log.warn(
        "Legacy plaintext user API key detected — attempting auto-migration",
        { userId }
      );
      try {
        await this.setUserKey(userId, user.anthropicApiKey);
        log.info("Successfully migrated legacy user API key", { userId });
        // The key has just been validated and encrypted at rest; return the
        // in-memory plaintext for immediate use and avoid a second DB round-trip.
        return user.anthropicApiKey;
      } catch (migrationError) {
        log.error(
          "Failed to auto-migrate legacy user API key — key unavailable until KMS is restored",
          {
            userId,
            error: migrationError,
          }
        );
        throw new Error(
          "API key migration failed. The legacy plaintext key cannot be used. " +
            "Please re-save your API key in Settings, or contact support if the issue persists."
        );
      }
    }

    // Fall back to org key
    const org = await withDb((db) =>
      db.organization.findUnique({
        where: { id: organizationId },
        select: {
          claudeApiKeyEncrypted: true,
          anthropicApiKey: true,
        },
      })
    );

    if (org?.claudeApiKeyEncrypted) {
      return decryptApiKey(org.claudeApiKeyEncrypted);
    }
    if (org?.anthropicApiKey) {
      // Auto-migrate legacy plaintext key to KMS-encrypted storage.
      // If migration fails, throw rather than returning the plaintext key.
      log.warn(
        "Legacy plaintext org API key detected — attempting auto-migration",
        { organizationId }
      );
      try {
        await this.setOrgKey(organizationId, org.anthropicApiKey);
        log.info("Successfully migrated legacy org API key", {
          organizationId,
        });
        // The key has just been validated and encrypted at rest; return the
        // in-memory plaintext for immediate use and avoid a second DB round-trip.
        return org.anthropicApiKey;
      } catch (migrationError) {
        log.error(
          "Failed to auto-migrate legacy org API key — key unavailable until KMS is restored",
          {
            organizationId,
            error: migrationError,
          }
        );
        throw new Error(
          "API key migration failed. The legacy plaintext key cannot be used. " +
            "Please re-save the organization API key in Settings, or contact support."
        );
      }
    }

    return null;
  },
};
