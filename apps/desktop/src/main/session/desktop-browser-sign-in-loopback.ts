import {
  DESKTOP_EMAIL_CALLBACK_TIMEOUT_MS,
  DESKTOP_OAUTH_CALLBACK_TIMEOUT_MS,
  type DesktopSignInFraming,
  DesktopSignInMethod,
} from "@repo/api/src/types/desktop-authorize-url";
import {
  buildDesktopAuthorizeUrl,
  redeemDesktopAuthorizationCode,
} from "../auth/desktop-authorize-client.js";
import {
  type DesktopPkce,
  generateDesktopPkce,
  generateOAuthState,
} from "../auth/desktop-authorize-pkce.js";
import { redeemDesktopBootstrap } from "../auth/desktop-bootstrap-client.js";
import { fetchDesktopIdentity } from "../auth/desktop-identity-client.js";
import {
  type DesktopLoopbackListener,
  startDesktopLoopbackListener,
} from "../auth/desktop-loopback-listener.js";
import type {
  DesktopBrowserSignInDeps,
  DesktopDeviceDescriptor,
  DesktopSessionManagerDeps,
  ResolvedBrowserSignInDeps,
} from "./desktop-session-manager-types.js";
import { defaultDesktopSessionTimeout } from "./desktop-session-timeout.js";

/**
 * The loopback leg of `DesktopSessionManager.beginBrowserSignIn`: building
 * the authorize URL behind a started `127.0.0.1` listener, and racing that
 * listener's callback against the timeout and the run's cancellation. Split out
 * of the manager, which keeps the auth state machine; nothing here reads or
 * writes auth state.
 */

type PrepareDeps = Required<
  Pick<
    DesktopBrowserSignInDeps,
    | "resolveDeviceDescriptor"
    | "resolveWebAppOrigin"
    | "generatePkce"
    | "generateState"
    | "startLoopbackListener"
    | "logDiagnostic"
  >
>;

/**
 * Resolve the device descriptor + web-app origin, generate PKCE + `state`,
 * start the loopback listener, and build the authorize URL. Returns null (and
 * closes any started listener) if any step throws, so the caller settles as
 * `start_failed` without opening the browser.
 */
export async function prepareBrowserSignIn(
  deps: PrepareDeps,
  method?: DesktopSignInMethod,
  emailHint?: string,
  framing?: DesktopSignInFraming
): Promise<{
  listener: DesktopLoopbackListener;
  authorizeUrl: string;
  pkce: DesktopPkce;
  state: string;
  descriptor: DesktopDeviceDescriptor;
} | null> {
  let listener: DesktopLoopbackListener | null = null;
  try {
    const descriptor = deps.resolveDeviceDescriptor();
    const webAppOrigin = deps.resolveWebAppOrigin();
    const pkce = deps.generatePkce();
    const state = deps.generateState();
    listener = await deps.startLoopbackListener();
    const authorizeUrl = buildDesktopAuthorizeUrl({
      webAppOrigin,
      codeChallenge: pkce.codeChallenge,
      codeChallengeMethod: pkce.codeChallengeMethod,
      state,
      redirectUri: listener.redirectUri,
      gatewayId: descriptor.gatewayId,
      gatewayPublicKeyPem: descriptor.gatewayPublicKeyPem,
      deviceName: descriptor.machineName,
      platform: descriptor.platform,
      method,
      // ISS-5954 M5: the typed address prefills the email form and nothing
      // else — it goes on the URL (hence browser history) only for the one
      // method that renders that form. The door framing rides the same
      // branch: only the email landing page reads it.
      emailHint: method === DesktopSignInMethod.Email ? emailHint : undefined,
      framing: method === DesktopSignInMethod.Email ? framing : undefined,
    });
    return { listener, authorizeUrl, pkce, state, descriptor };
  } catch (error) {
    if (listener) {
      await listener.close().catch(() => undefined);
    }
    // The `start_failed` reason is all the UI surfaces; capture the real cause
    // (signing-key/keychain, web-app origin, or loopback bind) to diagnostics
    // so a failure that never opens the browser is debuggable.
    deps.logDiagnostic(
      `Browser sign-in failed to start: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

/**
 * Await the loopback callback, racing it against the callback timeout and the
 * run's cancellation signal (fired by the manager's cancel / sign-out).
 */
export async function awaitLoopbackCallback(
  deps: Required<Pick<DesktopBrowserSignInDeps, "delayMs">>,
  runSignal: AbortSignal,
  listener: DesktopLoopbackListener,
  callbackTimeoutMs: number
): Promise<
  | {
      kind: "received";
      code: string | null;
      state: string | null;
      error: string | null;
      accountCreated: boolean;
      desktopBootstrap: boolean;
    }
  | { kind: "timeout" }
  | { kind: "cancelled" }
> {
  if (runSignal.aborted) {
    return { kind: "cancelled" };
  }
  // A race-local controller tears down whichever side loses: aborting it
  // clears the callback-timeout timer once the redirect arrives, and settles
  // the loopback wait once the timeout fires. It also chains off the run's own
  // cancellation signal so cancel / sign-out unblocks both sides at once.
  const raceAbort = new AbortController();
  const onRunAbort = () => raceAbort.abort();
  runSignal.addEventListener("abort", onRunAbort, { once: true });
  try {
    const timeout = deps
      .delayMs(callbackTimeoutMs, raceAbort.signal)
      .then(() => "timeout" as const);
    const callback = listener
      .waitForCallback(raceAbort.signal)
      .then((value) => value ?? ("aborted" as const));
    const outcome = await Promise.race([callback, timeout]);
    if (outcome === "timeout") {
      return { kind: "timeout" };
    }
    if (outcome === "aborted") {
      return { kind: "cancelled" };
    }
    return {
      kind: "received",
      code: outcome.code,
      state: outcome.state,
      error: outcome.error,
      accountCreated: outcome.accountCreated,
      desktopBootstrap: outcome.desktopBootstrap ?? false,
    };
  } finally {
    // Tear down the losing side of the race (timer or loopback wait) whatever
    // the outcome, then detach the run-signal bridge.
    raceAbort.abort();
    runSignal.removeEventListener("abort", onRunAbort);
  }
}

export function resolveBrowserSignInDeps(
  deps: DesktopSessionManagerDeps
): ResolvedBrowserSignInDeps | undefined {
  if (!deps.browserSignIn) {
    return undefined;
  }
  return {
    ...deps.browserSignIn,
    startLoopbackListener:
      deps.browserSignIn.startLoopbackListener ??
      (() => startDesktopLoopbackListener()),
    generatePkce:
      deps.browserSignIn.generatePkce ?? (() => generateDesktopPkce()),
    generateState:
      deps.browserSignIn.generateState ?? (() => generateOAuthState()),
    redeem: deps.browserSignIn.redeem ?? redeemDesktopAuthorizationCode,
    redeemBootstrap:
      deps.browserSignIn.redeemBootstrap ?? redeemDesktopBootstrap,
    fetchAccount:
      deps.browserSignIn.fetchAccount ??
      ((accessToken) =>
        fetchDesktopIdentity({
          fetch: deps.fetchImpl,
          getAccessToken: () => Promise.resolve(accessToken),
          getApiOrigin: () => deps.resolveApiOrigin(),
        })),
    callbackTimeoutMs:
      deps.browserSignIn.callbackTimeoutMs ?? DESKTOP_OAUTH_CALLBACK_TIMEOUT_MS,
    emailCallbackTimeoutMs:
      deps.browserSignIn.emailCallbackTimeoutMs ??
      DESKTOP_EMAIL_CALLBACK_TIMEOUT_MS,
    delayMs: deps.browserSignIn.delayMs ?? defaultDesktopSessionTimeout,
    logDiagnostic:
      deps.browserSignIn.logDiagnostic ??
      deps.logDiagnostic ??
      (() => undefined),
  };
}
