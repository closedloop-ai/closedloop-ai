import {
  MAX_TRANSIENT_QUERY_RETRIES,
  queryRetryDelay,
} from "@repo/app/shared/query/query-client";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUsageTransientRecovery } from "../sessions-transient-read-state";

/**
 * ISS-4561: the bounded recovery for a TRANSIENT usage-half failure must not
 * report itself exhausted while its final refetch is still in flight. "Still
 * recovering" and "recovery finished and still failing" are different facts;
 * conflating them makes the summary cards dash to an "unavailable" that is not
 * true yet — the exact conflation the ISS-4483 work existed to remove.
 */
type Deferred = { promise: Promise<unknown>; settle: () => void };

function createDeferred(): Deferred {
  let settle: () => void = () => undefined;
  const promise = new Promise<unknown>((resolve) => {
    settle = () => resolve(undefined);
  });
  return { promise, settle };
}

describe("useUsageTransientRecovery (ISS-4561)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the recovering state until the final refetch settles still-failing", async () => {
    const pending: Deferred[] = [];
    const refetch = vi.fn(() => {
      const deferred = createDeferred();
      pending.push(deferred);
      return deferred.promise;
    });

    const { result } = renderHook(() =>
      useUsageTransientRecovery({
        readGateOpen: true,
        usageError: true,
        usageErrorTransient: true,
        refetch,
      })
    );

    expect(result.current.usageRecoveryExhausted).toBe(false);

    for (let attempt = 0; attempt < MAX_TRANSIENT_QUERY_RETRIES; attempt++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(queryRetryDelay(attempt));
      });
      expect(refetch).toHaveBeenCalledTimes(attempt + 1);
      // The attempt is DISPATCHED but has not returned: the read is still in
      // progress, so the surface must still say "recovering", never "unavailable".
      expect(result.current.usageRecoveryExhausted).toBe(false);

      await act(async () => {
        pending[attempt].settle();
        await pending[attempt].promise;
      });
    }

    // Every attempt has now RETURNED and the usage half is still failing.
    expect(result.current.usageRecoveryExhausted).toBe(true);
    expect(refetch).toHaveBeenCalledTimes(MAX_TRANSIENT_QUERY_RETRIES);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        queryRetryDelay(MAX_TRANSIENT_QUERY_RETRIES)
      );
    });
    expect(refetch).toHaveBeenCalledTimes(MAX_TRANSIENT_QUERY_RETRIES);
  });

  it("resets and stops refetching when the usage half recovers mid-window", async () => {
    const refetch = vi.fn(() => Promise.resolve(undefined));
    const { result, rerender } = renderHook(
      ({ candidate }: { candidate: boolean }) =>
        useUsageTransientRecovery({
          readGateOpen: true,
          usageError: candidate,
          usageErrorTransient: candidate,
          refetch,
        }),
      { initialProps: { candidate: true } }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(queryRetryDelay(0));
    });
    expect(refetch).toHaveBeenCalledTimes(1);

    rerender({ candidate: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        queryRetryDelay(0) + queryRetryDelay(1) + queryRetryDelay(2)
      );
    });

    expect(result.current.usageRecoveryExhausted).toBe(false);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("cancels the pending attempt's bookkeeping on unmount", async () => {
    const deferred = createDeferred();
    const refetch = vi.fn(() => deferred.promise);
    const { unmount } = renderHook(() =>
      useUsageTransientRecovery({
        readGateOpen: true,
        usageError: true,
        usageErrorTransient: true,
        refetch,
      })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(queryRetryDelay(0));
    });
    expect(refetch).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      deferred.settle();
      await deferred.promise;
      await vi.advanceTimersByTimeAsync(queryRetryDelay(1));
    });

    // No timer survives the unmount, so no further attempt is dispatched.
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * ISS-6382: the recovery's escape hatch is a MANUAL `refetch()`, which ignores
 * `enabled`. Its trigger comes from the query's `data`, which on a revisit is
 * the cached payload — so a cached `usageErrorTransient` armed this hook while
 * the caller's read was gated shut and, one backoff later, drove exactly the
 * default-view read the gate exists to prevent.
 */
describe("useUsageTransientRecovery read gate (ISS-6382)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches nothing while the read gate is closed, then recovers once it opens", async () => {
    const refetch = vi.fn(() => Promise.resolve(undefined));
    const { result, rerender } = renderHook(
      ({ readGateOpen }: { readGateOpen: boolean }) =>
        useUsageTransientRecovery({
          readGateOpen,
          usageError: true,
          usageErrorTransient: true,
          refetch,
        }),
      { initialProps: { readGateOpen: false } }
    );

    // Slow auth hydration: `isViewReady` is still false, so the caller's read is
    // held closed while this transient candidate sits in the cached payload.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        queryRetryDelay(0) + queryRetryDelay(1) + queryRetryDelay(2)
      );
    });
    expect(refetch).not.toHaveBeenCalled();
    // Nothing was attempted, so nothing may be reported as exhausted either — a
    // gate that suppressed the refetch but let the counter run would dash the
    // cards about a recovery that never happened.
    expect(result.current.usageRecoveryExhausted).toBe(false);

    // POSITIVE CONTROL. Without this the assertions above pass just as well for
    // a hook that never dispatches at all, and the gate would be untested.
    rerender({ readGateOpen: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(queryRetryDelay(0));
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
