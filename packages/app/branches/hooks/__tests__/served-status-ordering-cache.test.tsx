import type { BranchListStatusOrderingResponse } from "@repo/api/src/types/branch-list-contract";
import { BranchStatusOrderingName } from "@repo/api/src/types/branch-status-order";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchesDataSource } from "../../data-source/branches-data-source";
import {
  SERVED_STATUS_ORDERING_CACHE_MAX_ENTRIES as CACHE_MAX_ENTRIES,
  SERVED_STATUS_ORDERING_RENEW_MS as RENEW_MS,
  SERVED_STATUS_ORDERING_RETRY_CACHE_TTL_MS as RETRY_MS,
  useServedStatusOrdering,
} from "../served-status-ordering";
import { spyingSource } from "./server-page-test-utils";

type OrderingRead = () => Promise<BranchListStatusOrderingResponse | null>;

describe("served status ordering — read cache and cancellation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("reports pending for a data source without an ordering read", async () => {
    const source = spyingSource("http");
    source.listStatusOrdering = undefined;
    const key = uniqueKey();
    const { result } = renderHook(() => useServedStatusOrdering(source, key));
    await advance(1);
    // pins current behavior; looks odd because the internal state is idle with a null key, so the key mismatch reports pending forever.
    // Harmless in production: useBranches computes orderingReady from dataSource.listStatusOrdering === undefined
    // before it reads this status, so no caller waits on this pending.
    expect(result.current).toEqual({
      status: "pending",
      key,
      statusOrdering: null,
    });
  });

  it("reports pending with the key while the first read is in flight", () => {
    const read = vi.fn<OrderingRead>(() => new Promise(() => undefined));
    const key = uniqueKey();
    const readSource = sourceWith(read);
    const { result } = renderHook(() =>
      useServedStatusOrdering(readSource, key)
    );
    expect(result.current).toEqual({
      status: "pending",
      key,
      statusOrdering: null,
    });
  });

  it("settles to an unanswered ready state when the first read rejects", async () => {
    const read = vi.fn<OrderingRead>(() =>
      Promise.reject(new Error("unreachable"))
    );
    const key = uniqueKey();
    const readSource = sourceWith(read);
    const { result } = renderHook(() =>
      useServedStatusOrdering(readSource, key)
    );
    await advance(1);
    expect(result.current).toMatchObject({
      status: "ready",
      key,
      statusOrdering: null,
      answered: false,
    });
  });

  it("retries a failed read on the short retry boundary, not the renewal one", async () => {
    const read = vi
      .fn<OrderingRead>()
      .mockRejectedValueOnce(new Error("unreachable"))
      .mockResolvedValue({
        statusOrdering: BranchStatusOrderingName.RootFirst,
      });
    const key = uniqueKey();
    const readSource = sourceWith(read);
    const { result } = renderHook(() =>
      useServedStatusOrdering(readSource, key)
    );
    await advance(1);
    await advance(RETRY_MS + 10);
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.statusOrdering).toBe(
      BranchStatusOrderingName.RootFirst
    );
  });

  it("shares one in-flight read between two consumers of the same key", async () => {
    const read = vi.fn<OrderingRead>(() =>
      Promise.resolve({ statusOrdering: BranchStatusOrderingName.Vocabulary })
    );
    const source = sourceWith(read);
    const key = uniqueKey();
    const first = renderHook(() => useServedStatusOrdering(source, key));
    const second = renderHook(() => useServedStatusOrdering(source, key));
    await advance(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(first.result.current.statusOrdering).toBe(
      BranchStatusOrderingName.Vocabulary
    );
    expect(second.result.current.statusOrdering).toBe(
      BranchStatusOrderingName.Vocabulary
    );
  });

  it("reuses a failed read inside the retry window when the data source is swapped", async () => {
    const read = vi.fn<OrderingRead>(() => Promise.resolve(null));
    const key = uniqueKey();
    const { result, rerender } = renderHook(
      ({ source }: { source: BranchesDataSource }) =>
        useServedStatusOrdering(source, key),
      { initialProps: { source: sourceWith(read) } }
    );
    await advance(1);
    const settled = result.current;
    rerender({ source: sourceWith(read) });
    await advance(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({
      status: "ready",
      key,
      statusOrdering: null,
      answered: false,
    });
    expect(result.current).not.toBe(settled);
  });

  it("keeps a latched ordering when a swapped data source reuses a cached read that states none", async () => {
    const read = vi
      .fn<OrderingRead>()
      .mockResolvedValueOnce({
        statusOrdering: BranchStatusOrderingName.RootFirst,
      })
      .mockResolvedValue({});
    const key = uniqueKey();
    const { result, rerender } = renderHook(
      ({ source }: { source: BranchesDataSource }) =>
        useServedStatusOrdering(source, key),
      { initialProps: { source: sourceWith(read) } }
    );
    await advance(1);
    await advance(RENEW_MS + 10);
    expect(read).toHaveBeenCalledTimes(2);
    rerender({ source: sourceWith(read) });
    await advance(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({
      status: "ready",
      answered: true,
      statusOrdering: BranchStatusOrderingName.RootFirst,
    });
  });

  it("ignores a first read that resolves after unmount", async () => {
    const pending = deferred();
    const read = vi.fn<OrderingRead>(() => pending.promise);
    const key = uniqueKey();
    const readSource = sourceWith(read);
    const { result, unmount } = renderHook(() =>
      useServedStatusOrdering(readSource, key)
    );
    const before = result.current;
    unmount();
    pending.resolve({ statusOrdering: BranchStatusOrderingName.RootFirst });
    await advance(1);
    expect(result.current).toBe(before);
    expect(result.current.status).toBe("pending");
  });

  it("ignores a first read that rejects after unmount", async () => {
    const pending = deferred();
    const read = vi.fn<OrderingRead>(() => pending.promise);
    const key = uniqueKey();
    const readSource = sourceWith(read);
    const { result, unmount } = renderHook(() =>
      useServedStatusOrdering(readSource, key)
    );
    unmount();
    pending.reject(new Error("late"));
    await advance(1);
    expect(result.current.status).toBe("pending");
  });

  it("ignores a renewal that resolves after unmount", async () => {
    const renewal = deferred();
    const read = vi
      .fn<OrderingRead>()
      .mockResolvedValueOnce({
        statusOrdering: BranchStatusOrderingName.Vocabulary,
      })
      .mockReturnValueOnce(renewal.promise);
    const key = uniqueKey();
    const readSource = sourceWith(read);
    const { result, unmount } = renderHook(() =>
      useServedStatusOrdering(readSource, key)
    );
    await advance(1);
    await advance(RENEW_MS + 10);
    expect(read).toHaveBeenCalledTimes(2);
    unmount();
    renewal.resolve({ statusOrdering: BranchStatusOrderingName.RootFirst });
    await advance(1);
    expect(result.current.statusOrdering).toBe(
      BranchStatusOrderingName.Vocabulary
    );
  });

  it("ignores a renewal that rejects after unmount", async () => {
    const renewalFailure = deferred();
    const failing = vi
      .fn<OrderingRead>()
      .mockResolvedValueOnce({
        statusOrdering: BranchStatusOrderingName.Vocabulary,
      })
      .mockReturnValueOnce(renewalFailure.promise);
    const key = uniqueKey();
    const failingSource = sourceWith(failing);
    const second = renderHook(() =>
      useServedStatusOrdering(failingSource, key)
    );
    await advance(1);
    await advance(RENEW_MS + 10);
    expect(failing).toHaveBeenCalledTimes(2);
    second.unmount();
    renewalFailure.reject(new Error("late"));
    await advance(1);
    expect(second.result.current).toMatchObject({
      statusOrdering: BranchStatusOrderingName.Vocabulary,
      answered: true,
    });
  });

  it("drops an expired failed read from the cache so the next mount reads again", async () => {
    const read = vi.fn<OrderingRead>(() => Promise.resolve(null));
    const key = uniqueKey();
    const readSource = sourceWith(read);
    const first = renderHook(() => useServedStatusOrdering(readSource, key));
    await advance(1);
    first.unmount();
    await advance(RETRY_MS + 1000);
    const other = vi.fn<OrderingRead>(() => Promise.resolve({}));
    const otherKey = uniqueKey();
    const otherSource = sourceWith(other);
    renderHook(() => useServedStatusOrdering(otherSource, otherKey));
    await advance(1);
    renderHook(() => useServedStatusOrdering(readSource, key));
    await advance(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest scope once the cache holds more than its cap", async () => {
    const read = vi.fn<OrderingRead>(() =>
      Promise.resolve({ statusOrdering: BranchStatusOrderingName.RootFirst })
    );
    const source = sourceWith(read);
    const keys = Array.from({ length: CACHE_MAX_ENTRIES + 1 }, () =>
      uniqueKey()
    );
    const [oldest, newest] = [keys[0], keys.at(-1)];
    for (const key of keys) {
      const view = renderHook(() => useServedStatusOrdering(source, key));
      await advance(1);
      view.unmount();
    }
    expect(read).toHaveBeenCalledTimes(CACHE_MAX_ENTRIES + 1);

    renderHook(() => useServedStatusOrdering(source, newest ?? ""));
    await advance(1);
    expect(read).toHaveBeenCalledTimes(CACHE_MAX_ENTRIES + 1);

    renderHook(() => useServedStatusOrdering(source, oldest ?? ""));
    await advance(1);
    expect(read).toHaveBeenCalledTimes(CACHE_MAX_ENTRIES + 2);
  });
});

function uniqueKey(): string {
  return `iss-11293-${crypto.randomUUID()}`;
}

function sourceWith(read: OrderingRead): BranchesDataSource {
  const source = spyingSource("http");
  source.listStatusOrdering = read;
  return source;
}

function deferred() {
  let resolve: (value: BranchListStatusOrderingResponse | null) => void = () =>
    undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<BranchListStatusOrderingResponse | null>(
    (res, rej) => {
      resolve = res;
      reject = rej;
    }
  );
  return { promise, resolve, reject };
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
