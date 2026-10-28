import type { ConnectionSecurityStatus } from "../../shared/connection-security.js";
import type {
  GatewaySigningKeyResult,
  GatewaySigningKeyStore,
} from "../command-signing/gateway-signing-key-store.js";
import type {
  ApiKeyProvenance,
  ApiKeyStore,
} from "../settings/api-key-store.js";
import { resolveConnectionSecurityStatus } from "../settings/connection-security-status.js";
import type { SavedConfigManagedPatch } from "../settings/saved-config.js";
import type { SettingsStore } from "../settings/settings-store.js";
import type { DesktopDeviceDescriptor } from "./desktop-session-manager-types.js";

type DesktopCredentialStoreAdapterDeps = {
  settingsStore: SettingsStore;
  apiKeyStore: ApiKeyStore;
  gatewaySigningKeyStore: GatewaySigningKeyStore;
  getActiveGatewayId: () => string;
  getDesktopVersion: () => string;
  getMachineName: () => string;
  getPlatform: () => string;
};

/** Owns the coupled active/profile managed-key metadata writes. */
export class DesktopCredentialStoreAdapter {
  private readonly deps: DesktopCredentialStoreAdapterDeps;

  constructor(deps: DesktopCredentialStoreAdapterDeps) {
    this.deps = deps;
  }

  /** Resolves the active signing key and persists its public managed metadata. */
  getOrCreateSigningKey(): GatewaySigningKeyResult {
    const gatewayId = this.deps.getActiveGatewayId();
    const result = this.deps.gatewaySigningKeyStore.getOrCreate(gatewayId);
    if (result.ok) {
      this.persistManagedMetadata({
        gatewayId,
        gatewayPublicKeyPem: result.keyPair.publicKeySpkiPem,
        desktopSecurityUpgradeProtocolVersion: 1,
      });
    }
    return result;
  }

  /** Returns the active gateway id only when its signing key is available. */
  getUpgradeCapableGatewayId(): string | null {
    const result = this.getOrCreateSigningKey();
    return result.ok ? result.keyPair.gatewayId : null;
  }

  /** Builds the first-party device descriptor without exposing private key bytes. */
  resolveDeviceDescriptor(): DesktopDeviceDescriptor {
    const result = this.getOrCreateSigningKey();
    if (!result.ok) {
      throw new Error(`Desktop signing key unavailable: ${result.reason}`);
    }
    return {
      gatewayId: result.keyPair.gatewayId,
      gatewayPublicKeyPem: result.keyPair.publicKeySpkiPem,
      machineName: this.deps.getMachineName(),
      platform: this.deps.getPlatform(),
      desktopVersion: this.deps.getDesktopVersion(),
    };
  }

  /** Persists one key under the active profile and its provenance metadata. */
  persistActiveProfileKey(apiKey: string, provenance: ApiKeyProvenance): void {
    const activeConfig = this.deps.settingsStore.getActiveConfig();
    if (!activeConfig) {
      return;
    }
    this.deps.apiKeyStore.saveProfileKey(activeConfig.id, apiKey, provenance);
    this.persistManagedMetadata({ apiKeySource: provenance });
  }

  /** Applies a partial managed-metadata patch to the active profile. */
  persistManagedMetadata(patch: SavedConfigManagedPatch): void {
    this.deps.settingsStore.updateActiveConfigManagedMetadata(patch);
  }

  /**
   * Reports the active key/signing posture without exposing credentials. The
   * rung order lives in `resolveConnectionSecurityStatus` (ISS-11426); the
   * signing key is loaded only when that decision reaches the managed-key rung.
   */
  getConnectionSecurityStatus(): ConnectionSecurityStatus {
    return resolveConnectionSecurityStatus(
      this.deps.apiKeyStore.getStatus(),
      () =>
        this.deps.gatewaySigningKeyStore.load(this.deps.getActiveGatewayId()).ok
    );
  }
}
