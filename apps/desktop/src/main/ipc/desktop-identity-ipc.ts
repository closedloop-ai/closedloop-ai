import { DesktopIdentityIpcChannel } from "../../shared/desktop-identity-channel.js";
import { GitHubIntegrationStatusIpcChannel } from "../../shared/github-integration-status-channel.js";
import { fetchDesktopIdentity } from "../auth/desktop-identity-client.js";
import { fetchGitHubIntegrationStatus } from "../github/github-integration-status-client.js";
import { isTrustedIpcSender } from "./ipc-trusted-sender.js";

/**
 * Account-scoped cloud reads exposed to the renderer: the signed-in desktop
 * identity and the connected GitHub integration status. Both resolve the access
 * token + API origin in the main process (never crossing them to the renderer)
 * and return `null` — rather than throwing — for an untrusted sender, matching
 * the renderer's optional-account contract.
 */
export const DesktopIdentityIpcChannels = {
  GetGitHubIntegrationStatus: GitHubIntegrationStatusIpcChannel.Get,
  GetDesktopIdentity: DesktopIdentityIpcChannel.Get,
} as const;

type IpcMainLike = {
  handle: (
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

type DesktopIdentityIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  getAccessToken: () => Promise<string | null>;
  getApiOrigin: () => string;
};

export function registerDesktopIdentityIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: DesktopIdentityIpcDeps
): void {
  ipcMainLike.handle(GitHubIntegrationStatusIpcChannel.Get, (event) => {
    if (!isTrustedIpcSender(deps.isTrustedSender, event)) {
      return null;
    }
    return fetchGitHubIntegrationStatus({
      getAccessToken: deps.getAccessToken,
      getApiOrigin: deps.getApiOrigin,
    });
  });

  ipcMainLike.handle(DesktopIdentityIpcChannel.Get, (event) => {
    if (!isTrustedIpcSender(deps.isTrustedSender, event)) {
      return null;
    }
    return fetchDesktopIdentity({
      getAccessToken: deps.getAccessToken,
      getApiOrigin: deps.getApiOrigin,
    });
  });
}
