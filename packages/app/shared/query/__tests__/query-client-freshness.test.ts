/**
 * Freshness contract for the shared query client (ISS-5976).
 *
 * The defect this pins: `makeQueryClient` used to force `refetchOnWindowFocus`
 * and `refetchOnReconnect` to `false` for every caller, overriding React Query's
 * stock `true`. The web shell has no push stream, so that left it with a
 * 60-second `staleTime` and no event that ever acted on staleness — every web
 * list was stale until the user reloaded or hit a manual Refresh control.
 *
 * These tests deliberately do NOT just read the config back. Asserting
 * `getDefaultOptions().queries?.refetchOnWindowFocus === true` passes even if the
 * option is never threaded through to a real observer, which is exactly the
 * false-confidence this ticket was filed against. Every case here MOUNTS an
 * observer against a real client, fires a real `focusManager`/`onlineManager`
 * event, and asserts on `queryFn` call counts.
 *
 * Negatives are proven BY CONTRAST rather than by waiting: an opt-in client and
 * an opt-out client observe the SAME event, and the opt-in client's refetch is
 * the synchronization point. When it has reached two calls the event has
 * demonstrably been delivered and processed, so the opt-out client still sitting
 * at one is a real negative rather than a race. No sleeps, no timing assertions.
 */

import {
  focusManager,
  onlineManager,
  QueryObserver,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectKeys } from "../../../projects/hooks/project-keys";
import {
  DEFAULT_QUERY_STALE_TIME_MS,
  FOCUS_REFETCH_ERROR_COOLDOWN_MS,
  makeQueryClient,
  shouldRefetchOnFocus,
} from "../query-client";

// A real shipped listing key, so the contract is exercised against the key shape
// production actually emits rather than a synthetic one.
const LIST_KEY = projectKeys.list({ teamId: "team-freshness" });

/**
 * Mount a client plus a subscribed observer on `LIST_KEY` and let the initial
 * fetch land. Returns the pieces plus a `dispose` that unsubscribes and unmounts,
 * so no test leaves a live observer subscribed to the shared focus/online
 * managers.
 */
async function mountObservedClient(
  options?: Parameters<typeof makeQueryClient>[0]
) {
  const client = makeQueryClient(options);
  const queryFn = vi.fn(() => Promise.resolve("value"));
  client.mount();
  const observer = new QueryObserver(client, { queryKey: LIST_KEY, queryFn });
  const unsubscribe = observer.subscribe(() => {
    // Subscribing is what makes the observer *active*; React Query only delivers
    // focus/reconnect refetches to active observers, so this is load-bearing.
  });
  // Throws rather than `expect`s: assertions belong in the tests themselves
  // (Biome `noMisplacedAssertion`), and a helper that fails to reach its
  // precondition should surface as a setup failure, not a fake assertion.
  await vi.waitFor(() => {
    if (queryFn.mock.calls.length < 1) {
      throw new Error("initial fetch has not landed yet");
    }
  });
  return {
    client,
    observer,
    queryFn,
    dispose: () => {
      unsubscribe();
      client.unmount();
    },
  };
}

/**
 * Backdate the cached entry past `staleTime` WITHOUT refetching it, so the next
 * focus/reconnect event meets a genuinely stale query. `setQueryData`'s
 * `updatedAt` is the supported way to move `dataUpdatedAt`, which is the exact
 * value React Query compares against `staleTime`.
 */
function markStale(
  client: ReturnType<typeof makeQueryClient>,
  value = "value"
) {
  client.setQueryData(LIST_KEY, value, {
    updatedAt: Date.now() - (DEFAULT_QUERY_STALE_TIME_MS + 1000),
  });
}

/** Force a real focus transition; `setFocused(true)` alone is a no-op if already focused. */
function fireWindowFocus() {
  focusManager.setFocused(false);
  focusManager.setFocused(true);
}

/**
 * Same as {@link mountObservedClient} but the read FAILS, leaving the query
 * parked in `error` state with `dataUpdatedAt` never advanced — the exact shape
 * the focus cooldown exists for.
 *
 * `retry: false` on the observer isolates the focus policy from the retry policy
 * (`shouldRetryQuery` has its own tests); without it each mount would burn the
 * two transient retries and their backoff before settling, which measures the
 * wrong contract.
 */
async function mountErroredObservedClient(
  options?: Parameters<typeof makeQueryClient>[0]
) {
  const client = makeQueryClient(options);
  const queryFn = vi.fn(() => Promise.reject(new Error("network down")));
  client.mount();
  const observer = new QueryObserver(client, {
    queryKey: LIST_KEY,
    queryFn,
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => {
    // Active subscription: focus refetches are only delivered to active observers.
  });
  await vi.waitFor(() => {
    if (observer.getCurrentResult().status !== "error") {
      throw new Error("query has not reached its error state yet");
    }
  });
  return {
    client,
    observer,
    queryFn,
    dispose: () => {
      unsubscribe();
      client.unmount();
    },
  };
}

afterEach(() => {
  // Hand both managers back to their environment-driven defaults, or a leaked
  // `false` would silently disable refetching for every later test in the file.
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
});

describe("web shell freshness (no push stream)", () => {
  it("refetches a stale list when the window regains focus", async () => {
    // The web shell constructs its browser client as exactly `makeQueryClient()`
    // with no freshness overrides, so this IS the shipped web policy.
    const web = await mountObservedClient();
    try {
      markStale(web.client);
      fireWindowFocus();
      await vi.waitFor(() => expect(web.queryFn).toHaveBeenCalledTimes(2));
    } finally {
      web.dispose();
    }
  });

  it("refetches a stale list when connectivity returns", async () => {
    const web = await mountObservedClient();
    try {
      markStale(web.client);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      await vi.waitFor(() => expect(web.queryFn).toHaveBeenCalledTimes(2));
    } finally {
      web.dispose();
    }
  });

  it("does NOT refetch a still-fresh list on focus, so staleTime bounds the request volume", async () => {
    // The request-volume claim in ISS-5976 criterion 4: a burst of tab-switching
    // cannot produce more than one refetch per mounted query per staleTime
    // window, because a fresh query ignores the trigger entirely.
    //
    // Proven by contrast: `fresh` and `stale` observe the same focus event.
    // `stale` reaching two calls proves the event was delivered and processed,
    // so `fresh` still sitting at one is a real negative, not an unawaited race.
    const fresh = await mountObservedClient();
    const stale = await mountObservedClient();
    try {
      markStale(stale.client);
      fireWindowFocus();
      await vi.waitFor(() => expect(stale.queryFn).toHaveBeenCalledTimes(2));
      expect(fresh.queryFn).toHaveBeenCalledTimes(1);
    } finally {
      fresh.dispose();
      stale.dispose();
    }
  });

  it("keeps the rendered rows and success state during a focus refetch, so user state is not clobbered", async () => {
    // ISS-5976 criterion 5 / ISS-5975 criterion 7: an auto-refresh landing
    // mid-interaction must not reset scroll, selection, filters, or pagination.
    // The mechanism that guarantees that is the refetch being a BACKGROUND one:
    // the observer stays `success` and keeps serving the previous rows, so the
    // table is never unmounted for a skeleton and never remounts its scroll
    // container. A refetch that dropped back to `pending` would blank the rows,
    // which is precisely what would destroy scroll position and selection.
    //
    // The refetch is held open by a deferred rather than resolved eagerly, so
    // the in-flight state is observed deterministically instead of being raced
    // against an already-settled promise.
    const client = makeQueryClient();
    let releaseRefetch: (rows: string) => void = () => {
      // Replaced by the second call's executor before it is ever invoked.
    };
    let calls = 0;
    const queryFn = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve("rows-v1");
      }
      return new Promise<string>((resolve) => {
        releaseRefetch = resolve;
      });
    });
    client.mount();
    const observer = new QueryObserver(client, { queryKey: LIST_KEY, queryFn });
    const unsubscribe = observer.subscribe(() => {
      // Active subscription — see `mountObservedClient`.
    });
    try {
      await vi.waitFor(() =>
        expect(observer.getCurrentResult().data).toBe("rows-v1")
      );

      markStale(client, "rows-v1");
      fireWindowFocus();
      await vi.waitFor(() =>
        expect(observer.getCurrentResult().isFetching).toBe(true)
      );

      // Mid-refetch: still success, still serving the rows already on screen.
      const during = observer.getCurrentResult();
      expect(during.status).toBe("success");
      expect(during.data).toBe("rows-v1");

      releaseRefetch("rows-v2");
      await vi.waitFor(() =>
        expect(observer.getCurrentResult().data).toBe("rows-v2")
      );
      // ...and it never passed through `pending` on the way to the new rows.
      expect(observer.getCurrentResult().status).toBe("success");
    } finally {
      unsubscribe();
      client.unmount();
    }
  });
});

describe("per-surface opt-outs are honored end to end", () => {
  it("does not refetch on focus for a desktop-local-shaped client", async () => {
    // Desktop local has a real push bridge (`desktop:db:changed`, FEA-1834) plus
    // the FEA-2187 visibility-gated poll, so it opts out. Same contrast proof:
    // `web` reaching two calls proves the shared focus event was processed.
    const web = await mountObservedClient();
    const local = await mountObservedClient({ refetchOnWindowFocus: false });
    try {
      markStale(web.client);
      markStale(local.client);
      fireWindowFocus();
      await vi.waitFor(() => expect(web.queryFn).toHaveBeenCalledTimes(2));
      expect(local.queryFn).toHaveBeenCalledTimes(1);
    } finally {
      web.dispose();
      local.dispose();
    }
  });

  it("does not refetch on reconnect for a desktop-cloud-shaped client", async () => {
    // Desktop cloud opts out of reconnect only: a reconnect there changes the
    // mode, which rebuilds the client from empty and refetches anyway.
    const web = await mountObservedClient();
    const cloud = await mountObservedClient({
      refetchOnWindowFocus: true,
      refetchOnReconnect: false,
    });
    try {
      markStale(web.client);
      markStale(cloud.client);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      await vi.waitFor(() => expect(web.queryFn).toHaveBeenCalledTimes(2));
      expect(cloud.queryFn).toHaveBeenCalledTimes(1);
    } finally {
      web.dispose();
      cloud.dispose();
    }
  });

  it("still refetches a desktop-cloud-shaped client on focus", async () => {
    const cloud = await mountObservedClient({
      refetchOnWindowFocus: true,
      refetchOnReconnect: false,
    });
    try {
      markStale(cloud.client);
      fireWindowFocus();
      await vi.waitFor(() => expect(cloud.queryFn).toHaveBeenCalledTimes(2));
    } finally {
      cloud.dispose();
    }
  });
});

/**
 * The failure-path bound (codex P2 review on #4818).
 *
 * A failed fetch advances `errorUpdatedAt`, never `dataUpdatedAt`, so `staleTime`
 * does not restart for an errored query — it is stale on EVERY focus event. With
 * a bare `refetchOnWindowFocus: true` that means a user tabbing back and forth
 * during an API outage re-issues a fetch for every mounted query every time. The
 * default policy is `shouldRefetchOnFocus`, which holds an errored query for
 * `FOCUS_REFETCH_ERROR_COOLDOWN_MS` before letting focus drive it again.
 *
 * Time is pinned with fake timers so the boundary is exact rather than wall-clock
 * dependent; `shouldAdvanceTime` keeps `vi.waitFor` usable alongside them.
 */
describe("errored queries are not re-fetched on every focus", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-11T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds an errored query inside the cooldown while an explicit opt-in still refetches", async () => {
    // Same contrast idiom as the opt-out cases above: both clients observe the
    // SAME focus event. An explicit `true` is taken verbatim (no cooldown), so
    // its second attempt proves the event was delivered and processed — which
    // makes the default client still sitting at one call a real negative.
    const cooled = await mountErroredObservedClient();
    const verbatim = await mountErroredObservedClient({
      refetchOnWindowFocus: true,
    });
    try {
      fireWindowFocus();
      await vi.waitFor(() => expect(verbatim.queryFn).toHaveBeenCalledTimes(2));
      expect(cooled.queryFn).toHaveBeenCalledTimes(1);
    } finally {
      cooled.dispose();
      verbatim.dispose();
    }
  });

  it("refetches on focus once the failure is older than the cooldown", async () => {
    const cooled = await mountErroredObservedClient();
    try {
      vi.setSystemTime(Date.now() + FOCUS_REFETCH_ERROR_COOLDOWN_MS + 1000);
      fireWindowFocus();
      await vi.waitFor(() => expect(cooled.queryFn).toHaveBeenCalledTimes(2));
    } finally {
      cooled.dispose();
    }
  });

  it("never withholds a reconnect refetch, which is the recovery event", async () => {
    // Deliberate asymmetry: reconnect is rare, self-limiting, and precisely when
    // a cache is most likely wrong. Applying the cooldown here would strand the
    // user on a failed read with no event left to correct it.
    const cooled = await mountErroredObservedClient();
    try {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      await vi.waitFor(() => expect(cooled.queryFn).toHaveBeenCalledTimes(2));
    } finally {
      cooled.dispose();
    }
  });
});

describe("shouldRefetchOnFocus policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows focus refetch for a query that is not errored", () => {
    expect(
      shouldRefetchOnFocus({
        state: { errorUpdatedAt: 0, status: "success" },
      })
    ).toBe(true);
  });

  it("withholds focus refetch strictly inside the cooldown", () => {
    expect(
      shouldRefetchOnFocus({
        state: {
          errorUpdatedAt: Date.now() - (FOCUS_REFETCH_ERROR_COOLDOWN_MS - 1),
          status: "error",
        },
      })
    ).toBe(false);
  });

  it("allows focus refetch exactly at the cooldown boundary", () => {
    expect(
      shouldRefetchOnFocus({
        state: {
          errorUpdatedAt: Date.now() - FOCUS_REFETCH_ERROR_COOLDOWN_MS,
          status: "error",
        },
      })
    ).toBe(true);
  });
});

describe("both halves of a surface refresh together (ISS-5975)", () => {
  it("revalidates every stale mounted query from ONE focus event", async () => {
    // The Sessions list's manual Refresh button existed partly to re-read BOTH
    // halves of the page at once — the table AND the usage/summary tiles —
    // because refreshing one without the other is exactly how the cards and the
    // rows come to disagree. ISS-5975 removes that button, so this pins the
    // property it was guaranteeing: a single focus event revalidates every
    // stale mounted query on the client, so the two halves cannot land on
    // different populations.
    const client = makeQueryClient();
    const tableKey = projectKeys.list({ teamId: "sessions-table" });
    const tilesKey = projectKeys.list({ teamId: "sessions-usage-tiles" });
    const fetchTable = vi.fn(() => Promise.resolve("rows"));
    const fetchTiles = vi.fn(() => Promise.resolve("totals"));
    client.mount();
    const tableObserver = new QueryObserver(client, {
      queryKey: tableKey,
      queryFn: fetchTable,
    });
    const tilesObserver = new QueryObserver(client, {
      queryKey: tilesKey,
      queryFn: fetchTiles,
    });
    const unsubscribeTable = tableObserver.subscribe(() => {
      // Active subscription — see `mountObservedClient`.
    });
    const unsubscribeTiles = tilesObserver.subscribe(() => {
      // Active subscription — see `mountObservedClient`.
    });
    try {
      // Both must have SETTLED before backdating — see `mountObservedClient`.
      await vi.waitFor(() => {
        const table = tableObserver.getCurrentResult();
        const tiles = tilesObserver.getCurrentResult();
        if (
          table.data === undefined ||
          table.isFetching ||
          tiles.data === undefined ||
          tiles.isFetching
        ) {
          throw new Error("initial fetches have not both settled yet");
        }
      });

      const staleAt = Date.now() - (DEFAULT_QUERY_STALE_TIME_MS + 1000);
      client.setQueryData(tableKey, "rows", { updatedAt: staleAt });
      client.setQueryData(tilesKey, "totals", { updatedAt: staleAt });

      fireWindowFocus();

      await vi.waitFor(() => expect(fetchTable).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(fetchTiles).toHaveBeenCalledTimes(2));
    } finally {
      unsubscribeTable();
      unsubscribeTiles();
      client.unmount();
    }
  });
});
