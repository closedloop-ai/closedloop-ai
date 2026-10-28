import { AuthOutcome, AuthReason } from "@closedloop-ai/telemetry-contract/app";
import {
  type DesktopSignInFraming,
  DesktopSignInMethod,
} from "@repo/api/src/types/desktop-authorize-url";
import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import {
  OnboardingAccountOutcome,
  onboardingFailedAccountModesForOutcome,
} from "@repo/api/src/types/onboarding-analytics.ts";
import {
  type DesktopAuthState,
  DesktopAuthStatus,
  type DesktopBootstrapOrganizationInput,
  type DesktopBootstrapOrganizationResult,
  type DesktopBrowserSignInFailure,
  type DesktopBrowserSignInResult,
  type DesktopExistingUserResolution,
} from "../../shared/contracts.js";
import { desktopAuthAccountOutcome } from "../../shared/desktop-auth-account-outcome.js";
import type { DesktopPopSigner } from "../auth/desktop-pop.js";
import {
  authReasonForSessionRequestError,
  type DesktopAuthFailureEventInput,
  signInExchangeFailedOutcome,
  signInRedirectFailedOutcome,
  signInRedirectFailureReason,
} from "../cloud/auth-failure-telemetry.js";
import type { SignedInUserIdentity } from "../util/user-identity.js";
import type { DesktopAccountAdmission } from "./desktop-account-admission.js";
import { DesktopBootstrapSession } from "./desktop-bootstrap-session.js";
import {
  awaitLoopbackCallback,
  prepareBrowserSignIn,
  resolveBrowserSignInDeps,
} from "./desktop-browser-sign-in-loopback.js";
import {
  type DesktopSessionResult,
  type DesktopSessionTokens,
  refreshDesktopSession,
  revokeDesktopSession,
} from "./desktop-session-client.js";
import type {
  DesktopBrowserSignInDeps,
  DesktopExistingUserDeps,
  DesktopSessionClientFns,
  DesktopSessionManagerDeps,
  ResolvedBrowserSignInDeps,
} from "./desktop-session-manager-types.js";
import type {
  DesktopSessionRecord,
  DesktopSessionStore,
} from "./desktop-session-store.js";
import {
  type DesktopSignInAnalytics,
  onboardingFailureReason,
} from "./desktop-sign-in-analytics.js";
import {
  type DesktopSignInConfirmation,
  isRedeemedAccount,
  waitForSignInConfirmation,
} from "./desktop-sign-in-confirmation.js";

/**
 * Main-process token/session manager for first-party desktop auth (FEA-1514 /
 * FEA-2219). Owns the in-memory access token, the durable session (via
 * {@link DesktopSessionStore}), and the full auth state machine: restore on
 * startup, single-flight refresh with an expiry skew, browser sign-in
 * (loopback OAuth authorization-code + PKCE), and sign-out.
 *
 * The access token is NEVER persisted (memory-only); the refresh token lives
 * only inside the encrypted store. No token, refresh, or signature material is
 * logged or returned through state.
 */

const DEFAULT_REFRESH_SKEW_MS = 60_000;

/**
 * Default callback-timeout timer for {@link DesktopBrowserSignInDeps.delayMs}.
 * Resolves after `ms` (a real timeout), but if `signal` aborts first — the
 * loopback callback arrived or the sign-in was cancelled — it clears the timer
 * and leaves the promise pending. The losing side of the race is simply
 * abandoned, so no timer handle is left to keep the event loop alive or fire
 * against a torn-down run (AGENTS.md "Runtime Cleanup").
 */
type SignInRun = {
  cancelled: boolean;
  abort: AbortController;
  browserOpened: boolean;
  accountCreated: boolean;
  framing?: DesktopSignInFraming;
  failureReported: boolean;
  analytics: DesktopSignInAnalytics | null;
  /** Set only while the run holds a redeemed session awaiting confirmation. */
  confirm?: () => void;
  /** The run itself, settled only after its cleanup (revoke, listener close). */
  settled?: Promise<DesktopBrowserSignInResult>;
};

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
  private readonly existingUser?: DesktopExistingUserDeps;
  private readonly beginSignInAnalytics?: () => DesktopSignInAnalytics | null;
  private readonly reportAuthFailure?: (
    input: DesktopAuthFailureEventInput
  ) => void;
  private readonly logDiagnostic?: (message: string) => void;
  /** Non-null while a browser sign-in is running; carries its cancel flag. */
  private signInRun: SignInRun | null = null;
  /** Latest computed existing-user resolution, mirrored to subscribers. */
  private existingUserResolution: DesktopExistingUserResolution = {
    kind: "none",
    dismissed: false,
  };
  private readonly resolutionListeners = new Set<
    (resolution: DesktopExistingUserResolution) => void
  >();

  private state: DesktopAuthState = {
    status: DesktopAuthStatus.Loading,
    userId: null,
    organizationId: null,
    accountOutcome: OnboardingAccountOutcome.Unknown,
    authGeneration: 0,
  };
  private session: DesktopSessionRecord | null = null;
  private accessToken: string | null = null;
  private accessTokenExpiresAtMs: number | null = null;
  /** The API origin that minted {@link accessToken}. */
  private accessTokenOrigin: string | null = null;
  private readonly bootstrapSession: DesktopBootstrapSession;
  private refreshInFlight: Promise<
    DesktopSessionResult<DesktopSessionTokens>
  > | null = null;
  /** Fences in-flight exchanges and refreshes across credential invalidation. */
  private sessionGeneration = 0;
  /**
   * ISS-10913: whether the loopback callback of the CURRENT sign-in reported
   * that this auth attempt created a new account. Latched for the life of one
   * run so the outcome survives the intermediate states between the callback
   * and the settled answer, and cleared whenever a run starts or credentials
   * are dropped — the fact belongs to one auth return, never to the install.
   */
  private signInAccountCreated = false;
  private readonly listeners = new Set<(state: DesktopAuthState) => void>();

  constructor(deps: DesktopSessionManagerDeps) {
    this.beginSignInAnalytics = deps.beginSignInAnalytics;
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
    this.bootstrapSession = new DesktopBootstrapSession({
      resolveApiOrigin: this.resolveApiOrigin,
      getGeneration: () => this.sessionGeneration,
      popSigner: this.popSigner,
      fetchImpl: this.fetchImpl,
      onAwaitingOrganization: (pendingUserId) =>
        this.setState(
          DesktopAuthStatus.Exchanging,
          null,
          undefined,
          pendingUserId
        ),
      applyTokens: (tokens, issuingOrigin) =>
        this.applyTokens(tokens, issuingOrigin),
    });
    this.browserSignIn = resolveBrowserSignInDeps(deps);
    this.existingUser = deps.existingUser;
    this.reportAuthFailure = deps.reportAuthFailure;
    this.logDiagnostic = deps.logDiagnostic;
  }

  getState(): DesktopAuthState {
    return this.state;
  }

  /** Current identity for the renderer AuthAdapter, or null when signed out. */
  /**
   * ISS-10533: `status === Authenticated`. The lane gate — "may this reach the
   * cloud at all?" — and deliberately NOT the inverse of {@link isSignedOut}:
   * the states between them (`Loading`, `RefreshFailed`, and the three sign-in
   * steps) are neither.
   */
  isAuthenticated(): boolean {
    return this.getState().status === DesktopAuthStatus.Authenticated;
  }

  /**
   * ISS-10533 (marisolashgrove review): `status === SignedOut`, which is a
   * STRICTLY narrower question than "is there an identity".
   *
   * {@link getIdentity} is null whenever {@link session} is — `Loading` before
   * `restore()`, `SignedOut`, and `RefreshFailed` after the background
   * `clearSession(DesktopAuthStatus.RefreshFailed)`. Only this predicate says
   * that nobody was signed in.
   */
  isSignedOut(): boolean {
    return this.getState().status === DesktopAuthStatus.SignedOut;
  }

  getIdentity(): SignedInUserIdentity | null {
    return this.session
      ? {
          userId: this.session.userId,
          organizationId: this.session.organizationId,
        }
      : null;
  }

  /** Authenticated account witness for generation-gated main-process work. */
  getAccountAdmission(): DesktopAccountAdmission | null {
    const identity = this.getIdentity();
    if (!(identity && this.isAuthenticated())) {
      return null;
    }
    return { ...identity, generation: this.sessionGeneration };
  }

  subscribe(listener: (state: DesktopAuthState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Current existing-user resolution (PRD-532 §8 / M6). `prompt` means the user
   * has an API key but no live session — surface the one-time, non-blocking
   * "Sign in with GitHub to sync" prompt. Never a hard block: this is advisory
   * UI state only, and acting on it is always the user's choice.
   */
  getExistingUserResolution(): DesktopExistingUserResolution {
    return this.existingUserResolution;
  }

  /** Subscribe to existing-user resolution transitions (main → renderer push). */
  subscribeExistingUserResolution(
    listener: (resolution: DesktopExistingUserResolution) => void
  ): () => void {
    this.resolutionListeners.add(listener);
    return () => {
      this.resolutionListeners.delete(listener);
    };
  }

  /**
   * Recompute the existing-user resolution after an out-of-band API-key change
   * (PRD-532 §8 / M6). The resolution derives from `hasApiKey()` + auth status,
   * but the manager only recomputes on auth transitions and dismissal — so a key
   * being set or cleared (`desktop:set-api-key`, `desktop:clear-api-key`, managed
   * onboarding, config deletion) would otherwise leave the prompt state stale.
   * The api-key mutation paths call this to re-derive + re-emit. No-op when the
   * existing-user ports are absent.
   */
  refreshExistingUserResolution(): void {
    this.recomputeExistingUserResolution();
  }

  /**
   * Record that the user dismissed the existing-user sync prompt. Persists via
   * the injected port so it stays a one-time prompt across restarts, then
   * re-emits so the prompt clears immediately. No-op when the ports are absent.
   */
  dismissExistingUserPrompt(): void {
    if (!this.existingUser) {
      return;
    }
    this.existingUser.persistDismissal();
    this.recomputeExistingUserResolution();
  }

  /**
   * Recompute the existing-user resolution from the live auth status + API-key
   * presence. Pure derivation — it never mints or clears a session. Idempotent
   * to call on every state change.
   *
   * The prompt is derived from status + `hasApiKey`, NOT from any credential:
   * signed-out/refresh-failed + a present key + not-yet-dismissed → `prompt`.
   * Any authenticated/loading/in-flight state, a missing key, or a prior
   * dismissal → `none`.
   */
  private recomputeExistingUserResolution(): void {
    const deps = this.existingUser;
    if (!deps) {
      return;
    }
    const next = this.computeExistingUserResolution(deps);
    if (
      next.kind !== this.existingUserResolution.kind ||
      next.dismissed !== this.existingUserResolution.dismissed
    ) {
      this.existingUserResolution = next;
      for (const listener of this.resolutionListeners) {
        listener(next);
      }
    }
  }

  private computeExistingUserResolution(
    deps: DesktopExistingUserDeps
  ): DesktopExistingUserResolution {
    const dismissed = deps.hasDismissedPrompt();
    // Only signed-out states with no live session are candidates. A live session
    // (authenticated) or a still-resolving state (loading / opening_browser /
    // awaiting_redirect / exchanging) is never a prompt candidate — the user is
    // either already on unified auth or actively moving there.
    const signedOut =
      this.state.status === DesktopAuthStatus.SignedOut ||
      this.state.status === DesktopAuthStatus.RefreshFailed;
    if (!(signedOut && deps.hasApiKey()) || dismissed) {
      return { kind: "none", dismissed };
    }
    return { kind: "prompt", dismissed };
  }

  /**
   * Restore from the keychain at startup: refresh once so a stale access token
   * is replaced and a revoked/expired session is detected immediately. Auth
   * failures clear the credentials; a transient network failure keeps them so a
   * later {@link getAccessToken} can retry.
   *
   * Always settles the status, including when the restore itself throws — see
   * {@link settleUnrestorableSession}.
   */
  async restore(): Promise<void> {
    try {
      await this.restoreStoredSession();
    } catch (error) {
      this.settleUnrestorableSession(error);
    }
  }

  /**
   * Settle a {@link restore} that threw, so the status cannot rest in the pending
   * set (ISS-11273).
   *
   * The boot path fires `restore()` and only LOGS a rejection, so any throw above
   * used to leave the status on `Loading` for the life of the process — and every
   * reader of the pending set then renders an indefinite "Loading" it can never
   * leave. `Loading` is the only status this replaces: a throw raised after a
   * `setState` must not downgrade the answer that call already established.
   *
   * The PERSISTED record is deliberately kept: the reachable causes are an
   * unreadable keystore or an `apiOrigin` that fails validation — transient or
   * configuration, never a credential the server refused — so wiping the disk
   * here would destroy a working session over a locked keychain, and the next
   * launch re-reads it. The IN-MEMORY session is dropped, because
   * {@link finishSignIn} derives its resting state from credential presence
   * alone: a retained one would turn the next failed sign-in into a confident
   * `Authenticated` with no usable token and no error surface, and would make
   * {@link getIdentity} answer for a status that promises nobody is signed in.
   */
  private settleUnrestorableSession(error: unknown): void {
    // Logged BEFORE the status guard: the boot path stopped rethrowing when this
    // catch was added, so this is now the only place the cause is reported, and
    // a throw raised after a legitimate `setState` returns below — silently, if
    // the log sat under the guard.
    this.logDiagnostic?.(
      `Session restore could not settle: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    if (this.state.status !== DesktopAuthStatus.Loading) {
      return;
    }
    // The closed enums carry no member for "restore itself threw"; the generic
    // fallback keeps the install visible to the monitor the refresh path already
    // reports on, and the cause above is the readable half.
    this.reportAuthFailure?.({
      outcome: AuthOutcome.TokenRefreshFailed,
      reason: AuthReason.Unknown,
    });
    this.clearSession(DesktopAuthStatus.RefreshFailed, { keepStored: true });
  }

  private async restoreStoredSession(): Promise<void> {
    const stored = this.store.getSession();
    if (!stored) {
      // ISS-6334: `getSession()` collapses FOUR situations into `null` —
      // nothing stored, safeStorage unavailable, a failed decrypt, and a
      // corrupt or incomplete record. Only the first is an ordinary sign-out.
      // The other three are an install holding a session it can never read: it
      // looks signed out to the user, never refreshes, and takes every
      // authenticated diagnostic lane down with it, silently. `hasSession()`
      // is the discriminator — a blob IS persisted, we just could not read it.
      if (this.store.hasSession()) {
        this.reportAuthFailure?.({
          outcome: AuthOutcome.TokenRefreshFailed,
          reason: AuthReason.CredentialUnreadable,
        });
      }
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
   * ISS-12222: {@link getAccessToken}, or null unless `origin` minted the
   * token. Applying another API profile keeps the session and its cached
   * token, so the token can belong to the origin the install just left.
   */
  async getAccessTokenIssuedBy(origin: string): Promise<string | null> {
    const token = await this.getAccessToken();
    return token !== null &&
      token === this.accessToken &&
      this.accessTokenOrigin === origin
      ? token
      : null;
  }

  /**
   * FEA-3425: drop the cached access token so the next {@link getAccessToken}
   * runs a refresh. Called when a server rejects the token as unauthorized
   * (HTTP 401) before its local expiry — early revocation / rotation — so a
   * stale-but-unexpired cached token cannot be re-sent for up to the full TTL.
   * Auth status is untouched: a live session recovers on that refresh; a
   * revoked one fails it non-retryably and clears to RefreshFailed there.
   *
   * ISS-9701: pass `rejectedToken` and the eviction is scoped to that exact
   * credential. 401s do not arrive in the order their requests left: two callers
   * can both be carrying token T1 when the first is rejected, refreshes to T2
   * and succeeds — and the second's 401, describing T1, lands afterwards. An
   * unconditional clear at that moment throws away the perfectly good T2 that
   * was just minted, so the late caller's read refreshes AGAIN, and every
   * further straggler from the same burst does the same. That is a token mint
   * per late 401 against a session that recovered on the first one, and under
   * provider rate limiting it can end at the very sign-in card the recovery
   * exists to avoid. Comparing first makes the late report a no-op: the cache
   * already holds something newer than what the server refused.
   *
   * Omitting the argument keeps the original unconditional clear, which is what
   * a caller that cannot name the credential it sent (the observability lanes)
   * still needs.
   */
  invalidateAccessToken(rejectedToken?: string): void {
    if (rejectedToken !== undefined && this.accessToken !== rejectedToken) {
      return;
    }
    this.accessToken = null;
    this.accessTokenExpiresAtMs = null;
  }

  /** Invalidates local auth synchronously, then starts best-effort remote revoke. */
  signOut(): Promise<void> {
    this.cancelSignIn();
    const session = this.session;
    this.bootstrapSession.clear();
    this.clearSession(DesktopAuthStatus.SignedOut);
    if (!session) {
      return Promise.resolve();
    }
    try {
      this.client
        .revoke({
          ...this.baseClientArgs(),
          refreshToken: session.refreshToken,
        })
        .catch(() => undefined);
    } catch {
      // Local invalidation is authoritative; a synchronous client/origin failure
      // cannot postpone sign-out or the application-owned cleanup that follows.
    }
    return Promise.resolve();
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
  async beginBrowserSignIn(
    method?: DesktopSignInMethod,
    emailHint?: string,
    framing?: DesktopSignInFraming,
    confirmation?: DesktopSignInConfirmation
  ): Promise<DesktopBrowserSignInResult> {
    const deps = this.browserSignIn;
    if (!deps) {
      return { ok: false, reason: "unavailable" };
    }
    if (this.signInRun || this.session !== null) {
      return { ok: false, reason: "already_in_progress" };
    }
    let analytics: DesktopSignInAnalytics | null = null;
    try {
      analytics = this.beginSignInAnalytics?.() ?? null;
    } catch {
      /* ISS-11127: analytics cannot gate sign-in. */
    }
    const run: SignInRun = {
      cancelled: false,
      abort: new AbortController(),
      browserOpened: false,
      accountCreated: false,
      framing,
      failureReported: false,
      analytics,
    };
    this.signInRun = run;
    // A fresh return answers for itself: the previous run's creation fact must
    // not colour this one's outcome.
    this.signInAccountCreated = false;
    run.settled = this.runBrowserSignIn(deps, run, {
      method,
      emailHint,
      framing,
      confirmation,
    });
    try {
      return await run.settled;
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
    this.reportSignInFailure(run, "cancelled");
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

  /**
   * ISS-11345: the quit path's {@link cancelSignIn}. Resolves once the cancelled
   * run has finished its cleanup: a redeemed session it was still holding is
   * revoked server-side, and its loopback listener is closed. Unbounded here;
   * the caller bounds the wait.
   */
  releaseSignIn(): Promise<void> {
    const settled = this.signInRun?.settled;
    this.cancelSignIn();
    // A run that rejects is already reported to its own caller; quit goes on.
    return settled
      ? settled.then(
          () => undefined,
          () => undefined
        )
      : Promise.resolve();
  }

  private async runBrowserSignIn(
    deps: ResolvedBrowserSignInDeps,
    run: SignInRun,
    {
      method,
      emailHint,
      framing,
      confirmation,
    }: {
      method?: DesktopSignInMethod;
      emailHint?: string;
      framing?: DesktopSignInFraming;
      confirmation?: DesktopSignInConfirmation;
    }
  ): Promise<DesktopBrowserSignInResult> {
    this.setState(DesktopAuthStatus.OpeningBrowser, null);

    const setup = await prepareBrowserSignIn(deps, method, emailHint, framing);
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
      // SECURITY (ISS-11127): register MUST start before openExternal. Once the
      // browser opens, code_challenge is readable from browser history, a
      // Referer or an access log, and /register is unauthenticated. A foreign
      // flowId bind (merging someone's PostHog person into the real user) is
      // blocked only by the desktop's own row winning the first write on
      // challenge_hash (skipDuplicates). Registration is fire-and-forget and
      // not awaited, so this ordering puts the desktop first only when its
      // write succeeds: a limiter rejection, the live-row cap or a network
      // failure leaves the challenge unclaimed for the run. Never reorder this
      // or re-register after the open.
      try {
        run.analytics?.register(pkce.codeChallenge);
      } catch {
        /* ISS-11127: best effort. */
      }
      // ISS-11127 (operator ruling on review): the browser counts as opened
      // once the open is requested, so a cancel during a slow cold launch,
      // after which the authorize page can still load, reports
      // creation_unconfirmed. Only a rejected open is creation_unattempted.
      run.browserOpened = true;
      try {
        await deps.openExternal(authorizeUrl);
      } catch {
        run.browserOpened = false;
        return this.settleSignIn(run, { ok: false, reason: "open_failed" });
      }
      if (this.signInSuperseded(run)) {
        return { ok: false, reason: "cancelled" };
      }

      this.setState(DesktopAuthStatus.AwaitingRedirect, null);
      const callback = await awaitLoopbackCallback(
        deps,
        run.abort.signal,
        listener,
        // The email journey (form + inbox round trip) outlives the OAuth-bounce
        // ceiling; see DESKTOP_EMAIL_CALLBACK_TIMEOUT_MS.
        method === DesktopSignInMethod.Email
          ? deps.emailCallbackTimeoutMs
          : deps.callbackTimeoutMs
      );
      if (callback.kind === "cancelled") {
        return this.settleSignIn(run, { ok: false, reason: "cancelled" });
      }
      if (callback.kind === "timeout") {
        return this.settleSignIn(run, {
          ok: false,
          reason: "redirect_timeout",
        });
      }
      // `state` must round-trip exactly, else this is a mix-up / CSRF attempt
      // rather than our own redirect. Checked FIRST so the outcomes below can
      // trust that the callback is ours.
      if (callback.state !== state) {
        return this.settleSignIn(run, { ok: false, reason: "state_mismatch" });
      }
      // The web consent screen reports a cancel by handing back an `error`
      // instead of a code. Answering it immediately is the whole point: without
      // this the run sits in AwaitingRedirect until the sign-in timeout, long
      // after the browser tab told the user to return to the desktop.
      if (callback.error) {
        return this.settleSignIn(run, { ok: false, reason: "cancelled" });
      }
      // A callback carrying our `state` but no code is not a usable redirect.
      if (!callback.code) {
        return this.settleSignIn(run, { ok: false, reason: "state_mismatch" });
      }
      if (this.signInSuperseded(run)) {
        return { ok: false, reason: "cancelled" };
      }
      // Latched BEFORE the redeem, so a created account whose exchange then
      // fails still reports the creation alongside the signed-out state it
      // settles into rather than losing the only record of it.
      run.accountCreated = callback.accountCreated;
      this.signInAccountCreated = callback.accountCreated;

      this.setState(DesktopAuthStatus.Exchanging, null);
      if (callback.desktopBootstrap) {
        const result = await this.bootstrapSession.redeem(deps, {
          code: callback.code,
          codeVerifier: pkce.codeVerifier,
          gatewayId: descriptor.gatewayId,
          redirectUri: listener.redirectUri,
        });
        return result.ok ? result : this.settleSignIn(run, result);
      }
      return await this.redeemAndComplete(deps, run, {
        code: callback.code,
        codeVerifier: pkce.codeVerifier,
        gatewayId: descriptor.gatewayId,
        redirectUri: listener.redirectUri,
        confirmation,
      });
    } finally {
      // The listener is single-use: release the ephemeral port whatever the
      // outcome (success, failure, timeout, or cancellation).
      await listener.close().catch(() => undefined);
    }
  }

  async createBootstrapOrganization(
    organization: DesktopBootstrapOrganizationInput
  ): Promise<DesktopBootstrapOrganizationResult> {
    return await this.bootstrapSession.createOrganization(organization);
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
      confirmation?: DesktopSignInConfirmation;
    }
  ): Promise<DesktopBrowserSignInResult> {
    const generation = this.sessionGeneration;
    let apiOrigin: string;
    let result: DesktopSessionResult<DesktopSessionTokens>;
    try {
      apiOrigin = this.resolveApiOrigin();
      result = await deps.redeem({
        apiOrigin,
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
    if (result.ok && input.confirmation) {
      return await this.adoptOnceConfirmed(deps, run, {
        generation,
        tokens: result.value,
        issuingOrigin: apiOrigin,
        confirmation: input.confirmation,
      });
    }
    if (result.ok && this.sessionGeneration === generation) {
      this.applyTokens(result.value, apiOrigin);
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
    // ISS-6334: a first-ever credential attempt that fails leaves the install
    // with no session at all, so no authenticated lane can report it. The
    // closed reason is mapped from the typed client error — never the message.
    //
    // Not reported for a SUPERSEDED run. A cancelled redeem can still fail
    // late, and the dedupe window is keyed on `outcome:reason`, so reporting it
    // would spend that window on a run nobody is waiting for and suppress the
    // replacement run's real failure for the next five minutes.
    if (!this.signInSuperseded(run)) {
      this.reportAuthFailure?.({
        outcome: signInExchangeFailedOutcome(run.accountCreated),
        reason: authReasonForSessionRequestError(result.error),
      });
    }
    return this.settleSignIn(run, { ok: false, reason });
  }

  /**
   * ISS-11345: adopt the redeemed session only after the user confirms the
   * account it belongs to. Until then it lives in this frame alone — never in
   * {@link session}, the store, or the access-token cache — so every reader
   * still sees a signed-out, non-authenticated install. Anything short of a
   * confirmation revokes it server-side.
   */
  private async adoptOnceConfirmed(
    deps: ResolvedBrowserSignInDeps,
    run: SignInRun,
    {
      generation,
      tokens,
      issuingOrigin,
      confirmation,
    }: {
      generation: number;
      tokens: DesktopSessionTokens;
      issuingOrigin: string;
      confirmation: DesktopSignInConfirmation;
    }
  ): Promise<DesktopBrowserSignInResult> {
    const live = () =>
      !this.signInSuperseded(run) && this.sessionGeneration === generation;
    const readAccount = () =>
      deps.fetchAccount(tokens.accessToken).catch(() => null);
    // One retry, so a single failed read does not cost a sign-in that
    // succeeded. Worst case: two `/desktop/identity` reads at 10s each.
    const account =
      (await readAccount()) ?? (live() ? await readAccount() : null);
    if (!live()) {
      await this.revokeUnadopted(tokens);
      return this.settleSignIn(run, { ok: false, reason: "cancelled" });
    }
    if (!isRedeemedAccount(account, tokens)) {
      deps.logDiagnostic(
        "Browser sign-in could not read the account it redeemed; not adopting it"
      );
      // Same pipe as a failed exchange: the install ends with no credential,
      // so no authenticated lane can report it.
      this.reportAuthFailure?.({
        outcome: signInExchangeFailedOutcome(run.accountCreated),
        reason: AuthReason.IdentityReadFailed,
      });
      await this.revokeUnadopted(tokens);
      return this.settleSignIn(run, { ok: false, reason: "exchange_failed" });
    }
    const { decision, confirm } = waitForSignInConfirmation(run.abort.signal);
    run.confirm = confirm;
    this.setState(DesktopAuthStatus.Exchanging, null, account);
    confirmation.onAwaitingConfirmation?.();
    const confirmed = await decision;
    run.confirm = undefined;
    if (confirmed && live()) {
      this.applyTokens(tokens, issuingOrigin);
      return { ok: true };
    }
    await this.revokeUnadopted(tokens);
    return this.settleSignIn(run, { ok: false, reason: "cancelled" });
  }

  /**
   * ISS-11345: the user's "yes" to the account an in-flight sign-in is holding.
   * A no-op when nothing is awaiting one — including after a cancel, which
   * releases the run before this could reach it.
   */
  confirmPendingSignIn(): void {
    this.signInRun?.confirm?.();
  }

  /** Best-effort server revoke of a redeemed session that was never adopted. */
  private async revokeUnadopted(tokens: DesktopSessionTokens): Promise<void> {
    try {
      await this.client.revoke({
        ...this.baseClientArgs(),
        refreshToken: tokens.refreshToken,
      });
    } catch {
      /* best effort: nothing local was ever written for this session */
    }
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
    if (!result.ok) {
      // ISS-11394: only a run that ended without a usable callback reports;
      // a cancellation never spends the replacement run's dedupe slot.
      const redirectReason = signInRedirectFailureReason(result.reason);
      if (redirectReason) {
        this.reportAuthFailure?.({
          outcome: signInRedirectFailedOutcome(run.framing),
          reason: redirectReason,
        });
      }
      this.reportSignInFailure(run, result.reason);
    }
    return this.finishSignIn(result);
  }

  private reportSignInFailure(
    run: SignInRun,
    reason: DesktopBrowserSignInFailure
  ): void {
    if (run.failureReported || this.session !== null) {
      return;
    }
    run.failureReported = true;
    const modes = onboardingFailedAccountModesForOutcome(
      desktopAuthAccountOutcome(
        DesktopAuthStatus.SignedOut,
        run.accountCreated
      ),
      run.browserOpened
    );
    if (!modes) {
      return;
    }
    try {
      run.analytics?.failed(modes, onboardingFailureReason(reason));
    } catch {
      /* ISS-11127: analytics must not change auth settlement. */
    }
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
    const clientArgs = this.baseClientArgs();
    const result = await this.client.refresh({
      ...clientArgs,
      refreshToken: session.refreshToken,
    });
    if (this.sessionGeneration !== generation) {
      // Credentials were cleared (e.g. a concurrent sign-out) while this refresh
      // was in flight. Drop the result rather than re-authenticating or clearing
      // a session that is no longer ours to touch.
      return result;
    }
    if (result.ok) {
      this.applyTokens(result.value, clientArgs.apiOrigin);
      return result;
    }
    // ISS-6334: report EVERY refresh failure, retryable or not. A retryable one
    // (network, 503) is exactly the install that is quietly stranded offline,
    // and it never reaches the clear-and-require-sign-in branch below.
    this.reportAuthFailure?.({
      outcome: AuthOutcome.TokenRefreshFailed,
      reason: authReasonForSessionRequestError(result.error),
    });
    if (!result.retryable) {
      // Revoked / expired / org-invalid / PoP-failed: clear and require sign-in.
      this.clearSession(DesktopAuthStatus.RefreshFailed);
    }
    return result;
  }

  private applyTokens(
    tokens: DesktopSessionTokens,
    issuingOrigin: string
  ): void {
    const record: DesktopSessionRecord = {
      refreshToken: tokens.refreshToken,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      userId: tokens.userId,
      organizationId: tokens.organizationId,
      gatewayId: this.resolveGatewayId(),
    };
    this.session = record;
    this.accessToken = tokens.accessToken;
    this.accessTokenOrigin = issuingOrigin;
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

  /** `keepStored` preserves an unreadable session. */
  private clearSession(
    status: DesktopAuthStatus,
    options?: { keepStored?: boolean }
  ): void {
    this.session = null;
    this.accessToken = null;
    this.accessTokenExpiresAtMs = null;
    this.bootstrapSession.clear();
    this.sessionGeneration += 1;
    // A sign-out or a revoked credential ends the auth return that carried the
    // creation fact, so the state it settles into is a plain `logged_out`.
    this.signInAccountCreated = false;
    if (!options?.keepStored) {
      // Clearing the on-disk record is best-effort: a safeStorage/disk failure
      // must not leave the in-memory state authenticated, so always reach
      // setState.
      try {
        this.store.clear();
      } catch {
        /* in-memory credentials are already cleared; retry on next write */
      }
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
    identity: { userId: string; organizationId: string } | null,
    pendingAccount?: DesktopIdentity,
    pendingUserId?: string
  ): void {
    let authGeneration = this.state.authGeneration ?? 0;
    if (
      (status === DesktopAuthStatus.Authenticated) !==
      this.isAuthenticated()
    ) {
      authGeneration += 1;
    }
    this.state = {
      status,
      authGeneration,
      userId: identity?.userId ?? null,
      organizationId: identity?.organizationId ?? null,
      accountOutcome: desktopAuthAccountOutcome(
        status,
        this.signInAccountCreated
      ),
      ...(pendingUserId ? { awaitingOrganization: true, pendingUserId } : {}),
      ...(pendingAccount ? { pendingAccount } : {}),
    };
    for (const listener of this.listeners) {
      // Isolated per subscriber (ISS-11273): the production fan-out starts with
      // the renderer push, so one throw there — a destroyed window mid-reload —
      // used to skip every later subscriber AND reject whatever called
      // `setState`, which on the boot path is the `restore()` that owns leaving
      // `Loading`. A transition nobody can observe is the same stranding as a
      // transition that never happened.
      try {
        listener(this.state);
      } catch (error) {
        this.logDiagnostic?.(
          `Auth state subscriber threw: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    // Existing-user resolution tracks every auth transition (PRD-532 §8 / M6).
    // It only ever derives what to OFFER the user — no auth transition mints a
    // session on its own.
    this.recomputeExistingUserResolution();
  }
}
