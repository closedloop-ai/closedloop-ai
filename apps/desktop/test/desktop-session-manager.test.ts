import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { DESKTOP_AUTHORIZE_QUERY_PARAMS } from "@repo/api/src/types/desktop-authorize-url";
import type { RedeemDesktopAuthorizationCodeInput } from "../src/main/desktop-authorize-client.js";
import type { DesktopPkce } from "../src/main/desktop-authorize-pkce.js";
import type {
  DesktopLoopbackListener,
  LoopbackCallback,
} from "../src/main/desktop-loopback-listener.js";
import type { DesktopPopHeaders } from "../src/main/desktop-pop.js";
import type {
  DesktopSessionResult,
  DesktopSessionTokens,
} from "../src/main/desktop-session-client.js";
import {
  type DesktopBrowserSignInDeps,
  DesktopSessionManager,
} from "../src/main/desktop-session-manager.js";
import {
  type DesktopSessionRecord,
  DesktopSessionStore,
} from "../src/main/desktop-session-store.js";
import type { SafeStorageLike } from "../src/main/electron-safe-storage.js";
// The DesktopAuthStatus runtime value lives in the shared wire-contract module
// (its canonical home); the manager re-exports only the type.
import { DesktopAuthStatus } from "../src/shared/contracts.js";
import { type Deferred, deferred } from "./deferred.js";

const API_ORIGIN = "https://api.closedloop.test";
const T0 = 1_700_000_000_000;
const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-session-manager-test-")
  );
});

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

function mockSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) =>
      Buffer.from(Buffer.from(s, "utf8").toString("base64"), "utf8"),
    decryptString: (b: Buffer) =>
      Buffer.from(b.toString("utf8"), "base64").toString("utf8"),
  };
}

function popSigner(): DesktopPopHeaders {
  return {
    "X-Desktop-Gateway-Id": "gateway-1",
    "X-Desktop-Timestamp": "1700000000",
    "X-Desktop-Signature": "sig",
  };
}

function makeTokens(
  overrides: Partial<DesktopSessionTokens> = {}
): DesktopSessionTokens {
  return {
    accessToken: "access-1",
    accessTokenExpiresAt: new Date(T0 + ACCESS_TTL_MS).toISOString(),
    refreshToken: "refresh-1",
    refreshTokenExpiresAt: new Date(T0 + REFRESH_TTL_MS).toISOString(),
    userId: "user-1",
    organizationId: "org-1",
    ...overrides,
  };
}

function storedRecord(
  overrides: Partial<DesktopSessionRecord> = {}
): DesktopSessionRecord {
  return {
    refreshToken: "stored-refresh",
    refreshTokenExpiresAt: new Date(T0 + REFRESH_TTL_MS).toISOString(),
    userId: "user-1",
    organizationId: "org-1",
    gatewayId: "gateway-1",
    ...overrides,
  };
}

type StubClient = {
  client: {
    refresh: () => Promise<DesktopSessionResult<DesktopSessionTokens>>;
    revoke: () => Promise<DesktopSessionResult<true>>;
  };
  calls: { refresh: number; revoke: number };
  setRefresh: (
    r:
      | DesktopSessionResult<DesktopSessionTokens>
      | (() => Promise<DesktopSessionResult<DesktopSessionTokens>>)
  ) => void;
};

function createStubClient(): StubClient {
  const calls = { refresh: 0, revoke: 0 };
  let refreshResult:
    | DesktopSessionResult<DesktopSessionTokens>
    | (() => Promise<DesktopSessionResult<DesktopSessionTokens>>) = {
    ok: true,
    value: makeTokens(),
  };

  return {
    calls,
    setRefresh: (r) => {
      refreshResult = r;
    },
    client: {
      refresh: () => {
        calls.refresh += 1;
        return typeof refreshResult === "function"
          ? refreshResult()
          : Promise.resolve(refreshResult);
      },
      revoke: () => {
        calls.revoke += 1;
        return Promise.resolve({ ok: true, value: true });
      },
    },
  };
}

function createManager(options?: {
  stub?: StubClient;
  now?: () => number;
  storeName?: string;
  browserSignIn?: DesktopBrowserSignInDeps;
}): { manager: DesktopSessionManager; store: DesktopSessionStore } {
  const store = new DesktopSessionStore({
    cwd: tempRoot,
    name: options?.storeName ?? "dsm",
    safeStorage: mockSafeStorage(),
  });
  const stub = options?.stub ?? createStubClient();
  const manager = new DesktopSessionManager({
    store,
    popSigner,
    resolveApiOrigin: () => API_ORIGIN,
    resolveGatewayId: () => "gateway-1",
    now: options?.now ?? (() => T0),
    client: stub.client as never,
    browserSignIn: options?.browserSignIn,
  });
  return { manager, store };
}

const AUTHORIZE_REDIRECT_URI = "http://127.0.0.1:49152/cb";

function loopbackPkce(): DesktopPkce {
  return {
    codeVerifier: "verifier-1",
    codeChallenge: "challenge-1",
    codeChallengeMethod: "S256",
  };
}

/** Resolves null when the signal aborts — the fake listener's abort branch. */
function resolveOnAbort(signal: AbortSignal): Promise<null> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    signal.addEventListener("abort", () => resolve(null), { once: true });
  });
}

type LoopbackStubState = {
  descriptorThrows: boolean;
  listenerStartRejects: boolean;
  /** When set, startLoopbackListener resolves only once this gate resolves. */
  listenerStartGate?: Deferred<void>;
  openShouldThrow: boolean;
  openCalls: string[];
  redeemResult: DesktopSessionResult<DesktopSessionTokens>;
  /** When true, the redeem port rejects (models a thrown, not a typed failure). */
  redeemThrows: boolean;
  redeemCalls: number;
  redeemInputs: RedeemDesktopAuthorizationCodeInput[];
  onRedeem?: () => void;
  closeCalls: number;
  waitCalls: number;
  /** Value waitForCallback resolves with. A `{ code }` object models the real
   *  callback; the harness never returns the top-level `null` (that is abort). */
  callbackValue: LoopbackCallback;
  /** When set, waitForCallback resolves only once this gate resolves. */
  callbackGate?: Deferred<void>;
  onWait?: () => void;
  /** When true, the injected callback-timeout timer fires (the callback loses). */
  timeoutFires: boolean;
  oauthState: string;
  /** Race signal captured from the last delayMs call (timeout side). */
  timeoutSignal?: AbortSignal;
  /** Race signal captured from the last waitForCallback call (callback side). */
  waitSignal?: AbortSignal;
  /** Diagnostic messages captured from logDiagnostic (start-failure causes). */
  diagnostics: string[];
};

function createLoopbackStub(): {
  deps: DesktopBrowserSignInDeps;
  state: LoopbackStubState;
} {
  const state: LoopbackStubState = {
    descriptorThrows: false,
    listenerStartRejects: false,
    openShouldThrow: false,
    openCalls: [],
    redeemResult: {
      ok: true,
      value: makeTokens({ refreshToken: "redeemed-refresh" }),
    },
    redeemThrows: false,
    redeemCalls: 0,
    redeemInputs: [],
    closeCalls: 0,
    waitCalls: 0,
    callbackValue: { code: "auth-code", state: "state-1" },
    timeoutFires: false,
    oauthState: "state-1",
    diagnostics: [],
  };

  const listener: DesktopLoopbackListener = {
    redirectUri: AUTHORIZE_REDIRECT_URI,
    waitForCallback: (signal) => {
      state.waitCalls += 1;
      state.waitSignal = signal;
      state.onWait?.();
      const gated = (async (): Promise<LoopbackCallback | null> => {
        if (state.callbackGate) {
          await state.callbackGate.promise;
        }
        return state.callbackValue;
      })();
      return Promise.race([gated, resolveOnAbort(signal)]);
    },
    close: () => {
      state.closeCalls += 1;
      return Promise.resolve();
    },
  };

  const deps: DesktopBrowserSignInDeps = {
    resolveWebAppOrigin: () => "https://app.closedloop.test",
    resolveDeviceDescriptor: () => {
      if (state.descriptorThrows) {
        throw new Error("signing key unavailable");
      }
      return {
        gatewayId: "gateway-1",
        gatewayPublicKeyPem: "public-key-pem",
        machineName: "test-machine",
        platform: "darwin",
        desktopVersion: "1.0.0",
      };
    },
    openExternal: (url: string) => {
      state.openCalls.push(url);
      return state.openShouldThrow
        ? Promise.reject(new Error("blocked"))
        : Promise.resolve();
    },
    logDiagnostic: (message: string) => {
      state.diagnostics.push(message);
    },
    startLoopbackListener: async () => {
      if (state.listenerStartRejects) {
        throw new Error("port bind failed");
      }
      if (state.listenerStartGate) {
        await state.listenerStartGate.promise;
      }
      return listener;
    },
    generatePkce: loopbackPkce,
    generateState: () => state.oauthState,
    redeem: (input) => {
      state.redeemCalls += 1;
      state.redeemInputs.push(input);
      state.onRedeem?.();
      return state.redeemThrows
        ? Promise.reject(new Error("redeem crashed"))
        : Promise.resolve(state.redeemResult);
    },
    callbackTimeoutMs: 1000,
    delayMs: (_ms, signal) => {
      state.timeoutSignal = signal;
      return state.timeoutFires
        ? Promise.resolve()
        : new Promise<void>(() => undefined);
    },
  };
  return { deps, state };
}

test("restore with no stored session becomes signed out", async () => {
  const { manager } = createManager({ storeName: "dsm-none" });
  await manager.restore();
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
  assert.equal(manager.getIdentity(), null);
});

test("restore refreshes a stored session and becomes authenticated", async () => {
  const stub = createStubClient();
  stub.setRefresh({
    ok: true,
    value: makeTokens({ refreshToken: "rotated-refresh" }),
  });
  const { manager, store } = createManager({ stub, storeName: "dsm-restore" });
  store.setSession(storedRecord());

  await manager.restore();

  assert.equal(manager.getState().status, DesktopAuthStatus.Authenticated);
  assert.deepEqual(manager.getIdentity(), {
    userId: "user-1",
    organizationId: "org-1",
  });
  assert.equal(await manager.getAccessToken(), "access-1");
  // The rotated refresh token was persisted.
  assert.equal(store.getSession()?.refreshToken, "rotated-refresh");
});

test("restore clears credentials on a non-retryable refresh failure", async () => {
  const stub = createStubClient();
  stub.setRefresh({ ok: false, error: "invalid", retryable: false });
  const { manager, store } = createManager({ stub, storeName: "dsm-invalid" });
  store.setSession(storedRecord());

  await manager.restore();

  assert.equal(manager.getState().status, DesktopAuthStatus.RefreshFailed);
  assert.equal(manager.getIdentity(), null);
  assert.equal(store.hasSession(), false, "invalid session must be cleared");
});

test("restore preserves credentials on a retryable network failure", async () => {
  const stub = createStubClient();
  stub.setRefresh({ ok: false, error: "network", retryable: true });
  const { manager, store } = createManager({ stub, storeName: "dsm-network" });
  store.setSession(storedRecord());

  await manager.restore();

  assert.equal(manager.getState().status, DesktopAuthStatus.Authenticated);
  assert.equal(store.hasSession(), true, "credentials preserved for retry");
});

test("getAccessToken serves the cached token within the expiry skew", async () => {
  const stub = createStubClient();
  let nowMs = T0;
  const { manager, store } = createManager({
    stub,
    now: () => nowMs,
    storeName: "dsm-cache",
  });
  store.setSession(storedRecord());
  await manager.restore();
  assert.equal(stub.calls.refresh, 1);

  // 5 minutes in, still well before the 15-minute expiry minus 60s skew.
  nowMs = T0 + 5 * 60 * 1000;
  assert.equal(await manager.getAccessToken(), "access-1");
  assert.equal(stub.calls.refresh, 1, "no extra refresh while token is fresh");
});

test("getAccessToken refreshes once when concurrent calls race past expiry", async () => {
  const stub = createStubClient();
  let nowMs = T0;
  const { manager, store } = createManager({
    stub,
    now: () => nowMs,
    storeName: "dsm-single-flight",
  });
  store.setSession(storedRecord());
  await manager.restore();
  assert.equal(stub.calls.refresh, 1);

  // Past expiry — the cached token is stale.
  nowMs = T0 + ACCESS_TTL_MS + 1000;

  const gate = deferred<DesktopSessionResult<DesktopSessionTokens>>();
  stub.setRefresh(() => gate.promise);

  const first = manager.getAccessToken();
  const second = manager.getAccessToken();
  // Both callers should be coalesced into a single in-flight refresh.
  assert.equal(
    stub.calls.refresh,
    2,
    "one additional refresh for both callers"
  );

  gate.resolve({ ok: true, value: makeTokens({ accessToken: "access-2" }) });
  assert.equal(await first, "access-2");
  assert.equal(await second, "access-2");
});

test("signOut revokes the session and clears credentials", async () => {
  const stub = createStubClient();
  const { manager, store } = createManager({ stub, storeName: "dsm-signout" });
  store.setSession(storedRecord());
  await manager.restore();
  assert.equal(manager.getState().status, DesktopAuthStatus.Authenticated);

  await manager.signOut();

  assert.equal(stub.calls.revoke, 1);
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
  assert.equal(store.hasSession(), false);
  assert.equal(await manager.getAccessToken(), null);
});

test("sign-out during an in-flight refresh is not overwritten by the resolving refresh", async () => {
  const stub = createStubClient();
  let nowMs = T0;
  const { manager, store } = createManager({
    stub,
    now: () => nowMs,
    storeName: "dsm-signout-race",
  });
  store.setSession(storedRecord());
  await manager.restore();
  assert.equal(manager.getState().status, DesktopAuthStatus.Authenticated);

  // Past expiry: the next getAccessToken starts a fresh refresh, which we gate.
  nowMs = T0 + ACCESS_TTL_MS + 1000;
  const gate = deferred<DesktopSessionResult<DesktopSessionTokens>>();
  stub.setRefresh(() => gate.promise);

  const tokenPromise = manager.getAccessToken();
  assert.equal(stub.calls.refresh, 2, "a refresh is in flight");

  // Sign out while that refresh is still in flight; revoke resolves first.
  await manager.signOut();
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);

  // The refresh now resolves with valid tokens — it must NOT re-authenticate
  // the signed-out user or write credentials back to disk.
  gate.resolve({ ok: true, value: makeTokens({ refreshToken: "rotated" }) });
  assert.equal(await tokenPromise, null);

  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
  assert.equal(manager.getIdentity(), null);
  assert.equal(
    store.hasSession(),
    false,
    "no credentials persisted after sign-out"
  );
});

test("beginBrowserSignIn opens the authorize URL, redeems the callback code, and authenticates", async () => {
  const loopback = createLoopbackStub();
  const { manager, store } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-ok",
  });
  const statuses: string[] = [];
  manager.subscribe((state) => statuses.push(state.status));

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: true });
  const opened = new URL(loopback.state.openCalls[0]);
  const openedParams = opened.searchParams;
  const key = DESKTOP_AUTHORIZE_QUERY_PARAMS;
  assert.equal(opened.origin, "https://app.closedloop.test");
  assert.equal(opened.pathname, "/settings/integrations/desktop/authorize");
  assert.equal(openedParams.get(key.codeChallenge), "challenge-1");
  assert.equal(openedParams.get(key.codeChallengeMethod), "S256");
  assert.equal(openedParams.get(key.state), "state-1");
  assert.equal(openedParams.get(key.redirectUri), AUTHORIZE_REDIRECT_URI);
  assert.equal(openedParams.get(key.gatewayId), "gateway-1");
  assert.equal(openedParams.get(key.deviceName), "test-machine");

  const redeemInput = loopback.state.redeemInputs[0];
  assert.equal(redeemInput.apiOrigin, API_ORIGIN);
  assert.equal(redeemInput.code, "auth-code");
  assert.equal(redeemInput.codeVerifier, "verifier-1");
  assert.equal(redeemInput.gatewayId, "gateway-1");
  assert.equal(redeemInput.redirectUri, AUTHORIZE_REDIRECT_URI);

  assert.equal(manager.getState().status, DesktopAuthStatus.Authenticated);
  assert.deepEqual(manager.getIdentity(), {
    userId: "user-1",
    organizationId: "org-1",
  });
  assert.equal(store.getSession()?.refreshToken, "redeemed-refresh");
  assert.equal(loopback.state.closeCalls, 1, "listener closed after success");
  assert.equal(
    loopback.state.timeoutSignal?.aborted,
    true,
    "callback-timeout timer torn down once the callback won"
  );
  assert.deepEqual(statuses, [
    DesktopAuthStatus.OpeningBrowser,
    DesktopAuthStatus.AwaitingRedirect,
    DesktopAuthStatus.Exchanging,
    DesktopAuthStatus.Authenticated,
  ]);
});

test("beginBrowserSignIn returns start_failed when a resolver port throws", async () => {
  const loopback = createLoopbackStub();
  loopback.state.descriptorThrows = true;
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-descriptor-throw",
  });

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "start_failed" });
  assert.equal(loopback.state.openCalls.length, 0, "browser never opened");
  assert.equal(
    manager.getState().status,
    DesktopAuthStatus.SignedOut,
    "never stranded in opening_browser"
  );
  assert.deepEqual(
    loopback.state.diagnostics,
    ["Browser sign-in failed to start: signing key unavailable"],
    "the swallowed root cause is surfaced to diagnostics"
  );
});

test("beginBrowserSignIn returns start_failed when the loopback listener won't start", async () => {
  const loopback = createLoopbackStub();
  loopback.state.listenerStartRejects = true;
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-listener-fail",
  });

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "start_failed" });
  assert.equal(loopback.state.openCalls.length, 0);
  assert.deepEqual(
    loopback.state.diagnostics,
    ["Browser sign-in failed to start: port bind failed"],
    "the loopback bind failure is surfaced to diagnostics"
  );
});

test("beginBrowserSignIn returns open_failed and closes the listener when the browser can't launch", async () => {
  const loopback = createLoopbackStub();
  loopback.state.openShouldThrow = true;
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-open-fail",
  });

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "open_failed" });
  assert.equal(loopback.state.closeCalls, 1, "listener closed on open failure");
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
});

test("beginBrowserSignIn rejects a callback whose state does not match", async () => {
  const loopback = createLoopbackStub();
  loopback.state.callbackValue = { code: "auth-code", state: "wrong-state" };
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-state-mismatch",
  });

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "state_mismatch" });
  assert.equal(loopback.state.redeemCalls, 0, "no redeem on state mismatch");
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
});

test("beginBrowserSignIn rejects a callback with no code as a state mismatch", async () => {
  const loopback = createLoopbackStub();
  loopback.state.callbackValue = { code: null, state: "state-1" };
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-no-code",
  });

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "state_mismatch" });
  assert.equal(loopback.state.redeemCalls, 0);
});

test("beginBrowserSignIn times out when no loopback callback arrives", async () => {
  const loopback = createLoopbackStub();
  loopback.state.callbackGate = deferred<void>(); // callback never resolves
  loopback.state.timeoutFires = true;
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-timeout",
  });

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "redirect_timeout" });
  assert.equal(loopback.state.redeemCalls, 0);
  assert.equal(loopback.state.closeCalls, 1, "listener closed on timeout");
  assert.equal(
    loopback.state.waitSignal?.aborted,
    true,
    "loopback wait torn down once the timeout won"
  );
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
});

test("beginBrowserSignIn maps an invalid/expired code to expired", async () => {
  const loopback = createLoopbackStub();
  loopback.state.redeemResult = {
    ok: false,
    error: "invalid",
    retryable: false,
  };
  const { manager, store } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-code-invalid",
  });

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "expired" });
  assert.equal(store.hasSession(), false);
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
});

test("beginBrowserSignIn maps a PoP-rejected redeem to exchange_failed", async () => {
  const loopback = createLoopbackStub();
  loopback.state.redeemResult = {
    ok: false,
    error: "pop_rejected",
    retryable: false,
  };
  const { manager, store } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-redeem-pop",
  });

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "exchange_failed" });
  assert.equal(store.hasSession(), false);
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
});

test("beginBrowserSignIn is unavailable without browser sign-in ports", async () => {
  const { manager } = createManager({ storeName: "dsm-signin-unavailable" });
  const result = await manager.beginBrowserSignIn();
  assert.deepEqual(result, { ok: false, reason: "unavailable" });
});

test("beginBrowserSignIn rejects a concurrent call as already_in_progress", async () => {
  const loopback = createLoopbackStub();
  const gate = deferred<void>();
  loopback.state.callbackGate = gate;
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-concurrent",
  });

  const first = manager.beginBrowserSignIn();
  const second = await manager.beginBrowserSignIn();
  assert.deepEqual(second, { ok: false, reason: "already_in_progress" });

  gate.resolve();
  assert.deepEqual(await first, { ok: true });
});

test("beginBrowserSignIn rejects when a session already exists", async () => {
  const loopback = createLoopbackStub();
  const { manager, store } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-have-session",
  });
  store.setSession(storedRecord());
  await manager.restore();
  assert.equal(manager.getState().status, DesktopAuthStatus.Authenticated);

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "already_in_progress" });
  assert.equal(loopback.state.openCalls.length, 0, "never opened a browser");
});

test("cancelSignIn frees the run slot so a later sign-in is not locked out", async () => {
  const loopback = createLoopbackStub();
  const gate = deferred<void>();
  loopback.state.callbackGate = gate;
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-lockout",
  });

  // The first run parks awaiting the loopback callback; cancel releases the slot
  // synchronously so a second sign-in is not rejected as already_in_progress.
  const first = manager.beginBrowserSignIn();
  manager.cancelSignIn();
  loopback.state.callbackGate = undefined; // the retry's callback resolves at once
  const second = await manager.beginBrowserSignIn();

  assert.deepEqual(await first, { ok: false, reason: "cancelled" });
  assert.deepEqual(second, { ok: true });
  assert.equal(manager.getState().status, DesktopAuthStatus.Authenticated);
});

test("signOut cancels an in-flight browser sign-in", async () => {
  const loopback = createLoopbackStub();
  loopback.state.callbackGate = deferred<void>();
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-signout",
  });
  // signOut() synchronously cancels the run the instant it parks on the callback.
  let signOut: Promise<void> | undefined;
  loopback.state.onWait = () => {
    signOut = manager.signOut();
  };

  const result = await manager.beginBrowserSignIn();
  await signOut;

  assert.deepEqual(result, { ok: false, reason: "cancelled" });
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
});

test("a cancel during the redeem does not authenticate the device", async () => {
  const loopback = createLoopbackStub();
  const { manager, store } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-cancel-redeem",
  });
  // Cancel fires the instant the redeem request is issued (mid round-trip).
  loopback.state.onRedeem = () => manager.cancelSignIn();

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "cancelled" });
  assert.equal(store.hasSession(), false, "no session persisted after cancel");
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
  assert.equal(await manager.getAccessToken(), null);
});

test("a cancel during the async listener start never opens a browser", async () => {
  const loopback = createLoopbackStub();
  const startGate = deferred<void>();
  loopback.state.listenerStartGate = startGate;
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-cancel-setup",
  });

  // The run parks inside prepareSignIn awaiting the (gated) listener start;
  // cancel supersedes it before setup completes.
  const first = manager.beginBrowserSignIn();
  manager.cancelSignIn();
  startGate.resolve(); // setup finishes, but the run is now superseded

  assert.deepEqual(await first, { ok: false, reason: "cancelled" });
  assert.equal(
    loopback.state.openCalls.length,
    0,
    "browser never opened for a superseded run"
  );
  assert.equal(loopback.state.redeemCalls, 0);
  assert.equal(
    loopback.state.closeCalls,
    1,
    "the listener started during setup is released"
  );
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
});

test("a thrown redeem settles to exchange_failed without stranding exchanging", async () => {
  const loopback = createLoopbackStub();
  loopback.state.redeemThrows = true; // redeem rejects instead of returning a typed result
  const statuses: string[] = [];
  const { manager, store } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-redeem-throw",
  });
  manager.subscribe((state) => statuses.push(state.status));

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "exchange_failed" });
  assert.equal(store.hasSession(), false);
  // It reaches exchanging, then settles back out of it — never stranded.
  assert.ok(
    statuses.includes(DesktopAuthStatus.Exchanging),
    "entered exchanging"
  );
  assert.equal(
    statuses.at(-1),
    DesktopAuthStatus.SignedOut,
    "settled back to a resting state"
  );
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
});

test("subscribe is notified on state transitions", async () => {
  const stub = createStubClient();
  const { manager, store } = createManager({
    stub,
    storeName: "dsm-subscribe",
  });
  store.setSession(storedRecord());
  const statuses: string[] = [];
  manager.subscribe((state) => statuses.push(state.status));

  await manager.restore(); // stored session refreshes -> authenticated
  await manager.signOut(); // revoke + clear -> signed out

  assert.deepEqual(statuses, [
    DesktopAuthStatus.Authenticated,
    DesktopAuthStatus.SignedOut,
  ]);
});
