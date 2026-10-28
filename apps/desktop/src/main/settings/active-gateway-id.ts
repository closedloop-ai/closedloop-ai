import { DesktopAuthStatus } from "../../shared/contracts.js";
import type { SettingsStore } from "./settings-store.js";

/** Avoid recreating retired profile metadata during accountless local reads. */
export function resolveActiveGatewayId(
  settings: Pick<
    SettingsStore,
    "getActiveConfigId" | "getActiveConfig" | "ensureConfigGatewayId"
  >,
  authStatus: DesktopAuthStatus,
  hasStoredSession: boolean,
  legacyGatewayId: string
): string {
  const activeConfigId = settings.getActiveConfigId();
  if (!activeConfigId) {
    return legacyGatewayId;
  }
  if (
    authStatus === DesktopAuthStatus.SignedOut ||
    authStatus === DesktopAuthStatus.RefreshFailed ||
    (authStatus === DesktopAuthStatus.Loading && !hasStoredSession)
  ) {
    return settings.getActiveConfig()?.gatewayId ?? legacyGatewayId;
  }
  return (
    settings.ensureConfigGatewayId(activeConfigId).gatewayId ?? legacyGatewayId
  );
}
