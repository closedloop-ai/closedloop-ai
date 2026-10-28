import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import type { RedeemDesktopAuthorizationCodeFn } from "../auth/desktop-authorize-client.js";
import type { DesktopPkce } from "../auth/desktop-authorize-pkce.js";
import type { redeemDesktopBootstrap } from "../auth/desktop-bootstrap-client.js";
import type { DesktopLoopbackListener } from "../auth/desktop-loopback-listener.js";
import type { DesktopPopSigner } from "../auth/desktop-pop.js";
import type { DesktopAuthFailureEventInput } from "../cloud/auth-failure-telemetry.js";
import type {
  refreshDesktopSession,
  revokeDesktopSession,
} from "./desktop-session-client.js";
import type { DesktopSessionManager } from "./desktop-session-manager.js";
import type { DesktopSessionStore } from "./desktop-session-store.js";
import type { DesktopSignInAnalytics } from "./desktop-sign-in-analytics.js";

export type DesktopSessionClientFns = {
  refresh: typeof refreshDesktopSession;
  revoke: typeof revokeDesktopSession;
};

/** Device descriptor sent on the authorize URL + used to bind the redeemed session. */
export type DesktopDeviceDescriptor = {
  gatewayId: string;
  /** Ed25519 SPKI PEM the backend binds the eventual credentials to. */
  gatewayPublicKeyPem: string;
  machineName: string;
  platform: string;
  desktopVersion: string;
};

/** Ports the loopback browser sign-in flow needs; omit to disable {@link DesktopSessionManager.beginBrowserSignIn}. */
export type DesktopBrowserSignInDeps = {
  /** Web-app origin whose authorize page the system browser opens. */
  resolveWebAppOrigin: () => string;
  /** Current device descriptor (gateway id + public key + machine info). */
  resolveDeviceDescriptor: () => DesktopDeviceDescriptor;
  /** Opens the (self-built, on-`webAppOrigin`) authorize URL in the system browser. */
  openExternal: (url: string) => Promise<void>;
  /**
   * Diagnostic sink for a sign-in that fails to start. Receives a key-free,
   * human-readable message (never a token, PKCE verifier, or `state`) naming the
   * underlying cause — the `start_failed` UI copy is deliberately generic, so
   * this is the only place the real reason (e.g. `safe_storage_unavailable`, an
   * invalid web-app origin, a loopback bind error) surfaces. Wired to the
   * gateway log in production; defaults to a no-op.
   */
  logDiagnostic?: (message: string) => void;
  /** Test seam — starts the 127.0.0.1 loopback listener; defaults to the real one. */
  startLoopbackListener?: () => Promise<DesktopLoopbackListener>;
  /** Test seam — generates the PKCE verifier/challenge; defaults to the real one. */
  generatePkce?: () => DesktopPkce;
  /** Test seam — generates the opaque `state`; defaults to the real one. */
  generateState?: () => string;
  /** Test seam — redeems the code for tokens; defaults to the real client. */
  redeem?: RedeemDesktopAuthorizationCodeFn;
  /** Test seam for a pending-user bootstrap code; defaults to the real client. */
  redeemBootstrap?: typeof redeemDesktopBootstrap;
  /**
   * Test seam — reads the display identity with a redeemed, NOT-YET-ADOPTED
   * access token, for a sign-in that confirms its account (ISS-11345).
   * Defaults to `GET /desktop/identity`.
   */
  fetchAccount?: (accessToken: string) => Promise<DesktopIdentity | null>;
  /** Max ms to wait for the loopback callback after opening the browser. */
  callbackTimeoutMs?: number;
  /**
   * ISS-5954 M3: the ceiling for an EMAIL sign-in, which is slower than an
   * OAuth bounce — the person types an address and password on the Clerk form
   * and fetches a verification code from their inbox. Defaults to
   * {@link DESKTOP_EMAIL_CALLBACK_TIMEOUT_MS}.
   */
  emailCallbackTimeoutMs?: number;
  /**
   * Test seam — the callback-timeout timer. `signal` fires when the loopback
   * callback or a cancellation wins the race, so the real timer is cleared
   * instead of dangling; defaults to a real, signal-cancellable timer.
   */
  delayMs?: (ms: number, signal: AbortSignal) => Promise<void>;
};

/**
 * Ports for existing-user resolution (PRD-532 §8 / M6). Omit to disable the
 * behavior entirely. Wired to {@link ApiKeyStore}: they derive the one-time,
 * non-blocking "Sign in with GitHub to sync" prompt for someone who holds an
 * `sk_live_*` API key but no first-party desktop session.
 *
 * Signing in is always an explicit user action. A silent background migrate
 * that traded the API key for a session with no user involvement was removed —
 * it re-authenticated a user who had just signed out, and again on every launch,
 * because "no session right now" is not the same as "never had a session".
 */
export type DesktopExistingUserDeps = {
  /** Whether an `sk_live_*` API key is present (safeStorage or env). */
  hasApiKey: () => boolean;
  /** Whether the one-time sync prompt was already dismissed (persisted). */
  hasDismissedPrompt: () => boolean;
  /** Persist that the sync prompt was dismissed (one-time). */
  persistDismissal: () => void;
};

export type DesktopSessionManagerDeps = {
  store: DesktopSessionStore;
  /** Signs exchange/refresh/revoke with the bound Ed25519 device key. */
  popSigner: DesktopPopSigner;
  /** Resolves the current platform API origin. */
  resolveApiOrigin: () => string;
  /**
   * Resolves the active device id (the device-key reference stamped on the
   * persisted session). Resolved lazily so the stamp always reflects the
   * currently-active gateway — consistent with {@link popSigner} and the
   * device descriptor, which both resolve it dynamically.
   */
  resolveGatewayId: () => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Refresh this many ms before the access token expires. */
  refreshSkewMs?: number;
  /** Test seam — defaults to the real HTTP client functions. */
  client?: DesktopSessionClientFns;
  /** Browser sign-in ports; omit to leave {@link DesktopSessionManager.beginBrowserSignIn} unavailable. */
  browserSignIn?: DesktopBrowserSignInDeps;
  beginSignInAnalytics?: () => DesktopSignInAnalytics | null;
  /** Existing-user resolution ports (PRD-532 §8 / M6); omit to disable. */
  existingUser?: DesktopExistingUserDeps;
  /**
   * ISS-6334: report a failed session refresh onto the UNAUTHENTICATED relay
   * pipe. A refresh that keeps failing leaves the install with no usable access
   * token, so every authenticated diagnostic lane goes quiet at exactly the
   * moment the failure starts. Closed enums only — no token, no identifier.
   */
  reportAuthFailure?: (input: DesktopAuthFailureEventInput) => void;
  /**
   * Manager-level diagnostic sink for a cause the closed telemetry enums cannot
   * carry — the `desktop-auth` log in production. The browser-sign-in ports fall
   * back to this one, so a suite that overrides theirs still captures sign-in
   * causes while the boot path reports through the same sink production uses.
   */
  logDiagnostic?: (message: string) => void;
};

export type ResolvedBrowserSignInDeps = DesktopBrowserSignInDeps & {
  startLoopbackListener: () => Promise<DesktopLoopbackListener>;
  generatePkce: () => DesktopPkce;
  generateState: () => string;
  redeem: RedeemDesktopAuthorizationCodeFn;
  redeemBootstrap: typeof redeemDesktopBootstrap;
  fetchAccount: (accessToken: string) => Promise<DesktopIdentity | null>;
  callbackTimeoutMs: number;
  emailCallbackTimeoutMs: number;
  delayMs: (ms: number, signal: AbortSignal) => Promise<void>;
  logDiagnostic: (message: string) => void;
};
