/**
 * Unit tests for apps/desktop/src/main/loop-heartbeat.ts
 *
 * Covers:
 *   - periodic heartbeat firing at the configured interval
 *   - fire-and-forget error handling (fetch throws — must not propagate)
 *   - fire-and-forget error handling (non-200 HTTP response — must not propagate)
 *   - job finalization on terminal signals: 404 triggers finalizeFn(job, "UNKNOWN") and stops the heartbeat
 *   - job finalization on terminal signals: 410 triggers finalizeFn(job, "UNKNOWN") and stops the heartbeat
 *   - job finalization on terminal signals: 401 triggers finalizeFn(job, "UNKNOWN") and stops the heartbeat (no token refresh)
 *   - 404 gate integration: 404 response disables the endpoint and stops the loop's scheduler
 *   - 410 stop behavior: 410 response stops the heartbeat scheduler (loop is terminal)
 *   - token adoption on revival: revived:true response persists new token via loopTokenStore.setLoopToken
 *   - CLOSEDLOOP_HEARTBEAT_INTERVAL_MS env var override
 *   - stop() cancels a running heartbeat scheduler cleanly
 *   - stopAll() cancels all active heartbeat schedulers
 *   - PLN-740: PoP headers attached when DESKTOP_MANAGED (AC-007, AC-008)
 *   - PLN-740: Authorization managed-key fallback when runner JWT null (AC-009)
 *   - PLN-740: isJwtUsable helper edge cases (AC-011)
 *   - PLN-740: postLoopHeartbeat managed-key swap on stale JWT (AC-011)
 *   - PLN-740: process-alive guard suppresses finalization on terminal heartbeat (AC-012)
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import type { LocalJob } from "../src/main/job-store.js";
import {
  isEndpointDisabled,
  resetAllGates,
} from "../src/main/loop-404-gate.js";
import { LoopSchedulerContext } from "../src/main/loop-scheduler-context.js";
import type {
  TelemetryEmitter,
  TelemetryEventPayload,
} from "../src/main/telemetry-protocol.js";
import { isJwtUsable } from "../src/server/operations/loop-http.js";
import { createLocalJob, makeStubJobStore } from "./job-store-test-utils.js";
import {
  createTestLoopTokenStore,
  flushAsync,
} from "./loop-token-test-utils.js";

// Per-test scheduler context. Cleared in afterEach via Symbol.dispose so
// timers never leak across tests.
let ctx: LoopSchedulerContext;

// Minimal no-op HeartbeatDeps extras used by tests that do not need
// finalization behaviour. Tests that exercise terminal-signal paths should
// supply their own jobStore / finalizeFn stubs.
const noopJobStore = {
  getByLoopId: (_loopId: string) => undefined,
} as unknown as import("../src/main/job-store.js").JobStore;
const noopFinalizeFn = async () => {};

// `start` defaults the (now required) jobStore / finalizeFn to no-ops so tests
// that only care about heartbeat firing stay terse, while still accepting the
// optional revival fields (loopTokenStore / getSessionToken) that the token
// adoption tests pass through. Tests exercising finalization call
// ctx.startHeartbeat directly with their own jobStore / finalizeFn stubs.
type StartDeps = Parameters<LoopSchedulerContext["startHeartbeat"]>[1];
const start = (
  loopId: string,
  deps: Omit<StartDeps, "jobStore" | "finalizeFn"> &
    Partial<Pick<StartDeps, "jobStore" | "finalizeFn">>
) =>
  ctx.startHeartbeat(loopId, {
    jobStore: noopJobStore,
    finalizeFn: noopFinalizeFn,
    ...deps,
  });
const stop = (loopId: string) => ctx.stopHeartbeat(loopId);
const stopAll = () => ctx[Symbol.dispose]();

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const originalIntervalEnv = process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS;

type CapturedHeartbeat = {
  url: string;
  method: string;
  authorization: string | undefined;
  gatewayId: string | undefined;
  desktopTimestamp: string | undefined;
  desktopSignature: string | undefined;
};

let capturedHeartbeats: CapturedHeartbeat[] = [];
let tempRoot = "";

// ---------------------------------------------------------------------------
// Fetch stub helpers
// ---------------------------------------------------------------------------

function installHeartbeatFetchStub(status: number, body = ""): void {
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    capturedHeartbeats.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization") ?? undefined,
      // PLN-740 T-3.1: capture X-Desktop-* PoP headers.
      gatewayId: headers.get("x-desktop-gateway-id") ?? undefined,
      desktopTimestamp: headers.get("x-desktop-timestamp") ?? undefined,
      desktopSignature: headers.get("x-desktop-signature") ?? undefined,
    });
    return new Response(body, { status });
  }) as typeof fetch;
}

/**
 * Installs a fetch stub that throws a network error on every call.
 */
function installThrowingFetchStub(): void {
  globalThis.fetch = (async () => {
    capturedHeartbeats.push({
      url: "throw",
      method: "POST",
      authorization: undefined,
      gatewayId: undefined,
      desktopTimestamp: undefined,
      desktopSignature: undefined,
    });
    throw new Error("ECONNREFUSED simulated network error");
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  capturedHeartbeats = [];
  resetAllGates();
  ctx = new LoopSchedulerContext();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-heartbeat-test-"));
});

afterEach(async () => {
  // Cancel all heartbeat timers left by the test.
  stopAll();

  // Reset fake timers.
  mock.timers.reset();

  // Restore global fetch.
  globalThis.fetch = originalFetch;

  // Restore env var.
  if (originalIntervalEnv === undefined) {
    delete process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS;
  } else {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = originalIntervalEnv;
  }

  // Reset 404 gate state.
  resetAllGates();

  // Clean up temp directory.
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Periodic heartbeat firing
// ---------------------------------------------------------------------------

describe("loop-heartbeat: periodic firing", () => {
  test("heartbeat fires at each interval tick", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";

    mock.timers.enable({ apis: ["Date", "setInterval"] });

    installHeartbeatFetchStub(200);

    start("loop-hb", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "bearer-token",
    });

    // First interval.
    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      1,
      "expected one heartbeat after first interval"
    );

    // Second interval.
    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      2,
      "expected two heartbeats after second interval"
    );

    // Third interval.
    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      3,
      "expected three heartbeats after third interval"
    );
  });

  test("heartbeat POSTs to the correct URL with Authorization header", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "500";

    mock.timers.enable({ apis: ["Date", "setInterval"] });

    installHeartbeatFetchStub(200);

    start("loop-123", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "my-bearer-token",
    });

    mock.timers.tick(500);
    await flushAsync();

    assert.equal(capturedHeartbeats.length, 1);
    const hb = capturedHeartbeats[0];
    assert.ok(hb, "expected at least one captured heartbeat");
    assert.equal(hb.url, "https://api.example.com/loops/loop-123/heartbeat");
    assert.equal(hb.method, "POST");
    assert.equal(hb.authorization, "Bearer my-bearer-token");
  });

  test("heartbeat does not fire before the first interval elapses", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "2000";

    mock.timers.enable({ apis: ["Date", "setInterval"] });

    installHeartbeatFetchStub(200);

    start("loop-early", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "tok",
    });

    mock.timers.tick(1999);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      0,
      "no heartbeat must fire before the interval"
    );
  });

  test("skips heartbeat when getToken() returns null", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";

    mock.timers.enable({ apis: ["Date", "setInterval"] });

    installHeartbeatFetchStub(200);

    // PLN-740 T-3.3: explicitly supply getApiKey: () => null to exercise the
    // double-null guard (both runner JWT and managed API key unavailable).
    start("loop-no-token", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => null,
      getApiKey: () => null,
    });

    mock.timers.tick(1000);
    await flushAsync();
    // Fetch must not be called because getToken returned null.
    assert.equal(
      capturedHeartbeats.length,
      0,
      "no heartbeat must be issued when token is null"
    );
  });
});

// ---------------------------------------------------------------------------
// Fire-and-forget error handling
// ---------------------------------------------------------------------------

describe("loop-heartbeat: fire-and-forget error handling", () => {
  test("a thrown network error in fetch does not propagate and heartbeat continues", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";

    mock.timers.enable({ apis: ["Date", "setInterval"] });

    installThrowingFetchStub();

    // Should not throw during start.
    assert.doesNotThrow(() => {
      start("loop-throw", {
        apiBaseUrl: "https://api.example.com",
        getToken: () => "tok",
      });
    });

    // Firing the interval must not cause an unhandled rejection or throw.
    await assert.doesNotReject(async () => {
      mock.timers.tick(1000);
      await flushAsync();
    });

    // The error was swallowed — heartbeat tried once.
    assert.equal(
      capturedHeartbeats.length,
      1,
      "expected one attempted heartbeat despite the thrown error"
    );

    // Subsequent intervals must still fire (scheduler is not stopped on error).
    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      2,
      "subsequent heartbeats must still fire after network error"
    );
  });

  test("a non-2xx HTTP response (500) is swallowed and does not stop the heartbeat", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";

    mock.timers.enable({ apis: ["Date", "setInterval"] });

    installHeartbeatFetchStub(500, "Internal Server Error");

    start("loop-500", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "tok",
    });

    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      1,
      "heartbeat must have fired once"
    );

    // Should still fire on next interval.
    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      2,
      "heartbeat must fire again after a 500 response"
    );
  });
});

// ---------------------------------------------------------------------------
// Job finalization on terminal signals (404 / 410 / 401)
// ---------------------------------------------------------------------------

describe("loop-heartbeat: job finalization on terminal heartbeat signals", () => {
  /**
   * Table-driven cases for status codes that must trigger finalization.
   *
   * Per loop-heartbeat.ts classifyLoopStatus mapping:
   *  - 404 → terminal reason "not_found"  → targetStatus "UNKNOWN"
   *  - 410 → terminal reason "gone"       → targetStatus "UNKNOWN"
   *  - 401 → terminal reason "unauthorized" → targetStatus "UNKNOWN"
   *  (Only "timed_out" reason maps to "TIMED_OUT"; all others map to "UNKNOWN")
   */
  // The status→reason→targetStatus mapping is proven exhaustively in
  // loop-status-classifier.test.ts; at the heartbeat layer every terminal HTTP
  // code maps to UNKNOWN (the TIMED_OUT branch is unreachable here because the
  // heartbeat always classifies with cloudKind=null). So we cover only the two
  // behaviorally-distinct codes: 404 (also trips the endpoint-disable gate) and
  // a non-404 (401, which the heartbeat must NOT token-refresh, unlike boot
  // recovery). 410 is omitted as it is identical to the 404 case minus the gate.
  const terminalSignalCases: {
    label: string;
    httpStatus: number;
    loopId: string;
    description: string;
  }[] = [
    {
      label: "404",
      httpStatus: 404,
      loopId: "loop-finalize-404",
      description:
        "404 response triggers finalizeFn with UNKNOWN and stops the heartbeat",
    },
    {
      label: "401",
      httpStatus: 401,
      loopId: "loop-finalize-401",
      description:
        "401 response triggers finalizeFn with UNKNOWN and stops the heartbeat (no token refresh)",
    },
  ];

  for (const {
    label,
    httpStatus,
    loopId,
    description,
  } of terminalSignalCases) {
    test(description, async () => {
      process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";

      mock.timers.enable({ apis: ["Date", "setInterval"] });

      installHeartbeatFetchStub(httpStatus);

      const testJob = createLocalJob({ id: `job-${label}`, loopId });
      const stubJobStore = makeStubJobStore({ [loopId]: testJob });

      // Mock finalizeFn that records every call.
      const finalizeCalls: Array<{
        job: LocalJob;
        targetStatus: "TIMED_OUT" | "UNKNOWN";
      }> = [];
      const mockFinalizeFn = async (
        job: LocalJob,
        targetStatus: "TIMED_OUT" | "UNKNOWN"
      ) => {
        finalizeCalls.push({ job, targetStatus });
      };

      // Start the heartbeat with the real jobStore stub and mock finalizeFn.
      ctx.startHeartbeat(loopId, {
        apiBaseUrl: "https://api.example.com",
        getToken: () => "tok",
        jobStore: stubJobStore,
        finalizeFn: mockFinalizeFn,
      });

      // First tick receives the terminal HTTP response.
      mock.timers.tick(1000);
      await flushAsync();
      assert.equal(
        capturedHeartbeats.length,
        1,
        `heartbeat must have fired once (received ${label})`
      );

      // finalizeFn must have been called exactly once with the correct job and status.
      assert.equal(
        finalizeCalls.length,
        1,
        `finalizeFn must be called once on ${label}`
      );
      const call = finalizeCalls[0];
      assert.ok(call, "finalizeCalls[0] must exist");
      assert.equal(
        call.job,
        testJob,
        "finalizeFn must receive the job returned by jobStore.getByLoopId"
      );
      assert.equal(
        call.targetStatus,
        "UNKNOWN",
        `finalizeFn must be called with targetStatus=UNKNOWN on ${label}`
      );

      // Heartbeat scheduler must have stopped — no further fetch calls after the terminal tick.
      mock.timers.tick(1000);
      await flushAsync();
      assert.equal(
        capturedHeartbeats.length,
        1,
        `heartbeat must not fire again after ${label} stops the scheduler`
      );
    });
  }

  test("404 response: finalizeFn is NOT called when jobStore returns undefined (no matching job)", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";

    mock.timers.enable({ apis: ["Date", "setInterval"] });

    installHeartbeatFetchStub(404);

    const stubJobStore = makeStubJobStore();

    const finalizeCalls: unknown[] = [];
    const mockFinalizeFn = async (
      job: LocalJob,
      targetStatus: "TIMED_OUT" | "UNKNOWN"
    ) => {
      finalizeCalls.push({ job, targetStatus });
    };

    ctx.startHeartbeat("loop-finalize-404-nojob", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "tok",
      jobStore: stubJobStore,
      finalizeFn: mockFinalizeFn,
    });

    mock.timers.tick(1000);
    await flushAsync();

    assert.equal(
      finalizeCalls.length,
      0,
      "finalizeFn must not be called when no job is found in store"
    );

    // Scheduler must still stop even without a job to finalize.
    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      1,
      "heartbeat must not fire again after 404 even with no job found"
    );
  });
});

// ---------------------------------------------------------------------------
// 404 gate integration
// ---------------------------------------------------------------------------

describe("loop-heartbeat: 404 gate integration", () => {
  test("a 404 response marks the endpoint disabled and stops the heartbeat scheduler", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";

    mock.timers.enable({ apis: ["Date", "setInterval"] });

    installHeartbeatFetchStub(404);

    start("loop-404", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "tok",
    });

    // First interval fires and receives 404.
    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      1,
      "heartbeat must have fired once (received 404)"
    );

    // The endpoint must now be marked disabled.
    assert.equal(
      isEndpointDisabled(
        "https://api.example.com",
        "/loops/loop-404/heartbeat"
      ),
      true,
      "endpoint must be marked disabled after 404"
    );

    // Subsequent interval ticks must not call fetch again (scheduler stopped).
    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      1,
      "heartbeat must not fire again after 404 stops the scheduler"
    );
  });

  test("heartbeat is skipped when endpoint is already marked disabled before start()", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";

    mock.timers.enable({ apis: ["Date", "setInterval"] });

    // Pre-disable the endpoint.
    const { markEndpointDisabled } = await import(
      "../src/main/loop-404-gate.js"
    );
    markEndpointDisabled(
      "https://api.example.com",
      "/loops/loop-pre-disabled/heartbeat"
    );

    installHeartbeatFetchStub(200);

    start("loop-pre-disabled", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "tok",
    });

    mock.timers.tick(1000);
    await flushAsync();
    // fetch must not be called because the endpoint was already disabled.
    assert.equal(
      capturedHeartbeats.length,
      0,
      "heartbeat must be skipped when endpoint is already disabled by 404 gate"
    );
  });
});

// ---------------------------------------------------------------------------
// Env var override
// ---------------------------------------------------------------------------

describe("loop-heartbeat: CLOSEDLOOP_HEARTBEAT_INTERVAL_MS override", () => {
  test("uses the env var interval instead of the default 30-minute interval", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "3000";

    mock.timers.enable({ apis: ["Date", "setInterval"] });

    installHeartbeatFetchStub(200);

    start("loop-env-interval", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "tok",
    });

    // Just before the env-var interval — must not fire.
    mock.timers.tick(2999);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      0,
      "must not fire before env-var interval"
    );

    // Exactly at the env-var interval — must fire.
    mock.timers.tick(1);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      1,
      "must fire at the env-var interval"
    );
  });

  test("ignores an invalid CLOSEDLOOP_HEARTBEAT_INTERVAL_MS and uses the default", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "not-a-number";

    mock.timers.enable({ apis: ["Date", "setInterval"] });

    installHeartbeatFetchStub(200);

    start("loop-env-invalid", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "tok",
    });

    // Default interval is 30 minutes = 1_800_000 ms.
    // Tick just before default — must not fire.
    mock.timers.tick(1_799_999);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      0,
      "must not fire before default interval"
    );

    // Tick 1 more ms — must fire.
    mock.timers.tick(1);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      1,
      "must fire at the default 30-minute interval"
    );
  });
});

// ---------------------------------------------------------------------------
// Clean stop
// ---------------------------------------------------------------------------

describe("loop-heartbeat: clean stop", () => {
  test("stop() cancels a running heartbeat and prevents further firing", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";

    mock.timers.enable({ apis: ["Date", "setInterval"] });

    installHeartbeatFetchStub(200);

    start("loop-cleanstop", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "tok",
    });

    // Let one heartbeat fire.
    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(capturedHeartbeats.length, 1, "first heartbeat must fire");

    stop("loop-cleanstop");

    // After stop, no further heartbeats should fire.
    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      1,
      "stop() must prevent further heartbeats"
    );
  });

  test("stop() is a no-op for a loop with no active timer", () => {
    assert.doesNotThrow(() => stop("loop-no-timer-hb"));
  });

  test("stopAll() cancels all active heartbeat schedulers", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";

    mock.timers.enable({ apis: ["Date", "setInterval"] });

    installHeartbeatFetchStub(200);

    start("loop-all-a", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "tok",
    });
    start("loop-all-b", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "tok",
    });

    stopAll();

    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      0,
      "stopAll() must prevent all heartbeats from firing"
    );
  });

  test("replacing an existing heartbeat via start() cancels the old interval", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";

    mock.timers.enable({ apis: ["Date", "setInterval"] });

    installHeartbeatFetchStub(200);

    // Start and immediately replace.
    start("loop-replace-hb", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "tok",
    });
    start("loop-replace-hb", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "tok",
    });

    // The second start replaces the first. There should be only one active interval.
    // If both were active, ticking once would fire twice.
    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      1,
      "only one heartbeat must fire when start() is called twice (second replaces first)"
    );
  });
});

// ---------------------------------------------------------------------------
// 410 stop behavior (AC-003)
// ---------------------------------------------------------------------------

describe("loop-heartbeat: 410 stop behavior", () => {
  test("a 410 response stops the heartbeat scheduler (loop is terminal)", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";

    mock.timers.enable({ apis: ["Date", "setInterval"] });

    installHeartbeatFetchStub(410);

    start("loop-410", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "tok",
    });

    // First interval fires and receives 410.
    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      1,
      "heartbeat must have fired once (received 410)"
    );

    // Subsequent interval ticks must not call fetch again (scheduler stopped).
    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      1,
      "heartbeat must not fire again after 410 stops the scheduler"
    );
  });
});

// ---------------------------------------------------------------------------
// Token adoption on revival (AC-001, AC-002)
// ---------------------------------------------------------------------------

describe("loop-heartbeat: token adoption on revival", () => {
  test("revived:true response persists the new runner token via loopTokenStore.setLoopToken", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";

    mock.timers.enable({ apis: ["Date", "setInterval"] });

    const revivedBody = JSON.stringify({
      revived: true,
      token: "new-runner-token",
      jti: "new-jti-abc",
      expiresAt: new Date("2099-01-01T00:00:00.000Z").toISOString(),
    });
    installHeartbeatFetchStub(200, revivedBody);

    const store = createTestLoopTokenStore(tempRoot, "store-revival");
    // Pre-seed a token so the runner token is not null.
    store.setLoopToken("loop-revival", { token: "old-runner-token" });

    start("loop-revival", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "old-runner-token",
      loopTokenStore: store,
    });

    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      1,
      "heartbeat must have fired once"
    );

    // The store must now hold the new token.
    const stored = store.getLoopToken("loop-revival");
    assert.ok(stored !== null, "token must be stored after revival");
    assert.equal(
      stored.token,
      "new-runner-token",
      "stored token must match revived token"
    );
    assert.equal(
      stored.jti,
      "new-jti-abc",
      "stored jti must match revived jti"
    );

    // Heartbeat scheduler must remain running (revival does not stop it).
    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      2,
      "scheduler must continue running after revival"
    );
  });

  test("revived:true without token fields does not update the store", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";

    mock.timers.enable({ apis: ["Date", "setInterval"] });

    // Malformed revival response: revived is true but no token field.
    installHeartbeatFetchStub(200, JSON.stringify({ revived: true }));

    const store = createTestLoopTokenStore(tempRoot, "store-revival-no-token");
    store.setLoopToken("loop-revival-nt", { token: "original-token" });

    start("loop-revival-nt", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "original-token",
      loopTokenStore: store,
    });

    mock.timers.tick(1000);
    await flushAsync();

    // The store must still have the original token unchanged (no token field to adopt).
    const stored = store.getLoopToken("loop-revival-nt");
    assert.ok(stored !== null, "token must still be in store");
    assert.equal(
      stored.token,
      "original-token",
      "original token must be unchanged when revival has no token field"
    );
  });
});

// ---------------------------------------------------------------------------
// PLN-740 T-3.1: PoP headers attached when DESKTOP_MANAGED (AC-007)
// ---------------------------------------------------------------------------

describe("PLN-740 T-3.1: PoP headers for DESKTOP_MANAGED keys", () => {
  /** Returns a mock signDesktopRequest that resolves to fixed PoP header values. */
  function makeMockSigner(
    capturedRequests?: Array<{ method: string; pathname: string }>
  ) {
    return async (req: { method: string; pathname: string }) => {
      capturedRequests?.push(req);
      return {
        "X-Desktop-Gateway-Id": "test-gw-id",
        "X-Desktop-Timestamp": "1234567890",
        "X-Desktop-Signature": "test-sig",
      };
    };
  }

  test("DESKTOP_MANAGED + signDesktopRequest: all three X-Desktop-* headers attached", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";
    mock.timers.enable({ apis: ["Date", "setInterval"] });
    installHeartbeatFetchStub(200);

    start("loop-pop-managed", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "runner-token",
      getApiKeyProvenance: () => "DESKTOP_MANAGED",
      signDesktopRequest: makeMockSigner(),
    });

    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(capturedHeartbeats.length, 1);
    const hb = capturedHeartbeats[0];
    assert.ok(hb, "expected heartbeat");
    assert.equal(
      hb.gatewayId,
      "test-gw-id",
      "X-Desktop-Gateway-Id must be present"
    );
    assert.equal(
      hb.desktopTimestamp,
      "1234567890",
      "X-Desktop-Timestamp must be present"
    );
    assert.equal(
      hb.desktopSignature,
      "test-sig",
      "X-Desktop-Signature must be present"
    );
  });

  test("runner JWT available AND DESKTOP_MANAGED: runner JWT in Authorization AND PoP headers", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";
    mock.timers.enable({ apis: ["Date", "setInterval"] });
    installHeartbeatFetchStub(200);

    start("loop-pop-jwt-and-pop", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "runner-jwt",
      getApiKeyProvenance: () => "DESKTOP_MANAGED",
      signDesktopRequest: makeMockSigner(),
    });

    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(capturedHeartbeats.length, 1);
    const hb = capturedHeartbeats[0];
    assert.ok(hb);
    assert.equal(
      hb.authorization,
      "Bearer runner-jwt",
      "Authorization must use runner JWT when available"
    );
    assert.ok(
      hb.gatewayId,
      "X-Desktop-Gateway-Id must be present alongside runner JWT"
    );
    assert.ok(
      hb.desktopTimestamp,
      "X-Desktop-Timestamp must be present alongside runner JWT"
    );
    assert.ok(
      hb.desktopSignature,
      "X-Desktop-Signature must be present alongside runner JWT"
    );
  });

  test("PR #248: signing request pathname matches the wire URL path (both encoded)", async () => {
    // Regression for the PR #248 review comment: the PoP signature must be
    // computed over the exact path that is sent on the wire. Previously the
    // pathname was signed over the raw loopId while the fetch URL used
    // encodeURIComponent(loopId), so the signed and sent paths diverged for any
    // loopId needing percent-encoding (server-side PoP signature mismatch).
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";
    mock.timers.enable({ apis: ["Date", "setInterval"] });
    installHeartbeatFetchStub(200);

    const signingRequests: Array<{ method: string; pathname: string }> = [];

    // Use a loopId with a URL-encodable character so raw and encoded differ.
    const loopId = "loop id with space";
    start(loopId, {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "runner-jwt",
      getApiKeyProvenance: () => "DESKTOP_MANAGED",
      signDesktopRequest: makeMockSigner(signingRequests),
    });

    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      signingRequests.length,
      1,
      "signDesktopRequest must be called once"
    );
    const sigReq = signingRequests[0];
    assert.ok(sigReq, "signing request must exist");
    assert.equal(sigReq.method, "POST", "signing request method must be POST");
    // The signed pathname must use the encoded loopId so it equals the wire path.
    assert.equal(
      sigReq.pathname,
      `/loops/${encodeURIComponent(loopId)}/heartbeat`,
      "signing request pathname must use the encoded loopId (parity with the wire URL)"
    );
    // The reviewed invariant: the signed pathname is byte-identical to the path
    // segment of the URL actually sent to fetch.
    const hb = capturedHeartbeats[0];
    assert.ok(hb, "heartbeat must be captured");
    const wirePath = new URL(hb.url).pathname;
    assert.equal(
      sigReq.pathname,
      wirePath,
      "signed PoP pathname must equal the wire URL pathname"
    );
  });
});

// ---------------------------------------------------------------------------
// PR #248: getTokenMeta must carry the body.closedLoopAuthToken fallback
//
// getTokenMeta wins over getToken in postLoopHeartbeat. The symphony-loop spawn
// path wires getTokenMeta as:
//   () => loopTokenStore.getLoopToken(loopId) ?? { token: body.closedLoopAuthToken }
// Without the `?? { token: ... }` fallback, a USER_CREATED loop short-circuits
// to missing_token whenever the token store is empty (e.g. safeStorage was
// unavailable so setLoopToken threw at start). These tests pin the invariant:
// the fallback is what keeps the heartbeat alive in that case.
// ---------------------------------------------------------------------------

describe("PR #248: getTokenMeta body-token fallback", () => {
  test("empty store + USER_CREATED: getTokenMeta fallback sends Bearer <body token>", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";
    mock.timers.enable({ apis: ["Date", "setInterval"] });
    installHeartbeatFetchStub(200);

    // Empty store models safeStorage unavailable: setLoopToken threw at start,
    // so getLoopToken returns null for this loop.
    const tokenStore = createTestLoopTokenStore(tempRoot, "pr248-fallback");
    const bodyToken = "body-fallback-token";
    const loopId = "loop-pr248-fallback";

    start(loopId, {
      apiBaseUrl: "https://api.example.com",
      getToken: () => tokenStore.getLoopToken(loopId)?.token ?? bodyToken,
      getApiKeyProvenance: () => "USER_CREATED",
      getApiKey: () => null,
      loopTokenStore: tokenStore,
      // Mirrors the symphony-loop wiring with the restored fallback.
      getTokenMeta: () =>
        tokenStore.getLoopToken(loopId) ?? { token: bodyToken },
    });

    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      1,
      "heartbeat must be sent, not short-circuited"
    );
    const hb = capturedHeartbeats[0];
    assert.ok(hb);
    assert.equal(
      hb.authorization,
      `Bearer ${bodyToken}`,
      "Authorization must fall back to the body token when the store is empty"
    );
  });

  test("regression: getTokenMeta WITHOUT fallback short-circuits to missing_token (no heartbeat)", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";
    mock.timers.enable({ apis: ["Date", "setInterval"] });
    installHeartbeatFetchStub(200);

    const tokenStore = createTestLoopTokenStore(tempRoot, "pr248-nofallback");
    const loopId = "loop-pr248-nofallback";

    start(loopId, {
      apiBaseUrl: "https://api.example.com",
      getToken: () =>
        tokenStore.getLoopToken(loopId)?.token ?? "body-fallback-token",
      getApiKeyProvenance: () => "USER_CREATED",
      getApiKey: () => null,
      loopTokenStore: tokenStore,
      // The pre-fix wiring: no body-token fallback in the getTokenMeta path.
      getTokenMeta: () => tokenStore.getLoopToken(loopId),
    });

    mock.timers.tick(1000);
    await flushAsync();
    // The dead getToken fallback never runs because getTokenMeta wins; with an
    // empty store and no managed key the ladder short-circuits to missing_token
    // and no request is sent. This is the regression the fallback prevents.
    assert.equal(
      capturedHeartbeats.length,
      0,
      "without the fallback the heartbeat short-circuits to missing_token (no fetch)"
    );
  });
});

// ---------------------------------------------------------------------------
// PLN-740 T-3.2: No PoP headers for USER_CREATED/null keys (AC-008)
// ---------------------------------------------------------------------------

describe("PLN-740 T-3.2: No PoP headers for non-DESKTOP_MANAGED keys", () => {
  test("USER_CREATED provenance: no PoP headers attached", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";
    mock.timers.enable({ apis: ["Date", "setInterval"] });
    installHeartbeatFetchStub(200);

    const signer = async () => ({
      "X-Desktop-Gateway-Id": "gw",
      "X-Desktop-Timestamp": "ts",
      "X-Desktop-Signature": "sig",
    });

    start("loop-pop-user-created", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "runner-token",
      getApiKeyProvenance: () => "USER_CREATED",
      signDesktopRequest: signer,
    });

    mock.timers.tick(1000);
    await flushAsync();
    const hb = capturedHeartbeats[0];
    assert.ok(hb);
    assert.equal(
      hb.gatewayId,
      undefined,
      "no X-Desktop-Gateway-Id for USER_CREATED"
    );
    assert.equal(
      hb.desktopTimestamp,
      undefined,
      "no X-Desktop-Timestamp for USER_CREATED"
    );
    assert.equal(
      hb.desktopSignature,
      undefined,
      "no X-Desktop-Signature for USER_CREATED"
    );
  });

  test("null provenance: no PoP headers attached", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";
    mock.timers.enable({ apis: ["Date", "setInterval"] });
    installHeartbeatFetchStub(200);

    start("loop-pop-null-prov", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "runner-token",
      getApiKeyProvenance: () => null,
    });

    mock.timers.tick(1000);
    await flushAsync();
    const hb = capturedHeartbeats[0];
    assert.ok(hb);
    assert.equal(hb.gatewayId, undefined, "no PoP header for null provenance");
  });

  test("DESKTOP_MANAGED but signDesktopRequest absent: no PoP headers, heartbeat still fires", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";
    mock.timers.enable({ apis: ["Date", "setInterval"] });
    installHeartbeatFetchStub(200);

    start("loop-pop-no-signer", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "runner-token",
      getApiKeyProvenance: () => "DESKTOP_MANAGED",
      // signDesktopRequest intentionally omitted
    });

    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      1,
      "heartbeat must still fire without signer"
    );
    const hb = capturedHeartbeats[0];
    assert.ok(hb);
    assert.equal(hb.gatewayId, undefined, "no PoP headers when signer absent");
    assert.equal(
      hb.authorization,
      "Bearer runner-token",
      "Authorization must still use runner JWT"
    );
  });
});

// ---------------------------------------------------------------------------
// PLN-740 T-3.3: Authorization managed-key fallback when runner JWT null (AC-009)
// ---------------------------------------------------------------------------

describe("PLN-740 T-3.3: Authorization managed-key fallback (AC-009)", () => {
  test("getToken=null + DESKTOP_MANAGED key: managed key in Authorization, PoP headers present", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";
    mock.timers.enable({ apis: ["Date", "setInterval"] });
    installHeartbeatFetchStub(200);

    start("loop-managed-auth", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => null,
      getApiKey: () => "sk_live_test_key",
      getApiKeyProvenance: () => "DESKTOP_MANAGED",
      signDesktopRequest: async () => ({
        "X-Desktop-Gateway-Id": "gw",
        "X-Desktop-Timestamp": "ts",
        "X-Desktop-Signature": "sig",
      }),
    });

    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      1,
      "fetch must be called (not short-circuited)"
    );
    const hb = capturedHeartbeats[0];
    assert.ok(hb);
    assert.equal(
      hb.authorization,
      "Bearer sk_live_test_key",
      "Authorization must use managed key"
    );
    assert.ok(hb.gatewayId, "X-Desktop-Gateway-Id must be present");
    assert.ok(hb.desktopTimestamp, "X-Desktop-Timestamp must be present");
    assert.ok(hb.desktopSignature, "X-Desktop-Signature must be present");
  });

  test("getToken=null + getApiKey=null: dual-null short-circuit, no fetch", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";
    mock.timers.enable({ apis: ["Date", "setInterval"] });
    installHeartbeatFetchStub(200);

    // PLN-740 T-3.3: both runner JWT and managed key null → short-circuit.
    // postLoopHeartbeat returns { success: false, kind: 'auth', error: 'missing_token' }
    // in this case; that result shape is unit-tested directly in loop-http.test.ts
    // ("postLoopHeartbeat X-Session-Token header" describe block and the ladder-rung
    // tests). At the runHeartbeatTick level the result is consumed internally
    // (Promise<void>) so only observable side effects can be asserted here:
    //   1. No fetch is issued (capturedHeartbeats.length === 0).
    //   2. The scheduler is stopped (the 'auth' kind is mapped to HTTP 401 →
    //      classifyLoopStatus returns terminal/unauthorized → stopFn is called),
    //      so a subsequent tick also issues no fetch.
    start("loop-dual-null", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => null,
      getApiKey: () => null,
    });

    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      0,
      "no fetch must be issued when both token sources are null"
    );

    // Verify the scheduler was stopped: the auth short-circuit is classified as
    // terminal (unauthorized), which calls stopFn. A second tick must not produce
    // any additional heartbeat attempts.
    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(
      capturedHeartbeats.length,
      0,
      "heartbeat must not fire on subsequent ticks: scheduler must be stopped after dual-null auth short-circuit"
    );
  });
});

// ---------------------------------------------------------------------------
// PLN-740 T-3.5: isJwtUsable helper + postLoopHeartbeat stale JWT swap (AC-011)
// ---------------------------------------------------------------------------

describe("PLN-740 T-3.5: isJwtUsable helper (AC-011)", () => {
  test("meta === null → false (safety guard)", () => {
    assert.equal(isJwtUsable(null, Date.now(), 30_000), false);
  });

  test("meta.expiresAt === undefined (legacy token) → true regardless of nowMs", () => {
    // Legacy tokens (expiresAt === undefined) are treated as usable to avoid
    // breaking tokens from older desktop versions.
    assert.equal(
      isJwtUsable({ token: "tok" }, Date.now() + 999_999_999, 30_000),
      true
    );
    assert.equal(isJwtUsable({ token: "tok" }, 0, 30_000), true);
  });

  test("expiresAt = nowMs + 3_600_000 (well in the future) → true", () => {
    const nowMs = Date.now();
    assert.equal(
      isJwtUsable(
        { token: "tok", expiresAt: nowMs + 3_600_000 },
        nowMs,
        30_000
      ),
      true
    );
  });

  test("expiresAt = nowMs - 1_000 (already past) → false", () => {
    const nowMs = Date.now();
    assert.equal(
      isJwtUsable({ token: "tok", expiresAt: nowMs - 1000 }, nowMs, 30_000),
      false
    );
  });

  test("expiresAt = nowMs + 5_000 with clockSkewMs=30_000 (within clock-skew) → false", () => {
    const nowMs = Date.now();
    // 5_000 < 30_000 skew window → treat as stale.
    assert.equal(
      isJwtUsable({ token: "tok", expiresAt: nowMs + 5000 }, nowMs, 30_000),
      false
    );
  });
});

describe("PLN-740 T-3.5: postLoopHeartbeat stale JWT swap via HeartbeatDeps", () => {
  test("stale JWT + DESKTOP_MANAGED key: managed key used in Authorization", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";
    mock.timers.enable({ apis: ["Date", "setInterval"] });
    installHeartbeatFetchStub(200);

    const store = createTestLoopTokenStore(tempRoot, "store-stale-jwt");
    // Set an expired token (expiresAt in the past).
    store.setLoopToken("loop-stale", {
      token: "stale-runner-jwt",
      expiresAt: Date.now() - 60_000,
    });

    start("loop-stale", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "stale-runner-jwt",
      getTokenMeta: () => store.getLoopToken("loop-stale"),
      getApiKey: () => "sk_live_test_key",
      getApiKeyProvenance: () => "DESKTOP_MANAGED",
      signDesktopRequest: async () => ({
        "X-Desktop-Gateway-Id": "gw",
        "X-Desktop-Timestamp": "ts",
        "X-Desktop-Signature": "sig",
      }),
      loopTokenStore: store,
    });

    mock.timers.tick(1000);
    await flushAsync();
    assert.equal(capturedHeartbeats.length, 1, "heartbeat must fire");
    const hb = capturedHeartbeats[0];
    assert.ok(hb);
    assert.equal(
      hb.authorization,
      "Bearer sk_live_test_key",
      "managed key used when JWT stale"
    );
    assert.ok(hb.gatewayId, "PoP headers present alongside managed key");
  });

  test("well-valid JWT: JWT used regardless of managed key availability", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";
    mock.timers.enable({ apis: ["Date", "setInterval"] });
    installHeartbeatFetchStub(200);

    const store = createTestLoopTokenStore(tempRoot, "store-valid-jwt");
    store.setLoopToken("loop-valid-jwt", {
      token: "valid-runner-jwt",
      expiresAt: Date.now() + 3_600_000,
    });

    start("loop-valid-jwt", {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "valid-runner-jwt",
      getTokenMeta: () => store.getLoopToken("loop-valid-jwt"),
      getApiKey: () => "sk_live_test_key",
      getApiKeyProvenance: () => "DESKTOP_MANAGED",
      signDesktopRequest: async () => ({
        "X-Desktop-Gateway-Id": "gw",
        "X-Desktop-Timestamp": "ts",
        "X-Desktop-Signature": "sig",
      }),
      loopTokenStore: store,
    });

    mock.timers.tick(1000);
    await flushAsync();
    const hb = capturedHeartbeats[0];
    assert.ok(hb);
    assert.equal(
      hb.authorization,
      "Bearer valid-runner-jwt",
      "valid JWT takes precedence over managed key"
    );
  });
});

// ---------------------------------------------------------------------------
// PLN-740 T-3.6: Process-alive guard suppresses finalization (AC-012)
// ---------------------------------------------------------------------------

describe("PLN-740 T-3.6: Process-alive guard on terminal heartbeat (AC-012)", () => {
  // The guard branches on `job.pid != null && isProcessRunning(job.pid)`, NOT
  // on the terminal HTTP status — the status is only copied into the telemetry
  // payload. So the three terminal codes (410/gone, 401/unauthorized,
  // 404/not_found) all exercise the same suppression path; table-drive them.
  for (const { httpStatus, loopId, jobId, pid } of [
    {
      httpStatus: 410,
      loopId: "loop-alive-guard",
      jobId: "job-alive",
      pid: 12_345,
    },
    {
      httpStatus: 401,
      loopId: "loop-alive-guard-401",
      jobId: "job-alive-401",
      pid: 22_222,
    },
    {
      httpStatus: 404,
      loopId: "loop-alive-guard-404",
      jobId: "job-alive-404",
      pid: 33_333,
    },
  ]) {
    test(`HTTP ${httpStatus} + isProcessRunning=true: finalizeFn NOT called, telemetry emitted`, async () => {
      process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";
      mock.timers.enable({ apis: ["Date", "setInterval"] });
      installHeartbeatFetchStub(httpStatus);

      const testJob = createLocalJob({ id: jobId, loopId, pid });
      const stubJobStore = makeStubJobStore({ [loopId]: testJob });

      const finalizeCalls: unknown[] = [];
      const mockFinalizeFn = async (
        j: LocalJob,
        s: "TIMED_OUT" | "UNKNOWN"
      ) => {
        finalizeCalls.push({ j, s });
      };

      const telemetryEvents: TelemetryEventPayload[] = [];
      const mockTelemetry: TelemetryEmitter = {
        emit: (event) => {
          telemetryEvents.push(event);
        },
      };

      ctx.startHeartbeat(loopId, {
        apiBaseUrl: "https://api.example.com",
        getToken: () => "tok",
        jobStore: stubJobStore,
        finalizeFn: mockFinalizeFn,
        isProcessRunning: (_pid: number) => true,
        telemetry: mockTelemetry,
      });

      mock.timers.tick(1000);
      await flushAsync();

      // finalizeFn must NOT be called.
      assert.equal(
        finalizeCalls.length,
        0,
        `finalizeFn must not be called when process is alive (${httpStatus})`
      );

      // Telemetry must have been emitted on the canonical category with the
      // suppression context in trace + diagnostics.extra.
      const telemetryEvent = telemetryEvents.find(
        (e) => e.category === "loop.heartbeat.terminal_finalization_suppressed"
      );
      assert.ok(
        telemetryEvent,
        `telemetry event must be emitted for ${httpStatus}`
      );
      assert.equal(
        telemetryEvent.severity,
        "warn",
        "telemetry.severity must be warn"
      );
      assert.equal(
        telemetryEvent.trace?.loopId,
        loopId,
        "telemetry.trace.loopId must match"
      );
      const extra = telemetryEvent.diagnostics?.extra ?? {};
      assert.equal(
        extra.jobPid,
        pid,
        "telemetry.diagnostics.extra.jobPid must match"
      );
      assert.equal(
        extra.httpStatus,
        httpStatus,
        `telemetry.diagnostics.extra.httpStatus must be ${httpStatus}`
      );
    });
  }

  test("HTTP 410 + isProcessRunning=false: finalizeFn IS called (normal path)", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";
    mock.timers.enable({ apis: ["Date", "setInterval"] });
    installHeartbeatFetchStub(410);

    const loopId = "loop-dead-guard";
    const testJob = createLocalJob({ id: "job-dead", loopId, pid: 99_999 });
    const stubJobStore = makeStubJobStore({ [loopId]: testJob });

    const finalizeCalls: [LocalJob, string][] = [];
    const mockFinalizeFn = async (j: LocalJob, s: "TIMED_OUT" | "UNKNOWN") => {
      finalizeCalls.push([j, s]);
    };

    ctx.startHeartbeat(loopId, {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "tok",
      jobStore: stubJobStore,
      finalizeFn: mockFinalizeFn,
      isProcessRunning: (_pid: number) => false,
    });

    mock.timers.tick(1000);
    await flushAsync();

    assert.equal(
      finalizeCalls.length,
      1,
      "finalizeFn must be called when process is NOT alive"
    );
    assert.equal(
      finalizeCalls[0]?.[1],
      "UNKNOWN",
      "targetStatus must be UNKNOWN for 410"
    );
  });

  test("job.pid === null: finalization proceeds (cannot prove liveness)", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";
    mock.timers.enable({ apis: ["Date", "setInterval"] });
    installHeartbeatFetchStub(410);

    const loopId = "loop-null-pid";
    const testJob = createLocalJob({
      id: "job-null-pid",
      loopId,
      pid: undefined,
    });
    const stubJobStore = makeStubJobStore({ [loopId]: testJob });

    const finalizeCalls: unknown[] = [];
    const mockFinalizeFn = async (j: LocalJob, s: "TIMED_OUT" | "UNKNOWN") => {
      finalizeCalls.push([j, s]);
    };

    const isProcessRunningMock = mock.fn((_pid: number) => true);

    ctx.startHeartbeat(loopId, {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "tok",
      jobStore: stubJobStore,
      finalizeFn: mockFinalizeFn,
      isProcessRunning: isProcessRunningMock,
    });

    mock.timers.tick(1000);
    await flushAsync();

    assert.equal(
      finalizeCalls.length,
      1,
      "finalization must proceed when job.pid is null/undefined"
    );
    // isProcessRunning must not have been called since pid is null.
    assert.equal(
      isProcessRunningMock.mock.callCount(),
      0,
      "isProcessRunning must not be called for null pid"
    );
  });

  test("transient or live disposition: isProcessRunning NOT called", async () => {
    process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "1000";
    mock.timers.enable({ apis: ["Date", "setInterval"] });
    // 500 maps to transient disposition.
    installHeartbeatFetchStub(500);

    const loopId = "loop-transient-prd";
    const testJob = createLocalJob({
      id: "job-transient-prd",
      loopId,
      pid: 55_555,
    });
    const stubJobStore = makeStubJobStore({ [loopId]: testJob });

    const isProcessRunningMock = mock.fn((_pid: number) => true);

    ctx.startHeartbeat(loopId, {
      apiBaseUrl: "https://api.example.com",
      getToken: () => "tok",
      jobStore: stubJobStore,
      finalizeFn: async () => {},
      isProcessRunning: isProcessRunningMock,
    });

    mock.timers.tick(1000);
    await flushAsync();

    assert.equal(
      isProcessRunningMock.mock.callCount(),
      0,
      "isProcessRunning must NOT be called for transient disposition"
    );
  });
});
