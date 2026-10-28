import { resolveGitHubDataConnected } from "@repo/api/src/types/github-data-connected";
import { DesktopFeatureFlagsIpcChannel } from "../../shared/desktop-feature-flags-channel.js";
import { DesktopIdentityIpcChannel } from "../../shared/desktop-identity-channel.js";
import { GitHubIntegrationStatusIpcChannel } from "../../shared/github-integration-status-channel.js";
import {
  fetchAnonymousDesktopFeatureFlags,
  fetchDesktopFeatureFlags,
} from "../auth/desktop-feature-flags-client.js";
import { fetchDesktopIdentity } from "../auth/desktop-identity-client.js";
import type { GitHubConnectReturnWatchDeps } from "../github/github-connect-return-watch.js";
import { fetchGitHubIntegrationStatus } from "../github/github-integration-status-client.js";
import {
  type DesktopAccountAdmission,
  isSameDesktopAccountAdmission,
} from "../session/desktop-account-admission.js";
import { isTrustedIpcSender } from "./ipc-trusted-sender.js";

/**
 * Account-scoped cloud reads exposed to the renderer: the signed-in desktop
 * identity, the connected GitHub integration status, and (ISS-8024) the user's
 * PostHog feature-flag assignment, which a signed-out install reads in its
 * anonymous mode (ISS-11945). All resolve the access token + API origin in
 * the main process (never crossing them to the renderer) and return `null` —
 * rather than throwing — for an untrusted sender, matching the renderer's
 * optional-account contract.
 */
export const DesktopIdentityIpcChannels = {
  GetGitHubIntegrationStatus: GitHubIntegrationStatusIpcChannel.Get,
  GetDesktopIdentity: DesktopIdentityIpcChannel.Get,
  GetDesktopFeatureFlags: DesktopFeatureFlagsIpcChannel.Get,
} as const;

type IpcMainLike = {
  handle: (
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

export type DesktopIdentityIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  getAccessToken: () => Promise<string | null>;
  getApiOrigin: () => string;
  getAccountAdmission?: () => DesktopAccountAdmission | null;
};

export function registerDesktopIdentityIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: DesktopIdentityIpcDeps
): void {
  ipcMainLike.handle(GitHubIntegrationStatusIpcChannel.Get, (event) => {
    if (!isTrustedIpcSender(deps.isTrustedSender, event)) {
      return null;
    }
    return accountScopedRead(deps, fetchGitHubIntegrationStatus);
  });

  ipcMainLike.handle(DesktopIdentityIpcChannel.Get, (event) => {
    if (!isTrustedIpcSender(deps.isTrustedSender, event)) {
      return null;
    }
    return accountScopedRead(deps, fetchDesktopIdentity);
  });

  ipcMainLike.handle(DesktopFeatureFlagsIpcChannel.Get, (event) => {
    if (!isTrustedIpcSender(deps.isTrustedSender, event)) {
      return null;
    }
    // ISS-11945: no admitted account takes the node_uuid-keyed anonymous mode.
    if (deps.getAccountAdmission?.() === null) {
      return fetchAnonymousDesktopFeatureFlags();
    }
    return accountScopedRead(deps, fetchDesktopFeatureFlags);
  });
}

async function accountScopedRead<T>(
  deps: DesktopIdentityIpcDeps,
  read: (options: {
    getAccessToken: () => Promise<string | null>;
    getApiOrigin: () => string;
  }) => Promise<T | null>
): Promise<T | null> {
  const captured = deps.getAccountAdmission?.() ?? null;
  if (!isIdentityAdmissionCurrent(deps, captured)) {
    return null;
  }
  const result = await read({
    getAccessToken: async () => {
      const token = await deps.getAccessToken();
      return isIdentityAdmissionCurrent(deps, captured) ? token : null;
    },
    getApiOrigin: deps.getApiOrigin,
  });
  return isIdentityAdmissionCurrent(deps, captured) ? result : null;
}

function isIdentityAdmissionCurrent(
  deps: DesktopIdentityIpcDeps,
  captured: DesktopAccountAdmission | null
): boolean {
  return (
    !deps.getAccountAdmission ||
    isSameDesktopAccountAdmission(captured, deps.getAccountAdmission())
  );
}

/**
 * The account-scoped reads the GitHub connect return watch makes: the same
 * status read the renderer's IPC answers, folded to the one connection
 * predicate, and a check that the account that opened the connect is still the
 * one signed in.
 */
export function accountGitHubConnectionReads(
  deps: DesktopIdentityIpcDeps
): Pick<GitHubConnectReturnWatchDeps, "captureAccount" | "readConnected"> {
  return {
    readConnected: async () =>
      resolveGitHubDataConnected(
        await accountScopedRead(deps, fetchGitHubIntegrationStatus).catch(
          () => null
        )
      ),
    captureAccount: () => {
      const captured = deps.getAccountAdmission?.() ?? null;
      return () => isIdentityAdmissionCurrent(deps, captured);
    },
  };
}
