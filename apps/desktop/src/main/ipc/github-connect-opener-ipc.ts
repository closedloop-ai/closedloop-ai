import {
  GITHUB_CLERK_LINK_PATH,
  GitHubConnectReturnSegment,
} from "@repo/api/src/types/github-clerk-link";
import { GitHubConnectIpcChannel } from "../../shared/github-connect-opener-ipc-channel.js";
import type { GitHubConnectReturnWatch } from "../github/github-connect-return-watch.js";
import { isAllowedDesktopVerificationUrl } from "../settings/external-url-allowlist.js";

export const GitHubConnectOpenFailureReason = {
  UntrustedSender: "untrusted_sender",
  InvalidOrigin: "invalid_origin",
  OpenFailed: "open_failed",
} as const;
export type GitHubConnectOpenFailureReason =
  (typeof GitHubConnectOpenFailureReason)[keyof typeof GitHubConnectOpenFailureReason];

export type GitHubConnectOpenResult =
  | { ok: true; url: string }
  | { ok: false; reason: GitHubConnectOpenFailureReason };

export type GitHubConnectOpenRequest = {
  install?: boolean;
  returnTo?: string;
  /**
   * Bring Desktop back to the front once the connect lands. Additive: a
   * renderer that predates it never asks, and a main process that predates it
   * ignores it, so either side of a skew opens the browser exactly as before.
   */
  returnToDesktop?: boolean;
};

export type GitHubConnectOpenerDeps = {
  isTrustedSender: (sender: unknown) => boolean;
  getWebAppOrigin: () => string;
  openExternal: (url: string) => Promise<unknown>;
  /** Absent in hosts that cannot read the connection; no watch then. */
  returnWatch?: GitHubConnectReturnWatch;
};

type IpcMainLike = {
  handle: (
    channel: GitHubConnectIpcChannel,
    listener: (event: unknown, request?: GitHubConnectOpenRequest) => unknown
  ) => void;
};

const BRANCH_DETAIL_RETURN_PATH_PATTERN = /^\/branches\/[^/]+$/;
const DEFAULT_RETURN_PATH = "/branches";
/**
 * The exact post-connect destinations the desktop may hand the web app, derived
 * from the one cross-process list so this side and the web app's own validator
 * cannot drift (ISS-5958). Still an allowlist, never a passthrough: this value
 * becomes a navigation target in the user's browser after an OAuth round trip.
 */
const EXACT_RETURN_PATHS: ReadonlySet<string> = new Set(
  Object.values(GitHubConnectReturnSegment).map((segment) => `/${segment}`)
);

/** Register the desktop GitHub App connect opener IPC handler. */
export function registerGitHubConnectOpenerIpcHandlers(
  ipcMain: IpcMainLike,
  deps: GitHubConnectOpenerDeps
): void {
  ipcMain.handle(GitHubConnectIpcChannel.Open, (event, request) => {
    const sender =
      event && typeof event === "object"
        ? (event as { sender?: unknown }).sender
        : undefined;
    if (!deps.isTrustedSender(sender)) {
      return {
        ok: false,
        reason: GitHubConnectOpenFailureReason.UntrustedSender,
      };
    }
    return openGitHubConnectUrl(deps, request);
  });
}

async function openGitHubConnectUrl(
  deps: GitHubConnectOpenerDeps,
  request: GitHubConnectOpenRequest | undefined
): Promise<GitHubConnectOpenResult> {
  const webAppOrigin = deps.getWebAppOrigin();
  const url = buildGitHubConnectUrl(webAppOrigin, request);
  if (!isAllowedDesktopVerificationUrl(url, webAppOrigin)) {
    return { ok: false, reason: GitHubConnectOpenFailureReason.InvalidOrigin };
  }
  try {
    await deps.openExternal(url);
    if (request?.returnToDesktop === true) {
      deps.returnWatch?.start();
    }
    return { ok: true, url };
  } catch {
    return { ok: false, reason: GitHubConnectOpenFailureReason.OpenFailed };
  }
}

function buildGitHubConnectUrl(
  webAppOrigin: string,
  request: GitHubConnectOpenRequest | undefined
): string {
  // PLN-1742 M5: authorize opens land on the web Clerk linking page,
  // unconditionally (the `github-clerk-credentials` Labs toggle was retired
  // with the in-house authorize flow). Install-mode opens stay on the app
  // route — the App-install entry point survives the OAuth-client retirement.
  const url = new URL(
    request?.install === true
      ? "/api/integrations/github"
      : GITHUB_CLERK_LINK_PATH,
    webAppOrigin
  );
  url.searchParams.set(
    "returnTo",
    resolveGitHubConnectReturnTo(request?.returnTo)
  );
  if (request?.install === true) {
    url.searchParams.set("install", "true");
  }
  return url.toString();
}

function resolveGitHubConnectReturnTo(
  requestedReturnTo: string | undefined
): string {
  if (!requestedReturnTo) {
    return DEFAULT_RETURN_PATH;
  }
  try {
    const parsed = new URL(requestedReturnTo, "https://return.invalid");
    if (parsed.origin !== "https://return.invalid") {
      return DEFAULT_RETURN_PATH;
    }
    if (parsed.search || parsed.hash) {
      return DEFAULT_RETURN_PATH;
    }
    if (EXACT_RETURN_PATHS.has(parsed.pathname)) {
      return parsed.pathname;
    }
    if (BRANCH_DETAIL_RETURN_PATH_PATTERN.test(parsed.pathname)) {
      return parsed.pathname;
    }
    return DEFAULT_RETURN_PATH;
  } catch {
    return DEFAULT_RETURN_PATH;
  }
}
