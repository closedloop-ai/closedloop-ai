import type { BranchListStatusOrderingResponse } from "@repo/api/src/types/branch-list-contract";
import { BranchStatusOrderingName } from "@repo/api/src/types/branch-status-order";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchesDataSource } from "../../data-source/branches-data-source";
import { useServedStatusOrdering } from "../served-status-ordering";

const RENEW_MS = 4 * 60 * 1000;

/**
 * ISS-9437 — the served status ordering is LATCHED, and an answer that states
 * none HOLDS whatever was already latched.
 *
 * A file of its own, deliberately: these cases run on a fake clock, and the
 * sibling `served-status-ordering.test.tsx` drives TanStack Query, which does
 * not want one.
 */
describe("served status ordering latch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
  });

  // Unconditional, in an `afterEach` rather than at the end of each case: an
  // assertion that throws mid-case would otherwise leak a frozen clock into
  // every later test in this worker and report one failure as a file of
  // unrelated red.
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("holds the latched ordering when a renewal states none", async () => {
    const readOrdering = orderingReturning(
      { statusOrdering: BranchStatusOrderingName.RootFirst },
      // The producer's own flag evaluation came back UNAVAILABLE, so it states
      // nothing. Falling back to the default here would re-key the list and
      // reset the reader's page every time PostHog blinked, then again when it
      // recovered.
      {}
    );
    const { result, unmount } = renderLatch(readOrdering);

    await settle();
    expect(result.current.statusOrdering).toBe(
      BranchStatusOrderingName.RootFirst
    );

    await renew();

    expect(readOrdering).toHaveBeenCalledTimes(2);
    expect(result.current.statusOrdering).toBe(
      BranchStatusOrderingName.RootFirst
    );
    unmount();
  });

  it("holds the latched ordering when a renewal fails outright", async () => {
    const readOrdering = vi
      .fn<() => Promise<BranchListStatusOrderingResponse | null>>()
      .mockResolvedValueOnce({
        statusOrdering: BranchStatusOrderingName.RootFirst,
      })
      .mockRejectedValueOnce(new Error("producer unreachable"));
    const { result, unmount } = renderLatch(readOrdering);

    await settle();
    await renew();

    // A transport failure is not evidence the producer changed the order it
    // serves, so the latch holds rather than flapping to a default.
    expect(result.current.statusOrdering).toBe(
      BranchStatusOrderingName.RootFirst
    );
    unmount();
  });

  it("adopts a genuinely changed ordering rather than holding forever", async () => {
    const readOrdering = orderingReturning(
      { statusOrdering: BranchStatusOrderingName.Vocabulary },
      { statusOrdering: BranchStatusOrderingName.RootFirst }
    );
    const { result, unmount } = renderLatch(readOrdering);

    await settle();
    await renew();

    // The hold must be a hold, not a freeze: a stated ordering always wins.
    expect(result.current.statusOrdering).toBe(
      BranchStatusOrderingName.RootFirst
    );
    unmount();
  });

  it("latches nothing for a producer that never states an ordering", async () => {
    const readOrdering = orderingReturning({});
    const { result, unmount } = renderLatch(readOrdering);

    await settle();

    expect(result.current.status).toBe("ready");
    expect(result.current.statusOrdering).toBeNull();
    unmount();
  });
});

function orderingReturning(
  ...responses: readonly BranchListStatusOrderingResponse[]
) {
  const spy = vi.fn<() => Promise<BranchListStatusOrderingResponse | null>>();
  for (const response of responses) {
    spy.mockResolvedValueOnce(response);
  }
  spy.mockResolvedValue(responses.at(-1) ?? null);
  return spy;
}

function renderLatch(
  listStatusOrdering: () => Promise<BranchListStatusOrderingResponse | null>
) {
  // A unique key per case. The latch memoizes per key in a MODULE-level cache
  // that outlives any single test, so a shared key would let one case read the
  // previous one's answer — green in file order, red run alone.
  const key = `iss-9437-${crypto.randomUUID()}`;
  const dataSource = { listStatusOrdering } as unknown as BranchesDataSource;
  return renderHook(() => useServedStatusOrdering(dataSource, key));
}

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
}

async function renew(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RENEW_MS + 10);
  });
}
