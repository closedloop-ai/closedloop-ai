import Store from "electron-store";
import type { ApiKeyProvenance as ApiKeyProvenanceFromContracts } from "../../shared/contracts.js";
import {
  getElectronSafeStorage,
  type SafeStorageLike,
} from "../util/electron-safe-storage.js";

export type { SafeStorageLike } from "../util/electron-safe-storage.js";

type SecretsSchema = {
  encryptedApiKey?: string;
  apiKeyProvenance?: ApiKeyProvenance;
  /**
   * Non-secret UI flag (PRD-532 §8 / M6): set once the user dismisses the
   * "Sign in with GitHub to sync" existing-user prompt, so it stays a one-time
   * prompt across restarts. Stored plaintext here — it is not a credential and
   * carries no identity/token material — but lives in the same store as the API
   * key because it is scoped to that key's lifecycle: {@link ApiKeyStore.clearApiKey}
   * wipes it so a fresh key on the same machine can re-offer the prompt.
   */
  existingUserSyncPromptDismissed?: string;
  [key: string]: string | undefined;
};

const SYNC_PROMPT_DISMISSED_KEY = "existingUserSyncPromptDismissed";
const SYNC_PROMPT_DISMISSED_VALUE = "1";

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
  /**
   * ISS-6243 — subscribers to credential changes. The active key is what decides
   * which account the desktop is acting as, and it is mutated from a scattered
   * set of call sites (manual entry, onboarding claim, profile switch, reset).
   * Announcing the change HERE, at the single store every one of them writes
   * through, is what lets a downstream consumer react to a sign-in, a sign-out,
   * or an org switch without every one of those call sites having to know about
   * it.
   */
  private readonly listeners = new Set<() => void>();

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

  getApiKeyDiagnostic(): "available" | "missing" | "undecryptable" {
    const encryptedApiKey = this.store.get("encryptedApiKey");
    if (encryptedApiKey) {
      const decrypted = this.getApiKey();
      return decrypted ? "available" : "undecryptable";
    }
    const envApiKey = this.getEnvironmentApiKey();
    return envApiKey ? "available" : "missing";
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
    this.notifyApiKeyChanged();
  }

  clearApiKey(): void {
    this.store.delete("encryptedApiKey");
    this.store.delete("apiKeyProvenance");
    // The sync-prompt dismissal is scoped to the key's lifecycle: clearing the
    // key resets it so a later key (a different account, or a re-add) can offer
    // the existing-user prompt again rather than staying permanently dismissed.
    this.store.delete(SYNC_PROMPT_DISMISSED_KEY);
    this.notifyApiKeyChanged();
  }

  /**
   * ISS-6243 — observe active-key changes (set, rotate, clear). Returns the
   * unsubscribe. Listeners run AFTER the store has been written, so a listener
   * that reads the key back sees the new value.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Announce a credential change. A listener must never be able to fail a
   * credential write — sign-out in particular has already mutated the store by
   * this point, so throwing here would report a failure for work that DID
   * happen. Each listener is isolated instead.
   */
  private notifyApiKeyChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Best-effort fan-out: one bad subscriber must not strand the others,
        // nor surface as a failed key write.
      }
    }
  }

  /**
   * Whether the user has dismissed the existing-user "Sign in with GitHub to
   * sync" prompt (PRD-532 §8 / M6). Non-secret; drives the one-time prompt so it
   * does not reappear on every launch once dismissed.
   */
  hasDismissedSyncPrompt(): boolean {
    return (
      this.store.get(SYNC_PROMPT_DISMISSED_KEY) === SYNC_PROMPT_DISMISSED_VALUE
    );
  }

  /** Persist that the existing-user sync prompt was dismissed (one-time). */
  dismissSyncPrompt(): void {
    this.store.set(SYNC_PROMPT_DISMISSED_KEY, SYNC_PROMPT_DISMISSED_VALUE);
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
