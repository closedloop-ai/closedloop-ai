import { isAllowedDesktopVerificationUrl } from "./external-url-allowlist.js";

export const GitHubConnectIpcChannel = {
  Open: "desktop:open-github-connect",
} as const;
export type GitHubConnectIpcChannel =
  (typeof GitHubConnectIpcChannel)[keyof typeof GitHubConnectIpcChannel];

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
};

export type GitHubConnectOpenerDeps = {
  isTrustedSender: (sender: unknown) => boolean;
  getWebAppOrigin: () => string;
  openExternal: (url: string) => Promise<unknown>;
};

type IpcMainLike = {
  handle: (
    channel: GitHubConnectIpcChannel,
    listener: (event: unknown, request?: GitHubConnectOpenRequest) => unknown
  ) => void;
};

const BRANCH_DETAIL_RETURN_PATH_PATTERN = /^\/branches\/[^/]+$/;
const INSIGHTS_RETURN_PATH = "/insights";

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
    return { ok: true, url };
  } catch {
    return { ok: false, reason: GitHubConnectOpenFailureReason.OpenFailed };
  }
}

function buildGitHubConnectUrl(
  webAppOrigin: string,
  request: GitHubConnectOpenRequest | undefined
): string {
  const url = new URL("/api/integrations/github", webAppOrigin);
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
    return "/branches";
  }
  try {
    const parsed = new URL(requestedReturnTo, "https://return.invalid");
    if (parsed.origin !== "https://return.invalid") {
      return "/branches";
    }
    if (parsed.search || parsed.hash) {
      return "/branches";
    }
    if (parsed.pathname === "/branches") {
      return parsed.pathname;
    }
    if (parsed.pathname === INSIGHTS_RETURN_PATH) {
      return parsed.pathname;
    }
    if (BRANCH_DETAIL_RETURN_PATH_PATTERN.test(parsed.pathname)) {
      return parsed.pathname;
    }
    return "/branches";
  } catch {
    return "/branches";
  }
}
