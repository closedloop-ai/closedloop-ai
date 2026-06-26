import Store from "electron-store";
import type { ApiKeyProvenance as ApiKeyProvenanceFromContracts } from "../shared/contracts.js";
import {
  getElectronSafeStorage,
  type SafeStorageLike,
} from "./electron-safe-storage.js";

export type { SafeStorageLike } from "./electron-safe-storage.js";

type SecretsSchema = {
  encryptedApiKey?: string;
  apiKeyProvenance?: ApiKeyProvenance;
  [key: string]: string | undefined;
};

/**
 * Provenance controls whether Desktop PoP signing applies to the active API key.
 * Re-exported from contracts.ts (SSOT) so all imports from api-key-store.ts
 * continue to work without changes.
 */
export type ApiKeyProvenance = ApiKeyProvenanceFromContracts;

/** Plaintext API key plus non-secret provenance metadata for request-signing decisions. */
export type ApiKeyRecord = {
  apiKey: string;
  provenance: ApiKeyProvenance;
};

export type ApiKeyStatus = {
  hasApiKey: boolean;
  source: "safeStorage" | "environment" | "none";
  environmentVariable?: "CLOSEDLOOP_API_KEY" | "SYMPHONY_API_KEY";
  provenance?: ApiKeyProvenance;
};

export type ApiKeyStoreOptions = {
  cwd?: string;
  name?: string;
  safeStorage?: SafeStorageLike;
};

export class ApiKeyStore {
  private readonly store: Store<SecretsSchema>;
  private readonly safeStorage: SafeStorageLike;

  constructor(options?: ApiKeyStoreOptions) {
    this.store = new Store<SecretsSchema>({
      name: options?.name ?? "desktop-secrets",
      cwd: options?.cwd,
    });
    this.safeStorage = getElectronSafeStorage(
      options?.safeStorage,
      "ApiKeyStore"
    );
  }

  /** Returns only the plaintext key for legacy callers that do not need provenance. */
  getApiKey(): string | null {
    return this.getApiKeyRecord()?.apiKey ?? null;
  }

  /** Returns the plaintext key and provenance, treating env and legacy keys as USER_CREATED. */
  getApiKeyRecord(): ApiKeyRecord | null {
    const encryptedApiKey = this.store.get("encryptedApiKey");
    if (!encryptedApiKey) {
      const envApiKey = this.getEnvironmentApiKey();
      return envApiKey
        ? { apiKey: envApiKey.value, provenance: "USER_CREATED" }
        : null;
    }

    if (!this.safeStorage.isEncryptionAvailable()) {
      return null;
    }

    try {
      return {
        apiKey: this.safeStorage.decryptString(
          Buffer.from(encryptedApiKey, "base64")
        ),
        provenance: this.getStoredApiKeyProvenance(),
      };
    } catch {
      return null;
    }
  }

  /** Returns provenance for the active key, or null when no key can be read. */
  getApiKeyProvenance(): ApiKeyProvenance | null {
    return this.getApiKeyRecord()?.provenance ?? null;
  }

  getStatus(): ApiKeyStatus {
    const encryptedApiKey = this.store.get("encryptedApiKey");
    if (encryptedApiKey) {
      const decrypted = this.getApiKey();
      return {
        hasApiKey: Boolean(decrypted),
        source: decrypted ? "safeStorage" : "none",
        provenance: decrypted ? this.getStoredApiKeyProvenance() : undefined,
      };
    }

    const envApiKey = this.getEnvironmentApiKey();
    if (envApiKey) {
      return {
        hasApiKey: true,
        source: "environment",
        environmentVariable: envApiKey.environmentVariable,
        provenance: "USER_CREATED",
      };
    }

    return {
      hasApiKey: false,
      source: "none",
    };
  }

  /** Stores the active key encrypted at rest with explicit provenance metadata. */
  setApiKey(
    apiKey: string,
    provenance: ApiKeyProvenance = "USER_CREATED"
  ): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("safeStorage is not available on this system");
    }

    const encrypted = this.safeStorage.encryptString(apiKey);
    this.store.set("encryptedApiKey", encrypted.toString("base64"));
    this.store.set("apiKeyProvenance", provenance);
  }

  clearApiKey(): void {
    this.store.delete("encryptedApiKey");
    this.store.delete("apiKeyProvenance");
  }

  /** Stores a saved-config key encrypted at rest with its provenance metadata. */
  saveProfileKey(
    profileId: string,
    key: string,
    provenance: ApiKeyProvenance = "USER_CREATED"
  ): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("safeStorage is not available on this system");
    }
    const encrypted = this.safeStorage.encryptString(key);
    this.store.set(`profile:${profileId}`, encrypted.toString("base64"));
    this.store.set(`profile:${profileId}:provenance`, provenance);
  }

  /** Returns only a saved-config key for legacy callers that do not need provenance. */
  getProfileKey(profileId: string): string | null {
    return this.getProfileKeyRecord(profileId)?.apiKey ?? null;
  }

  /** Returns a saved-config key plus provenance, defaulting legacy profiles to USER_CREATED. */
  getProfileKeyRecord(profileId: string): ApiKeyRecord | null {
    const encryptedValue = this.store.get(
      `profile:${profileId}` as keyof SecretsSchema
    );
    if (!encryptedValue) {
      return null;
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      return null;
    }
    try {
      return {
        apiKey: this.safeStorage.decryptString(
          Buffer.from(encryptedValue, "base64")
        ),
        provenance: this.getProfileKeyProvenance(profileId),
      };
    } catch {
      return null;
    }
  }

  /** Returns non-secret provenance metadata for a saved-config key. */
  getProfileKeyProvenance(profileId: string): ApiKeyProvenance {
    const raw = this.store.get(
      `profile:${profileId}:provenance` as keyof SecretsSchema
    );
    return raw === "DESKTOP_MANAGED" ? "DESKTOP_MANAGED" : "USER_CREATED";
  }

  deleteProfileKey(profileId: string): void {
    this.store.delete(`profile:${profileId}` as keyof SecretsSchema);
    this.store.delete(`profile:${profileId}:provenance` as keyof SecretsSchema);
  }

  private getStoredApiKeyProvenance(): ApiKeyProvenance {
    const raw = this.store.get("apiKeyProvenance");
    return raw === "DESKTOP_MANAGED" ? "DESKTOP_MANAGED" : "USER_CREATED";
  }

  private getEnvironmentApiKey(): {
    value: string;
    environmentVariable: "CLOSEDLOOP_API_KEY" | "SYMPHONY_API_KEY";
  } | null {
    const closedloopKey = process.env.CLOSEDLOOP_API_KEY?.trim();
    if (closedloopKey) {
      return {
        value: closedloopKey,
        environmentVariable: "CLOSEDLOOP_API_KEY",
      };
    }

    const symphonyKey = process.env.SYMPHONY_API_KEY?.trim();
    if (symphonyKey) {
      return {
        value: symphonyKey,
        environmentVariable: "SYMPHONY_API_KEY",
      };
    }

    return null;
  }
}
