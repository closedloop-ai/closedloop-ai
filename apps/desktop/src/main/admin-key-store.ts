/**
 * @file admin-key-store.ts
 * @description Desktop-main (ESM) safeStorage-backed persistence for the vendor
 * ORG-LEVEL Admin API keys that nightly cost reconciliation uses to read what a
 * vendor actually billed (FEA-1435/1436).
 *
 * ── Why this is main-only, and why it is its own store ───────────────────────
 * Admin keys are org-scoped secrets (Anthropic `sk-ant-admin…`, OpenAI
 * `sk-admin…`) that can read an organization's billing. They live ONLY in the
 * main process, encrypted at rest via Electron safeStorage (OS keychain), and
 * are never handed to the sandboxed sidecar or the renderer. They are kept in a
 * dedicated electron-store file (`desktop-admin-secrets`) separate from the
 * regular per-user API key (`desktop-secrets`) so their blast radius is small
 * and obvious.
 *
 * ── The two-method contract: getKey() vs getStatus() ─────────────────────────
 * `getKey()` returns plaintext for MAIN-PROCESS outbound vendor calls only (the
 * admin clients in Slice D). It must NEVER be exposed over IPC or logged.
 * `getStatus()` returns existence-only (`hasKey: boolean`) and is the ONLY shape
 * safe to send to the renderer — it decrypts internally to confirm the key is
 * actually usable, then discards the plaintext. This mirrors api-key-store.ts,
 * where IPC sees `getStatus()` and never the key itself.
 *
 * One shared class is parameterized by vendor (storage-key namespace + a vendor
 * tag); the per-vendor factories below are thin so we don't duplicate the
 * safeStorage plumbing per vendor.
 */
import Store from "electron-store";
import {
  getElectronSafeStorage,
  type SafeStorageLike,
} from "./electron-safe-storage.js";

export type { SafeStorageLike } from "./electron-safe-storage.js";

/** Vendor whose org-level Admin API key this store holds. */
export type AdminKeyVendor = "anthropic" | "openai";

/** electron-store file name shared by both vendors (namespaced keys within). */
const ADMIN_SECRETS_STORE_NAME = "desktop-admin-secrets";

type AdminSecretsSchema = {
  [key: string]: string | undefined;
};

/**
 * Existence-only status. This is the ONLY admin-key shape that may cross IPC to
 * the renderer — it never carries key material.
 */
export type AdminKeyStatus = {
  vendor: AdminKeyVendor;
  hasKey: boolean;
};

export type AdminKeyStoreOptions = {
  /** Which vendor's admin key this instance manages. */
  vendor: AdminKeyVendor;
  /** electron-store directory override (tests point this at a temp dir). */
  cwd?: string;
  /** electron-store file name override (without extension). */
  name?: string;
  /** Injectable safeStorage for Node tests. */
  safeStorage?: SafeStorageLike;
};

export class AdminKeyStore {
  private readonly vendor: AdminKeyVendor;
  private readonly store: Store<AdminSecretsSchema>;
  private readonly safeStorage: SafeStorageLike;
  /** Namespaced per vendor so both keys can share one store file. */
  private readonly storageKey: string;

  constructor(options: AdminKeyStoreOptions) {
    this.vendor = options.vendor;
    this.store = new Store<AdminSecretsSchema>({
      name: options.name ?? ADMIN_SECRETS_STORE_NAME,
      cwd: options.cwd,
    });
    this.safeStorage = getElectronSafeStorage(
      options.safeStorage,
      `AdminKeyStore(${options.vendor})`
    );
    this.storageKey = `encryptedAdminKey:${options.vendor}`;
  }

  /**
   * Returns the decrypted Admin API key for MAIN-PROCESS outbound vendor calls
   * ONLY (the reconciliation admin clients). NEVER expose this over IPC or log
   * it — the renderer-facing contract is getStatus(). Returns null when unset or
   * when safeStorage cannot decrypt (e.g. keychain unavailable).
   */
  getKey(): string | null {
    const encrypted = this.store.get(this.storageKey);
    if (!encrypted) {
      return null;
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      return null;
    }
    try {
      return this.safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    } catch {
      return null;
    }
  }

  /**
   * Existence-only status, safe to return over IPC. Decrypts internally to
   * confirm the stored blob is actually readable, then discards the plaintext.
   */
  getStatus(): AdminKeyStatus {
    return { vendor: this.vendor, hasKey: this.getKey() !== null };
  }

  /**
   * Encrypts and persists the Admin API key at rest. Rejects an empty key and
   * any key that is not a header-safe token.
   *
   * `setKey` is reached from the untrusted `desktop:set-admin-key` IPC boundary,
   * and the stored key is later sent verbatim as an HTTP header value
   * (`x-api-key` / `Authorization`). A key carrying a control character — e.g. an
   * embedded newline from a corrupted paste — would pass `fetch` a malformed
   * header value; `fetch` throws `Headers.append: "<value>" is an invalid header
   * value`, echoing the raw key into a message the reconciliation/analytics
   * services log and surface over IPC. Rejecting non-header-safe characters here
   * keeps such a value from ever being stored, so it can never reach that path.
   * Real Admin keys are all visible ASCII (`sk-…` alphanumerics, `-`, `_`); the
   * error never includes the key itself.
   */
  setKey(key: string): void {
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      throw new Error("Admin API key must not be empty");
    }
    // Anything outside header-safe visible ASCII (0x21–0x7E) — control chars,
    // spaces, non-ASCII — is rejected before storage. Note 0x20 (space) is
    // excluded too: a valid key has no interior whitespace post-trim.
    if (/[^\x21-\x7E]/.test(trimmed)) {
      throw new Error("Admin API key contains invalid characters");
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("safeStorage is not available on this system");
    }
    const encrypted = this.safeStorage.encryptString(trimmed);
    this.store.set(this.storageKey, encrypted.toString("base64"));
  }

  clearKey(): void {
    this.store.delete(this.storageKey);
  }
}

/** Thin factory: the Anthropic org Admin key store (`sk-ant-admin…`). */
export function createAnthropicAdminKeyStore(
  options?: Omit<AdminKeyStoreOptions, "vendor">
): AdminKeyStore {
  return new AdminKeyStore({ ...options, vendor: "anthropic" });
}

/** Thin factory: the OpenAI org Admin key store (`sk-admin…`). */
export function createOpenAiAdminKeyStore(
  options?: Omit<AdminKeyStoreOptions, "vendor">
): AdminKeyStore {
  return new AdminKeyStore({ ...options, vendor: "openai" });
}
