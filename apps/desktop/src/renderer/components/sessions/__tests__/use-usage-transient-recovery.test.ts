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
