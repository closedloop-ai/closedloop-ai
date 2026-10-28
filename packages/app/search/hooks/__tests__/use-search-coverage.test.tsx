import { SearchMode } from "@repo/api/src/types/search";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import {
  searchKeys,
  useGlobalSearch,
  useSearchPanelState,
  useUnifiedSearch,
} from "@repo/app/search/hooks/use-search";
import { ApiError } from "@repo/app/shared/api/api-error";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mockApiClient = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("search hooks", () => {
  /**
   * davetho review (ISS-9414). Measured both shapes before changing anything:
   *
   *   - a COLD query (no data yet) returns to `pending` on retry, so `isLoading`
   *     already goes true and the surface already leaves the failure. The
   *     original reading held there.
   *   - a WARM query — one that succeeded, then failed on a later fetch — keeps
   *     its data, so `status` stays `error` and `isLoading` stays FALSE while the
   *     retry runs. That is the case below, and without `isRetrying` the surface
   *     kept rendering the settled failure and its retry button throughout the
   *     retry it had just started.
   */
  test("reports a retry of a warm failed query as in flight, not as the settled failure", async () => {
    mockApiClient.get.mockResolvedValueOnce({
      query: "alpha",
      mode: SearchMode.Fulltext,
      nextCursor: null,
      results: [
        {
          deepLink: "/sessions/s1",
          entityId: "s1",
          entityType: SearchEntityType.AgentSession,
          rank: 1,
          snippet: "s",
          title: "t",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const wrapper = createWrapperWithClient(createTestQueryClient());
    const panel = renderHook(() => useSearchPanelState({ query: "alpha" }), {
      wrapper,
    });
    await waitFor(() => expect(panel.result.current.results).toHaveLength(1));

    mockApiClient.get.mockRejectedValueOnce(new Error("search is down"));
    act(() => {
      panel.result.current.refetch();
    });
    await waitFor(() => expect(panel.result.current.isError).toBe(true));
    // The settled failure, with the earlier page still in hand.
    expect(panel.result.current.isLoading).toBe(false);
    expect(panel.result.current.isRetrying).toBe(false);

    // A retry that never settles, so the in-flight window is observable.
    mockApiClient.get.mockReturnValue(new Promise(() => undefined));
    act(() => {
      panel.result.current.refetch();
    });

    await waitFor(() => expect(panel.result.current.isRetrying).toBe(true));
    // `isLoading` stays false and `isError` stays latched — which is precisely
    // why neither of them could tell the surface a retry was running.
    expect(panel.result.current.isLoading).toBe(false);
    expect(panel.result.current.isError).toBe(true);
  });

  test("runs encoded global text and tag searches while empty input stays idle", async () => {
    mockApiClient.get.mockResolvedValue({
      query: "query",
      documents: [],
      projects: [],
    });
    const wrapper = createWrapperWithClient(createTestQueryClient());
    const text = renderHook(
      () => useGlobalSearch({ query: "  audit & risk  " }),
      { wrapper }
    );
    const tag = renderHook(
      () => useGlobalSearch({ query: "ignored", tagId: " tag/id " }),
      { wrapper }
    );
    const idle = renderHook(() => useGlobalSearch({ query: "  " }), {
      wrapper,
    });

    await waitFor(() => expect(text.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(tag.result.current.isSuccess).toBe(true));
    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/search?q=audit%20%26%20risk"
    );
    expect(mockApiClient.get).toHaveBeenCalledWith("/search?tagId=tag%2Fid");
    expect(idle.result.current.fetchStatus).toBe("idle");
    expect(mockApiClient.get).toHaveBeenCalledTimes(2);
  });

  test("serializes unified mode, repeated types, and an explicit limit", async () => {
    mockApiClient.get.mockResolvedValue({
      query: "deploy",
      mode: SearchMode.Prefix,
      results: [],
      nextCursor: "next",
    });
    const queryClient = createTestQueryClient();
    const { rerender, result } = renderHook(
      ({ limit }) =>
        useUnifiedSearch({
          query: "  deploy  ",
          mode: SearchMode.Prefix,
          types: [SearchEntityType.Document, SearchEntityType.Project],
          limit,
        }),
      {
        initialProps: { limit: 0 },
        wrapper: createWrapperWithClient(queryClient),
      }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/search?q=deploy&mode=prefix&types=document&types=project&limit=1"
    );
    expect(
      queryClient
        .getQueryCache()
        .findAll()
        .map((entry) => entry.queryKey)
    ).toContainEqual(
      searchKeys.unified({
        query: "deploy",
        mode: SearchMode.Prefix,
        types: [SearchEntityType.Document, SearchEntityType.Project],
        limit: 1,
      })
    );
    expect(result.current.data).toEqual({
      query: "deploy",
      mode: SearchMode.Prefix,
      results: [],
      nextCursor: "next",
    });

    rerender({ limit: 101 });
    await waitFor(() =>
      expect(mockApiClient.get).toHaveBeenCalledWith(
        "/search?q=deploy&mode=prefix&types=document&types=project&limit=100"
      )
    );
    expect(
      queryClient
        .getQueryCache()
        .findAll()
        .map((entry) => entry.queryKey)
    ).toContainEqual(
      searchKeys.unified({
        query: "deploy",
        mode: SearchMode.Prefix,
        types: [SearchEntityType.Document, SearchEntityType.Project],
        limit: 100,
      })
    );

    rerender({ limit: 12.7 });
    await waitFor(() =>
      expect(mockApiClient.get).toHaveBeenCalledWith(
        "/search?q=deploy&mode=prefix&types=document&types=project&limit=12"
      )
    );
    expect(
      queryClient
        .getQueryCache()
        .findAll()
        .map((entry) => entry.queryKey)
    ).toContainEqual(
      searchKeys.unified({
        query: "deploy",
        mode: SearchMode.Prefix,
        types: [SearchEntityType.Document, SearchEntityType.Project],
        limit: 12,
      })
    );
  });

  test("omits a non-finite limit instead of serializing it", async () => {
    mockApiClient.get.mockResolvedValue({
      query: "deploy",
      mode: SearchMode.Fulltext,
      results: [],
      nextCursor: null,
    });
    const queryClient = createTestQueryClient();
    const { result } = renderHook(
      () => useUnifiedSearch({ limit: Number.NaN, query: "deploy" }),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // `limit=NaN` parses as absent server-side, so the omitted param is what
    // the cache key must describe -- not a NaN the key hashes to null.
    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/search?q=deploy&mode=fulltext"
    );
    expect(
      queryClient
        .getQueryCache()
        .findAll()
        .map((entry) => entry.queryKey)
    ).toContainEqual(
      searchKeys.unified({
        query: "deploy",
        mode: SearchMode.Fulltext,
        types: [],
        limit: undefined,
      })
    );
  });

  test("defaults unified options and gates queries shorter than two characters", async () => {
    mockApiClient.get.mockResolvedValue({
      query: "ok",
      mode: SearchMode.Fulltext,
      results: [],
      nextCursor: null,
    });
    const queryClient = createTestQueryClient();
    const wrapper = createWrapperWithClient(queryClient);
    const short = renderHook(() => useUnifiedSearch({ query: " x " }), {
      wrapper,
    });
    const valid = renderHook(() => useUnifiedSearch({ query: " ok " }), {
      wrapper,
    });

    await waitFor(() => expect(valid.result.current.isSuccess).toBe(true));
    expect(short.result.current.fetchStatus).toBe("idle");
    expect(mockApiClient.get).toHaveBeenCalledOnce();
    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/search?q=ok&mode=fulltext"
    );
    expect(
      queryClient
        .getQueryCache()
        .findAll()
        .map((entry) => entry.queryKey)
    ).toContainEqual(
      searchKeys.unified({
        query: "ok",
        mode: SearchMode.Fulltext,
        types: [],
        limit: undefined,
      })
    );
  });

  test("derives successful panel results and delegates retries", async () => {
    const response = {
      query: "ok",
      mode: SearchMode.Fulltext,
      results: [
        {
          entityType: SearchEntityType.AgentSession,
          entityId: "session-1",
          title: "Session",
          snippet: "Session result",
          rank: 1,
          updatedAt: "2026-08-20T00:00:00Z",
          deepLink: "/sessions/session-1",
        },
      ],
      nextCursor: "cursor-1",
    };
    mockApiClient.get.mockResolvedValue(response);
    const { result } = renderHook(() => useSearchPanelState({ query: "ok" }), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    await waitFor(() => expect(result.current.results).toHaveLength(1));
    expect(result.current).toMatchObject({
      isLoading: false,
      isError: false,
      filterErrorMessage: undefined,
      nextCursor: "cursor-1",
    });
    act(() => result.current.refetch());
    await waitFor(() => expect(mockApiClient.get).toHaveBeenCalledTimes(2));
  });

  // PRD-795: an older API can still return a hit of the retired Loop kind; the
  // hook keeps only the kinds this build offers, so no row has to render one.
  test("keeps only hits of an offered kind", async () => {
    mockApiClient.get.mockResolvedValue({
      query: "ok",
      mode: SearchMode.Fulltext,
      results: [
        {
          entityType: SearchEntityType.Loop,
          entityId: "loop-1",
          title: "Retired",
          snippet: "retired",
          rank: 1,
          updatedAt: "2026-08-20T00:00:00Z",
          deepLink: "/loops/loop-1",
        },
        {
          entityType: SearchEntityType.AgentSession,
          entityId: "session-1",
          title: "Session",
          snippet: "Session result",
          rank: 0.5,
          updatedAt: "2026-08-20T00:00:00Z",
          deepLink: "/sessions/session-1",
        },
      ],
      nextCursor: null,
    });
    const { result } = renderHook(() => useSearchPanelState({ query: "ok" }), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.results.map((hit) => hit.entityId)).toEqual([
      "session-1",
    ]);
  });

  test("surfaces only safe malformed-filter messages", async () => {
    mockApiClient.get.mockRejectedValue(
      new ApiError("Unknown priority value: huge", 400)
    );
    const filterError = renderHook(
      () => useSearchPanelState({ query: "priority:huge" }),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );
    await waitFor(() => expect(filterError.result.current.isError).toBe(true));
    expect(filterError.result.current.results).toEqual([]);
    expect(filterError.result.current.nextCursor).toBeUndefined();
    expect(filterError.result.current.filterErrorMessage).toBe(
      "Unknown priority value: huge"
    );

    mockApiClient.get.mockRejectedValue(new ApiError("secret", 500));
    const serverError = renderHook(
      () => useSearchPanelState({ query: "different" }),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );
    await waitFor(() => expect(serverError.result.current.isError).toBe(true));
    expect(serverError.result.current.filterErrorMessage).toBeUndefined();
  });
});
