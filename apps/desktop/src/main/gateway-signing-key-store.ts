import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import Store from "electron-store";
import {
  getElectronSafeStorage,
  type SafeStorageLike,
} from "./electron-safe-storage.js";

type GatewaySigningKeysSchema = {
  encryptedPrivateKeysByGatewayId: Record<string, string>;
};

export type GatewaySigningKeyUnavailableReason =
  | "gateway_id_missing"
  | "key_missing"
  | "safe_storage_unavailable"
  | "decrypt_failed"
  | "key_import_failed"
  | "key_generation_failed";

export type GatewaySigningKeyMaterial = {
  gatewayId: string;
  privateKeyPkcs8Pem: string;
  publicKeySpkiPem: string;
};

export type GatewaySigningKeyResult =
  | { ok: true; keyPair: GatewaySigningKeyMaterial }
  | { ok: false; reason: GatewaySigningKeyUnavailableReason };

export type GatewaySigningKeyStoreOptions = {
  cwd?: string;
  name?: string;
  safeStorage?: SafeStorageLike;
};

/**
 * Encrypted persistence for the Desktop gateway Ed25519 private key, scoped by stable gatewayId.
 */
export class GatewaySigningKeyStore {
  private readonly store: Store<GatewaySigningKeysSchema>;
  private readonly safeStorage: SafeStorageLike;

  constructor(options?: GatewaySigningKeyStoreOptions) {
    this.safeStorage = getElectronSafeStorage(
      options?.safeStorage,
      "GatewaySigningKeyStore"
    );
    this.store = new Store<GatewaySigningKeysSchema>({
      name: options?.name ?? "desktop-gateway-signing-keys",
      cwd: options?.cwd,
      defaults: {
        encryptedPrivateKeysByGatewayId: {},
      },
    });
  }

  /**
   * Loads the existing keypair for a gatewayId, or creates exactly one if absent.
   */
  getOrCreate(gatewayId: string): GatewaySigningKeyResult {
    const existing = this.load(gatewayId);
    if (existing.ok || existing.reason !== "key_missing") {
      return existing;
    }
    return this.create(gatewayId);
  }

  /**
   * Loads an existing keypair without creating replacement material in runtime request paths.
   */
  load(gatewayId: string): GatewaySigningKeyResult {
    const normalizedGatewayId = gatewayId.trim();
    if (!normalizedGatewayId) {
      return { ok: false, reason: "gateway_id_missing" };
    }

    const encrypted = this.getEncryptedMap()[normalizedGatewayId];
    if (!encrypted) {
      return { ok: false, reason: "key_missing" };
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      return { ok: false, reason: "safe_storage_unavailable" };
    }

    let privateKeyPkcs8Pem: string;
    try {
      privateKeyPkcs8Pem = this.safeStorage.decryptString(
        Buffer.from(encrypted, "base64")
      );
    } catch {
      return { ok: false, reason: "decrypt_failed" };
    }

    return this.materialFromPrivateKey(normalizedGatewayId, privateKeyPkcs8Pem);
  }

  /** Deletes persisted private key material for a removed saved-config identity. */
  delete(gatewayId: string): void {
    const normalizedGatewayId = gatewayId.trim();
    if (!normalizedGatewayId) {
      return;
    }
    const map = this.getEncryptedMap();
    delete map[normalizedGatewayId];
    this.setEncryptedMap(map);
  }

  private create(gatewayId: string): GatewaySigningKeyResult {
    const normalizedGatewayId = gatewayId.trim();
    if (!normalizedGatewayId) {
      return { ok: false, reason: "gateway_id_missing" };
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      return { ok: false, reason: "safe_storage_unavailable" };
    }

    try {
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const privateKeyPkcs8Pem = privateKey
        .export({
          format: "pem",
          type: "pkcs8",
        })
        .toString();
      const publicKeySpkiPem = publicKey
        .export({
          format: "pem",
          type: "spki",
        })
        .toString();
      const encrypted = this.safeStorage
        .encryptString(privateKeyPkcs8Pem)
        .toString("base64");
      const map = this.getEncryptedMap();
      map[normalizedGatewayId] = encrypted;
      this.setEncryptedMap(map);
      return {
        ok: true,
        keyPair: {
          gatewayId: normalizedGatewayId,
          privateKeyPkcs8Pem,
          publicKeySpkiPem,
        },
      };
    } catch {
      return { ok: false, reason: "key_generation_failed" };
    }
  }

  private materialFromPrivateKey(
    gatewayId: string,
    privateKeyPkcs8Pem: string
  ): GatewaySigningKeyResult {
    try {
      const privateKey = createPrivateKey({
        key: privateKeyPkcs8Pem,
        format: "pem",
        type: "pkcs8",
      });
      const publicKeySpkiPem = createPublicKey(privateKey)
        .export({
          format: "pem",
          type: "spki",
        })
        .toString();
      return {
        ok: true,
        keyPair: {
          gatewayId,
          privateKeyPkcs8Pem,
          publicKeySpkiPem,
        },
      };
    } catch {
      return { ok: false, reason: "key_import_failed" };
    }
  }

  private getEncryptedMap(): Record<string, string> {
    const raw = this.store.get("encryptedPrivateKeysByGatewayId");
    return raw && typeof raw === "object" ? { ...raw } : {};
  }

  private setEncryptedMap(map: Record<string, string>): void {
    this.store.set("encryptedPrivateKeysByGatewayId", map);
  }
}
