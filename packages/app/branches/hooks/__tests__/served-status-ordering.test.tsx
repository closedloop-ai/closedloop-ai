import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListPageMode,
} from "@repo/api/src/types/branch-list-contract";
import { BranchStatusOrderingName } from "@repo/api/src/types/branch-status-order";
import { QueryClient } from "@tanstack/react-query";
import { render, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { BranchQueryFilters } from "../../data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../../data-source/provider";
import { useBranchServedStatusOrderingReset } from "../use-branch-filter-state";
import { useBranchesPageData } from "../use-branches";
import {
  flushAsyncWork,
  type SpyingSource,
  serverPageList,
  spyingSource,
} from "./server-page-test-utils";

/**
 * ISS-9437 — the producer states the status ordering it built its pages with on
 * the evaluation clock; the client keys the LIST query on it and returns to page
 * 0 when it changes.
 *
 * Each case takes its OWN `startDate`, and that is load-bearing rather than
 * decoration: the evaluation clock is memoized in a MODULE-level cache keyed by
 * the scope plus these filters, so two cases sharing them would share a latch
 * and the second would read the first's answer — passing in file order and
 * failing alone.
 */
describe("served status ordering — list query key", () => {
  it("carries the served ordering into the list query key", async () => {
    const queryClient = testQueryClient();
    const source = clockSource(BranchStatusOrderingName.RootFirst);

    renderProbe(source, queryClient, serverFilters("2026-08-01T00:00:00.000Z"));
    await flushAsyncWork();
    await flushAsyncWork();

    // The key is what makes a producer flip a different cache entry rather than
    // the same one silently restitched. Folding the ordering into the FILTERS
    // instead would also 400 the read: the HTTP source spreads every filter into
    // the query string and the server-page schema is `.strict()`.
    expect(listQueryKeys(queryClient)).toContainEqual(
      expect.arrayContaining([
        { servedStatusOrdering: BranchStatusOrderingName.RootFirst },
      ])
    );
  });

  it("leaves the key exactly as it is today when the producer states nothing", async () => {
    const queryClient = testQueryClient();
    const source = clockSource(undefined);

    renderProbe(source, queryClient, serverFilters("2026-08-02T00:00:00.000Z"));
    await flushAsyncWork();
    await flushAsyncWork();

    // A producer that predates the field must not re-key anything, so every list
    // key here is the pre-ISS-9437 five-segment shape.
    expect(listQueryKeys(queryClient).length).toBeGreaterThan(0);
    for (const key of listQueryKeys(queryClient)) {
      expect(key).toHaveLength(5);
    }
  });
});

describe("served status ordering — page reset", () => {
  it("returns to page 0 when the producer changes the order it serves", () => {
    const setPage = vi.fn();
    const { rerender } = renderHook(
      ({ ordering }: { ordering: string | null }) => {
        useBranchServedStatusOrderingReset(ordering, setPage);
      },
      {
        initialProps: {
          ordering: BranchStatusOrderingName.Vocabulary as string | null,
        },
      }
    );

    // The FIRST observation is the clock answering, not a flip. Resetting here
    // would discard the page a deep link asked for, on every mount.
    expect(setPage).not.toHaveBeenCalled();

    rerender({ ordering: BranchStatusOrderingName.RootFirst });

    // The PAGE RESET, not merely a new key. A new key is a new cache entry; the
    // reader's offset survives it and would then name a slice of a differently
    // ordered list.
    expect(setPage).toHaveBeenCalledWith(0);
  });

  it("does not reset while the producer keeps stating the same order", () => {
    const setPage = vi.fn();
    const { rerender } = renderHook(
      ({ ordering }: { ordering: string | null }) => {
        useBranchServedStatusOrderingReset(ordering, setPage);
      },
      {
        initialProps: {
          ordering: BranchStatusOrderingName.RootFirst as string | null,
        },
      }
    );

    rerender({ ordering: BranchStatusOrderingName.RootFirst });

    expect(setPage).not.toHaveBeenCalled();
  });

  it("does not reset for an absent ordering, before or after one is stated", () => {
    const setPage = vi.fn();
    const { rerender } = renderHook(
      ({ ordering }: { ordering: string | null }) => {
        useBranchServedStatusOrderingReset(ordering, setPage);
      },
      { initialProps: { ordering: null as string | null } }
    );

    rerender({ ordering: null });
    expect(setPage).not.toHaveBeenCalled();

    // Absent is what a legacy producer AND an unavailable flag evaluation both
    // look like. Neither is evidence the order moved, so an ordering that goes
    // away must not reset either.
    rerender({ ordering: BranchStatusOrderingName.RootFirst });
    rerender({ ordering: null });
    expect(setPage).not.toHaveBeenCalled();
  });
});

function serverFilters(startDate: string): BranchQueryFilters {
  return {
    pageMode: BranchListPageMode.Server,
    limit: BRANCH_LIST_SERVER_PAGE_SIZE,
    offset: 0,
    startDate,
  };
}

function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
  });
}

function clockSource(statusOrdering: string | undefined): SpyingSource {
  const source = spyingSource("http");
  source.supportsSplitPageData = true;
  source.list = vi.fn(() => Promise.resolve(serverPageList("branch-1")));
  source.listStatusOrdering = vi.fn(() =>
    Promise.resolve(statusOrdering ? { statusOrdering } : {})
  );
  return source;
}

function renderProbe(
  source: SpyingSource,
  queryClient: QueryClient,
  filters: BranchQueryFilters
) {
  function Probe() {
    useBranchesPageData(filters);
    return null;
  }
  return render(
    <AppCoreStoryProviders>
      <BranchesDataSourceProvider dataSource={source} queryClient={queryClient}>
        <Probe />
      </BranchesDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

function listQueryKeys(queryClient: QueryClient): readonly unknown[][] {
  return queryClient
    .getQueryCache()
    .getAll()
    .map((query) => [...query.queryKey])
    .filter((key) => key[0] === "branches" && key[1] === "list");
}
