import { SETTINGS_LOCAL_DEVICE_CHANNEL } from "../shared/settings-local-device-contract.js";

type IpcInvokeLike = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
};

/**
 * ISS-8379 (PRD-691) — the Settings local-device namespace, assembled here
 * rather than inline so `preload-common.ts` gains one spread instead of a
 * method body (same shape as `createProfileConfigDesktopApi`).
 *
 * Resolves `unknown` on purpose. The renderer adapter validates the payload
 * against `settingsLocalDeviceSnapshotSchema`; a preload that pre-typed it would
 * hand the renderer a shape nothing had checked.
 */
export function createSettingsLocalDeviceDesktopApi(
  ipcRendererLike: IpcInvokeLike
) {
  return {
    getSettingsLocalDevice: () =>
      ipcRendererLike.invoke(SETTINGS_LOCAL_DEVICE_CHANNEL),
  };
}
