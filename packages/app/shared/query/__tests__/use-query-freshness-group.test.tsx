/**
 * Freshness-group contract.
 *
 * ISS-12286 (PRD-792): a focus or reconnect event re-reads each STALE member
 * and leaves a fresh one alone. The case that discriminates is therefore
 * ONE-STALE/ONE-FRESH: the rule this replaced re-read both members there.
 *
 * These tests drive the REAL `focusManager`/`onlineManager` events the
 * production policy is wired to, and assert on `refetch` call counts, rather
 * than reading configuration back.
 */

import { focusManager, onlineManager } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type QueryFreshnessGroupMember,
  useQueryFreshnessGroup,
} from "../use-query-freshness-group";

/** A query-shaped group member with a spied `refetch`. */
function member(
  overrides: Partial<Omit<QueryFreshnessGroupMember, "refetch">> = {}
) {
  const refetch = vi.fn();
  return {
    isError: false,
    isStale: false,
    refetch,
    ...overrides,
  } satisfies QueryFreshnessGroupMember & { refetch: typeof refetch };
}

/**
 * Drive a real focus transition. `focusManager` only notifies on a CHANGE, so
 * the blur is load-bearing — setting `true` twice delivers nothing.
 */
function fireWindowFocus() {
  focusManager.setFocused(false);
  focusManager.setFocused(true);
}

afterEach(() => {
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

describe("useQueryFreshnessGroup", () => {
  it("re-reads only the stale member when its partner is still fresh", () => {
    const table = member({ isStale: true });
    const tiles = member({ isStale: false });
    renderHook(() => useQueryFreshnessGroup([table, tiles]));

    fireWindowFocus();

    expect(table.refetch).toHaveBeenCalledTimes(1);
    expect(tiles.refetch).not.toHaveBeenCalled();
  });

  it("re-reads only the stale member with the roles swapped", () => {
    // Same mixed state with the roles swapped, so the rule cannot be satisfied
    // by one that only ever re-reads a fixed position.
    const table = member({ isStale: false });
    const tiles = member({ isStale: true });
    renderHook(() => useQueryFreshnessGroup([table, tiles]));

    fireWindowFocus();

    expect(table.refetch).not.toHaveBeenCalled();
    expect(tiles.refetch).toHaveBeenCalledTimes(1);
  });

  it("re-reads every member when all of them are stale", () => {
    const table = member({ isStale: true });
    const tiles = member({ isStale: true });
    renderHook(() => useQueryFreshnessGroup([table, tiles]));

    fireWindowFocus();

    expect(table.refetch).toHaveBeenCalledTimes(1);
    expect(tiles.refetch).toHaveBeenCalledTimes(1);
  });

  it("joins an in-flight fetch instead of cancelling and restarting it", () => {
    // `refetch()` defaults to `cancelRefetch: true`, which would abort the read
    // the built-in focus trigger just started for the stale member — one
    // refresh costing two requests.
    const table = member({ isStale: true });
    const tiles = member();
    renderHook(() => useQueryFreshnessGroup([table, tiles]));

    fireWindowFocus();

    expect(table.refetch).toHaveBeenCalledWith({ cancelRefetch: false });
  });

  it("does nothing when every member is still fresh", () => {
    // The group must not raise the request ceiling: no member stale, no read.
    const table = member();
    const tiles = member();
    renderHook(() => useQueryFreshnessGroup([table, tiles]));

    fireWindowFocus();

    expect(table.refetch).not.toHaveBeenCalled();
    expect(tiles.refetch).not.toHaveBeenCalled();
  });

  it("stands down while a member is in error state", () => {
    // An errored query is stale forever (a failure advances `errorUpdatedAt`,
    // not `dataUpdatedAt`), so grouping on staleness alone would re-read on
    // EVERY focus event during an outage. The members keep their own
    // `shouldRefetchOnFocus` cooldown instead.
    const table = member({ isError: true, isStale: true });
    const tiles = member({ isStale: true });
    renderHook(() => useQueryFreshnessGroup([table, tiles]));

    fireWindowFocus();

    expect(table.refetch).not.toHaveBeenCalled();
    expect(tiles.refetch).not.toHaveBeenCalled();
  });

  it("re-reads the stale member on reconnect as well as on focus", () => {
    const table = member({ isStale: true });
    const tiles = member({ isStale: false });
    renderHook(() => useQueryFreshnessGroup([table, tiles]));

    onlineManager.setOnline(false);
    onlineManager.setOnline(true);

    expect(table.refetch).toHaveBeenCalledTimes(1);
    expect(tiles.refetch).not.toHaveBeenCalled();
  });

  it("acts on the current render's queries, not the ones it first mounted with", () => {
    // The listeners register once. Reading staleness off a captured first-render
    // closure would refetch the wrong generation after any filter/page change.
    const initialTable = member({ isStale: false });
    const initialTiles = member({ isStale: false });
    const { rerender } = renderHook(
      ({ group }: { group: QueryFreshnessGroupMember[] }) =>
        useQueryFreshnessGroup(group),
      { initialProps: { group: [initialTable, initialTiles] } }
    );

    const nextTable = member({ isStale: true });
    const nextTiles = member({ isStale: false });
    rerender({ group: [nextTable, nextTiles] });
    fireWindowFocus();

    expect(nextTable.refetch).toHaveBeenCalledTimes(1);
    expect(nextTiles.refetch).not.toHaveBeenCalled();
    expect(initialTable.refetch).not.toHaveBeenCalled();
    expect(initialTiles.refetch).not.toHaveBeenCalled();
  });

  it("unsubscribes on unmount so an unmounted surface issues no reads", () => {
    const table = member({ isStale: true });
    const tiles = member({ isStale: true });
    const { unmount } = renderHook(() =>
      useQueryFreshnessGroup([table, tiles])
    );

    unmount();
    fireWindowFocus();

    expect(table.refetch).not.toHaveBeenCalled();
    expect(tiles.refetch).not.toHaveBeenCalled();
  });
});
