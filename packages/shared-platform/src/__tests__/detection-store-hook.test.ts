import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGatewayDetectionSnapshot,
  resetGatewayDetectionForTests,
  subscribeGatewayDetection,
  useGatewayDetection,
} from "../detection-store";
import type { GatewayDetectionState } from "../types";

// The package ships no React renderer, so the two hooks `useGatewayDetection`
// calls are replaced with recorders: the store read returns the live client
// snapshot, and the effect is captured so a test can inspect its dependency
// list and run it by hand.
const reactCalls = vi.hoisted(() => ({
  effects: [] as { run: () => unknown; deps: unknown[] | undefined }[],
  stores: [] as {
    subscribe: unknown;
    getSnapshot: () => unknown;
    getServerSnapshot: () => unknown;
  }[],
}));

vi.mock("react", () => ({
  useEffect: (run: () => unknown, deps?: unknown[]) => {
    reactCalls.effects.push({ run, deps });
  },
  useSyncExternalStore: (
    subscribe: unknown,
    getSnapshot: () => unknown,
    getServerSnapshot: () => unknown
  ) => {
    reactCalls.stores.push({ subscribe, getSnapshot, getServerSnapshot });
    return getSnapshot();
  },
}));

vi.mock("../gateway-probe", () => ({
  probeGateway: vi.fn(),
}));

import { probeGateway } from "../gateway-probe";

const mockProbeGateway = vi.mocked(probeGateway);

const DETECTED_POLL_INTERVAL_MS = 10_000;
const FAST_POLL_MAX_ABSENT_SWEEPS = 12;

const DISABLED_STATE: GatewayDetectionState = {
  detected: false,
  loading: false,
  port: null,
  version: null,
  machineName: null,
  gatewayId: null,
  capabilities: null,
  onboardingCompleted: null,
  checkedAt: null,
};

const ABSENT_PROBE = {
  detected: false,
  port: null,
  version: null,
  machineName: null,
  gatewayId: null,
  capabilities: null,
  onboardingCompleted: null,
} as const;

const cleanups: (() => void)[] = [];

function lastEffect() {
  const effect = reactCalls.effects.at(-1);
  if (!effect) {
    throw new Error("useGatewayDetection registered no effect");
  }
  return effect;
}

function runLastEffect(): unknown {
  const cleanup = lastEffect().run();
  if (typeof cleanup === "function") {
    cleanups.push(cleanup as () => void);
  }
  return cleanup;
}

beforeEach(() => {
  // The store only probes in a browser; an empty window is enough to get past
  // that guard.
  vi.stubGlobal("window", {});
  resetGatewayDetectionForTests();
  reactCalls.effects.length = 0;
  reactCalls.stores.length = 0;
  mockProbeGateway.mockReset();
  mockProbeGateway.mockResolvedValue(ABSENT_PROBE);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetGatewayDetectionForTests();
});

describe("useGatewayDetection", () => {
  it("defaults to enabled with every option off when called with no arguments", () => {
    const state = useGatewayDetection();

    expect(lastEffect().deps).toEqual([true, false]);
    expect(state).toBe(getGatewayDetectionSnapshot());
  });

  it("reads the store through the shared subscribe and snapshot functions", () => {
    useGatewayDetection();

    const store = reactCalls.stores.at(-1);
    expect(store?.subscribe).toBe(subscribeGatewayDetection);
    expect(store?.getSnapshot).toBe(getGatewayDetectionSnapshot);
    const serverSnapshot = store?.getServerSnapshot();
    expect(serverSnapshot).toEqual({ ...DISABLED_STATE, loading: true });
    // useSyncExternalStore requires a cached snapshot, so the server read must
    // hand back the same object every time.
    expect(store?.getServerSnapshot()).toBe(serverSnapshot);
  });

  it("depends on each option as a primitive, in [enabled, fastPoll] order", () => {
    useGatewayDetection(true, { fastPoll: true });
    expect(lastEffect().deps).toEqual([true, true]);
  });

  it("returns the disabled state and starts no poll loop when disabled", () => {
    const state = useGatewayDetection(false, { fastPoll: true });

    expect(state).toEqual(DISABLED_STATE);
    expect(lastEffect().deps).toEqual([false, true]);
    expect(runLastEffect()).toBeUndefined();
    expect(mockProbeGateway).not.toHaveBeenCalled();
  });

  it("starts a poll loop that probes", () => {
    useGatewayDetection(true, { fastPoll: true });

    expect(typeof runLastEffect()).toBe("function");
    expect(mockProbeGateway).toHaveBeenCalledTimes(1);
  });

  it("stops the poll timer and detaches the re-arm listeners when the effect is cleaned up", async () => {
    vi.useFakeTimers();
    const fakeWindow = createListenerRecorder();
    const fakeDocument = createListenerRecorder();
    vi.stubGlobal("window", fakeWindow.target);
    vi.stubGlobal("document", fakeDocument.target);
    useGatewayDetection(true, { fastPoll: true });

    const cleanup = runLastEffect();
    // The first probe runs synchronously; this settles the `.then(scheduleNext)`
    // chain behind it so the next poll timer is armed before cleanup.
    await vi.advanceTimersByTimeAsync(0);
    expect(mockProbeGateway).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(fakeWindow.count("focus")).toBe(1);
    expect(fakeDocument.count("visibilitychange")).toBe(1);

    if (typeof cleanup !== "function") {
      throw new Error("the enabled effect returned no cleanup");
    }
    cleanup();
    await vi.advanceTimersByTimeAsync(DETECTED_POLL_INTERVAL_MS * 5);

    expect(mockProbeGateway).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(fakeWindow.count("focus")).toBe(0);
    expect(fakeDocument.count("visibilitychange")).toBe(0);
  });

  it("hands fastPoll to the loop so it spends the onboarding sweep budget", async () => {
    vi.useFakeTimers();
    useGatewayDetection(true, { fastPoll: true });
    runLastEffect();
    await vi.advanceTimersByTimeAsync(DETECTED_POLL_INTERVAL_MS * 500);

    expect(mockProbeGateway).toHaveBeenCalledTimes(FAST_POLL_MAX_ABSENT_SWEEPS);
  });
});

function createListenerRecorder() {
  const attached = new Map<string, Set<unknown>>();
  return {
    target: {
      visibilityState: "visible",
      addEventListener(type: string, listener: unknown): void {
        const listeners = attached.get(type) ?? new Set<unknown>();
        listeners.add(listener);
        attached.set(type, listeners);
      },
      removeEventListener(type: string, listener: unknown): void {
        attached.get(type)?.delete(listener);
      },
    },
    count(type: string): number {
      return attached.get(type)?.size ?? 0;
    },
  };
}
