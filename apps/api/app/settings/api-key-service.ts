import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";

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
    await withDb((db) =>
      db.organization.update({
        where: { id: organizationId },
        data: { anthropicApiKey: key },
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
        data: { anthropicApiKey: null },
      })
    );
  },

  /**
   * Get org API key info (never returns full key).
   */
  async getOrgKeyInfo(
    organizationId: string
  ): Promise<{ isSet: boolean; lastFour: string | null }> {
    const org = await withDb((db) =>
      db.organization.findUnique({
        where: { id: organizationId },
        select: { anthropicApiKey: true },
      })
    );

    if (!org?.anthropicApiKey) {
      return { isSet: false, lastFour: null };
    }

    return { isSet: true, lastFour: org.anthropicApiKey.slice(-4) };
  },

  /**
   * Set user-level API key.
   */
  async setUserKey(userId: string, key: string): Promise<void> {
    await withDb((db) =>
      db.user.update({
        where: { id: userId },
        data: { anthropicApiKey: key },
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
        data: { anthropicApiKey: null },
      })
    );
  },

  /**
   * Get user API key info (never returns full key).
   */
  async getUserKeyInfo(
    userId: string
  ): Promise<{ isSet: boolean; lastFour: string | null }> {
    const user = await withDb((db) =>
      db.user.findUnique({
        where: { id: userId },
        select: { anthropicApiKey: true },
      })
    );

    if (!user?.anthropicApiKey) {
      return { isSet: false, lastFour: null };
    }

    return { isSet: true, lastFour: user.anthropicApiKey.slice(-4) };
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
        select: { anthropicApiKey: true },
      })
    );

    if (user?.anthropicApiKey) {
      return user.anthropicApiKey;
    }

    // Fall back to org key
    const org = await withDb((db) =>
      db.organization.findUnique({
        where: { id: organizationId },
        select: { anthropicApiKey: true },
      })
    );

    return org?.anthropicApiKey ?? null;
  },
};
