import {
  type DesktopAuthState,
  DesktopAuthStatus,
  type DesktopBrowserSignInFailure,
  type DesktopBrowserSignInResult,
} from "../shared/contracts.js";
import {
  buildDesktopAuthorizeUrl,
  type RedeemDesktopAuthorizationCodeFn,
  redeemDesktopAuthorizationCode,
} from "./desktop-authorize-client.js";
import {
  type DesktopPkce,
  generateDesktopPkce,
  generateOAuthState,
} from "./desktop-authorize-pkce.js";
import {
  type DesktopLoopbackListener,
  startDesktopLoopbackListener,
} from "./desktop-loopback-listener.js";
import type { DesktopPopSigner } from "./desktop-pop.js";
import {
  type DesktopSessionResult,
  type DesktopSessionTokens,
  refreshDesktopSession,
  revokeDesktopSession,
} from "./desktop-session-client.js";
import type {
  DesktopSessionRecord,
  DesktopSessionStore,
} from "./desktop-session-store.js";

/**
 * Main-process token/session manager for first-party desktop auth (FEA-1514 /
 * FEA-2219). Owns the in-memory access token, the durable session (via
 * {@link DesktopSessionStore}), and the full auth state machine: restore on
 * startup, single-flight refresh with an expiry skew, browser sign-in
 * (loopback OAuth authorization-code + PKCE), and sign-out.
 *
 * The browser sign-in orchestration ({@link DesktopSessionManager.beginBrowserSignIn})
 * is the native OAuth authorization-code + PKCE loopback flow (RFC 8252 /
 * FEA-2525): generate PKCE + state, start a `127.0.0.1` loopback listener, open
 * the web authorize URL in the system browser, await the loopback redirect,
 * validate `state`, then redeem the one-time code (+ PKCE verifier + device PoP)
 * for tokens. It lives here behind injected ports (`openExternal`, the loopback
 * listener, the redeem client) so it stays unit-testable.
 *
 * The access token is NEVER persisted (memory-only); the refresh token lives
 * only inside the encrypted store. No token, refresh, or signature material is
 * logged or returned through state.
 */

// The auth status/state and sign-in-result types are the canonical wire
// contract shared with the renderer; they live in shared/contracts.ts (see the
// AGENTS.md wire-contract rule) and are re-exported here as types so existing
// importers of this module resolve them unchanged. Consumers that need the
// DesktopAuthStatus runtime value import it from shared/contracts.ts directly.
export type {
  DesktopAuthState,
  DesktopAuthStatus,
  DesktopBrowserSignInFailure,
  DesktopBrowserSignInResult,
} from "../shared/contracts.js";

type DesktopSessionClientFns = {
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
  /** Max ms to wait for the loopback callback after opening the browser. */
  callbackTimeoutMs?: number;
  /**
   * Test seam — the callback-timeout timer. `signal` fires when the loopback
   * callback or a cancellation wins the race, so the real timer is cleared
   * instead of dangling; defaults to a real, signal-cancellable timer.
   */
  delayMs?: (ms: number, signal: AbortSignal) => Promise<void>;
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
};

type ResolvedBrowserSignInDeps = DesktopBrowserSignInDeps & {
  startLoopbackListener: () => Promise<DesktopLoopbackListener>;
  generatePkce: () => DesktopPkce;
  generateState: () => string;
  redeem: RedeemDesktopAuthorizationCodeFn;
  callbackTimeoutMs: number;
  delayMs: (ms: number, signal: AbortSignal) => Promise<void>;
  logDiagnostic: (message: string) => void;
};

const DEFAULT_REFRESH_SKEW_MS = 60_000;
// The loopback callback covers the whole browser interaction — sign-in / sign-up
// + consent — so it is minutes, not the ~60s server-side authorization-code TTL
// (the code is minted at consent and redeemed within ~1s of the redirect).
const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60_000;

/**
 * Default callback-timeout timer for {@link DesktopBrowserSignInDeps.delayMs}.
 * Resolves after `ms` (a real timeout), but if `signal` aborts first — the
 * loopback callback arrived or the sign-in was cancelled — it clears the timer
 * and leaves the promise pending. The losing side of the race is simply
 * abandoned, so no timer handle is left to keep the event loop alive or fire
 * against a torn-down run (AGENTS.md "Runtime Cleanup").
 */
function defaultCallbackTimeoutDelay(
  ms: number,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
      },
      { once: true }
    );
  });
}

type SignInRun = { cancelled: boolean; abort: AbortController };

export class DesktopSessionManager {
  private readonly store: DesktopSessionStore;
  private readonly popSigner: DesktopPopSigner;
  private readonly resolveApiOrigin: () => string;
  private readonly resolveGatewayId: () => string;
  private readonly fetchImpl?: typeof fetch;
  private readonly now: () => number;
  private readonly refreshSkewMs: number;
  private readonly client: DesktopSessionClientFns;
  private readonly browserSignIn?: ResolvedBrowserSignInDeps;
  /** Non-null while a browser sign-in is running; carries its cancel flag. */
  private signInRun: SignInRun | null = null;

  private state: DesktopAuthState = {
    status: DesktopAuthStatus.Loading,
    userId: null,
    organizationId: null,
  };
  private session: DesktopSessionRecord | null = null;
  private accessToken: string | null = null;
  private accessTokenExpiresAtMs: number | null = null;
  private refreshInFlight: Promise<
    DesktopSessionResult<DesktopSessionTokens>
  > | null = null;
  /**
   * Bumped on every {@link clearSession}. An in-flight exchange/refresh captures
   * the generation before its network call and drops the result if it changed —
   * so a sign-out that clears credentials mid-refresh can never be silently
   * overwritten by the resolving refresh (fail closed).
   */
  private sessionGeneration = 0;
  private readonly listeners = new Set<(state: DesktopAuthState) => void>();

  constructor(deps: DesktopSessionManagerDeps) {
    this.store = deps.store;
    this.popSigner = deps.popSigner;
    this.resolveApiOrigin = deps.resolveApiOrigin;
    this.resolveGatewayId = deps.resolveGatewayId;
    this.fetchImpl = deps.fetchImpl;
    this.now = deps.now ?? (() => Date.now());
    this.refreshSkewMs = deps.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    this.client = deps.client ?? {
      refresh: refreshDesktopSession,
      revoke: revokeDesktopSession,
    };
    this.browserSignIn = deps.browserSignIn
      ? {
          ...deps.browserSignIn,
          startLoopbackListener:
            deps.browserSignIn.startLoopbackListener ??
            (() => startDesktopLoopbackListener()),
          generatePkce:
            deps.browserSignIn.generatePkce ?? (() => generateDesktopPkce()),
          generateState:
            deps.browserSignIn.generateState ?? (() => generateOAuthState()),
          redeem: deps.browserSignIn.redeem ?? redeemDesktopAuthorizationCode,
          callbackTimeoutMs:
            deps.browserSignIn.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS,
          delayMs: deps.browserSignIn.delayMs ?? defaultCallbackTimeoutDelay,
          logDiagnostic: deps.browserSignIn.logDiagnostic ?? (() => undefined),
        }
      : undefined;
  }

  getState(): DesktopAuthState {
    return this.state;
  }

  /** Current identity for the renderer AuthAdapter, or null when signed out. */
  getIdentity(): { userId: string; organizationId: string } | null {
    return this.session
      ? {
          userId: this.session.userId,
          organizationId: this.session.organizationId,
        }
      : null;
  }

  subscribe(listener: (state: DesktopAuthState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Restore from the keychain at startup: refresh once so a stale access token
   * is replaced and a revoked/expired session is detected immediately. Auth
   * failures clear the credentials; a transient network failure keeps them so a
   * later {@link getAccessToken} can retry.
   */
  async restore(): Promise<void> {
    const stored = this.store.getSession();
    if (!stored) {
      this.session = null;
      this.setState(DesktopAuthStatus.SignedOut, null);
      return;
    }

    this.session = stored;
    const result = await this.refreshNow();
    if (result.ok) {
      return;
    }
    if (result.retryable) {
      // Preserve credentials; surface as authenticated so getAccessToken retries.
      this.setState(DesktopAuthStatus.Authenticated, stored);
    }
    // Non-retryable failures were already cleared to RefreshFailed in refreshNow.
  }

  /**
   * Return a valid access token, refreshing (single-flight) when the cached one
   * is absent or within the expiry skew. Returns null when there is no session
   * or the refresh fails.
   */
  async getAccessToken(): Promise<string | null> {
    if (!this.session) {
      return null;
    }
    if (
      this.accessToken &&
      this.accessTokenExpiresAtMs !== null &&
      this.now() < this.accessTokenExpiresAtMs - this.refreshSkewMs
    ) {
      return this.accessToken;
    }
    const result = await this.refreshNow();
    return result.ok ? this.accessToken : null;
  }

  /**
   * Sign out: best-effort server revoke of the session/refresh-token family,
   * then clear local credentials and the in-memory access token.
   */
  async signOut(): Promise<void> {
    // Abort any in-flight browser sign-in so its pending loopback wait / code
    // redeem cannot resurrect a session after we clear.
    this.cancelSignIn();
    const session = this.session;
    if (session) {
      await this.client
        .revoke({
          ...this.baseClientArgs(),
          refreshToken: session.refreshToken,
        })
        .catch(() => undefined);
    }
    this.clearSession(DesktopAuthStatus.SignedOut);
  }

  /**
   * Drive an interactive browser sign-in via the loopback OAuth flow: generate
   * PKCE + `state`, start the `127.0.0.1` loopback listener, open the web
   * authorize URL in the system browser, await the loopback redirect, validate
   * `state`, then redeem the one-time code (+ PKCE verifier + device PoP) for
   * tokens. Single-flight — a second call while one is running (or while a
   * session already exists) returns `already_in_progress`. The flow is
   * cancellable via {@link cancelSignIn} / {@link signOut}.
   */
  async beginBrowserSignIn(): Promise<DesktopBrowserSignInResult> {
    const deps = this.browserSignIn;
    if (!deps) {
      return { ok: false, reason: "unavailable" };
    }
    if (this.signInRun || this.session !== null) {
      return { ok: false, reason: "already_in_progress" };
    }
    const run: SignInRun = { cancelled: false, abort: new AbortController() };
    this.signInRun = run;
    try {
      return await this.runBrowserSignIn(deps, run);
    } finally {
      if (this.signInRun === run) {
        this.signInRun = null;
      }
    }
  }

  /**
   * Cancel an in-flight browser sign-in; no-op when none is running. Releases
   * the run slot synchronously so a new sign-in can start even if the current
   * run is parked on a slow/unresponsive network call (no unbounded lockout),
   * and bumps {@link sessionGeneration} so an approving exchange already in
   * flight is dropped rather than authenticating a cancelled device.
   */
  cancelSignIn(): void {
    const run = this.signInRun;
    if (!run) {
      return;
    }
    run.cancelled = true;
    // Wake a sign-in parked on the loopback callback so it settles as cancelled.
    run.abort.abort();
    this.signInRun = null;
    this.sessionGeneration += 1;
    // Settle the resting state here; the (now superseded) run will not.
    if (this.session === null) {
      this.setState(DesktopAuthStatus.SignedOut, null);
    }
  }

  private async runBrowserSignIn(
    deps: ResolvedBrowserSignInDeps,
    run: SignInRun
  ): Promise<DesktopBrowserSignInResult> {
    this.setState(DesktopAuthStatus.OpeningBrowser, null);

    const setup = await this.prepareSignIn(deps);
    if (!setup) {
      // A resolver port, PKCE generation, or the loopback listener threw —
      // never strand the state in opening_browser.
      return this.settleSignIn(run, { ok: false, reason: "start_failed" });
    }
    const { listener, authorizeUrl, pkce, state, descriptor } = setup;

    try {
      // A cancel / sign-out during the async listener start supersedes this run
      // (which already settled the resting state) — don't pop a browser window
      // for an abandoned sign-in. The listener is released by the finally below.
      if (this.signInSuperseded(run)) {
        return { ok: false, reason: "cancelled" };
      }
      try {
        await deps.openExternal(authorizeUrl);
      } catch {
        return this.settleSignIn(run, { ok: false, reason: "open_failed" });
      }
      if (this.signInSuperseded(run)) {
        return { ok: false, reason: "cancelled" };
      }

      this.setState(DesktopAuthStatus.AwaitingRedirect, null);
      const callback = await this.awaitLoopbackCallback(deps, run, listener);
      if (callback.kind === "cancelled") {
        return this.settleSignIn(run, { ok: false, reason: "cancelled" });
      }
      if (callback.kind === "timeout") {
        return this.settleSignIn(run, {
          ok: false,
          reason: "redirect_timeout",
        });
      }
      // `state` must round-trip exactly and a `code` must be present, else this
      // is a mix-up / CSRF attempt rather than our own redirect.
      if (!callback.code || callback.state !== state) {
        return this.settleSignIn(run, { ok: false, reason: "state_mismatch" });
      }
      if (this.signInSuperseded(run)) {
        return { ok: false, reason: "cancelled" };
      }

      this.setState(DesktopAuthStatus.Exchanging, null);
      return await this.redeemAndComplete(deps, run, {
        code: callback.code,
        codeVerifier: pkce.codeVerifier,
        gatewayId: descriptor.gatewayId,
        redirectUri: listener.redirectUri,
      });
    } finally {
      // The listener is single-use: release the ephemeral port whatever the
      // outcome (success, failure, timeout, or cancellation).
      await listener.close().catch(() => undefined);
    }
  }

  /**
   * Resolve the device descriptor + web-app origin, generate PKCE + `state`,
   * start the loopback listener, and build the authorize URL. Returns null (and
   * closes any started listener) if any step throws, so the caller settles as
   * `start_failed` without opening the browser.
   */
  private async prepareSignIn(deps: ResolvedBrowserSignInDeps): Promise<{
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
   * run's cancellation signal (fired by {@link cancelSignIn} / {@link signOut}).
   */
  private async awaitLoopbackCallback(
    deps: ResolvedBrowserSignInDeps,
    run: SignInRun,
    listener: DesktopLoopbackListener
  ): Promise<
    | { kind: "received"; code: string | null; state: string | null }
    | { kind: "timeout" }
    | { kind: "cancelled" }
  > {
    if (run.abort.signal.aborted) {
      return { kind: "cancelled" };
    }
    // A race-local controller tears down whichever side loses: aborting it
    // clears the callback-timeout timer once the redirect arrives, and settles
    // the loopback wait once the timeout fires. It also chains off the run's own
    // cancellation signal so cancel / sign-out unblocks both sides at once.
    const raceAbort = new AbortController();
    const onRunAbort = () => raceAbort.abort();
    run.abort.signal.addEventListener("abort", onRunAbort, { once: true });
    try {
      const timeout = deps
        .delayMs(deps.callbackTimeoutMs, raceAbort.signal)
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
      return { kind: "received", code: outcome.code, state: outcome.state };
    } finally {
      // Tear down the losing side of the race (timer or loopback wait) whatever
      // the outcome, then detach the run-signal bridge.
      raceAbort.abort();
      run.abort.signal.removeEventListener("abort", onRunAbort);
    }
  }

  /**
   * Redeem the authorization code (+ PKCE verifier + device PoP) for tokens and
   * apply them. Guards on the session generation like the refresh path: a
   * concurrent clear/cancel during the redeem round-trip drops the result rather
   * than authenticating a cancelled device.
   */
  private async redeemAndComplete(
    deps: ResolvedBrowserSignInDeps,
    run: SignInRun,
    input: {
      code: string;
      codeVerifier: string;
      gatewayId: string;
      redirectUri: string;
    }
  ): Promise<DesktopBrowserSignInResult> {
    const generation = this.sessionGeneration;
    let result: DesktopSessionResult<DesktopSessionTokens>;
    try {
      result = await deps.redeem({
        apiOrigin: this.resolveApiOrigin(),
        code: input.code,
        codeVerifier: input.codeVerifier,
        gatewayId: input.gatewayId,
        redirectUri: input.redirectUri,
        popSigner: this.popSigner,
        fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      // resolveApiOrigin() or the redeem port threw (not the client's typed
      // failure result) — settle back to the resting state rather than stranding
      // the UI in `exchanging` with no active run left to cancel.
      deps.logDiagnostic(
        `Browser sign-in exchange threw: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return this.settleSignIn(run, { ok: false, reason: "exchange_failed" });
    }
    if (result.ok && this.sessionGeneration === generation) {
      this.applyTokens(result.value);
    }
    if (result.ok && this.session !== null) {
      return { ok: true };
    }
    if (result.ok) {
      // Redeem succeeded but a concurrent clear/cancel bumped the generation.
      return this.settleSignIn(run, { ok: false, reason: "cancelled" });
    }
    // An invalid/expired/replayed code reads as `expired`; PoP/network/server
    // failures read as a failed exchange.
    const reason: DesktopBrowserSignInFailure =
      result.error === "invalid" ? "expired" : "exchange_failed";
    // The UI collapses every non-`invalid` redeem outcome into `exchange_failed`;
    // capture the specific transport/auth error (`pop_unavailable`,
    // `pop_rejected`, `org_required`, `unavailable`, `network`, …) so a redeem
    // that never establishes credentials is diagnosable from the log.
    deps.logDiagnostic(
      `Browser sign-in exchange failed: ${result.error} ` +
        `(retryable=${result.retryable}, reason=${reason})`
    );
    return this.settleSignIn(run, { ok: false, reason });
  }

  /** Whether `run` is no longer the active sign-in (cancelled or superseded). */
  private signInSuperseded(run: SignInRun): boolean {
    return this.signInRun !== run;
  }

  /**
   * Settle a non-authenticating sign-in outcome. If the run was superseded by a
   * cancel/sign-out — which already settled the resting state — don't clobber it;
   * report the cancellation instead.
   */
  private settleSignIn(
    run: SignInRun,
    result: DesktopBrowserSignInResult
  ): DesktopBrowserSignInResult {
    if (this.signInSuperseded(run)) {
      return { ok: false, reason: "cancelled" };
    }
    return this.finishSignIn(result);
  }

  /** Settle a non-authenticating sign-in outcome back to the resting state. */
  private finishSignIn(
    result: DesktopBrowserSignInResult
  ): DesktopBrowserSignInResult {
    // Restore the resting state from credential presence: a session established
    // out-of-band (or surviving sign-out) stays authenticated; otherwise signed
    // out. Never strand the UI in opening_browser/awaiting_redirect/exchanging.
    if (this.session === null) {
      this.setState(DesktopAuthStatus.SignedOut, null);
    } else {
      this.setState(DesktopAuthStatus.Authenticated, this.getIdentity());
    }
    return result;
  }

  private refreshNow(): Promise<DesktopSessionResult<DesktopSessionTokens>> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    const session = this.session;
    if (!session) {
      return Promise.resolve({ ok: false, error: "invalid", retryable: false });
    }
    const promise = this.performRefresh(session).finally(() => {
      this.refreshInFlight = null;
    });
    this.refreshInFlight = promise;
    return promise;
  }

  private async performRefresh(
    session: DesktopSessionRecord
  ): Promise<DesktopSessionResult<DesktopSessionTokens>> {
    const generation = this.sessionGeneration;
    const result = await this.client.refresh({
      ...this.baseClientArgs(),
      refreshToken: session.refreshToken,
    });
    if (this.sessionGeneration !== generation) {
      // Credentials were cleared (e.g. a concurrent sign-out) while this refresh
      // was in flight. Drop the result rather than re-authenticating or clearing
      // a session that is no longer ours to touch.
      return result;
    }
    if (result.ok) {
      this.applyTokens(result.value);
    } else if (!result.retryable) {
      // Revoked / expired / org-invalid / PoP-failed: clear and require sign-in.
      this.clearSession(DesktopAuthStatus.RefreshFailed);
    }
    return result;
  }

  private applyTokens(tokens: DesktopSessionTokens): void {
    const record: DesktopSessionRecord = {
      refreshToken: tokens.refreshToken,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      userId: tokens.userId,
      organizationId: tokens.organizationId,
      gatewayId: this.resolveGatewayId(),
    };
    this.session = record;
    this.accessToken = tokens.accessToken;
    const expiresAtMs = Date.parse(tokens.accessTokenExpiresAt);
    this.accessTokenExpiresAtMs = Number.isNaN(expiresAtMs)
      ? null
      : expiresAtMs;
    // Persistence is best-effort: a safeStorage failure leaves a working
    // memory-only session rather than discarding freshly minted credentials.
    try {
      this.store.setSession(record);
    } catch {
      /* memory-only fallback until the next successful write */
    }
    this.setState(DesktopAuthStatus.Authenticated, record);
  }

  private clearSession(status: DesktopAuthStatus): void {
    this.session = null;
    this.accessToken = null;
    this.accessTokenExpiresAtMs = null;
    this.sessionGeneration += 1;
    // Clearing the on-disk record is best-effort: a safeStorage/disk failure must
    // not leave the in-memory state authenticated, so always reach setState.
    try {
      this.store.clear();
    } catch {
      /* in-memory credentials are already cleared; retry on next write */
    }
    this.setState(status, null);
  }

  /** Shared per-call client args (origin, signer, fetch) for exchange/refresh/revoke. */
  private baseClientArgs(): {
    apiOrigin: string;
    popSigner: DesktopPopSigner;
    fetchImpl?: typeof fetch;
  } {
    return {
      apiOrigin: this.resolveApiOrigin(),
      popSigner: this.popSigner,
      fetchImpl: this.fetchImpl,
    };
  }

  private setState(
    status: DesktopAuthStatus,
    identity: { userId: string; organizationId: string } | null
  ): void {
    this.state = {
      status,
      userId: identity?.userId ?? null,
      organizationId: identity?.organizationId ?? null,
    };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}
