import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canRearmGatewayDetection,
  ensureGatewayDetection,
  getAbsentSweepCount,
  getGatewayDetectionSnapshot,
  getNextProbeDelayMs,
  getRearmIntervalMs,
  invalidateGatewayDetectionCache,
  isGatewayDetectionExhausted,
  rearmGatewayDetection,
  resetGatewayDetectionForTests,
  startGatewayDetectionPolling,
  subscribeGatewayDetection,
} from "../detection-store";
import type { GatewayDetectionState } from "../types";

// Mock the gateway probe
vi.mock("../gateway-probe", () => ({
  probeGateway: vi.fn(),
}));

import { probeGateway } from "../gateway-probe";

const mockProbeGateway = vi.mocked(probeGateway);

const CACHE_TTL_MS = 60_000;
const DETECTED_POLL_INTERVAL_MS = 10_000;
const AMBIENT_MAX_ABSENT_SWEEPS = 1;
const FAST_POLL_MAX_ABSENT_SWEEPS = 12;
const RECOVERY_MAX_ABSENT_SWEEPS = 3;
const REARM_BASE_INTERVAL_MS = 30_000;
const REARM_MAX_INTERVAL_MS = 30 * 60_000;

const DETECTED_PROBE = {
  detected: true,
  port: 19_432,
  version: "1.0.0",
  machineName: "test",
  gatewayId: "gw-1",
  capabilities: {},
  onboardingCompleted: true,
} as const;

const ABSENT_PROBE = {
  detected: false,
  port: null,
  version: null,
  machineName: null,
  gatewayId: null,
  capabilities: null,
  onboardingCompleted: null,
} as const;

// Flush the native microtask queue so a resolved-probe `.then` chain runs
// without advancing the (fake) timer clock.
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function probeCount(): number {
  return mockProbeGateway.mock.calls.length;
}

/**
 * Minimal stand-in for an event target that records listeners, so a test can
 * fire the re-arm signals the poll loop subscribes to and assert they are
 * detached on dispose.
 *
 * Two of these are stubbed separately, because the browser dispatches the two
 * signals on two different objects: `focus` on `window`, and `visibilitychange`
 * on `document` (it does not bubble to the window). A single shared fake would
 * accept a `visibilitychange` listener registered on the window and hide the
 * fact that no such event is ever delivered there in a real browser.
 */
function createFakeEventTarget() {
  const handlers = new Map<string, Set<() => void>>();
  const target = {
    visibilityState: "visible",
    addEventListener(type: string, listener: () => void): void {
      const existing = handlers.get(type) ?? new Set<() => void>();
      existing.add(listener);
      handlers.set(type, existing);
    },
    removeEventListener(type: string, listener: () => void): void {
      handlers.get(type)?.delete(listener);
    },
  };

  return {
    target,
    setVisibility(state: string): void {
      target.visibilityState = state;
    },
    dispatch(type: string): void {
      for (const listener of [...(handlers.get(type) ?? [])]) {
        listener();
      }
    },
    listenerCount(): number {
      let total = 0;
      for (const set of handlers.values()) {
        total += set.size;
      }
      return total;
    },
  };
}

function stateWith(
  overrides: Partial<GatewayDetectionState>
): GatewayDetectionState {
  return {
    detected: false,
    loading: false,
    port: null,
    version: null,
    machineName: null,
    gatewayId: null,
    capabilities: null,
    onboardingCompleted: null,
    checkedAt: 1,
    ...overrides,
  };
}

describe("detection-store", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    resetGatewayDetectionForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns default state initially", () => {
    const snapshot = getGatewayDetectionSnapshot();
    expect(snapshot.detected).toBe(false);
    expect(snapshot.loading).toBe(true);
    expect(snapshot.checkedAt).toBeNull();
  });

  it("updates snapshot after successful probe", async () => {
    mockProbeGateway.mockResolvedValueOnce({
      detected: true,
      port: 19_432,
      version: "1.0.0",
      machineName: "test-machine",
      gatewayId: "gw-123",
      capabilities: {},
      onboardingCompleted: true,
    });

    const result = await ensureGatewayDetection();

    expect(result.detected).toBe(true);
    expect(result.port).toBe(19_432);
    expect(result.version).toBe("1.0.0");
    expect(result.loading).toBe(false);
    expect(result.checkedAt).toBeTypeOf("number");
  });

  it("handles probe failure gracefully", async () => {
    mockProbeGateway.mockRejectedValueOnce(new Error("Network error"));

    const result = await ensureGatewayDetection();

    expect(result.detected).toBe(false);
    expect(result.loading).toBe(false);
    expect(result.checkedAt).toBeTypeOf("number");
  });

  it("uses cached result within TTL", async () => {
    mockProbeGateway.mockResolvedValueOnce(DETECTED_PROBE);

    await ensureGatewayDetection();
    const firstCallCount = probeCount();

    await ensureGatewayDetection();
    expect(probeCount()).toBe(firstCallCount);
  });

  it("re-probes after cache invalidation", async () => {
    mockProbeGateway.mockResolvedValue(DETECTED_PROBE);

    await ensureGatewayDetection();
    const firstCallCount = probeCount();

    invalidateGatewayDetectionCache();
    await ensureGatewayDetection();
    expect(probeCount()).toBe(firstCallCount + 1);
  });

  it("notifies listeners on state change", async () => {
    const listener = vi.fn();
    subscribeGatewayDetection(listener);

    mockProbeGateway.mockResolvedValueOnce(DETECTED_PROBE);

    await ensureGatewayDetection();
    expect(listener).toHaveBeenCalled();
  });

  it("returns SSR-safe state when window is undefined", async () => {
    vi.stubGlobal("window", undefined);
    resetGatewayDetectionForTests();

    const result = await ensureGatewayDetection();
    expect(result.detected).toBe(false);
    expect(result.loading).toBe(false);
  });

  it("deduplicates concurrent probes", async () => {
    const callCountBefore = probeCount();
    let resolveProbe:
      | ((value: Awaited<ReturnType<typeof probeGateway>>) => void)
      | undefined;
    mockProbeGateway.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        })
    );

    const p1 = ensureGatewayDetection({ force: true });
    const p2 = ensureGatewayDetection({ force: true });

    resolveProbe?.(DETECTED_PROBE);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(probeCount() - callCountBefore).toBe(1);
  });

  it("resolves an absent state (no throw) when the loopback probe is rejected", async () => {
    // Simulates the browser rejecting the localhost fetch (PNA/CORS/ERR_FAILED)
    // for a plain web user with no desktop gateway. The store must treat this
    // as the normal "not installed" signal, not surface it as an error.
    mockProbeGateway.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(ensureGatewayDetection()).resolves.toMatchObject({
      detected: false,
      loading: false,
    });
  });

  it("counts a rejected loopback probe as an absent sweep", async () => {
    mockProbeGateway.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await ensureGatewayDetection();

    // The browser refusing the loopback request IS the negative answer. If it
    // did not count against the sweep budget, the give-up rule below would
    // never trigger for the exact user the ticket is about.
    expect(getAbsentSweepCount()).toBe(1);
  });
});

describe("getNextProbeDelayMs", () => {
  it("uses the responsive cadence while the gateway is present", () => {
    expect(getNextProbeDelayMs(stateWith({ detected: true }))).toBe(
      DETECTED_POLL_INTERVAL_MS
    );
  });

  // Every absent sweep issues one refused loopback request per probe port, and
  // the browser's network stack logs each refusal itself -- a JS `.catch()`
  // cannot suppress it. Once the answer is known, the only correct delay is
  // "never": a slower cadence still floods the console, just more slowly.
  it("stops ambient probing entirely once a sweep comes back absent", () => {
    const absent = stateWith({ detected: false });
    expect(getNextProbeDelayMs(absent, { absentSweeps: 0 })).toBe(
      DETECTED_POLL_INTERVAL_MS
    );
    expect(
      getNextProbeDelayMs(absent, { absentSweeps: AMBIENT_MAX_ABSENT_SWEEPS })
    ).toBeNull();
    expect(getNextProbeDelayMs(absent, { absentSweeps: 500 })).toBeNull();
  });

  it("gives fastPoll a larger absent budget, then stops too", () => {
    const absent = stateWith({ detected: false });
    expect(
      getNextProbeDelayMs(absent, {
        fastPoll: true,
        absentSweeps: FAST_POLL_MAX_ABSENT_SWEEPS - 1,
      })
    ).toBe(DETECTED_POLL_INTERVAL_MS);
    expect(
      getNextProbeDelayMs(absent, {
        fastPoll: true,
        absentSweeps: FAST_POLL_MAX_ABSENT_SWEEPS,
      })
    ).toBeNull();
    expect(
      getNextProbeDelayMs(absent, { fastPoll: true, absentSweeps: 500 })
    ).toBeNull();
  });

  it("returns to the responsive cadence once the gateway appears", () => {
    expect(
      getNextProbeDelayMs(stateWith({ detected: true }), {
        fastPoll: true,
        absentSweeps: 999,
      })
    ).toBe(DETECTED_POLL_INTERVAL_MS);
  });
});

describe("startGatewayDetectionPolling", () => {
  let fakeWindow: ReturnType<typeof createFakeEventTarget>;
  let fakeDocument: ReturnType<typeof createFakeEventTarget>;

  beforeEach(() => {
    fakeWindow = createFakeEventTarget();
    fakeDocument = createFakeEventTarget();
    vi.stubGlobal("window", fakeWindow.target);
    vi.stubGlobal("document", fakeDocument.target);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
    mockProbeGateway.mockReset();
    resetGatewayDetectionForTests();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stops probing entirely after a single absent sweep", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    const dispose = startGatewayDetectionPolling();
    // Flush the immediate probe's microtasks without advancing the clock.
    await flushMicrotasks();
    expect(probeCount()).toBe(1);

    // The give-up rule: no timer is armed at all, so there is no cadence -- fast
    // or slow -- that could re-emit the refused loopback requests.
    expect(vi.getTimerCount()).toBe(0);

    // An hour of idle time on a page left open must add nothing.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(probeCount()).toBe(1);

    dispose();
  });

  it("does not re-probe when a route change remounts the hook after the stop", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    const dispose = startGatewayDetectionPolling();
    await flushMicrotasks();
    dispose();
    expect(probeCount()).toBe(1);

    // The cache TTL has long expired; the remembered negative must still hold,
    // otherwise navigating around the app re-floods the console.
    await vi.advanceTimersByTimeAsync(CACHE_TTL_MS * 5);

    const disposeAgain = startGatewayDetectionPolling();
    await flushMicrotasks();
    expect(probeCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    disposeAgain();
  });

  it("does not re-probe on cache expiry once the gateway is known absent", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    await ensureGatewayDetection();
    expect(probeCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(CACHE_TTL_MS * 3);
    await ensureGatewayDetection();

    expect(probeCount()).toBe(1);
  });

  it("bounds the fastPoll probe loop and then stops", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    const dispose = startGatewayDetectionPolling({ fastPoll: true });
    await flushMicrotasks();
    expect(probeCount()).toBe(1);

    // Unbounded, this window produces one sweep per fast interval, forever.
    // Bounded, the loop spends exactly its budget and then arms nothing.
    await vi.advanceTimersByTimeAsync(DETECTED_POLL_INTERVAL_MS * 500);
    expect(probeCount()).toBe(FAST_POLL_MAX_ABSENT_SWEEPS);
    expect(vi.getTimerCount()).toBe(0);

    dispose();
  });

  it("keeps the responsive cadence while the gateway is present", async () => {
    mockProbeGateway.mockResolvedValue(DETECTED_PROBE);

    const dispose = startGatewayDetectionPolling();
    await flushMicrotasks();
    expect(probeCount()).toBe(1);

    // Detected: the next probe fires at the fast cadence, with no extra latency
    // introduced by the give-up machinery.
    await vi.advanceTimersByTimeAsync(DETECTED_POLL_INTERVAL_MS);
    expect(probeCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(DETECTED_POLL_INTERVAL_MS);
    expect(probeCount()).toBe(3);

    dispose();
  });

  it("re-arms on a focus signal when the desktop app starts later", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    const dispose = startGatewayDetectionPolling();
    await flushMicrotasks();
    expect(probeCount()).toBe(1);

    // Inside the debounce window a focus signal must not re-probe, or a user
    // alternating between apps turns every switch back into a sweep.
    fakeWindow.dispatch("focus");
    await flushMicrotasks();
    expect(probeCount()).toBe(1);

    // The user installs and launches the desktop app, then returns to the tab.
    await vi.advanceTimersByTimeAsync(REARM_BASE_INTERVAL_MS);
    mockProbeGateway.mockResolvedValue(DETECTED_PROBE);
    fakeWindow.dispatch("focus");
    await flushMicrotasks();

    expect(probeCount()).toBe(2);
    expect(getGatewayDetectionSnapshot().detected).toBe(true);

    // ...and the loop resumes the responsive cadence without a reload.
    await vi.advanceTimersByTimeAsync(DETECTED_POLL_INTERVAL_MS);
    expect(probeCount()).toBe(3);

    dispose();
  });

  it("re-arms on a visibility signal as well as focus", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    const dispose = startGatewayDetectionPolling();
    await flushMicrotasks();
    expect(probeCount()).toBe(1);

    // Dispatched on the DOCUMENT, which is where a browser fires it. Switching
    // back to a hidden tab that never lost window focus produces only this
    // event, so a listener bound to the window would never see it.
    await vi.advanceTimersByTimeAsync(REARM_BASE_INTERVAL_MS);
    fakeDocument.dispatch("visibilitychange");
    await flushMicrotasks();

    expect(probeCount()).toBe(2);
    expect(fakeWindow.listenerCount()).toBe(1);

    dispose();
  });

  it("backs the re-arm debounce off while re-arms keep finding nothing", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    const dispose = startGatewayDetectionPolling();
    await flushMicrotasks();
    expect(getRearmIntervalMs()).toBe(REARM_BASE_INTERVAL_MS);

    await vi.advanceTimersByTimeAsync(REARM_BASE_INTERVAL_MS);
    fakeWindow.dispatch("focus");
    await flushMicrotasks();
    expect(probeCount()).toBe(2);
    expect(getRearmIntervalMs()).toBe(REARM_BASE_INTERVAL_MS * 2);

    // One base interval later the signal is still debounced away...
    await vi.advanceTimersByTimeAsync(REARM_BASE_INTERVAL_MS);
    fakeWindow.dispatch("focus");
    await flushMicrotasks();
    expect(probeCount()).toBe(2);

    // ...and only clears at the doubled interval.
    await vi.advanceTimersByTimeAsync(REARM_BASE_INTERVAL_MS);
    fakeWindow.dispatch("focus");
    await flushMicrotasks();
    expect(probeCount()).toBe(3);

    dispose();
  });

  it("caps the re-arm debounce so it cannot grow without bound", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    const dispose = startGatewayDetectionPolling();
    await flushMicrotasks();

    for (let attempt = 0; attempt < 20; attempt++) {
      await vi.advanceTimersByTimeAsync(REARM_MAX_INTERVAL_MS);
      fakeWindow.dispatch("focus");
      await flushMicrotasks();
    }

    expect(getRearmIntervalMs()).toBe(REARM_MAX_INTERVAL_MS);
    expect(canRearmGatewayDetection()).toBe(false);

    dispose();
  });

  it("resumes a stopped loop from an explicit re-arm", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    const dispose = startGatewayDetectionPolling();
    await flushMicrotasks();
    expect(probeCount()).toBe(1);

    // The UI "Check again" affordance: an explicit user request bypasses the
    // debounce entirely.
    mockProbeGateway.mockResolvedValue(DETECTED_PROBE);
    await rearmGatewayDetection();
    await flushMicrotasks();

    expect(probeCount()).toBe(2);
    expect(getGatewayDetectionSnapshot().detected).toBe(true);

    await vi.advanceTimersByTimeAsync(DETECTED_POLL_INTERVAL_MS);
    expect(probeCount()).toBe(3);

    dispose();
  });

  it("probes once for an explicit re-arm with no poll loop mounted", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    await ensureGatewayDetection();
    expect(probeCount()).toBe(1);

    await rearmGatewayDetection();
    expect(probeCount()).toBe(2);
  });

  it("clears the pending timer and re-arm listeners on dispose", async () => {
    mockProbeGateway.mockResolvedValue(DETECTED_PROBE);

    const dispose = startGatewayDetectionPolling();
    await flushMicrotasks();
    expect(probeCount()).toBe(1);
    // One listener per target: `focus` on the window, `visibilitychange` on the
    // document.
    expect(fakeWindow.listenerCount()).toBe(1);
    expect(fakeDocument.listenerCount()).toBe(1);

    dispose();

    // No pending timers remain, no listeners remain, and neither the clock nor
    // a re-arm signal can produce another probe.
    expect(vi.getTimerCount()).toBe(0);
    expect(fakeWindow.listenerCount()).toBe(0);
    expect(fakeDocument.listenerCount()).toBe(0);

    fakeWindow.dispatch("focus");
    fakeDocument.dispatch("visibilitychange");
    await vi.advanceTimersByTimeAsync(REARM_MAX_INTERVAL_MS * 2);
    await flushMicrotasks();
    expect(probeCount()).toBe(1);
  });

  it("arms no timer when disposed before the initial probe resolves", async () => {
    // Hold the very first probe unresolved, dispose while it is still in
    // flight, THEN resolve it. The `disposed` guard in scheduleNext must reject
    // the late schedule so no interval leaks past the disposer -- otherwise the
    // guard could regress without the "already-armed" cleanup test catching it.
    let resolveProbe:
      | ((value: Awaited<ReturnType<typeof probeGateway>>) => void)
      | undefined;
    mockProbeGateway.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        })
    );

    const dispose = startGatewayDetectionPolling();
    dispose();

    resolveProbe?.(DETECTED_PROBE);
    await flushMicrotasks();

    expect(vi.getTimerCount()).toBe(0);
    expect(fakeWindow.listenerCount()).toBe(0);
    expect(fakeDocument.listenerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DETECTED_POLL_INTERVAL_MS * 5);
    expect(probeCount()).toBe(1);

    dispose();
  });

  it("spends one shared absent budget across concurrent mount sites", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    // Five components mount the hook on the same page. A per-loop budget would
    // let each one spend its own, multiplying the refused requests by the mount
    // count; the budget is module-level precisely to stop that.
    const disposers = [
      startGatewayDetectionPolling(),
      startGatewayDetectionPolling(),
      startGatewayDetectionPolling(),
      startGatewayDetectionPolling(),
      startGatewayDetectionPolling(),
    ];
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(probeCount()).toBe(1);

    for (const dispose of disposers) {
      dispose();
    }
  });

  it("recovers a detected gateway that goes quiet for a sweep", async () => {
    mockProbeGateway.mockResolvedValue(DETECTED_PROBE);

    const dispose = startGatewayDetectionPolling();
    await flushMicrotasks();
    expect(getGatewayDetectionSnapshot().detected).toBe(true);

    // The gateway blips -- a desktop self-update, a sleep/resume, one dropped
    // probe. The ambient one-sweep rule must NOT apply here: it would stop
    // detection for good while the app is still running, and every consumer
    // would report not-detected until the user happened to refocus the tab.
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);
    await vi.advanceTimersByTimeAsync(DETECTED_POLL_INTERVAL_MS);
    expect(getGatewayDetectionSnapshot().detected).toBe(false);

    mockProbeGateway.mockResolvedValue(DETECTED_PROBE);
    await vi.advanceTimersByTimeAsync(DETECTED_POLL_INTERVAL_MS);

    expect(getGatewayDetectionSnapshot().detected).toBe(true);

    dispose();
  });

  it("stops after the recovery budget when the gateway really did shut down", async () => {
    mockProbeGateway.mockResolvedValue(DETECTED_PROBE);

    const dispose = startGatewayDetectionPolling();
    await flushMicrotasks();
    const detectedProbes = probeCount();

    // A genuine quit still converges: the recovery budget buys a few sweeps,
    // then the ambient rule takes over and the loop arms no timer at all.
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(probeCount() - detectedProbes).toBe(RECOVERY_MAX_ABSENT_SWEEPS);
    expect(vi.getTimerCount()).toBe(0);

    dispose();
  });

  it("re-checks the shared budget when a staggered timer fires", async () => {
    mockProbeGateway.mockResolvedValue(DETECTED_PROBE);

    const disposeFirst = startGatewayDetectionPolling();
    await flushMicrotasks();
    const detectedProbes = probeCount();

    // A second consumer mounts half a cadence later, so its timer is always
    // armed while the first loop is between probes -- the ordinary staggered
    // case for two components on one page.
    await vi.advanceTimersByTimeAsync(DETECTED_POLL_INTERVAL_MS / 2);
    const disposeSecond = startGatewayDetectionPolling();
    await flushMicrotasks();

    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    // The recovery budget is a TOTAL, not a per-consumer allowance. The second
    // loop's timer was armed while budget remained and fires after the first
    // loop spends the last sweep; without a re-check at fire time it probes
    // anyway, so the cap would scale with the number of mounted consumers.
    expect(probeCount() - detectedProbes).toBe(RECOVERY_MAX_ABSENT_SWEEPS);
    expect(vi.getTimerCount()).toBe(0);

    disposeFirst();
    disposeSecond();
  });

  it("does not charge the passive backoff for an explicit user re-check", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    const dispose = startGatewayDetectionPolling();
    await flushMicrotasks();
    expect(getRearmIntervalMs()).toBe(REARM_BASE_INTERVAL_MS);

    // The button already bypasses the debounce, so charging it an attempt would
    // only slow the passive focus re-arm as a side effect of asking more often.
    await rearmGatewayDetection({ userInitiated: true });
    await rearmGatewayDetection({ userInitiated: true });
    await flushMicrotasks();

    expect(probeCount()).toBe(3);
    expect(getRearmIntervalMs()).toBe(REARM_BASE_INTERVAL_MS);

    dispose();
  });

  it("counts one re-arm attempt when several consumers share one signal", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    const disposers = [
      startGatewayDetectionPolling(),
      startGatewayDetectionPolling(),
      startGatewayDetectionPolling(),
      startGatewayDetectionPolling(),
    ];
    await flushMicrotasks();
    expect(probeCount()).toBe(1);
    expect(getRearmIntervalMs()).toBe(REARM_BASE_INTERVAL_MS);

    // Restoring a minimized window fires `visibilitychange` AND `focus`, and each
    // mounted loop has its own listener -- eight handlers for one user gesture.
    // After a long idle gap every one of them clears the debounce, because the
    // gap still dwarfs each freshly doubled interval. `inFlight` collapses them
    // into a single probe, so they must also count as a single ATTEMPT: counting
    // per call would drive the backoff to its 30-minute cap on one tab restore
    // and strand detection on a surface that has no re-check control.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    fakeDocument.dispatch("visibilitychange");
    fakeWindow.dispatch("focus");
    await flushMicrotasks();

    expect(probeCount()).toBe(2);
    expect(getRearmIntervalMs()).toBe(REARM_BASE_INTERVAL_MS * 2);

    for (const dispose of disposers) {
      dispose();
    }
  });

  it("ignores a visibility signal raised as the tab is being hidden", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    const dispose = startGatewayDetectionPolling();
    await flushMicrotasks();
    expect(probeCount()).toBe(1);

    // `visibilitychange` fires on hide as well as show. Treating the hide as a
    // re-arm would sweep loopback on a page nobody is looking at -- emitting the
    // exact refused-request log this store exists to stop.
    fakeDocument.setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    fakeDocument.dispatch("visibilitychange");
    await flushMicrotasks();
    expect(probeCount()).toBe(1);

    // Coming back is a real signal and must still re-arm.
    fakeDocument.setVisibility("visible");
    fakeDocument.dispatch("visibilitychange");
    await flushMicrotasks();
    expect(probeCount()).toBe(2);

    dispose();
  });

  it("restores the fastPoll budget when the onboarding step remounts", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    const dispose = startGatewayDetectionPolling({ fastPoll: true });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(DETECTED_POLL_INTERVAL_MS * 500);
    expect(probeCount()).toBe(FAST_POLL_MAX_ABSENT_SWEEPS);
    dispose();

    // Stepping back and returning to the download step remounts it. That is
    // explicit user intent on the very screen watching for the install, so it
    // must get its budget back rather than inherit the spent module-global
    // counter -- otherwise the step arms no timer, never probes, and sits on
    // "not detected" even with Desktop running.
    const disposeAgain = startGatewayDetectionPolling({ fastPoll: true });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(DETECTED_POLL_INTERVAL_MS * 500);

    expect(probeCount()).toBe(FAST_POLL_MAX_ABSENT_SWEEPS * 2);
    disposeAgain();
  });
});

describe("isGatewayDetectionExhausted", () => {
  let fakeWindow: ReturnType<typeof createFakeEventTarget>;
  let fakeDocument: ReturnType<typeof createFakeEventTarget>;

  beforeEach(() => {
    fakeWindow = createFakeEventTarget();
    fakeDocument = createFakeEventTarget();
    vi.stubGlobal("window", fakeWindow.target);
    vi.stubGlobal("document", fakeDocument.target);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
    mockProbeGateway.mockReset();
    resetGatewayDetectionForTests();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports the ambient loop exhausted after its single sweep", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    const dispose = startGatewayDetectionPolling();
    await flushMicrotasks();

    // The ambient loop has armed no further timer, so the answer it reached is
    // final. A consumer that assumed the onboarding budget would keep saying
    // "still looking" through eleven sweeps nobody is going to run.
    expect(getAbsentSweepCount()).toBe(AMBIENT_MAX_ABSENT_SWEEPS);
    expect(vi.getTimerCount()).toBe(0);
    expect(isGatewayDetectionExhausted()).toBe(true);

    dispose();
  });

  it("is not exhausted while a fastPoll loop still has sweeps queued", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    const dispose = startGatewayDetectionPolling({ fastPoll: true });
    await flushMicrotasks();

    // Same absent count as the ambient case above, opposite answer: this loop
    // has a timer armed and more sweeps to run, so nothing has been established.
    expect(getAbsentSweepCount()).toBe(AMBIENT_MAX_ABSENT_SWEEPS);
    expect(isGatewayDetectionExhausted()).toBe(false);

    await vi.advanceTimersByTimeAsync(DETECTED_POLL_INTERVAL_MS * 500);
    expect(probeCount()).toBe(FAST_POLL_MAX_ABSENT_SWEEPS);
    expect(isGatewayDetectionExhausted()).toBe(true);

    dispose();
  });

  it("returns to the ambient budget once the fastPoll loop is disposed", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    const dispose = startGatewayDetectionPolling({ fastPoll: true });
    await flushMicrotasks();
    expect(isGatewayDetectionExhausted()).toBe(false);

    // Leaving the onboarding step must hand the budget back. Otherwise the
    // raised allowance outlives the loop that earned it and every later
    // consumer reads "still looking" against a loop that stopped.
    dispose();
    dispose();

    expect(isGatewayDetectionExhausted()).toBe(true);
  });
});
