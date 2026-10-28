import { BranchViewerScope } from "@repo/api/src/types/branch";
import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
  type MergedTraceItem,
} from "@repo/api/src/types/branch-trace";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import { createHttpBranchesDataSource } from "../../data-source/branches-data-source";
import { useBranchTracePages } from "../use-branch-trace-pages";

const mocks = vi.hoisted(() => ({ get: vi.fn(), source: vi.fn() }));
vi.mock("../../data-source/provider", async () => {
  const { useQueryClient } = await import("@tanstack/react-query");
  return {
    useBranchesDataSource: () => mocks.source(),
    useBranchesQueryContext: () => ({ queryClient: useQueryClient() }),
  };
});

const cursor = `v1:${"a".repeat(64)}:1`;
const state = {
  sessions: [
    {
      identity: {
        artifactId: "s1",
        name: "Session",
        slug: null,
        navigableRef: "s1",
      },
      state: BranchTraceSessionHydrationState.Loaded,
    },
  ],
  qualifyingSessionCount: 1,
  completeness: { state: BranchTraceCompletenessState.Complete },
  aggregateCompleteness: { state: BranchTraceCompletenessState.Complete },
};
const items: MergedTraceItem[] = [
  { type: "end", sessionId: "s1", text: "first" },
  { type: "end", sessionId: "s1", text: "last" },
];

beforeEach(() => {
  mocks.get.mockReset();
  mocks.source.mockReturnValue(
    createHttpBranchesDataSource({ get: mocks.get })
  );
});

describe("production branch trace paging", () => {
  it("reads one page on mount and only requests the cursor when asked for more", async () => {
    mocks.get
      .mockResolvedValueOnce(
        page([items[0]], true, {
          nextCursor: cursor,
          overviewItems: items,
        })
      )
      .mockResolvedValueOnce(page([items[1]], false));
    const view = renderPaging();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get.mock.calls[0][0]).toBe(
      "/branches/branch-1/trace?pageMode=cursor&limit=100"
    );
    expect(view.result.current.data?.items).toEqual([items[0]]);
    expect(view.result.current.data?.overviewItems).toEqual(items);
    act(() => view.result.current.loadMore());
    await waitFor(() => expect(view.result.current.data?.items).toEqual(items));
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.get.mock.calls[1][0]).toContain(encodeURIComponent(cursor));
    expect(view.result.current.hasNextPage).toBe(false);
  });

  it("replaces earlier pages when membership changed during navigation", async () => {
    mocks.get
      .mockResolvedValueOnce(
        page([items[0]], true, {
          nextCursor: cursor,
          overviewItems: items,
        })
      )
      .mockResolvedValueOnce(
        page([items[1]], false, { reset: true, overviewItems: [items[1]] })
      );
    const view = renderPaging();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    act(() => view.result.current.loadMore());
    await waitFor(() =>
      expect(view.result.current.data?.items).toEqual([items[1]])
    );
    expect(view.result.current.data?.overviewItems).toEqual([items[1]]);
  });

  it("uses complete mode when an older server rejects cursor parameters", async () => {
    mocks.get
      .mockRejectedValueOnce(new ApiError("Invalid query parameters", 400))
      .mockResolvedValueOnce(page(items, false));
    const view = renderPaging();
    await waitFor(() => expect(view.result.current.data?.items).toEqual(items));
    expect(mocks.get.mock.calls[1][0]).toBe(
      "/branches/branch-1/trace?complete=true"
    );
    expect(view.result.current.hasNextPage).toBe(false);
  });

  it("keeps desktop sources without the additive page port working", async () => {
    const trace = vi.fn().mockResolvedValue({ ...state, items });
    mocks.source.mockReturnValue({ scope: "local", trace });
    const view = renderPaging();
    await waitFor(() => expect(view.result.current.data?.items).toEqual(items));
    expect(trace).toHaveBeenCalledTimes(1);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("retains loaded rows and reports a failed later page without an automatic loop", async () => {
    mocks.get
      .mockResolvedValueOnce(
        page([items[0]], true, {
          nextCursor: cursor,
          overviewItems: items,
        })
      )
      .mockRejectedValueOnce(new ApiError("Failed to fetch branch trace", 500))
      .mockResolvedValueOnce(
        page([items[1]], true, { nextCursor: `v1:${"a".repeat(64)}:2` })
      )
      .mockResolvedValueOnce(page([], false));
    const view = renderPaging();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    act(() => view.result.current.loadMore());
    await waitFor(() => expect(view.result.current.isError).toBe(true));
    expect(view.result.current.data?.items).toEqual([items[0]]);
    expect(view.result.current.data?.completeness.state).toBe(
      BranchTraceCompletenessState.Incomplete
    );
    act(() => view.result.current.loadMore());
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(view.result.current.data?.overviewItems).toEqual(items);
    act(() => view.result.current.retryPage());
    await waitFor(() => expect(view.result.current.data?.items).toEqual(items));
    expect(mocks.get.mock.calls[2][0]).toBe(mocks.get.mock.calls[1][0]);
    expect(view.result.current.isFetchNextPageError).toBe(false);
    expect(view.result.current.data?.overviewItems).toEqual(items);
    act(() => view.result.current.loadMore());
    await waitFor(() => expect(view.result.current.hasNextPage).toBe(false));
    expect(mocks.get).toHaveBeenCalledTimes(4);
  });
});

function page(values: MergedTraceItem[], hasMore: boolean, extras = {}) {
  return {
    branchId: "branch-1",
    viewerScope: BranchViewerScope.Organization,
    items: values,
    hasMore,
    traceState: state,
    ...extras,
  };
}

function renderPaging() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderHook(() => useBranchTracePages("branch-1"), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}
