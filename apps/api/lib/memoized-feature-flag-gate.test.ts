/**
 * ISS-7860 — the memo's CONCURRENCY contract.
 *
 * The consumers' route suites drive this gate SEQUENTIALLY: one request, then
 * the next. That is the right shape for the TTL, the hold-on-unavailable
 * fallback and the fail-closed default, and it structurally cannot reach the
 * one window where those three interact badly — two reads of the same expired
 * entry, in flight at once, whose evaluations come back differently.
 *
 * That window is the reason this file exists rather than more cases over there.
 * A gate that answers one in-flight read `false` from a real evaluation and its
 * sibling `true` from a stale fallback has broken the single promise the module
 * makes — that one viewer's reads agree — while every sequential test stays
 * green, because sequentially the second read simply sees the first one's write.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMOIZED_GATE_SAMPLE_FLAG } from "@/__tests__/support/lib/memoized-feature-flag-gate.test-fixtures";
import type { FeatureFlagIdentity } from "@/lib/feature-flag-identity";
import {
  createMemoizedFeatureFlagGate,
  type MemoizedFeatureFlagGate,
} from "@/lib/memoized-feature-flag-gate";

const mocks = vi.hoisted(() => ({
  evaluateFeatureFlagForAnyIdentity: vi.fn(),
}));

// Only the evaluator is replaced: `resolveDistinctIdsForIdentity` stays real so
// the memo keys these viewers exactly as production does.
vi.mock("@/lib/feature-flag-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/feature-flag-identity")>()),
  evaluateFeatureFlagForAnyIdentity: mocks.evaluateFeatureFlagForAnyIdentity,
}));

const FLAG = MEMOIZED_GATE_SAMPLE_FLAG;
const UNAVAILABLE_LOG_KEY = "memoized_gate_test_flag_unavailable";
const TTL_MS = 60_000;
const UNAVAILABLE_BACKOFF_MS = 5000;
const MAX_ENTRIES = 100;
const VIEWER: FeatureFlagIdentity = {
  userId: "user_alpha",
  clerkUserId: "clerk_alpha",
};
const OTHER_VIEWER: FeatureFlagIdentity = {
  userId: "user_beta",
  clerkUserId: "clerk_beta",
};
// The memo takes `now` as a parameter, so expiry is driven by arithmetic on
// this rather than by a clock the test would have to fake.
const T0 = 1_000_000;
const AFTER_TTL = T0 + TTL_MS + 1;

describe("createMemoizedFeatureFlagGate concurrency (ISS-7860)", () => {
  let gate: MemoizedFeatureFlagGate;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.evaluateFeatureFlagForAnyIdentity.mockReset();
    // A fresh gate per case: the memo is module-local to its consumer in
    // production, so a decision carried between cases here would answer without
    // the evaluator being reached at all.
    gate = createMemoizedFeatureFlagGate({
      flag: FLAG,
      unavailableLogKey: UNAVAILABLE_LOG_KEY,
      ttlMs: TTL_MS,
      unavailableBackoffMs: UNAVAILABLE_BACKOFF_MS,
      maxEntries: MAX_ENTRIES,
    });
  });

  it("does not answer a concurrent read from a fallback that raced a real evaluation", async () => {
    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(true);
    expect(await gate.resolve(VIEWER, T0)).toBe(true);

    // Both reads land past the entry's expiry, so both take the evaluation
    // path. PostHog answers one of them with a real `false` — the rollout was
    // genuinely turned off — and fails the other. Both round trips are held
    // open until both reads are in flight, so the interleaving under test is
    // deterministic rather than a scheduling accident.
    const answered = createDeferred<boolean | null>();
    const unavailable = createDeferred<boolean | null>();
    mocks.evaluateFeatureFlagForAnyIdentity
      .mockReturnValueOnce(answered.promise)
      .mockReturnValueOnce(unavailable.promise);

    const first = gate.resolve(VIEWER, AFTER_TTL);
    const second = gate.resolve(VIEWER, AFTER_TTL);
    answered.resolve(false);
    unavailable.resolve(null);

    // The whole promise of this module, at the one moment it is hardest to
    // keep. Without a single flight the second read computes its fallback from
    // the entry it snapshotted BEFORE its own await — the stale `true` — so the
    // two responses of one page load divide by different cost bases.
    expect(await first).toBe(false);
    expect(await second).toBe(false);

    // And the evaluated answer SURVIVED the race rather than being overwritten
    // by the fallback that lost it: a later read inside the new window still
    // reports what PostHog actually said.
    expect(await gate.resolve(VIEWER, AFTER_TTL + 1)).toBe(false);
  });

  it("issues ONE evaluation for concurrent reads of an expired decision", async () => {
    // The mechanism behind the case above, pinned directly. Without it, N
    // simultaneous readers each open their own round trip to a flag service
    // that is by hypothesis already the thing going wrong.
    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(true);
    await gate.resolve(VIEWER, T0);
    expect(mocks.evaluateFeatureFlagForAnyIdentity).toHaveBeenCalledTimes(1);

    const answered = createDeferred<boolean | null>();
    mocks.evaluateFeatureFlagForAnyIdentity.mockReturnValue(answered.promise);
    const reads = [
      gate.resolve(VIEWER, AFTER_TTL),
      gate.resolve(VIEWER, AFTER_TTL),
      gate.resolve(VIEWER, AFTER_TTL),
    ];
    answered.resolve(true);
    await Promise.all(reads);

    expect(mocks.evaluateFeatureFlagForAnyIdentity).toHaveBeenCalledTimes(2);
  });

  it("keys the in-flight resolution per viewer", async () => {
    // The join is keyed, not global. Collapsing two principals into one flight
    // would serve one viewer a rollout decision PostHog made for the other —
    // the same inherited-decision bug the injective cache key exists to stop.
    const viewerAnswer = createDeferred<boolean | null>();
    const otherAnswer = createDeferred<boolean | null>();
    mocks.evaluateFeatureFlagForAnyIdentity
      .mockReturnValueOnce(viewerAnswer.promise)
      .mockReturnValueOnce(otherAnswer.promise);

    const viewerRead = gate.resolve(VIEWER, T0);
    const otherRead = gate.resolve(OTHER_VIEWER, T0);
    viewerAnswer.resolve(true);
    otherAnswer.resolve(false);

    expect(await viewerRead).toBe(true);
    expect(await otherRead).toBe(false);
    expect(mocks.evaluateFeatureFlagForAnyIdentity).toHaveBeenCalledTimes(2);
  });

  it("releases the in-flight slot once a resolution settles", async () => {
    // The cleanup half. An entry left behind after its resolution settled would
    // pin every later read of this viewer to that first answer permanently —
    // turning the memo into the latch the TTL exists to prevent, and one that
    // no amount of elapsed time could clear.
    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(true);
    expect(await gate.resolve(VIEWER, T0)).toBe(true);

    mocks.evaluateFeatureFlagForAnyIdentity.mockResolvedValueOnce(false);
    expect(await gate.resolve(VIEWER, AFTER_TTL)).toBe(false);
  });
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

/**
 * A promise whose settlement the test controls, so two reads can be proven to
 * be in flight at the same time without sleeping or racing the scheduler.
 */
function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {
    // Replaced synchronously by the executor below, which runs before the
    // constructor returns.
  };
  const promise = new Promise<T>((resolveFn) => {
    resolve = resolveFn;
  });
  return { promise, resolve };
}
