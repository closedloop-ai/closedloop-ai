import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Minimal Electron safeStorage surface used by encrypted desktop stores.
 */
export type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

/**
 * Resolves Electron safeStorage with an injectable override for Node tests.
 */
export function getElectronSafeStorage(
  override: SafeStorageLike | undefined,
  ownerName: string
): SafeStorageLike {
  if (override) {
    return override;
  }
  try {
    const electron = require("electron") as unknown;
    if (electron && typeof electron === "object" && "safeStorage" in electron) {
      const safeStorage = (electron as { safeStorage?: SafeStorageLike })
        .safeStorage;
      if (
        safeStorage &&
        typeof safeStorage.isEncryptionAvailable === "function" &&
        typeof safeStorage.encryptString === "function" &&
        typeof safeStorage.decryptString === "function"
      ) {
        return safeStorage;
      }
    }
  } catch {
    /* not running in Electron */
  }
  throw new Error(
    `${ownerName} requires Electron main process or options.safeStorage`
  );
}
