import type { SaveConfigPayload } from "../shared/contracts.js";
import { ProfileConfigIpcChannel } from "./profile-config-ipc.js";

type IpcInvokeLike = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
};

export function createProfileConfigDesktopApi(ipcRendererLike: IpcInvokeLike) {
  return {
    saveConfig: (payload: string | SaveConfigPayload) =>
      ipcRendererLike.invoke(
        ProfileConfigIpcChannel.SaveConfig,
        typeof payload === "string" ? { name: payload } : payload
      ),
    findMatchingConfig: () =>
      ipcRendererLike.invoke(ProfileConfigIpcChannel.FindMatchingConfig),
    listConfigs: () =>
      ipcRendererLike.invoke(ProfileConfigIpcChannel.ListConfigs),
    deleteConfig: (id: string) =>
      ipcRendererLike.invoke(ProfileConfigIpcChannel.DeleteConfig, { id }),
    renameConfig: (id: string, name: string) =>
      ipcRendererLike.invoke(ProfileConfigIpcChannel.RenameConfig, {
        id,
        name,
      }),
    applyConfig: (id: string) =>
      ipcRendererLike.invoke(ProfileConfigIpcChannel.ApplyConfig, { id }),
  };
}
