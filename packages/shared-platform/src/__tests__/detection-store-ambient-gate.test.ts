/**
 * ISS-6084 -- the ambient probe gate.
 *
 * Every assertion here is about REQUESTS NOT MADE. The refused-loopback log
 * (`net::ERR_CONNECTION_REFUSED`) is emitted by the browser's own network stack
 * before any JS promise rejects, so it cannot be caught, swallowed, or bounded
 * after the fact -- the only fix is to not issue the request. `probeCount()`
 * being 0 is therefore the contract, not an implementation detail.
 *
 * Lives beside `detection-store.test.ts` rather than inside it: that file is
 * already 864 lines and this block would push it against the 1,000-line ceiling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureGatewayDetection,
  getAbsentSweepCount,
  getGatewayDetectionSnapshot,
  hasSeenGatewayBefore,
  isGatewayDetectionExhausted,
  isGatewayProbePermitted,
  resetGatewayDetectionForTests,
  startGatewayDetectionPolling,
} from "../detection-store";

vi.mock("../gateway-probe", () => ({
  probeGateway: vi.fn(),
}));

import { probeGateway } from "../gateway-probe";

const mockProbeGateway = vi.mocked(probeGateway);

const CACHE_TTL_MS = 60_000;

const DETECTED_PROBE = {
  detected: true,
  port: 19_432,
  version: "1.0.0",
  machineName: "test-machine",
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function probeCount(): number {
  return mockProbeGateway.mock.calls.length;
}

/** Map-backed `localStorage` stand-in; the suite's environment is `node`. */
function createFakeStorage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string): string | null => entries.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      entries.set(key, value);
    },
    removeItem: (key: string): void => {
      entries.delete(key);
    },
  };
}

describe("ambient gateway probe gate (ISS-6084)", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    vi.stubGlobal("document", {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      visibilityState: "visible",
    });
    vi.stubGlobal("localStorage", createFakeStorage());
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    mockProbeGateway.mockReset();
    resetGatewayDetectionForTests();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("issues zero localhost requests for a visitor with no desktop evidence", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    const dispose = startGatewayDetectionPolling({ ambient: true });
    await flushMicrotasks();

    // Not "one sweep then stop" -- NOT ONE REQUEST. This is the whole ticket.
    expect(probeCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    // A page left open, and a page navigated around, must both stay silent.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(probeCount()).toBe(0);

    dispose();
    const disposeAgain = startGatewayDetectionPolling({ ambient: true });
    await flushMicrotasks();
    expect(probeCount()).toBe(0);
    disposeAgain();
  });

  it("settles consumers out of loading so routing selection is not stranded", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    const dispose = startGatewayDetectionPolling({ ambient: true });
    await flushMicrotasks();

    const snapshot = getGatewayDetectionSnapshot();
    // The web bootstrap returns early while `loading` is true, so a suppressed
    // loop that never settled would freeze CloudRelay auto-selection forever.
    expect(snapshot.loading).toBe(false);
    expect(snapshot.detected).toBe(false);
    // `checkedAt` must stay null: it is the store's "a probe answered this"
    // marker, and the fetch interceptor reads it to decide whether to force a
    // probe before a LocalElectron dispatch.
    expect(snapshot.checkedAt).toBeNull();

    dispose();
  });

  it("still probes on an intentful request after an ambient loop was suppressed", async () => {
    mockProbeGateway.mockResolvedValue(DETECTED_PROBE);

    const dispose = startGatewayDetectionPolling({ ambient: true });
    await flushMicrotasks();
    expect(probeCount()).toBe(0);

    // The dispatch path (a user actually driving the Engineer feature) must not
    // inherit the ambient suppression as a cached negative.
    const result = await ensureGatewayDetection();

    expect(probeCount()).toBe(1);
    expect(result.detected).toBe(true);

    dispose();
  });

  it("probes ambiently when the user owns a registered compute target", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    const dispose = startGatewayDetectionPolling({
      ambient: true,
      desktopKnown: true,
    });
    await flushMicrotasks();

    expect(probeCount()).toBe(1);

    dispose();
  });

  it("starts probing when desktopKnown flips true after the compute-targets read lands", async () => {
    mockProbeGateway.mockResolvedValue(DETECTED_PROBE);

    // The real production sequence: `useComputeTargets` is cold on first render,
    // so the ambient loop mounts gated and calls settleWithoutProbing. When the
    // query resolves, `desktopKnown` flips and the effect rebuilds the loop.
    const disposeGated = startGatewayDetectionPolling({ ambient: true });
    await flushMicrotasks();
    expect(probeCount()).toBe(0);
    disposeGated();

    const dispose = startGatewayDetectionPolling({
      ambient: true,
      desktopKnown: true,
    });
    await flushMicrotasks();

    // The suppressed first loop must not have left behind a cached negative or a
    // spent sweep budget that blocks this one -- that would strand a desktop
    // user on "not detected" for the life of the page.
    expect(probeCount()).toBe(1);
    expect(getGatewayDetectionSnapshot().detected).toBe(true);

    dispose();
  });

  it("probes ambiently on a browser that has detected a gateway before", async () => {
    // Bootstrap: an intentful loop finds the gateway and writes the marker...
    mockProbeGateway.mockResolvedValue(DETECTED_PROBE);
    await ensureGatewayDetection();
    expect(hasSeenGatewayBefore()).toBe(true);

    // ...and from then on the ambient loop is allowed to look, even with no
    // compute target (a desktop app running with cloud sync off). Advance past
    // the cache TTL first, so what is measured is the gate rather than the
    // still-fresh snapshot the first probe left behind.
    mockProbeGateway.mockReset();
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);
    await vi.advanceTimersByTimeAsync(CACHE_TTL_MS + 1);
    const dispose = startGatewayDetectionPolling({ ambient: true });
    await flushMicrotasks();

    expect(probeCount()).toBe(1);

    dispose();
  });

  it("keeps probing for the onboarding fastPoll loop with no prior evidence", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    // The user is installing the desktop app on this very screen; this is the
    // primary first-ever-detection bootstrap and must never be gated.
    const dispose = startGatewayDetectionPolling({ fastPoll: true });
    await flushMicrotasks();

    expect(probeCount()).toBe(1);

    dispose();
  });

  it("keeps probing for a non-ambient loop with no prior evidence", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    // Consumers that mount only under an explicitly selected LocalElectron
    // routing mode (branch view, chat, repo path) pass no `ambient` flag.
    const dispose = startGatewayDetectionPolling();
    await flushMicrotasks();

    expect(probeCount()).toBe(1);

    dispose();
  });

  it("does not let a suppressed ambient loop corrupt a sibling fastPoll budget", async () => {
    mockProbeGateway.mockResolvedValue(ABSENT_PROBE);

    // `absentSweeps` is module-global and shared across loop kinds, and
    // `isGatewayDetectionExhausted` is what the onboarding "we looked and did
    // not find it" copy reads. A suppressed ambient loop must contribute
    // nothing to that counter — spending a sweep it never ran would make the
    // onboarding step claim it finished looking before it started.
    const disposeAmbient = startGatewayDetectionPolling({ ambient: true });
    await flushMicrotasks();
    expect(getAbsentSweepCount()).toBe(0);
    expect(isGatewayDetectionExhausted()).toBe(false);

    const disposeFast = startGatewayDetectionPolling({ fastPoll: true });
    await flushMicrotasks();

    // The onboarding loop gets its full budget, unspent by its ambient sibling.
    expect(probeCount()).toBe(1);
    expect(isGatewayDetectionExhausted()).toBe(false);

    disposeFast();
    disposeAmbient();
  });

  it("treats an unreadable storage as no evidence instead of throwing", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    });

    // Safari private mode and hardened profiles throw on access. A false
    // negative costs one explicit re-check; a thrown error would break render.
    expect(hasSeenGatewayBefore()).toBe(false);
    expect(isGatewayProbePermitted({ ambient: true })).toBe(false);
  });

  it("permits a non-ambient caller regardless of the desktopKnown value", () => {
    // An older/unknown caller that omits the additive field must degrade to the
    // pre-ISS-6084 behavior for intentful loops: probe.
    expect(isGatewayProbePermitted()).toBe(true);
    expect(isGatewayProbePermitted({ ambient: false })).toBe(true);
    expect(isGatewayProbePermitted({ ambient: false, fastPoll: true })).toBe(
      true
    );
    // ...while an ambient caller that omits it degrades to the quiet default.
    expect(isGatewayProbePermitted({ ambient: true })).toBe(false);
  });

  // ISS-6084 review: `fastPoll` documents itself as ALWAYS permitting probing,
  // while an ambient loop is gated -- so a caller passing both asks for two
  // contradictory guarantees. Rather than resolve it with a precedence rule a
  // reader has to memorise, the options type makes the combination impossible
  // to express. These are compile-time assertions: if the union is ever
  // flattened back into one flat object type, the combinations below become
  // legal, the `@ts-expect-error` directives go unused, and `tsc` fails.
  it("makes an ambient fastPoll loop impossible to express", () => {
    expect(
      // @ts-expect-error fastPoll is intentful-only; the ambient variant excludes it
      isGatewayProbePermitted({ ambient: true, fastPoll: true })
    ).toBe(false);
    expect(
      // @ts-expect-error desktopKnown only opens the ambient gate; intentful excludes it
      isGatewayProbePermitted({ ambient: false, desktopKnown: true })
    ).toBe(true);
  });

  it("stays silent while an intentful probe is still in flight", async () => {
    // The race wongk found: an intentful caller (an explicit "Check again", a
    // LocalElectron routing selection) has a probe OPEN. Its snapshot is
    // `checkedAt: null, loading: true` -- byte-for-byte the state a suppressed
    // ambient loop reads as "nobody has answered this, so I will settle it".
    let resolveProbe: ((value: typeof DETECTED_PROBE) => void) | undefined;
    mockProbeGateway.mockReturnValue(
      new Promise((resolve) => {
        resolveProbe = resolve;
      })
    );

    const disposeIntentful = startGatewayDetectionPolling();
    await flushMicrotasks();
    expect(probeCount()).toBe(1);
    expect(getGatewayDetectionSnapshot().loading).toBe(true);

    // The ambient loop mounts mid-flight and is not permitted to probe.
    const disposeAmbient = startGatewayDetectionPolling({ ambient: true });
    await flushMicrotasks();

    // It must NOT have published a settled negative over the pending probe:
    // `EngineerTransportBootstrap` acts on `loading: false` immediately and
    // would fall back to CloudRelay while the local gateway is still answering.
    expect(probeCount()).toBe(1);
    expect(getGatewayDetectionSnapshot().loading).toBe(true);
    expect(getGatewayDetectionSnapshot().checkedAt).toBeNull();
    expect(getGatewayDetectionSnapshot().detected).toBe(false);

    // The real verdict lands when the in-flight probe answers, and it wins.
    resolveProbe?.(DETECTED_PROBE);
    await flushMicrotasks();

    const settled = getGatewayDetectionSnapshot();
    expect(settled.loading).toBe(false);
    expect(settled.detected).toBe(true);
    expect(settled.port).toBe(DETECTED_PROBE.port);

    disposeAmbient();
    disposeIntentful();
  });
});
