/**
 * Shared fixtures for the `DesktopSessionManager` suites.
 *
 * Extracted when `desktop-session-manager.test.ts` crossed its grandfathered
 * line ceiling (ISS-5112): the browser sign-in tests moved to their own file and
 * both halves need the same manager, store, clock and loopback stubs. One copy
 * here rather than two drifting ones — the loopback stub in particular models
 * enough of the real ports (abort races, gated callbacks, timeout signals) that
 * a second hand-rolled version would not stay equivalent for long.
 *
 * Deliberately NOT a `*.test.ts` file: `scripts/run-node-tests.mjs` globs
 * `test/*.test.ts` non-recursively, so nothing in this directory is collected as
 * a suite of its own.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "node:test";
import type { RedeemDesktopAuthorizationCodeInput } from "../../src/main/auth/desktop-authorize-client.js";
import type { DesktopPkce } from "../../src/main/auth/desktop-authorize-pkce.js";
import type {
  DesktopLoopbackListener,
  LoopbackCallback,
} from "../../src/main/auth/desktop-loopback-listener.js";
import type { DesktopPopHeaders } from "../../src/main/auth/desktop-pop.js";
import type {
  DesktopSessionResult,
  DesktopSessionTokens,
} from "../../src/main/session/desktop-session-client.js";
import {
  type DesktopBrowserSignInDeps,
  type DesktopExistingUserDeps,
  DesktopSessionManager,
} from "../../src/main/session/desktop-session-manager.js";
import {
  type DesktopSessionRecord,
  DesktopSessionStore,
} from "../../src/main/session/desktop-session-store.js";
import type { SafeStorageLike } from "../../src/main/util/electron-safe-storage.js";
import type { Deferred } from "../deferred.js";

let tempRoot = "";

/**
 * Register the per-test temp store root. Call once at module scope in each
 * suite that builds a manager: the store writes real files, so every test needs
 * its own directory and a guaranteed cleanup.
 */
export function installTempRoot(): void {
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
}

export const API_ORIGIN = "https://api.closedloop.test";
export const T0 = 1_700_000_000_000;
export const ACCESS_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function mockSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) =>
      Buffer.from(Buffer.from(s, "utf8").toString("base64"), "utf8"),
    decryptString: (b: Buffer) =>
      Buffer.from(b.toString("utf8"), "base64").toString("utf8"),
  };
}

export function popSigner(): DesktopPopHeaders {
  return {
    "X-Desktop-Gateway-Id": "gateway-1",
    "X-Desktop-Timestamp": "1700000000",
    "X-Desktop-Signature": "sig",
  };
}

export function makeTokens(
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

export function storedRecord(
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

export type StubClient = {
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

export function createStubClient(): StubClient {
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

export function createManager(options?: {
  stub?: StubClient;
  now?: () => number;
  storeName?: string;
  browserSignIn?: DesktopBrowserSignInDeps;
  existingUser?: DesktopExistingUserDeps;
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
    existingUser: options?.existingUser,
  });
  return { manager, store };
}

export type ExistingUserStub = {
  deps: DesktopExistingUserDeps;
  state: { hasApiKey: boolean; dismissed: boolean; persistCalls: number };
};

/**
 * In-memory existing-user ports. They only derive the one-time sync prompt —
 * there is deliberately no seam that mints a session, so no auth transition can
 * sign the user back in on its own.
 */
export function createExistingUserStub(options?: {
  hasApiKey?: boolean;
  dismissed?: boolean;
}): ExistingUserStub {
  const state = {
    hasApiKey: options?.hasApiKey ?? true,
    dismissed: options?.dismissed ?? false,
    persistCalls: 0,
  };
  const deps: DesktopExistingUserDeps = {
    hasApiKey: () => state.hasApiKey,
    hasDismissedPrompt: () => state.dismissed,
    persistDismissal: () => {
      state.dismissed = true;
      state.persistCalls += 1;
    },
  };
  return { deps, state };
}

export const AUTHORIZE_REDIRECT_URI = "http://127.0.0.1:49152/cb";

export function loopbackPkce(): DesktopPkce {
  return {
    codeVerifier: "verifier-1",
    codeChallenge: "challenge-1",
    codeChallengeMethod: "S256",
  };
}

/** Resolves null when the signal aborts — the fake listener's abort branch. */
export function resolveOnAbort(signal: AbortSignal): Promise<null> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    signal.addEventListener("abort", () => resolve(null), { once: true });
  });
}

export type LoopbackStubState = {
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

export function createLoopbackStub(): {
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
    callbackValue: { code: "auth-code", state: "state-1", error: null },
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
