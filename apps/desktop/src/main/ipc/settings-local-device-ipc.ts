import type { SettingsLocalDeviceSnapshot } from "@repo/api/src/types/settings-host-capabilities";
import { SETTINGS_LOCAL_DEVICE_CHANNEL } from "../../shared/settings-local-device-contract.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

/**
 * ISS-8379 (PRD-691) — the Settings local-device read.
 *
 * Producer for {@link SETTINGS_LOCAL_DEVICE_CHANNEL}. It reports only facts main
 * already holds; it performs no local operation and reaches no cloud record.
 * Anything about the cloud `ComputeTarget` row beyond its id stays behind the
 * authorized cloud API, so this channel cannot become a way for the renderer to
 * read device state it is not authorized for.
 *
 * Registrar is electron-free (every fact is injected) so it loads under
 * `test:node` and its sender gate can be driven directly.
 */

type IpcMainLike = {
  handle: (
    channel: typeof SETTINGS_LOCAL_DEVICE_CHANNEL,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

// Exported so the sender-gate and omission tests can construct the deps and
// drive the real handler.
export type SettingsLocalDeviceIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  getMachineName: () => string;
  getPlatform: () => string;
  getAppVersion: () => string;
  getActivePort: () => number;
  isServerAlive: () => boolean;
  /** The cloud compute-target row this desktop is currently online as. */
  getComputeTargetId: () => string | null;
};

/**
 * An absent identity is OMITTED, never `null`. An installed renderer that
 * predates a field must see the same shape it was built against, and `null`
 * would read as a present-but-empty identity rather than "not known yet".
 */
export function buildSettingsLocalDeviceSnapshot(
  deps: SettingsLocalDeviceIpcDeps
): SettingsLocalDeviceSnapshot {
  const computeTargetId = deps.getComputeTargetId();
  return {
    machineName: deps.getMachineName(),
    platform: deps.getPlatform(),
    appVersion: deps.getAppVersion(),
    gatewayPort: deps.getActivePort(),
    gatewayReachable: deps.isServerAlive(),
    ...(computeTargetId ? { computeTargetId } : {}),
  };
}

export function registerSettingsLocalDeviceIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: SettingsLocalDeviceIpcDeps
): void {
  ipcMainLike.handle(SETTINGS_LOCAL_DEVICE_CHANNEL, (event) => {
    // The payload names this machine and the cloud row it maps to — restrict it
    // to the trusted renderer, like every other identity-bearing read.
    assertTrustedIpcSender(deps.isTrustedSender, event);
    return buildSettingsLocalDeviceSnapshot(deps);
  });
}
