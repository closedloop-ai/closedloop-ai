/**
 * Unit tests for apps/desktop/src/main/loop-refresh-scheduler.ts
 *
 * Covers:
 *   - scheduler fires at correct time relative to expiresAt (delay = expiresAt - skew - now)
 *   - reschedules after a successful refresh that includes a new expiresAt
 *   - does not reschedule when the refreshed token has no expiresAt (opaque token)
 *   - handles missing expiresAt gracefully (skips scheduling for opaque tokens)
 *   - respects CLOSEDLOOP_TOKEN_REFRESH_SKEW_MS env var override
 *   - stop() cancels a pending schedule cleanly
 *   - stopAll() cancels all active schedules
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import type { LoopSchedulerDeps } from "../src/main/loop-lifecycle.js";
import { LoopSchedulerContext } from "../src/main/loop-scheduler-context.js";
import type { LoopTokenStore } from "../src/main/loop-token-store.js";

// Per-test scheduler context; disposed in afterEach so timers cannot leak.
let ctx: LoopSchedulerContext;
const start = (
  loopId: string,
  expiresAt: number | undefined,
  deps: LoopSchedulerDeps
) => ctx.startRefresh(loopId, expiresAt, deps);
const stop = (loopId: string) => ctx.stopRefresh(loopId);
const stopAll = () => ctx[Symbol.dispose]();

import {
  createTestLoopTokenStore,
  flushAsync,
  makeFakeJwt,
} from "./loop-token-test-utils.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const originalSkewEnv = process.env.CLOSEDLOOP_TOKEN_REFRESH_SKEW_MS;

let tempRoot = "";

function makeStore(name: string): LoopTokenStore {
  return createTestLoopTokenStore(tempRoot, name);
}

function makeDeps(store: LoopTokenStore, token = "test-token") {
  return {
    apiBaseUrl: "https://api.example.com",
    getToken: () => token,
    loopTokenStore: store,
  };
}

/**
 * Installs a fetch stub that returns a successful refresh response.
 * `expiresAtMs` is the millisecond timestamp to encode as the JWT exp
 * (will be divided to seconds for the JWT).
 */
function _installSuccessRefreshStub(expiresAtMs: number | undefined): void {
  const expSeconds =
    expiresAtMs === undefined ? undefined : Math.floor(expiresAtMs / 1000);
  const token =
    expSeconds === undefined
      ? "opaque-token-no-exp"
      : makeFakeJwt({ sub: "runner", exp: expSeconds });
  const body = JSON.stringify({ token, jti: "jti-stub" });
  globalThis.fetch = (async () =>
    new Response(body, { status: 200 })) as typeof fetch;
}

/**
 * Installs a fetch stub that returns a failed refresh response.
 */
function _installFailRefreshStub(): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
    })) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "loop-refresh-scheduler-test-")
  );
  ctx = new LoopSchedulerContext();
});

afterEach(async () => {
  // Cancel any timers left by the test under test.
  stopAll();

  // Restore mocked timers before re-enabling or resetting in the next test.
  mock.timers.reset();

  // Restore global fetch.
  globalThis.fetch = originalFetch;

  // Restore env var.
  if (originalSkewEnv === undefined) {
    delete process.env.CLOSEDLOOP_TOKEN_REFRESH_SKEW_MS;
  } else {
    process.env.CLOSEDLOOP_TOKEN_REFRESH_SKEW_MS = originalSkewEnv;
  }

  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scheduler fires at correct time relative to expiresAt
// ---------------------------------------------------------------------------

describe("loop-refresh-scheduler: timing", () => {
  test("fires the refresh tick at (expiresAt - skew - now) ms from start", async () => {
    // Use a deterministic skew of 10_000 ms via env override.
    process.env.CLOSEDLOOP_TOKEN_REFRESH_SKEW_MS = "10000";

    mock.timers.enable({ apis: ["Date", "setTimeout"] });

    // Date.now() == 0 after mock.timers.enable.
    // Set expiresAt 60 seconds from now (ms): 60_000 ms.
    // Expected delay = 60_000 - 10_000 - 0 = 50_000 ms.
    const expiresAt = 60_000; // ms
    let fetchCallCount = 0;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      return new Response(
        JSON.stringify({ token: "opaque-token-no-exp", jti: "jti-1" }),
        {
          status: 200,
        }
      );
    }) as typeof fetch;

    const store = makeStore("timing-test");
    store.setLoopToken("loop-timing", { token: "test-token" });
    start("loop-timing", expiresAt, makeDeps(store));

    // Tick just before the expected delay — must not fire.
    mock.timers.tick(49_999);
    await flushAsync();
    assert.equal(
      fetchCallCount,
      0,
      "fetch must not be called before the scheduled delay"
    );

    // Tick the remaining 1 ms — must fire exactly once.
    mock.timers.tick(1);
    await flushAsync();
    assert.equal(
      fetchCallCount,
      1,
      "fetch must be called exactly once at the scheduled delay"
    );
  });

  test("fires immediately (delay=0) when expiresAt - skew is already in the past", async () => {
    process.env.CLOSEDLOOP_TOKEN_REFRESH_SKEW_MS = "10000";

    mock.timers.enable({ apis: ["Date", "setTimeout"] });

    // Date.now() == 0. expiresAt = 5_000 ms, skew = 10_000 ms.
    // delay = max(5_000 - 10_000 - 0, 0) = 0.
    const expiresAt = 5000;
    let fetchCallCount = 0;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      return new Response(
        JSON.stringify({ token: "opaque-no-exp", jti: "j" }),
        { status: 200 }
      );
    }) as typeof fetch;

    const store = makeStore("timing-past");
    store.setLoopToken("loop-past", { token: "tok" });
    start("loop-past", expiresAt, makeDeps(store));

    // Tick 0 ms (fires timers with delay=0).
    mock.timers.tick(0);
    await flushAsync();
    assert.equal(fetchCallCount, 1, "fetch must fire immediately when delay=0");
  });
});

// ---------------------------------------------------------------------------
// Reschedules after successful refresh
// ---------------------------------------------------------------------------

describe("loop-refresh-scheduler: rescheduling", () => {
  test("reschedules after a successful refresh that includes a new expiresAt", async () => {
    process.env.CLOSEDLOOP_TOKEN_REFRESH_SKEW_MS = "5000";

    mock.timers.enable({ apis: ["Date", "setTimeout"] });

    // First token expires at 20_000 ms. Skew = 5_000.
    // First tick delay = 20_000 - 5_000 - 0 = 15_000 ms.
    // After the first refresh, new token expires at 40_000 ms.
    // Second tick delay = 40_000 - 5_000 - 15_000 (Date.now after first tick) = 20_000 ms.
    const firstExpiresAt = 20_000; // ms

    let fetchCallCount = 0;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      // New token expiry: 40_000 ms = 40 seconds -> JWT exp = 40
      const newToken = makeFakeJwt({ sub: "runner", exp: 40 }); // 40 seconds -> 40_000 ms in meta
      return new Response(
        JSON.stringify({ token: newToken, jti: "jti-resched" }),
        {
          status: 200,
        }
      );
    }) as typeof fetch;

    const store = makeStore("reschedule-test");
    store.setLoopToken("loop-resched", { token: "tok" });
    start("loop-resched", firstExpiresAt, makeDeps(store));

    // Fire the first tick.
    mock.timers.tick(15_000);
    await flushAsync();
    assert.equal(
      fetchCallCount,
      1,
      "first fetch must have been called after first delay"
    );

    // Date.now() is now 15_000 ms after mock.timers.enable.
    // Second tick delay = 40_000 - 5_000 - 15_000 = 20_000 ms.
    mock.timers.tick(19_999);
    await flushAsync();
    assert.equal(
      fetchCallCount,
      1,
      "fetch must NOT be called before second scheduled delay"
    );

    mock.timers.tick(1);
    await flushAsync();
    assert.equal(
      fetchCallCount,
      2,
      "fetch must be called a second time after reschedule fires"
    );
  });

  test("does not reschedule when the refreshed token has no expiresAt (opaque token)", async () => {
    process.env.CLOSEDLOOP_TOKEN_REFRESH_SKEW_MS = "0";

    mock.timers.enable({ apis: ["Date", "setTimeout"] });

    // expiresAt = 1_000 ms, skew = 0 -> fires at 1_000 ms.
    // After refresh, response token is opaque (no JWT exp).
    let fetchCallCount = 0;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      // Plain string token — no base64url JWT structure, so parseJwtExpiry returns null.
      return new Response(
        JSON.stringify({ token: "plain-opaque-token", jti: "jti-opaque" }),
        {
          status: 200,
        }
      );
    }) as typeof fetch;

    const store = makeStore("no-reschedule");
    store.setLoopToken("loop-opaque", { token: "tok" });
    start("loop-opaque", 1000, makeDeps(store));

    // Fire the first tick.
    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(fetchCallCount, 1, "first fetch must fire");

    // Advance a large interval — no second call should occur.
    mock.timers.tick(1_000_000);
    await flushAsync();
    assert.equal(
      fetchCallCount,
      1,
      "no reschedule must happen when new token has no expiresAt"
    );
  });

  test("does not reschedule when the refresh fails", async () => {
    process.env.CLOSEDLOOP_TOKEN_REFRESH_SKEW_MS = "0";

    mock.timers.enable({ apis: ["Date", "setTimeout"] });

    let fetchCallCount = 0;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      return new Response("Unauthorized", { status: 401 });
    }) as typeof fetch;

    const store = makeStore("no-reschedule-on-fail");
    store.setLoopToken("loop-fail", { token: "tok" });
    start("loop-fail", 1000, makeDeps(store));

    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(fetchCallCount, 1, "first fetch must fire on failure");

    mock.timers.tick(1_000_000);
    await flushAsync();
    assert.equal(fetchCallCount, 1, "no reschedule after a failed refresh");
  });
});

// ---------------------------------------------------------------------------
// Handles missing expiresAt gracefully
// ---------------------------------------------------------------------------

describe("loop-refresh-scheduler: opaque tokens", () => {
  test("start() with undefined expiresAt skips scheduling entirely", async () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });

    let fetchCallCount = 0;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const store = makeStore("opaque-skip");
    store.setLoopToken("loop-opaque-skip", { token: "tok" });
    // Pass undefined expiresAt — must not schedule any timer.
    start("loop-opaque-skip", undefined, makeDeps(store));

    mock.timers.tick(10_000_000);
    await flushAsync();
    assert.equal(
      fetchCallCount,
      0,
      "no fetch must be issued when expiresAt is undefined"
    );
  });
});

// ---------------------------------------------------------------------------
// Env var override for refresh skew
// ---------------------------------------------------------------------------

describe("loop-refresh-scheduler: CLOSEDLOOP_TOKEN_REFRESH_SKEW_MS override", () => {
  test("uses the env var value instead of the default 30-minute skew", async () => {
    // Override skew to 2_000 ms.
    process.env.CLOSEDLOOP_TOKEN_REFRESH_SKEW_MS = "2000";

    mock.timers.enable({ apis: ["Date", "setTimeout"] });

    // expiresAt = 7_000 ms, skew = 2_000 ms -> delay = 5_000 ms.
    const expiresAt = 7000;
    let fetchCallCount = 0;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      return new Response(
        JSON.stringify({ token: "opaque-env-test", jti: "jti-env" }),
        {
          status: 200,
        }
      );
    }) as typeof fetch;

    const store = makeStore("env-skew");
    store.setLoopToken("loop-env", { token: "tok" });
    start("loop-env", expiresAt, makeDeps(store));

    // Tick just before the env-var-determined delay — must not fire.
    mock.timers.tick(4999);
    await flushAsync();
    assert.equal(fetchCallCount, 0, "must not fire before env-var skew delay");

    // Tick the remaining 1 ms — must fire.
    mock.timers.tick(1);
    await flushAsync();
    assert.equal(
      fetchCallCount,
      1,
      "must fire at the env-var-skew-determined delay"
    );
  });

  test("ignores a non-numeric CLOSEDLOOP_TOKEN_REFRESH_SKEW_MS and uses default", async () => {
    // Set an invalid env var value — the scheduler should fall back to the 30-minute default.
    process.env.CLOSEDLOOP_TOKEN_REFRESH_SKEW_MS = "not-a-number";

    mock.timers.enable({ apis: ["Date", "setTimeout"] });

    // Default skew = 30 * 60 * 1000 = 1_800_000 ms.
    // expiresAt = 1_900_000 ms -> delay = 1_900_000 - 1_800_000 - 0 = 100_000 ms.
    const expiresAt = 1_900_000;
    let fetchCallCount = 0;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      return new Response(
        JSON.stringify({ token: "opaque-fallback", jti: "jti-fb" }),
        {
          status: 200,
        }
      );
    }) as typeof fetch;

    const store = makeStore("env-invalid");
    store.setLoopToken("loop-invalid", { token: "tok" });
    start("loop-invalid", expiresAt, makeDeps(store));

    // Default skew is 30 minutes. Tick 99_999 ms — must not fire.
    mock.timers.tick(99_999);
    await flushAsync();
    assert.equal(fetchCallCount, 0, "must not fire before default-skew delay");

    // Tick 1 more ms — must fire.
    mock.timers.tick(1);
    await flushAsync();
    assert.equal(fetchCallCount, 1, "must fire at the default-skew delay");
  });
});

// ---------------------------------------------------------------------------
// Stop cleanly
// ---------------------------------------------------------------------------

describe("loop-refresh-scheduler: stop", () => {
  test("stop() cancels a pending refresh and prevents it from firing", async () => {
    process.env.CLOSEDLOOP_TOKEN_REFRESH_SKEW_MS = "0";

    mock.timers.enable({ apis: ["Date", "setTimeout"] });

    let fetchCallCount = 0;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const store = makeStore("stop-cancels");
    store.setLoopToken("loop-stop", { token: "tok" });
    start("loop-stop", 5000, makeDeps(store));

    // Cancel before the timer fires.
    stop("loop-stop");

    mock.timers.tick(5000);
    await flushAsync();
    assert.equal(
      fetchCallCount,
      0,
      "stop() must prevent the scheduled refresh from firing"
    );
  });

  test("stop() is a no-op for a loop with no active timer", () => {
    // Should not throw.
    assert.doesNotThrow(() => stop("loop-no-timer"));
  });

  test("stopAll() cancels all active schedules", async () => {
    process.env.CLOSEDLOOP_TOKEN_REFRESH_SKEW_MS = "0";

    mock.timers.enable({ apis: ["Date", "setTimeout"] });

    let fetchCallCount = 0;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const storeA = makeStore("stopall-a");
    storeA.setLoopToken("loop-a", { token: "tok" });
    const storeB = makeStore("stopall-b");
    storeB.setLoopToken("loop-b", { token: "tok" });

    start("loop-a", 3000, makeDeps(storeA));
    start("loop-b", 3000, makeDeps(storeB));

    stopAll();

    mock.timers.tick(3000);
    await flushAsync();
    assert.equal(
      fetchCallCount,
      0,
      "stopAll() must prevent all scheduled refreshes from firing"
    );
  });

  test("replacing an existing schedule via start() cancels the old timer", async () => {
    process.env.CLOSEDLOOP_TOKEN_REFRESH_SKEW_MS = "0";

    mock.timers.enable({ apis: ["Date", "setTimeout"] });

    let fetchCallCount = 0;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      return new Response(
        JSON.stringify({ token: "opaque-replace", jti: "jti-rep" }),
        {
          status: 200,
        }
      );
    }) as typeof fetch;

    const store = makeStore("replace-timer");
    store.setLoopToken("loop-replace", { token: "tok" });

    // Schedule with expiresAt = 1_000 ms.
    start("loop-replace", 1000, makeDeps(store));
    // Immediately replace with expiresAt = 10_000 ms.
    start("loop-replace", 10_000, makeDeps(store));

    // Tick past the original delay — original timer must have been cancelled.
    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      fetchCallCount,
      0,
      "original timer must be cancelled when start() is called again for the same loopId"
    );

    // Tick to the replacement delay.
    mock.timers.tick(9000);
    await flushAsync();
    assert.equal(
      fetchCallCount,
      1,
      "replacement timer must fire at the new delay"
    );
  });
});
