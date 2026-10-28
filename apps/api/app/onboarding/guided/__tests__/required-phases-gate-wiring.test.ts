/**
 * ISS-11073 — the required-phases gate's CONSTRUCTION, not its evaluation.
 *
 * The gate is a module-scope `createMemoizedFeatureFlagGate` call, so the only
 * thing that can prove how it was built is the options object it passed. Every
 * property asserted here is one whose absence is silent at runtime: the gate
 * still resolves, still fails closed, and no test of its VALUE would change.
 *
 * The cross-instance pair is why this file exists. `apps/api` is serverless and
 * the memo is process-local, so a reader who got an ON decision from one
 * instance and reloaded onto a COLD one during a PostHog outage would have that
 * instance fail closed and return `Ready` — dropping them out of the required
 * invitation/download sequence mid-run. Dropping `sharedDecisionStore`, or
 * leaving `sharedDecisionTtlMs` unset so the store is inert, reintroduces
 * exactly that with nothing else in the suite able to see it.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MemoizedFeatureFlagGateOptions } from "@/lib/memoized-feature-flag-gate";

const mocks = vi.hoisted(() => ({
  createMemoizedFeatureFlagGate: vi.fn(() => ({
    resolve: vi.fn(),
    clear: vi.fn(),
  })),
  createFeatureFlagDecisionStore: vi.fn(() => STORE_SENTINEL),
}));

vi.mock("@/lib/memoized-feature-flag-gate", () => ({
  createMemoizedFeatureFlagGate: mocks.createMemoizedFeatureFlagGate,
}));

vi.mock("@/lib/feature-flag-decision-store", () => ({
  createFeatureFlagDecisionStore: mocks.createFeatureFlagDecisionStore,
}));

/** The production store's identity, so the assertion is not merely "truthy". */
const STORE_SENTINEL = {
  read: vi.fn(),
  publish: vi.fn(),
};

let options: MemoizedFeatureFlagGateOptions;

describe("guided required-phases gate wiring (ISS-11073)", () => {
  beforeAll(async () => {
    await import("../required-phases-gate");
    const call = mocks.createMemoizedFeatureFlagGate.mock.calls[0];
    if (call === undefined) {
      // Thrown rather than asserted: a setup hook that only FAILED here would
      // leave `options` undefined and every case below would report its own
      // unrelated TypeError instead of the one real cause.
      throw new Error(
        "the required-phases gate was never constructed on import"
      );
    }
    options = (call as unknown as [MemoizedFeatureFlagGateOptions])[0];
  });

  it("evaluates the required-phases flag itself", () => {
    expect(options.flag.key).toBe("web-guided-onboarding-required-phases");
  });

  // Identity, not truthiness, and not a call count: the gate is constructed at
  // IMPORT, so a spy's call history is already cleared by the time any case
  // runs. The sentinel is the only thing that survives to be compared.
  it("publishes and consults the SHARED decision record", () => {
    expect(options.sharedDecisionStore).toBe(STORE_SENTINEL);
  });

  // The presence assertion above and this one are a pair on the same wiring: a
  // store with no window is inert, and a window with no store is inert, so
  // either alone would pass over a gate that still splits across instances.
  it("honors a shared decision for longer than one page load, and bounds it", () => {
    const shared = options.sharedDecisionTtlMs;
    expect(shared, "an unset window leaves the store inert").toBeTypeOf(
      "number"
    );
    expect(shared as number).toBeGreaterThan(options.ttlMs);
    expect(shared as number).toBeLessThanOrEqual(3_600_000);
  });

  it("bounds the per-viewer memo", () => {
    expect(options.maxEntries).toBeGreaterThan(0);
  });

  it("re-arms an unanswered lookup sooner than an evaluated one", () => {
    expect(options.unavailableBackoffMs).toBeLessThan(options.ttlMs);
  });
});
