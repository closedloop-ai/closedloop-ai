import {
  BranchStatusOrderingName,
  DEFAULT_BRANCH_STATUS_ORDERING,
  ROOT_FIRST_BRANCH_STATUS_ORDERING,
} from "@repo/api/src/types/branch-status-order";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER_FEATURE_FLAGS } from "@/lib/feature-flags/server-feature-flags";

const mocks = vi.hoisted(() => ({
  evaluate: vi.fn(),
}));

// The EVALUATOR is mocked, not `evaluateFeatureFlagForAnyIdentity` itself, so
// these cases run the real registry lookup, the real per-id loop, and the real
// catch. Mocking the wrapper would have made the "a thrown read still serves the
// list" case assert nothing but its own mock.
vi.mock("@/lib/feature-flags/server-feature-flag-evaluation", () => ({
  evaluateServerFeatureFlagForDistinctId: mocks.evaluate,
}));

import {
  resetHeldBranchStatusOrderings,
  resolveBranchStatusOrdering,
  resolveServedBranchStatusOrderingName,
} from "./branch-status-ordering";

const IDENTITY = { userId: "user-1", clerkUserId: "clerk-1" };

describe("resolveBranchStatusOrdering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Module-level state, not a mock: `vi.clearAllMocks()` does not touch it,
    // and without this a case that resolved `true` answers the next case's
    // unavailable read.
    resetHeldBranchStatusOrderings();
  });

  it("evaluates the flag through the ISS-7778 registry entry", async () => {
    mocks.evaluate.mockResolvedValue(true);

    await resolveBranchStatusOrdering(IDENTITY);

    // The registry descriptor by IDENTITY, not a bare key string: an
    // unregistered flag is not assignable to the evaluator at all, which is what
    // makes the kind classification unskippable.
    expect(mocks.evaluate).toHaveBeenCalledWith(
      SERVER_FEATURE_FLAGS.artifactStatusRootOrder,
      "clerk-1",
      undefined
    );
  });

  it("returns the root-first ordering only for an evaluated true", async () => {
    mocks.evaluate.mockResolvedValue(true);
    await expect(resolveBranchStatusOrdering(IDENTITY)).resolves.toBe(
      ROOT_FIRST_BRANCH_STATUS_ORDERING
    );

    mocks.evaluate.mockResolvedValue(false);
    await expect(resolveBranchStatusOrdering(IDENTITY)).resolves.toBe(
      DEFAULT_BRANCH_STATUS_ORDERING
    );
  });

  it("falls back to today's ordering when PostHog cannot answer", async () => {
    mocks.evaluate.mockResolvedValue(null);

    await expect(resolveBranchStatusOrdering(IDENTITY)).resolves.toBe(
      DEFAULT_BRANCH_STATUS_ORDERING
    );
  });

  it("serves the list on a THROWN evaluation instead of failing the read", async () => {
    mocks.evaluate.mockRejectedValue(new Error("posthog unreachable"));

    // The raw `isFeatureFlagEnabledForDistinctId` re-throws, which would turn a
    // PostHog outage into a 500 on the whole Branches list. This resolves, and
    // it resolves to today's order.
    await expect(resolveBranchStatusOrdering(IDENTITY)).resolves.toBe(
      DEFAULT_BRANCH_STATUS_ORDERING
    );
  });
});

describe("resolveServedBranchStatusOrderingName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Module-level state, not a mock: `vi.clearAllMocks()` does not touch it,
    // and without this a case that resolved `true` answers the next case's
    // unavailable read.
    resetHeldBranchStatusOrderings();
  });

  it("states the ordering it evaluated", async () => {
    mocks.evaluate.mockResolvedValue(true);
    await expect(resolveServedBranchStatusOrderingName(IDENTITY)).resolves.toBe(
      BranchStatusOrderingName.RootFirst
    );

    mocks.evaluate.mockResolvedValue(false);
    await expect(resolveServedBranchStatusOrderingName(IDENTITY)).resolves.toBe(
      BranchStatusOrderingName.Vocabulary
    );
  });

  it("states NOTHING when the evaluation is unavailable", async () => {
    mocks.evaluate.mockResolvedValue(null);

    // Not the default NAME. An absent field tells the client to HOLD what it
    // latched; naming the default would re-key its list query and reset the
    // reader's page on every PostHog blip, then again on recovery.
    await expect(
      resolveServedBranchStatusOrderingName(IDENTITY)
    ).resolves.toBeUndefined();
  });

  it("states nothing on a thrown evaluation too", async () => {
    mocks.evaluate.mockRejectedValue(new Error("posthog unreachable"));

    await expect(
      resolveServedBranchStatusOrderingName(IDENTITY)
    ).resolves.toBeUndefined();
  });
});

describe("held ordering across a PostHog blip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetHeldBranchStatusOrderings();
  });

  // ISS-9437 / #6928 review: the clock and the list are separate requests. A
  // read that fails on the SECOND one served vocabulary-ordered rows under the
  // root-first key the client had already latched, so page 2 indexed into a
  // different ordering than page 1 and rows repeated or vanished at the seam.
  it("serves the last evaluated ordering when a later read is unavailable", async () => {
    mocks.evaluate.mockResolvedValue(true);
    await expect(resolveBranchStatusOrdering(IDENTITY)).resolves.toBe(
      ROOT_FIRST_BRANCH_STATUS_ORDERING
    );

    mocks.evaluate.mockResolvedValue(null);
    await expect(resolveBranchStatusOrdering(IDENTITY)).resolves.toBe(
      ROOT_FIRST_BRANCH_STATUS_ORDERING
    );
  });

  // CONTROLS. The four cases below pass with the hold and without it, and that
  // is the point: each pins something the hold must NOT do. Only the two cases
  // above and the clock case below fail when `heldOrderingFor` is neutered.
  it("never turns the feature on through a blip", async () => {
    mocks.evaluate.mockResolvedValue(false);
    await resolveBranchStatusOrdering(IDENTITY);

    mocks.evaluate.mockResolvedValue(null);
    await expect(resolveBranchStatusOrdering(IDENTITY)).resolves.toBe(
      DEFAULT_BRANCH_STATUS_ORDERING
    );
  });

  // The hold is keyed on the SAME distinct id the evaluation used, so one
  // principal's answer can never be served to another.
  it("does not serve one principal's answer to a different principal", async () => {
    mocks.evaluate.mockResolvedValue(true);
    await resolveBranchStatusOrdering(IDENTITY);

    mocks.evaluate.mockResolvedValue(null);
    await expect(
      resolveBranchStatusOrdering({ userId: "user-2", clerkUserId: "clerk-2" })
    ).resolves.toBe(DEFAULT_BRANCH_STATUS_ORDERING);
  });

  // LOAD-BEARING, like the first case: the clock names the held ordering rather
  // than omitting the field, so the client's latch is CONFIRMED during a blip
  // instead of merely un-contradicted.
  it("states the held ordering on the clock during a blip", async () => {
    mocks.evaluate.mockResolvedValue(true);
    await resolveServedBranchStatusOrderingName(IDENTITY);

    mocks.evaluate.mockResolvedValue(null);
    await expect(resolveServedBranchStatusOrderingName(IDENTITY)).resolves.toBe(
      BranchStatusOrderingName.RootFirst
    );
  });

  it("expires the held answer, returning to today's order", async () => {
    vi.useFakeTimers();
    try {
      mocks.evaluate.mockResolvedValue(true);
      await resolveBranchStatusOrdering(IDENTITY);

      vi.advanceTimersByTime(60_001);
      mocks.evaluate.mockResolvedValue(null);
      await expect(resolveBranchStatusOrdering(IDENTITY)).resolves.toBe(
        DEFAULT_BRANCH_STATUS_ORDERING
      );
      await expect(
        resolveServedBranchStatusOrderingName(IDENTITY)
      ).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // A successful read always wins, so a real flip is never delayed by the hold.
  it("lets a successful read overwrite the held answer immediately", async () => {
    mocks.evaluate.mockResolvedValue(true);
    await resolveBranchStatusOrdering(IDENTITY);

    mocks.evaluate.mockResolvedValue(false);
    await expect(resolveBranchStatusOrdering(IDENTITY)).resolves.toBe(
      DEFAULT_BRANCH_STATUS_ORDERING
    );

    mocks.evaluate.mockResolvedValue(null);
    await expect(resolveBranchStatusOrdering(IDENTITY)).resolves.toBe(
      DEFAULT_BRANCH_STATUS_ORDERING
    );
  });
});
