/**
 * Unit tests for apps/desktop/src/main/loop-sleep-recovery.ts
 *
 * Covers:
 *   - resume triggers refresh and heartbeat for all active loops
 *   - handles zero active loops gracefully
 *   - handles refresh failures without blocking heartbeat
 *   - registerLoop and unregisterLoop manage the registry correctly
 *
 * Strategy: `onResume` is exported for testing. `refreshLoopTokenSingleflight`
 * and `sendHeartbeatNow` use `globalThis.fetch` internally; stubbing fetch lets
 * us control their behavior and verify the calls without mocking ES modules.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  init,
  onResume,
  registerLoop,
  resetForTesting,
  unregisterLoop,
} from "../src/main/loop-sleep-recovery.js";
import type { LoopTokenStore } from "../src/main/loop-token-store.js";
import {
  createTestLoopTokenStore,
  flushAsync as flushOnce,
} from "./loop-token-test-utils.js";

// ---------------------------------------------------------------------------
// Shared fetch stub infrastructure
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

type CapturedFetchCall = {
  url: string;
  method: string;
  authorization: string | undefined;
  sessionToken: string | undefined;
};

let capturedFetchCalls: CapturedFetchCall[] = [];
let tempRoot = "";

// ---------------------------------------------------------------------------
// Fetch stubs
// ---------------------------------------------------------------------------

/**
 * Captures fetch calls and routes refresh-token URLs through `handleRefresh`.
 * All other URLs return 200 with an empty body (heartbeat endpoint).
 */
function installFetchStub(handleRefresh: () => Promise<Response>): void {
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    capturedFetchCalls.push({
      url,
      method: init?.method ?? "GET",
      authorization: headers.get("authorization") ?? undefined,
      sessionToken: headers.get("x-session-token") ?? undefined,
    });
    if (url.includes("refresh-token")) {
      return handleRefresh();
    }
    return new Response("", { status: 200 });
  }) as typeof fetch;
}

function installSuccessFetchStub(loopToken = "refreshed-token"): void {
  installFetchStub(() =>
    Promise.resolve(
      new Response(JSON.stringify({ token: loopToken, jti: "test-jti" }), {
        status: 200,
      })
    )
  );
}

function installRefreshThrowingFetchStub(): void {
  installFetchStub(() => {
    throw new Error("simulated network error during refresh");
  });
}

function installRefreshFailureFetchStub(): void {
  installFetchStub(() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
    )
  );
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStore(name: string): LoopTokenStore {
  return createTestLoopTokenStore(tempRoot, name);
}

/**
 * Waits for all pending microtasks and macrotasks so that fire-and-forget
 * async work initiated by onResume() has a chance to complete before
 * assertions run. Two rounds of setImmediate cover the async chains inside
 * handleResumeForLoop (refresh await + synchronous sendHeartbeatNow + the
 * fetch inside onTick which is itself fire-and-forget).
 */
async function flushAsync(): Promise<void> {
  await flushOnce();
  await flushOnce();
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "loop-sleep-recovery-test-")
  );
  capturedFetchCalls = [];
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
  // Reset all module-level state so tests are fully independent.
  resetForTesting();
});

// ---------------------------------------------------------------------------
// Resume triggers refresh and heartbeat for all active loops
// ---------------------------------------------------------------------------

describe("loop-sleep-recovery: resume with active loops", () => {
  test("resume triggers refresh and heartbeat for all active loops", async () => {
    installSuccessFetchStub();

    const storeA = makeStore("store-a");
    storeA.setLoopToken("loop-a", { token: "runner-token-a" });
    const storeB = makeStore("store-b");
    storeB.setLoopToken("loop-b", { token: "runner-token-b" });

    registerLoop("loop-a", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "runner-token-a",
      loopTokenStore: storeA,
    });
    registerLoop("loop-b", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "runner-token-b",
      loopTokenStore: storeB,
    });

    onResume();
    await flushAsync();

    const refreshCalls = capturedFetchCalls.filter((c) =>
      c.url.includes("refresh-token")
    );
    const heartbeatCalls = capturedFetchCalls.filter((c) =>
      c.url.includes("heartbeat")
    );

    assert.equal(
      refreshCalls.length,
      2,
      "expected one refresh call per active loop"
    );
    assert.equal(
      heartbeatCalls.length,
      2,
      "expected one heartbeat call per active loop"
    );

    const refreshedLoopIds = refreshCalls
      .map((c) => {
        const match = /\/loops\/([^/]+)\/refresh-token/.exec(c.url);
        return match?.[1] ?? "";
      })
      .sort();
    assert.deepEqual(refreshedLoopIds, ["loop-a", "loop-b"]);

    const heartbeatLoopIds = heartbeatCalls
      .map((c) => {
        const match = /\/loops\/([^/]+)\/heartbeat/.exec(c.url);
        return match?.[1] ?? "";
      })
      .sort();
    assert.deepEqual(heartbeatLoopIds, ["loop-a", "loop-b"]);
  });

  test("resume issues calls with the correct Authorization header", async () => {
    // PLN-740: postLoopHeartbeat now prefers getTokenMeta over getToken when both are
    // supplied. The stored runner token (from loopTokenStore) takes precedence.
    installSuccessFetchStub();

    const store = makeStore("store-auth");
    store.setLoopToken("loop-a", { token: "runner-token" });

    registerLoop("loop-a", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "gateway-token",
      loopTokenStore: store,
    });

    onResume();
    await flushAsync();

    // The refresh fires first (updating the store to "refreshed-token"),
    // then the heartbeat fires using the updated token via getTokenMeta.
    // The refresh call uses getToken ("gateway-token"); the heartbeat uses
    // the refreshed token from the store ("refreshed-token").
    const heartbeatCalls = capturedFetchCalls.filter((c) =>
      c.url.includes("heartbeat")
    );
    const refreshCalls = capturedFetchCalls.filter((c) =>
      c.url.includes("refresh-token")
    );

    for (const call of refreshCalls) {
      assert.equal(
        call.authorization,
        "Bearer gateway-token",
        "expected Bearer gateway-token on refresh"
      );
    }
    // Heartbeat uses the refreshed token (stored by the refresh response).
    for (const call of heartbeatCalls) {
      assert.ok(
        call.authorization === "Bearer runner-token" ||
          call.authorization === "Bearer refreshed-token",
        `expected a Bearer token on heartbeat (got ${call.authorization})`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Handles zero active loops gracefully
// ---------------------------------------------------------------------------

describe("loop-sleep-recovery: zero active loops", () => {
  test("handles zero active loops gracefully — no fetch calls are issued", async () => {
    installSuccessFetchStub();

    // Ensure no loops are registered (afterEach cleans up loop-a/b/c;
    // additional cleanup here for safety).
    unregisterLoop("loop-a");
    unregisterLoop("loop-b");
    unregisterLoop("loop-c");

    // onResume must not throw and must not issue any fetch calls.
    assert.doesNotThrow(() => {
      onResume();
    });
    await flushAsync();

    assert.equal(
      capturedFetchCalls.length,
      0,
      "no fetch calls should occur when no loops are registered"
    );
  });
});

// ---------------------------------------------------------------------------
// Handles refresh failures without blocking heartbeat
// ---------------------------------------------------------------------------

describe("loop-sleep-recovery: refresh failure handling", () => {
  test("heartbeat fires even when the refresh network call throws", async () => {
    installRefreshThrowingFetchStub();

    const store = makeStore("store-throw");
    store.setLoopToken("loop-a", { token: "runner-token" });

    registerLoop("loop-a", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "gateway-token",
      loopTokenStore: store,
    });

    // onResume is fire-and-forget; it must not propagate the thrown error.
    assert.doesNotThrow(() => {
      onResume();
    });
    await flushAsync();

    const heartbeatCalls = capturedFetchCalls.filter((c) =>
      c.url.includes("heartbeat")
    );
    assert.equal(
      heartbeatCalls.length,
      1,
      "heartbeat must still fire even when refresh throws a network error"
    );
    assert.ok(
      heartbeatCalls[0]!.url.includes("loop-a"),
      "heartbeat must target the correct loopId"
    );
  });

  test("heartbeat fires even when the refresh call returns a non-OK response", async () => {
    installRefreshFailureFetchStub();

    const store = makeStore("store-fail");
    store.setLoopToken("loop-a", { token: "runner-token" });

    registerLoop("loop-a", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "gateway-token",
      loopTokenStore: store,
    });

    onResume();
    await flushAsync();

    const heartbeatCalls = capturedFetchCalls.filter((c) =>
      c.url.includes("heartbeat")
    );
    assert.equal(
      heartbeatCalls.length,
      1,
      "heartbeat must still fire even when the refresh endpoint returns a failure status"
    );
  });
});

// ---------------------------------------------------------------------------
// registerLoop and unregisterLoop manage the registry
// ---------------------------------------------------------------------------

describe("loop-sleep-recovery: registry management", () => {
  test("registerLoop adds the loop so it participates in resume recovery", async () => {
    installSuccessFetchStub();

    const store = makeStore("store-register");
    store.setLoopToken("loop-a", { token: "runner-token" });

    registerLoop("loop-a", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "gateway-token",
      loopTokenStore: store,
    });

    onResume();
    await flushAsync();

    assert.ok(
      capturedFetchCalls.some((c) => c.url.includes("loop-a")),
      "registered loop must be included in resume recovery"
    );
  });

  test("unregisterLoop removes the loop so it no longer participates in resume recovery", async () => {
    installSuccessFetchStub();

    const store = makeStore("store-unregister");
    store.setLoopToken("loop-a", { token: "runner-token" });

    registerLoop("loop-a", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "gateway-token",
      loopTokenStore: store,
    });
    unregisterLoop("loop-a");

    onResume();
    await flushAsync();

    assert.equal(
      capturedFetchCalls.filter((c) => c.url.includes("loop-a")).length,
      0,
      "unregistered loop must not trigger any fetch calls on resume"
    );
  });

  test("unregisterLoop is a no-op for a loop that is not registered", () => {
    assert.doesNotThrow(() => unregisterLoop("loop-never-registered"));
  });
});

// ---------------------------------------------------------------------------
// init() idempotency
// ---------------------------------------------------------------------------

describe("loop-sleep-recovery: init() idempotency", () => {
  test("calling init() twice does not throw", async () => {
    // powerMonitor is undefined in the Node.js test runner (Electron CJS shim
    // exports only the binary path), so powerMonitor?.on("resume", ...) is a
    // no-op. The double-registration guard in init() cannot be exercised here;
    // this test verifies only that calling init() multiple times does not throw.
    installSuccessFetchStub();

    const store = makeStore("store-init");
    store.setLoopToken("loop-a", { token: "runner-token" });
    registerLoop("loop-a", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "gateway-token",
      loopTokenStore: store,
    });

    assert.doesNotThrow(() => {
      init();
      init(); // second call must be a no-op
    });

    onResume();
    await flushAsync();

    const refreshCalls = capturedFetchCalls.filter((c) =>
      c.url.includes("refresh-token")
    );
    assert.equal(
      refreshCalls.length,
      1,
      "onResume fires exactly once per explicit call"
    );
  });

  test("registerLoop replaces the deps when called again for the same loopId", async () => {
    installSuccessFetchStub();

    const storeFirst = makeStore("store-first");
    storeFirst.setLoopToken("loop-a", { token: "runner-token" });
    const storeSecond = makeStore("store-second");
    storeSecond.setLoopToken("loop-a", { token: "runner-token-2" });

    registerLoop("loop-a", {
      apiBaseUrl: "https://first.example.com",
      getToken: () => "first-token",
      loopTokenStore: storeFirst,
    });
    // Re-register with different deps.
    registerLoop("loop-a", {
      apiBaseUrl: "https://second.example.com",
      getToken: () => "second-token",
      loopTokenStore: storeSecond,
    });

    onResume();
    await flushAsync();

    // Only one set of calls expected (not two).
    const loopACalls = capturedFetchCalls.filter((c) =>
      c.url.includes("loop-a")
    );
    assert.equal(
      loopACalls.length,
      2, // one refresh + one heartbeat
      "calling registerLoop twice for the same loopId must not double the calls"
    );

    // All calls must use the replaced apiBaseUrl.
    for (const call of loopACalls) {
      assert.ok(
        call.url.startsWith("https://second.example.com"),
        "replaced deps must be used — calls must go to the second apiBaseUrl"
      );
    }
  });
});

// ---------------------------------------------------------------------------
// PLN-740 T-4.8: getSessionToken passthrough tests removed.
// The X-Session-Token revival path has been removed in PLN-740 T-4.3.
// X-Session-Token header is no longer sent with heartbeat requests.
describe("loop-sleep-recovery: getSessionToken passthrough to heartbeat", () => {
  test("PLN-740 T-4.3: X-Session-Token is never sent on resume heartbeat (revival path removed)", async () => {
    installSuccessFetchStub();

    const store = makeStore("store-no-session-token");
    store.setLoopToken("loop-no-x-session", { token: "runner-token" });

    registerLoop("loop-no-x-session", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "gateway-token",
      loopTokenStore: store,
    });

    onResume();
    await flushAsync();

    const heartbeatCalls = capturedFetchCalls.filter((c) =>
      c.url.includes("heartbeat")
    );
    assert.equal(
      heartbeatCalls.length,
      1,
      "expected exactly one heartbeat call"
    );

    const hb = heartbeatCalls[0];
    assert.ok(hb, "expected a heartbeat call");
    assert.equal(
      hb.sessionToken,
      undefined,
      "X-Session-Token must never be sent (PLN-740 T-4.3)"
    );
  });
});
