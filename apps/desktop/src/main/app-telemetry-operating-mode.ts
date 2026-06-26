import type { ApiKeyStatus } from "./api-key-store.js";
import { DesktopAppOperatingMode } from "./app-otel-runtime-lifecycle.js";

export type AppTelemetryApiKeyStatusReader = {
  getStatus: () => Pick<ApiKeyStatus, "hasApiKey">;
};

export function getDesktopAppOperatingModeForTelemetry(
  apiKeyStore: AppTelemetryApiKeyStatusReader
): DesktopAppOperatingMode {
  if (apiKeyStore.getStatus().hasApiKey) {
    return DesktopAppOperatingMode.Multiplayer;
  }
  return DesktopAppOperatingMode.SinglePlayer;
}
