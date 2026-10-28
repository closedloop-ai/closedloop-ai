/**
 * The main process's half of the browser-bridge host-token handoff (ISS-8412).
 *
 * The dev launcher used to append the host launch token to the
 * `--closedloop-renderer-url=` argument, which put a credential that mints an
 * authorized bridge host into world-readable process arguments — `ps -ef` is
 * enough on macOS and Linux, from any local user. It now arrives in the Electron
 * child's environment instead, and this module is where main takes it OUT of
 * that environment (so nothing it later spawns inherits it) and puts it on the
 * dev renderer URL it loads in-process.
 *
 * Nothing here weakens a bridge control: the broker still binds loopback-only,
 * still checks the socket origin, still admits exactly one host, and still
 * requires this exact token. Only the channel the token reaches Electron over
 * changed.
 */

import {
  desktopBrowserBridgeHostTokenEnvVar,
  desktopBrowserBridgeMinimumTokenLength,
  desktopBrowserBridgeTokenParam,
} from "../shared/desktop-browser-bridge-contract.mjs";
import {
  isLoopbackHttpUrl,
  resolveDevRendererUrl,
} from "./renderer-dev-url.js";

/**
 * Read the host launch token out of `env` and REMOVE it, whatever its shape.
 *
 * The deletion is unconditional and happens before the value is judged: a
 * malformed value is still a value a child would inherit, and this is the only
 * point that can stop it. Returns null unless what was there is a plausible
 * launch token, so a blank or truncated variable fails closed rather than
 * appending an unusable parameter to the renderer URL.
 */
export function takeBridgeHostTokenFromEnv(
  env: Record<string, string | undefined>
): string | null {
  const raw = env[desktopBrowserBridgeHostTokenEnvVar];
  Reflect.deleteProperty(env, desktopBrowserBridgeHostTokenEnvVar);
  if (
    typeof raw !== "string" ||
    raw.length < desktopBrowserBridgeMinimumTokenLength
  ) {
    return null;
  }
  return raw;
}

/**
 * Put the host launch token on a loopback dev renderer URL.
 *
 * A null URL or a null token yields the URL unchanged — a packaged build
 * resolves no dev URL at all, so the token can never reach a shipped renderer
 * even if the variable is set. The loopback check is re-asserted here rather
 * than assumed from the caller: this function is what decides a credential is
 * safe to attach, so it does not attach one to a URL it has not itself judged.
 */
export function appendBridgeHostToken(
  devRendererUrl: string | null,
  hostToken: string | null
): string | null {
  if (devRendererUrl === null || hostToken === null) {
    return devRendererUrl;
  }
  let url: URL;
  try {
    url = new URL(devRendererUrl);
  } catch {
    return devRendererUrl;
  }
  if (!isLoopbackHttpUrl(url)) {
    return devRendererUrl;
  }
  url.searchParams.set(desktopBrowserBridgeTokenParam, hostToken);
  return url.href;
}

/**
 * Take the token out of `process.env` once, as early in boot as the entrypoint
 * can manage, so no child of the main process ever inherits it. Idempotent: the
 * variable is gone after the first call and the resolved value is what every
 * later renderer load reads.
 */
export function consumeBrowserBridgeHostToken(): void {
  if (!consumed) {
    consumed = true;
    hostToken = takeBridgeHostTokenFromEnv(process.env);
  }
}

/**
 * The dev renderer URL to load, carrying the bridge host token when this launch
 * was handed one. Stable across calls — the recovery reload and the renderer
 * health reporter's recovered-URL comparison both have to see the same string
 * the initial load used.
 */
export function resolveDevRendererUrlWithBridgeToken(
  argv: readonly string[],
  options: { isPackaged: boolean }
): string | null {
  consumeBrowserBridgeHostToken();
  return appendBridgeHostToken(resolveDevRendererUrl(argv, options), hostToken);
}

let consumed = false;
let hostToken: string | null = null;
