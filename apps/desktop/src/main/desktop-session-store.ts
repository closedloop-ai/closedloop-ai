import Store from "electron-store";
import {
  getElectronSafeStorage,
  type SafeStorageLike,
} from "./electron-safe-storage.js";

export type { SafeStorageLike } from "./electron-safe-storage.js";

/**
 * Durable credentials for the active first-party desktop session (FEA-1514 /
 * FEA-2219). Persisted encrypted at rest; the short-lived ACCESS token is
 * deliberately NOT part of this record — it stays in main-process memory only.
 *
 * `gatewayId` is the device-key reference (the Ed25519 keypair is keyed by
 * gatewayId in {@link ./gateway-signing-key-store}); `userId`/`organizationId`
 * are kept for display/bootstrapping only, never for authorization decisions.
 * `*ExpiresAt` fields are ISO-8601 strings as returned by the session API.
 */
export type DesktopSessionRecord = {
  refreshToken: string;
  refreshTokenExpiresAt: string;
  userId: string;
  organizationId: string;
  gatewayId: string;
};

type DesktopSessionStoreSchema = {
  encryptedSession?: string;
};

export type DesktopSessionStoreOptions = {
  cwd?: string;
  name?: string;
  /**
   * Test override for Electron safeStorage. Production callers omit this and
   * resolve safeStorage from the Electron main process.
   */
  safeStorage?: SafeStorageLike;
};

const REQUIRED_STRING_FIELDS: readonly (keyof DesktopSessionRecord)[] = [
  "refreshToken",
  "refreshTokenExpiresAt",
  "userId",
  "organizationId",
  "gatewayId",
];

/**
 * Encrypted persistence for the single active desktop session. Same primitive
 * as {@link ApiKeyStore} / {@link LoopTokenStore}: safeStorage encrypts the
 * serialized record before it ever touches electron-store / disk, so the
 * refresh token is never written as plaintext JSON (FEA-1514 no-plaintext gate).
 */
export class DesktopSessionStore {
  private readonly store: Store<DesktopSessionStoreSchema>;
  private readonly safe: SafeStorageLike;

  constructor(options?: DesktopSessionStoreOptions) {
    this.safe = getElectronSafeStorage(
      options?.safeStorage,
      "DesktopSessionStore"
    );
    this.store = new Store<DesktopSessionStoreSchema>({
      name: options?.name ?? "desktop-session",
      cwd: options?.cwd,
    });
  }

  /** Persists the session record encrypted at rest, replacing any prior one. */
  setSession(record: DesktopSessionRecord): void {
    if (!this.safe.isEncryptionAvailable()) {
      throw new Error("safeStorage is not available on this system");
    }
    const encrypted = this.safe
      .encryptString(JSON.stringify(record))
      .toString("base64");
    this.store.set("encryptedSession", encrypted);
  }

  /**
   * Returns the stored session, or `null` when none is stored, safeStorage is
   * unavailable, or the persisted blob is corrupt/incomplete.
   */
  getSession(): DesktopSessionRecord | null {
    const encrypted = this.store.get("encryptedSession");
    if (!encrypted) {
      return null;
    }
    if (!this.safe.isEncryptionAvailable()) {
      return null;
    }
    let decrypted: string;
    try {
      decrypted = this.safe.decryptString(Buffer.from(encrypted, "base64"));
    } catch {
      return null;
    }
    return parseSessionRecord(decrypted);
  }

  /** Removes the stored session (sign-out / cleared invalid credentials). */
  clear(): void {
    this.store.delete("encryptedSession");
  }

  /** Whether any encrypted session blob is currently persisted. */
  hasSession(): boolean {
    return Boolean(this.store.get("encryptedSession"));
  }
}

function parseSessionRecord(serialized: string): DesktopSessionRecord | null {
  const trimmed = serialized.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof record[field] !== "string" || record[field] === "") {
      return null;
    }
  }
  return {
    refreshToken: record.refreshToken as string,
    refreshTokenExpiresAt: record.refreshTokenExpiresAt as string,
    userId: record.userId as string,
    organizationId: record.organizationId as string,
    gatewayId: record.gatewayId as string,
  };
}
