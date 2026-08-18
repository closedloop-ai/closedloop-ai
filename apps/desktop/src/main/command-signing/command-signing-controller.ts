import type {
  DesktopPopHeaders,
  DesktopPopSigningRequest,
} from "../auth/desktop-pop.js";
import type { CommandSigningKeysState } from "../ipc/command-signing-keys-ipc.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import type { ApiKeyStore } from "../settings/api-key-store.js";
import type { SettingsStore } from "../settings/settings-store.js";
import type { DesktopWindow } from "../window.js";
import type { AuthorizedCommandKeyStore } from "./authorized-command-key-store.js";
import {
  fetchOrganizationCommandKeys,
  type OrganizationCommandPublicKey,
} from "./authorized-public-keys-client.js";
import type { BrowserCommandKeyAppLifecycle } from "./command-key-app-lifecycle.js";
import type {
  ActiveCommandKeyTargetContext,
  CommandKeyReconciliationReason,
} from "./command-key-target-context.js";
import type { PendingCommandKeyNotifier } from "./pending-command-key-notifier.js";

/**
 * Collaborators and application callbacks the command-signing-key controller
 * needs. Passed as an explicit bag (rather than the `DesktopApplication`
 * instance) so the controller is unit-testable and the coupling is visible.
 */
export type CommandSigningControllerDeps = {
  authorizedCommandKeys: AuthorizedCommandKeyStore;
  commandKeyLifecycle: BrowserCommandKeyAppLifecycle;
  pendingCommandKeyNotifier: PendingCommandKeyNotifier;
  apiKeyStore: ApiKeyStore;
  settingsStore: SettingsStore;
  desktopWindow: DesktopWindow;
  /** Whether the connected gateway server advertised command-signing support. */
  isServerCommandSigningSupported: () => boolean;
  /** PoP-sign an outbound desktop request (owned by the application). */
  signDesktopRequest: (
    request: DesktopPopSigningRequest
  ) => DesktopPopHeaders | null;
  /** Report a PoP-unavailable condition for telemetry (owned by the app). */
  reportDesktopPopUnavailable: (surface: string, reason: string) => void;
};

/**
 * Owns browser-command-signing key management: listing available/authorized
 * keys, approving/rejecting organization keys, and raising the pending-key
 * notifications. Extracted from `DesktopApplication` (PLN-1359 Phase 3);
 * behavior — including every renderer IPC channel string — is unchanged.
 */
export class CommandSigningController {
  private readonly deps: CommandSigningControllerDeps;

  constructor(deps: CommandSigningControllerDeps) {
    this.deps = deps;
  }

  openBrowserCommandKeysSettings(): void {
    this.deps.desktopWindow.show();
    this.deps.desktopWindow.sendToRenderer("desktop:navigate-tab", "settings");
    this.deps.desktopWindow.sendToRenderer(
      "desktop:navigate-settings-tab",
      "security"
    );
  }

  notifyCommandKeysChanged(): void {
    this.deps.desktopWindow.sendToRenderer("desktop:command-keys-changed");
  }

  private async fetchAvailableCommandSigningKeys(options?: {
    requireApiKey?: boolean;
    targetContext?: ActiveCommandKeyTargetContext;
  }): Promise<OrganizationCommandPublicKey[]> {
    const apiKey = this.deps.apiKeyStore.getApiKey();
    if (!apiKey) {
      if (options?.requireApiKey) {
        throw new Error("missing API key");
      }
      return [];
    }
    return await fetchOrganizationCommandKeys({
      apiOrigin: this.deps.settingsStore.getApiOrigin(),
      apiKey,
      apiKeyProvenance:
        this.deps.apiKeyStore.getApiKeyProvenance() ?? "USER_CREATED",
      signDesktopRequest: (request) => this.deps.signDesktopRequest(request),
      onDesktopPopUnavailable: (surface, reason) =>
        this.deps.reportDesktopPopUnavailable(surface, reason),
      computeTargetId: options?.targetContext?.computeTargetId,
      gatewayId: options?.targetContext?.gatewayId,
    });
  }

  async fetchOrganizationCommandKeyClassification(
    reason: CommandKeyReconciliationReason
  ) {
    return await this.deps.commandKeyLifecycle.fetchOrganizationKeyClassification(
      {
        reason,
        fetchAvailableCommandSigningKeys: (options) =>
          this.fetchAvailableCommandSigningKeys(options),
      }
    );
  }

  async listCommandSigningKeys(): Promise<CommandSigningKeysState> {
    if (!this.deps.isServerCommandSigningSupported()) {
      gatewayLog.info(
        "command-signing",
        "List browser command keys skipped; server support is disabled"
      );
      return {
        available: [],
        authorized: [],
        rejectedFingerprints: [],
        serverSupported: false,
        enforcementEnabled:
          this.deps.settingsStore.getCommandSigningEnforcementEnabled(),
      };
    }

    const authorizedFingerprints = new Set(
      this.deps.authorizedCommandKeys.list().map((key) => key.fingerprint)
    );
    const rejectedFingerprints = new Set(
      this.deps.authorizedCommandKeys.listRejectedFingerprints()
    );
    let available: OrganizationCommandPublicKey[] = [];
    let availableError: string | undefined;
    try {
      const classification =
        await this.fetchOrganizationCommandKeyClassification("manual");
      available = classification.notificationKeys;
    } catch (error) {
      availableError =
        error instanceof Error ? error.message : "Failed to list public keys";
    }
    return {
      available: available.filter(
        (key) =>
          !(
            authorizedFingerprints.has(key.fingerprint) ||
            rejectedFingerprints.has(key.fingerprint)
          )
      ),
      authorized: this.deps.authorizedCommandKeys.list(),
      rejectedFingerprints: [...rejectedFingerprints],
      serverSupported: this.deps.isServerCommandSigningSupported(),
      enforcementEnabled:
        this.deps.settingsStore.getCommandSigningEnforcementEnabled(),
      ...(availableError ? { availableError } : {}),
    };
  }

  async getPendingCommandSigningKeysForNotification(): Promise<
    OrganizationCommandPublicKey[]
  > {
    if (!this.deps.apiKeyStore.getApiKey()) {
      return [];
    }
    const state = await this.listCommandSigningKeys();
    if (state.availableError) {
      return [];
    }
    return state.available;
  }

  private getPendingCommandSigningKeysFromOrganizationKeys(
    organizationKeys: OrganizationCommandPublicKey[]
  ): OrganizationCommandPublicKey[] {
    const authorizedFingerprints = new Set(
      this.deps.authorizedCommandKeys.list().map((key) => key.fingerprint)
    );
    const rejectedFingerprints = new Set(
      this.deps.authorizedCommandKeys.listRejectedFingerprints()
    );
    return organizationKeys.filter(
      (key) =>
        !(
          authorizedFingerprints.has(key.fingerprint) ||
          rejectedFingerprints.has(key.fingerprint)
        )
    );
  }

  async notifyPendingCommandSigningKeysForOrganizationKeys(
    organizationKeys: OrganizationCommandPublicKey[]
  ): Promise<void> {
    await this.deps.pendingCommandKeyNotifier.notifyPendingKeys(
      this.getPendingCommandSigningKeysFromOrganizationKeys(organizationKeys)
    );
  }

  async notifyPendingCommandSigningKeyByFingerprint(
    fingerprint: string
  ): Promise<void> {
    await this.deps.pendingCommandKeyNotifier.notifyPendingKeys([
      {
        fingerprint,
        ownerName: "A browser session",
      },
    ]);
  }

  async approveOrganizationCommandPublicKey(
    fingerprint: unknown
  ): Promise<CommandSigningKeysState> {
    const trimmedFingerprint =
      typeof fingerprint === "string" ? fingerprint.trim() : "";
    if (!trimmedFingerprint) {
      throw new Error("fingerprint is required");
    }
    const activeContext =
      this.deps.commandKeyLifecycle.getActiveTargetContext();
    const keys = await this.fetchAvailableCommandSigningKeys({
      targetContext: activeContext,
    });
    const key =
      this.deps.commandKeyLifecycle.selectOrganizationCommandKeyForManualApproval(
        {
          keys,
          fingerprint: trimmedFingerprint,
        }
      );
    if (!key) {
      throw new Error("Command signing key not found");
    }
    this.deps.authorizedCommandKeys.authorize({
      fingerprint: key.fingerprint,
      publicKeyBase64: key.publicKeyBase64,
      ownerName: key.ownerEmail || key.ownerName || key.fingerprint,
      ...(key.ownerEmail ? { ownerEmail: key.ownerEmail } : {}),
      source: "org",
      ...(key.id ? { sourceUserPublicKeyId: key.id } : {}),
    });
    this.deps.commandKeyLifecycle.consumeLegacyContextlessApproval(
      key.fingerprint
    );
    this.deps.pendingCommandKeyNotifier.dismiss(key.fingerprint);
    const state = await this.listCommandSigningKeys();
    this.notifyCommandKeysChanged();
    return state;
  }

  async rejectOrganizationCommandPublicKey(
    fingerprint: unknown
  ): Promise<CommandSigningKeysState> {
    const trimmedFingerprint =
      typeof fingerprint === "string" ? fingerprint.trim() : "";
    if (!trimmedFingerprint) {
      throw new Error("fingerprint is required");
    }
    this.deps.authorizedCommandKeys.reject(trimmedFingerprint);
    this.deps.commandKeyLifecycle.consumeLegacyContextlessApproval(
      trimmedFingerprint
    );
    this.deps.pendingCommandKeyNotifier.dismiss(trimmedFingerprint);
    const state = await this.listCommandSigningKeys();
    this.notifyCommandKeysChanged();
    return state;
  }
}
