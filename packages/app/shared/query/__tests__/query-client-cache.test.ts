/**
 * Cache-retention contract for the shared query client (FEA-4104, wongk review
 * on PR #3714). The raised inactive-query retention is scoped to *listing*
 * families only: a list you navigate away from stays resident far past the stock
 * window so back/repeat navigation renders from cache instantly instead of
 * refetching and flashing a skeleton. Detail/large queries (document version
 * content, branch diffs, parsed transcripts) stay on the stock window so their
 * large payloads are not pinned in cache six times longer. A per-query gcTime
 * override still wins so any surface can opt out.
 */

import { onlineManager, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectKeys } from "../../../projects/hooks/project-keys";
import {
  DEFAULT_QUERY_GC_TIME_MS,
  isListQueryKey,
  LIST_QUERY_GC_TIME_MS,
  LIST_QUERY_KEY_SEGMENT,
  makeQueryClient,
} from "../query-client";

// React Query's stock inactive-query retention. The base default stays pinned to
// this; only listing families are scoped up past it (FEA-4104).
const REACT_QUERY_STOCK_GC_TIME_MS = 5 * 60 * 1000;

// A real listing-family key and a real detail key from a shipped key factory, so
// the scoping test exercises the exact key shapes production emits rather than
// synthetic ones.
const LIST_KEY = projectKeys.list({ teamId: "team-1" });
const DETAIL_KEY = projectKeys.detail("project-1");

describe("makeQueryClient gcTime constants", () => {
  it("keeps the base default on React Query's stock 5-minute window", () => {
    // Pin the literal so this fails if the base default ever drifts. FEA-4104
    // must NOT raise the blanket default — only listings are scoped up.
    expect(DEFAULT_QUERY_GC_TIME_MS).toBe(300_000);
    expect(DEFAULT_QUERY_GC_TIME_MS).toBe(REACT_QUERY_STOCK_GC_TIME_MS);

    const client = makeQueryClient();
    expect(client.getDefaultOptions().queries?.gcTime).toBe(300_000);
  });

  it("pins the listing retention window to 30 minutes, six times the stock window", () => {
    expect(LIST_QUERY_GC_TIME_MS).toBe(1_800_000);
    expect(LIST_QUERY_GC_TIME_MS).toBeGreaterThan(DEFAULT_QUERY_GC_TIME_MS);
  });

  it("keeps the listing window well above the default staleTime so back-nav reads cache", () => {
    const client = makeQueryClient();
    const staleTime = Number(
      client.getDefaultOptions().queries?.staleTime ?? 0
    );
    // staleTime governs revalidation of a mounted query; the listing gcTime
    // governs how long an unmounted (navigated-away) list survives. Retention
    // must outlast staleness by a wide margin or back-nav would refetch empty.
    expect(LIST_QUERY_GC_TIME_MS).toBeGreaterThan(staleTime);
  });
});

describe("isListQueryKey", () => {
  it("identifies a listing-family key by its shared marker segment", () => {
    expect(isListQueryKey(LIST_KEY)).toBe(true);
    expect(LIST_KEY[1]).toBe(LIST_QUERY_KEY_SEGMENT);
  });

  it("does not treat a detail key as a listing key", () => {
    expect(isListQueryKey(DETAIL_KEY)).toBe(false);
  });

  it("does not treat a non-array or short key as a listing key", () => {
    expect(isListQueryKey(["projects"])).toBe(false);
  });
});

describe("makeQueryClient per-surface overrides", () => {
  it("defaults reconnect refetch on and honors a narrow opt-out", () => {
    // ISS-5976 inverted this: the stock React Query value is the default, and a
    // surface with a push stream (desktop local) or a mode rebuild (desktop
    // cloud) opts OUT at its own construction site.
    expect(
      makeQueryClient().getDefaultOptions().queries?.refetchOnReconnect
    ).toBe(true);
    expect(
      makeQueryClient({ refetchOnReconnect: false }).getDefaultOptions().queries
        ?.refetchOnReconnect
    ).toBe(false);
  });

  it("resumes an online-mode query when the client reconnects", async () => {
    const client = makeQueryClient();
    const queryFn = vi.fn(() => Promise.resolve("canonical"));
    client.mount();
    try {
      onlineManager.setOnline(false);

      const queryPromise = client.fetchQuery({
        queryKey: ["branches", "reconnect-contract"],
        queryFn,
      });
      await vi.waitFor(() =>
        expect(
          client.getQueryState(["branches", "reconnect-contract"])?.fetchStatus
        ).toBe("paused")
      );
      expect(queryFn).not.toHaveBeenCalled();

      onlineManager.setOnline(true);
      await expect(queryPromise).resolves.toBe("canonical");
      expect(queryFn).toHaveBeenCalledOnce();
    } finally {
      onlineManager.setOnline(true);
      client.unmount();
    }
  });

  it("lets an explicit gcTime override win for a listing query (per-surface opt-out)", () => {
    const client = makeQueryClient();
    const fetchListing = vi.fn(() => Promise.resolve(["a"]));
    // A listing query that sets its own gcTime: 0 must NOT be scoped up to the
    // 30-minute listing window — the explicit per-query value wins.
    const resolved = client.defaultQueryOptions({
      queryKey: LIST_KEY,
      queryFn: fetchListing,
      gcTime: 0,
    });
    expect(resolved.gcTime).toBe(0);
  });

  it("scopes a listing query up to the 30-minute window when no gcTime is set", () => {
    const client = makeQueryClient();
    const resolved = client.defaultQueryOptions({
      queryKey: LIST_KEY,
      queryFn: () => Promise.resolve([]),
    });
    expect(resolved.gcTime).toBe(LIST_QUERY_GC_TIME_MS);
  });

  it("leaves a detail query on the stock 5-minute window", () => {
    const client = makeQueryClient();
    const resolved = client.defaultQueryOptions({
      queryKey: DETAIL_KEY,
      queryFn: () => Promise.resolve({}),
    });
    expect(resolved.gcTime).toBe(DEFAULT_QUERY_GC_TIME_MS);
  });

  it("disables the listing scope-up when a base gcTime override is supplied (SSR path)", () => {
    // The SSR client passes gcTime: Infinity. That must apply to *every* query,
    // including listings, so no finite listing timer is ever scheduled on the
    // server (codex P1). The list-scoping subclass is not used in that case.
    const client = makeQueryClient({ gcTime: Number.POSITIVE_INFINITY });
    const resolved = client.defaultQueryOptions({
      queryKey: LIST_KEY,
      queryFn: () => Promise.resolve([]),
    });
    expect(resolved.gcTime).toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps the desktop infinite-staleTime client on stock base gcTime for detail queries", () => {
    // The desktop local client passes staleTime: Infinity but no gcTime, so it
    // still gets the list-scoped client: detail queries stay on the stock window.
    const client = makeQueryClient({ staleTime: Number.POSITIVE_INFINITY });
    const resolved = client.defaultQueryOptions({
      queryKey: DETAIL_KEY,
      queryFn: () => Promise.resolve({}),
    });
    expect(resolved.gcTime).toBe(DEFAULT_QUERY_GC_TIME_MS);
    expect(client.getDefaultOptions().queries?.staleTime).toBe(
      Number.POSITIVE_INFINITY
    );
  });
});

describe("makeQueryClient retention (remount behavior)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps an unmounted LISTING resident past the stock 5-minute window and back-nav reads cache", async () => {
    const client = makeQueryClient();
    const fetchListing = vi.fn(() => Promise.resolve(["a", "b", "c"]));

    // Mount a listing query (an active observer) and let it settle.
    const observer = new QueryObserver(client, {
      queryKey: LIST_KEY,
      queryFn: fetchListing,
    });
    const unsubscribe = observer.subscribe(() => {
      // no-op: we assert against the cache/observer state below
    });
    await vi.waitFor(() =>
      expect(client.getQueryData(LIST_KEY)).toEqual(["a", "b", "c"])
    );
    expect(fetchListing).toHaveBeenCalledTimes(1);

    // Navigate away: the observer unmounts, so the query goes inactive and its
    // gcTime countdown begins.
    unsubscribe();

    // Advance past React Query's stock 5-minute retention. A non-listing query
    // would already be gone; the raised listing window must keep it resident.
    await vi.advanceTimersByTimeAsync(REACT_QUERY_STOCK_GC_TIME_MS + 60_000);
    expect(client.getQueryData(LIST_KEY)).toEqual(["a", "b", "c"]);

    // Back-navigation remounts the same query: it renders synchronously from the
    // still-resident cache — no `pending` status, no skeleton flash — which is
    // the perceived-perf win. (A stale entry then background-revalidates; that
    // refetch is expected and not what the fix removes, so we assert the instant
    // cache read, not the fetch count.)
    const remount = new QueryObserver(client, {
      queryKey: LIST_KEY,
      queryFn: fetchListing,
    });
    const remountUnsubscribe = remount.subscribe(() => {
      // no-op
    });
    const remountResult = remount.getCurrentResult();
    expect(remountResult.data).toEqual(["a", "b", "c"]);
    expect(remountResult.status).toBe("success");
    expect(remountResult.isPending).toBe(false);
    remountUnsubscribe();
  });

  it("evicts an inactive LISTING once the 30-minute window elapses", async () => {
    const client = makeQueryClient();
    const fetchListing = vi.fn(() => Promise.resolve(["x"]));

    const observer = new QueryObserver(client, {
      queryKey: LIST_KEY,
      queryFn: fetchListing,
    });
    const unsubscribe = observer.subscribe(() => {
      // no-op
    });
    await vi.waitFor(() =>
      expect(client.getQueryData(LIST_KEY)).toEqual(["x"])
    );
    unsubscribe();

    // Past the raised listing window with margin: the inactive entry is
    // garbage-collected.
    await vi.advanceTimersByTimeAsync(LIST_QUERY_GC_TIME_MS + 60_000);
    expect(client.getQueryData(LIST_KEY)).toBeUndefined();
  });

  it("evicts an inactive DETAIL query on the stock 5-minute window, NOT the listing window", async () => {
    // The core wongk fix: a large detail query must not inherit the 30-minute
    // listing retention. It is gone shortly after the stock window, long before
    // the listing window would have elapsed.
    const client = makeQueryClient();
    const fetchDetail = vi.fn(() => Promise.resolve({ big: "payload" }));

    const observer = new QueryObserver(client, {
      queryKey: DETAIL_KEY,
      queryFn: fetchDetail,
    });
    const unsubscribe = observer.subscribe(() => {
      // no-op
    });
    await vi.waitFor(() =>
      expect(client.getQueryData(DETAIL_KEY)).toEqual({ big: "payload" })
    );
    unsubscribe();

    // Just past the stock 5-minute window the detail entry is already evicted…
    await vi.advanceTimersByTimeAsync(REACT_QUERY_STOCK_GC_TIME_MS + 60_000);
    expect(client.getQueryData(DETAIL_KEY)).toBeUndefined();
  });

  it("still retains a detail query through the stock window before that boundary", async () => {
    // Guard the other side of the boundary so the eviction test above proves the
    // 5-minute schedule, not merely that detail data is dropped immediately.
    const client = makeQueryClient();
    const observer = new QueryObserver(client, {
      queryKey: DETAIL_KEY,
      queryFn: () => Promise.resolve({ big: "payload" }),
    });
    const unsubscribe = observer.subscribe(() => {
      // no-op
    });
    await vi.waitFor(() =>
      expect(client.getQueryData(DETAIL_KEY)).toEqual({ big: "payload" })
    );
    unsubscribe();

    // Comfortably inside the stock window: still resident.
    await vi.advanceTimersByTimeAsync(REACT_QUERY_STOCK_GC_TIME_MS - 60_000);
    expect(client.getQueryData(DETAIL_KEY)).toEqual({ big: "payload" });
  });
});
