import type { AdminKeyVendor } from "../cost/admin-key-store.js";
import type { CostReconciliationService } from "../cost/cost-reconciliation-service.js";
import type { ApiKeyStore } from "../settings/api-key-store.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";
import { normalizeClosedloopApiKey } from "./profile-config-ipc.js";

export const ApiKeyIpcChannel = {
  GetApiKeyStatus: "desktop:get-api-key-status",
  SetApiKey: "desktop:set-api-key",
  ClearApiKey: "desktop:clear-api-key",
  GetAdminKeyStatuses: "desktop:get-admin-key-statuses",
  SetAdminKey: "desktop:set-admin-key",
  ClearAdminKey: "desktop:clear-admin-key",
} as const;

export type ApiKeyIpcChannel =
  (typeof ApiKeyIpcChannel)[keyof typeof ApiKeyIpcChannel];

type IpcMainLike = {
  handle: (
    channel: ApiKeyIpcChannel,
    listener: (event: unknown, payload?: unknown) => unknown
  ) => void;
};

type ApiKeyIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  apiKeyStore: ApiKeyStore;
  costReconciliation: CostReconciliationService;
  cancelManagedOnboardingForUserChange: (reason: string) => void;
  warmTelemetryOrgIdentity: () => void;
  restartCloudSocket: () => void;
  /**
   * Re-derive the existing-user sync-prompt resolution after the API key is set
   * or cleared (PRD-532 §8 / M6). The resolution depends on `hasApiKey`, so a
   * key mutation must recompute it — otherwise the prompt state goes stale.
   */
  onApiKeyChanged: () => void;
  /**
   * PRD-532 §5.5 (PR-K / M8): whether manual API-key entry is retired. In the
   * unified auth flow the relay key is auto-provisioned as a DESKTOP_MANAGED,
   * PoP-bound credential, so the paste path is disabled to avoid a redundant
   * (and weaker, unbound `USER_CREATED`) credential surface. Returns `false`
   * until a DESKTOP_MANAGED key is actually held, so a keyless install that has
   * not yet provisioned keeps the paste path as a fallback.
   */
  isManualApiKeyEntryDisabled: () => boolean;
};

/** Runtime-validate an IPC vendor argument to a known AdminKeyVendor. */
function parseAdminKeyVendor(value: unknown): AdminKeyVendor {
  if (value === "anthropic" || value === "openai") {
    return value;
  }
  throw new Error("Admin key vendor must be 'anthropic' or 'openai'");
}

/** Runtime-validate the {vendor, key} payload for desktop:set-admin-key. */
function parseSetAdminKeyPayload(value: unknown): {
  vendor: AdminKeyVendor;
  key: string;
} {
  if (typeof value !== "object" || value === null) {
    throw new Error("set-admin-key payload must be an object");
  }
  const record = value as Record<string, unknown>;
  const vendor = parseAdminKeyVendor(record.vendor);
  if (typeof record.key !== "string") {
    throw new Error("Admin key must be a string");
  }
  return { vendor, key: record.key };
}

export function registerApiKeyIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: ApiKeyIpcDeps
): void {
  ipcMainLike.handle(ApiKeyIpcChannel.GetApiKeyStatus, () =>
    deps.apiKeyStore.getStatus()
  );

  ipcMainLike.handle(ApiKeyIpcChannel.SetApiKey, (event, apiKey) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    // PRD-532 §5.5 (PR-K / M8): under the unified-auth flag the relay key is
    // auto-provisioned (DESKTOP_MANAGED, PoP-bound). Reject manual paste so it
    // cannot overwrite the managed key with an unbound USER_CREATED one. Fails
    // closed at the trusted main-process boundary — not just hidden in the UI.
    if (deps.isManualApiKeyEntryDisabled()) {
      throw new Error(
        "Manual API key entry is disabled; the desktop relay key is provisioned automatically."
      );
    }
    const trimmed = normalizeClosedloopApiKey(apiKey);
    deps.cancelManagedOnboardingForUserChange("a manual API key was set");
    deps.apiKeyStore.setApiKey(trimmed);
    deps.warmTelemetryOrgIdentity();
    deps.restartCloudSocket();
    deps.onApiKeyChanged();
    return deps.apiKeyStore.getStatus();
  });

  ipcMainLike.handle(ApiKeyIpcChannel.ClearApiKey, (event) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    deps.cancelManagedOnboardingForUserChange("the API key was cleared");
    deps.apiKeyStore.clearApiKey();
    deps.warmTelemetryOrgIdentity();
    deps.restartCloudSocket();
    deps.onApiKeyChanged();
    return deps.apiKeyStore.getStatus();
  });

  // FEA-1435/1436: vendor Admin key intake + cost reconciliation. These handlers
  // delegate to the main-only CostReconciliationService. Only existence-only
  // statuses, persisted drift rows, and key-free run summaries cross IPC — the
  // Admin key material itself never does. The vendor and query inputs are
  // runtime-validated here before use (IPC payloads are untrusted).
  ipcMainLike.handle(ApiKeyIpcChannel.GetAdminKeyStatuses, () =>
    deps.costReconciliation.getAdminKeyStatuses()
  );

  ipcMainLike.handle(ApiKeyIpcChannel.SetAdminKey, (event, payload) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    const { vendor, key } = parseSetAdminKeyPayload(payload);
    return deps.costReconciliation.setAdminKey(vendor, key);
  });

  ipcMainLike.handle(ApiKeyIpcChannel.ClearAdminKey, (event, vendor) => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    return deps.costReconciliation.clearAdminKey(parseAdminKeyVendor(vendor));
  });
}
