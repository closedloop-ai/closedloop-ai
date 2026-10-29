/**
 * ISS-12120: GenAI request telemetry when the billing mode is not known yet.
 * On macOS a cold Keychain memo makes the detector answer with a promise
 * instead of blocking the main thread; the observation that needed it finishes
 * once it settles, and every later observation waits behind it in call order.
 * These pin that a deferred observation ships exactly what a synchronous one
 * would have, that waiting observations neither reorder nor double-ship, that
 * a rebind drops what waited for the old binding, that the queue is bounded,
 * and that a throw after the probe is logged instead of escaping.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { Harness } from "../src/main/collectors/types.js";
import { createGenAiRequestTelemetry } from "../src/main/telemetry/gen-ai-request-telemetry.js";
import type { BillingMode } from "../src/shared/billing-mode.js";
import {
  boundTelemetry,
  record,
  STARTED_AT,
  stampedAt,
} from "./support/gen-ai-request-telemetry-fixtures.js";

const QUEUE_FULL_LOG = /queue behind a billing-mode probe is full/;

/** Past the bridge's 120 s settle window. */
const SETTLED_AFTER_MS = 150_000;
/** The bridge's settle sweep period. */
const SETTLE_SWEEP_MS = 30_000;

afterEach(() => {
  vi.useRealTimers();
});

/** A detector whose Claude answers the test settles by hand; Codex answers at once. */
function pendingDetector() {
  const pending: {
    resolve: (mode: BillingMode) => void;
    reject: (error: Error) => void;
  }[] = [];
  const detect = (harness: Harness): BillingMode | Promise<BillingMode> =>
    harness === Harness.Claude
      ? new Promise<BillingMode>((resolve, reject) => {
          pending.push({ resolve, reject });
        })
      : "api";
  return { detect, pending };
}

/** Let every settled promise callback run: a macrotask drains them all. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function claudeSession(sessionId: string, seconds: readonly number[]) {
  return {
    sessionId,
    model: null,
    startedAt: STARTED_AT,
    tokenSeries: seconds.map((second) => record(second)),
  };
}

describe("GenAI request telemetry with a pending billing mode", () => {
  test("a deferred observation ships after the probe, with the cost its mode decides", async () => {
    const { detect, pending } = pendingDetector();
    const { emitted, telemetry } = boundTelemetry({
      detectBillingMode: detect,
    });

    telemetry.observeLiveSession(claudeSession("s1", [1, 2]), Harness.Claude);
    assert.equal(emitted.length, 0, "nothing ships before the mode is known");
    pending[0]?.resolve("subscription_unknown");
    await flush();

    // The first request is closed by the second; a subscription drops the cost.
    assert.deepEqual(stampedAt(emitted), [1000]);
    assert.equal(emitted[0]?.costUsd, undefined);
  });

  test("observations made during the probe ship in call order, each request once", async () => {
    const { detect, pending } = pendingDetector();
    const { emitted, telemetry } = boundTelemetry({
      detectBillingMode: detect,
    });

    telemetry.observeLiveSession(claudeSession("s1", [1, 2]), Harness.Claude);
    telemetry.observeLiveSession(
      {
        sessionId: "c1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [record(3)],
      },
      Harness.Codex
    );
    // A re-parse of s1 offers its first request again.
    telemetry.observeLiveSession(claudeSession("s1", [1, 2]), Harness.Claude);
    assert.equal(emitted.length, 0, "the Codex request jumped the queue");
    pending[0]?.resolve("api");
    await flush();
    // This detector never memoizes, so the re-parse (whose held second request
    // is still unseen) asks again; the real one answers from its fresh memo.
    pending[1]?.resolve("api");
    await flush();

    assert.deepEqual(stampedAt(emitted), [1000, 3000]);
  });

  test("a rebind while the probe runs ships nothing into the new binding", async () => {
    const { detect, pending } = pendingDetector();
    const { clock, emitted, telemetry } = boundTelemetry({
      detectBillingMode: detect,
    });

    telemetry.observeLiveSession(claudeSession("s1", [1, 2]), Harness.Claude);
    const rebound: number[] = [];
    clock.nowMs -= 10_000;
    telemetry.bindRuntime({
      emitGenAiRequestEvent: (input) => rebound.push(input.atUnixMs),
    });
    pending[0]?.resolve("api");
    await flush();

    assert.deepEqual(emitted, []);
    assert.deepEqual(rebound, []);
  });

  test("the queue keeps one slot per session and drops the oldest past its cap", async () => {
    const { detect, pending } = pendingDetector();
    const logged: string[] = [];
    const { emitted, telemetry } = boundTelemetry({
      detectBillingMode: detect,
      deferredCapacity: 2,
      log: (message) => logged.push(message),
    });

    telemetry.observeLiveSession(
      claudeSession("probing", [1, 2]),
      Harness.Claude
    );
    telemetry.observeLiveSession(
      claudeSession("oldest", [3, 4]),
      Harness.Claude
    );
    telemetry.observeLiveSession(claudeSession("kept", [5]), Harness.Claude);
    // A newer parse of a queued session replaces its slot rather than taking one.
    telemetry.observeLiveSession(claudeSession("kept", [5, 6]), Harness.Claude);
    telemetry.observeLiveSession(
      claudeSession("newest", [7, 8]),
      Harness.Claude
    );
    pending[0]?.resolve("api");
    await flush();
    pending[1]?.resolve("api");
    await flush();
    pending[2]?.resolve("api");
    await flush();

    assert.deepEqual(stampedAt(emitted), [1000, 5000, 7000]);
    assert.equal(logged.length, 1);
    assert.match(logged[0] ?? "", QUEUE_FULL_LOG);
  });

  test("the settle sweep waits while newer usage is pending on the probe", async () => {
    // Only the sweep's interval is faked, so `flush` still reaches a macrotask.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { detect, pending } = pendingDetector();
    const { clock, emitted, telemetry } = boundTelemetry({
      detectBillingMode: detect,
    });
    telemetry.observeLiveSession(claudeSession("s1", [1]), Harness.Claude);
    pending[0]?.resolve("api");
    await flush();

    // Settled by the clock, but a newer parse with grown usage is waiting.
    clock.nowMs += SETTLED_AFTER_MS;
    telemetry.observeLiveSession(
      {
        ...claudeSession("s1", []),
        tokenSeries: [record(1, { output: 99 })],
      },
      Harness.Claude
    );
    await vi.advanceTimersByTimeAsync(SETTLE_SWEEP_MS);
    assert.equal(emitted.length, 0, "the sweep shipped the stale usage");
    pending[1]?.resolve("api");
    await flush();
    clock.nowMs += SETTLED_AFTER_MS;
    await vi.advanceTimersByTimeAsync(SETTLE_SWEEP_MS);

    assert.deepEqual(
      emitted.map((input) => input.outputTokens),
      [99]
    );
  });

  test("a probe that fails drops its observation, logs it, and frees the queue", async () => {
    const { detect, pending } = pendingDetector();
    const logged: string[] = [];
    const { emitted, telemetry } = boundTelemetry({
      detectBillingMode: detect,
      log: (message) => logged.push(message),
    });

    telemetry.observeLiveSession(claudeSession("s1", [1, 2]), Harness.Claude);
    telemetry.observeLiveSession(
      {
        sessionId: "c1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [record(3)],
      },
      Harness.Codex
    );
    pending[0]?.reject(new Error("detector exploded"));
    await flush();

    assert.deepEqual(stampedAt(emitted), [3000]);
    assert.deepEqual(logged, [
      "gen_ai request telemetry dropped an observation: detector exploded",
    ]);
  });

  test("a throw while a deferred observation ships is logged, and the queue keeps draining", async () => {
    const { detect, pending } = pendingDetector();
    const logged: string[] = [];
    const shipped: string[] = [];
    const telemetry = createGenAiRequestTelemetry({
      now: () => Date.parse(STARTED_AT) + 3_600_000,
      detectBillingMode: detect,
      log: (message) => logged.push(message),
    });
    telemetry.bindRuntime({
      emitGenAiRequestEvent: (input) => {
        if (input.inputTokens === 666) {
          throw new Error("sink exploded");
        }
        shipped.push(String(input.atUnixMs));
      },
    });

    telemetry.observeLiveSession(
      {
        ...claudeSession("s1", []),
        tokenSeries: [record(1, { input: 666 }), record(2)],
      },
      Harness.Claude
    );
    telemetry.observeLiveSession(
      {
        sessionId: "c1",
        model: null,
        startedAt: STARTED_AT,
        tokenSeries: [record(3)],
      },
      Harness.Codex
    );
    pending[0]?.resolve("api");
    await flush();

    assert.deepEqual(logged, [
      "gen_ai request telemetry dropped an observation: sink exploded",
    ]);
    assert.equal(shipped.length, 1, "the queued Codex observation never ran");
  });

  test("a throw from an observation drained after the probe is logged, and the rest of the queue still ships", async () => {
    const { detect, pending } = pendingDetector();
    const logged: string[] = [];
    const shipped: number[] = [];
    const telemetry = createGenAiRequestTelemetry({
      now: () => Date.parse(STARTED_AT) + 3_600_000,
      detectBillingMode: detect,
      log: (message) => logged.push(message),
    });
    telemetry.bindRuntime({
      emitGenAiRequestEvent: (input) => {
        if (input.inputTokens === 666) {
          throw new Error("sink exploded");
        }
        shipped.push(input.inputTokens);
      },
    });
    const codex = (sessionId: string, input: number) => ({
      sessionId,
      model: null,
      startedAt: STARTED_AT,
      tokenSeries: [record(3, { input })],
    });

    telemetry.observeLiveSession(claudeSession("s1", [1, 2]), Harness.Claude);
    telemetry.observeLiveSession(codex("c1", 666), Harness.Codex);
    telemetry.observeLiveSession(codex("c2", 7), Harness.Codex);
    pending[0]?.resolve("api");
    await flush();

    assert.deepEqual(logged, [
      "gen_ai request telemetry dropped an observation: sink exploded",
    ]);
    assert.deepEqual(shipped, [10, 7]);
  });

  test("a newer parse of a queued session never overtakes another session's queued update", async () => {
    const { detect, pending } = pendingDetector();
    const { clock, emitted, telemetry } = boundTelemetry({
      detectBillingMode: detect,
    });
    const seconds = (value: number) => value * 1000;
    // b1 is held with its first usage.
    telemetry.observeLiveSession(claudeSession("b", [1]), Harness.Claude);
    pending[0]?.resolve("api");
    await flush();

    clock.nowMs += seconds(100);
    telemetry.observeLiveSession(claudeSession("c", [2]), Harness.Claude);
    clock.nowMs += seconds(5);
    telemetry.observeLiveSession(claudeSession("a", [3]), Harness.Claude);
    clock.nowMs += seconds(5);
    // b1's usage grew; this update waits behind c's probe.
    telemetry.observeLiveSession(
      { ...claudeSession("b", []), tokenSeries: [record(1, { output: 99 })] },
      Harness.Claude
    );
    clock.nowMs += seconds(20);
    // A newer parse of a, made after b's update, past b1's settle time.
    telemetry.observeLiveSession(claudeSession("a", [3, 4]), Harness.Claude);
    for (const settle of [1, 2, 3, 4]) {
      pending[settle]?.resolve("api");
      await flush();
    }

    // b's update was made first, so b1 holds its grown usage and has not
    // settled; only a's closed request ships.
    assert.deepEqual(stampedAt(emitted), [3000]);
  });
});
