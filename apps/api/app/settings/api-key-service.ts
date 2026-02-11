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
      });

      if (response.status === 401) {
        return { valid: false, error: "Invalid API key" };
      }

      // Any non-401 response means the key is valid (even if rate limited, etc.)
      return { valid: true };
    } catch (error) {
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
      throw new Error(
        "Legacy user API key detected. Re-save your key in Settings to migrate to encrypted storage."
      );
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
      throw new Error(
        "Legacy organization API key detected. Re-save the key in Settings to migrate to encrypted storage."
      );
    }

    return null;
  },
};
