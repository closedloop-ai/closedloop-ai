import Store from "electron-store";
import {
  getElectronSafeStorage,
  type SafeStorageLike,
} from "./electron-safe-storage.js";

export type { SafeStorageLike } from "./electron-safe-storage.js";

/**
 * Metadata stored alongside a loop runner auth token.
 * `expiresAt` is a Unix timestamp in milliseconds.
 * `jti` is the JWT ID from the most recently issued token.
 * `lastIdempotencyKey` is persisted so a force-quit mid-refresh can reuse the
 * same key on the next launch (AC-008).
 */
export type LoopTokenMeta = {
  token: string;
  expiresAt?: number;
  jti?: string;
  lastIdempotencyKey?: string;
};

type LoopTokenStoreSchema = {
  encryptedLoopTokens: Record<string, string>;
};

export type LoopTokenStoreOptions = {
  cwd?: string;
  name?: string;
  /**
   * When set (e.g. in unit tests under Node), uses this instead of Electron safeStorage.
   * Production callers omit this and resolve safeStorage from the Electron main process.
   */
  safeStorage?: SafeStorageLike;
};

/**
 * Encrypted persistence for per-loop runner auth tokens, keyed by `loopId`.
 * Uses the same pattern as {@link ApiKeyStore}: electron-store + safeStorage.
 *
 * On-disk format: encrypted JSON serialization of {@link LoopTokenMeta}.
 */
export class LoopTokenStore {
  private readonly store: Store<LoopTokenStoreSchema>;
  private readonly safe: SafeStorageLike;

  constructor(options?: LoopTokenStoreOptions) {
    this.safe = getElectronSafeStorage(options?.safeStorage, "LoopTokenStore");
    this.store = new Store<LoopTokenStoreSchema>({
      name: options?.name ?? "desktop-loop-tokens",
      cwd: options?.cwd,
      defaults: {
        encryptedLoopTokens: {},
      },
    });
  }

  private getEncryptedMap(): Record<string, string> {
    const raw = this.store.get("encryptedLoopTokens");
    return raw && typeof raw === "object" ? { ...raw } : {};
  }

  private setEncryptedMap(map: Record<string, string>): void {
    this.store.set("encryptedLoopTokens", map);
  }

  setLoopToken(loopId: string, meta: LoopTokenMeta): void {
    if (!this.safe.isEncryptionAvailable()) {
      throw new Error("safeStorage is not available on this system");
    }
    const serialized = JSON.stringify(meta);
    const encrypted = this.safe.encryptString(serialized).toString("base64");
    const map = this.getEncryptedMap();
    map[loopId] = encrypted;
    this.setEncryptedMap(map);
  }

  /**
   * Returns the full token metadata for the given loop, or `null` if not found
   * or decryption fails.
   */
  getLoopToken(loopId: string): LoopTokenMeta | null {
    const encrypted = this.getEncryptedMap()[loopId];
    if (!encrypted) {
      return null;
    }
    if (!this.safe.isEncryptionAvailable()) {
      return null;
    }
    try {
      const decrypted = this.safe.decryptString(
        Buffer.from(encrypted, "base64")
      );
      const trimmed = decrypted.trim();
      if (trimmed.length === 0) {
        return null;
      }
      const parsed: unknown = JSON.parse(trimmed);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "token" in parsed &&
        typeof (parsed as Record<string, unknown>).token === "string"
      ) {
        return parsed as LoopTokenMeta;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Convenience method for callers that only need the raw token string.
   * Returns `null` if no token is stored or decryption fails.
   */
  getLoopTokenString(loopId: string): string | null {
    return this.getLoopToken(loopId)?.token ?? null;
  }

  deleteLoopToken(loopId: string): void {
    const map = this.getEncryptedMap();
    if (!(loopId in map)) {
      return;
    }
    delete map[loopId];
    this.setEncryptedMap(map);
  }

  listLoopIds(): string[] {
    return Object.keys(this.getEncryptedMap());
  }
}
