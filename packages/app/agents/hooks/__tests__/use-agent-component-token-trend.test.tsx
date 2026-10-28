import type {
  TokenTrendPoint,
  TokenTrendResponse,
} from "@repo/api/src/types/agent-component-analytics";
import {
  createTestQueryClient,
  createWrapper,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import { TokenTrendCursorLoopError } from "../../lib/token-trend-pages";
import {
  agentComponentTokenTrendKeys,
  tokenTrendQueryData,
  useAgentComponentTokenTrend,
} from "../use-agent-component-token-trend";

// Mock useApiClient — the token-trend hook calls it directly (no data-source).
const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const SINCE = "2026-06-08T12:00:00.000Z";

// Written out rather than rebuilt with URLSearchParams: re-deriving the query
// string with the same builder the hook uses would pass whatever it produced.
const FIRST_PAGE_URL = "/agent-components/skill%3A%3Artk/token-trend";
const SECOND_PAGE_URL =
  "/agent-components/skill%3A%3Artk/token-trend?userId=user-1&since=2026-06-08T12%3A00%3A00.000Z&cursor=sess-1";

function point(sessionId: string, sessionStartedAt: string): TokenTrendPoint {
  return {
    sessionId,
    sessionStartedAt,
    model: "claude-opus-4-5",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0.12,
    runtimeMs: 5000,
    componentInvocations: 3,
    componentErrorCount: 0,
  };
}

const response: TokenTrendResponse = {
  slug: "skill::rtk",
  models: ["claude-opus-4-5"],
  points: [point("sess-1", "2026-06-01T10:00:00.000Z")],
};

/** Page one of a two-page walk: names the session the read stopped on. */
const firstPage: TokenTrendResponse = {
  slug: "skill::rtk",
  models: ["claude-opus-4-5"],
  points: [point("sess-1", "2026-06-01T10:00:00.000Z")],
  appliedWindow: { since: SINCE },
  truncated: true,
  nextCursor: "sess-1",
};

const secondPage: TokenTrendResponse = {
  slug: "skill::rtk",
  models: ["claude-sonnet-4-5"],
  points: [point("sess-2", "2026-06-02T10:00:00.000Z")],
  appliedWindow: { since: SINCE },
};

/**
 * A promise the test resolves by hand, so "page one arrived" and "the walk was
 * abandoned" are two separate, ordered events rather than a race.
 */
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    // replaced synchronously by the executor below
  };
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Drain the microtask queue. A page that settles hands its result to the query
 * one `await` later and schedules no timer in between, so a bounded drain is
 * exhaustive here — it is not a sleep waiting for a wall clock.
 */
async function settleWalk() {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

// `resetAllMocks`, not `clearAllMocks`: a queued `mockResolvedValueOnce` a
// case never consumed would otherwise answer the next case's first request.
beforeEach(() => {
  vi.resetAllMocks();
});

/**
 * The pinned clock of the same-millisecond case below. Restored unconditionally
 * here rather than at the end of that case: an assertion throwing mid-case would
 * otherwise leave `Date.now` frozen for every test after it in this worker.
 */
let dateNowSpy: MockInstance<() => number> | undefined;

afterEach(() => {
  dateNowSpy?.mockRestore();
  dateNowSpy = undefined;
});

/**
 * The walk has read every page: a success with no cursor left to follow. A
 * predicate rather than assertions, so `waitFor` can poll it and the misplaced-
 * assertion lint stays satisfied.
 */
function walkedToTheEnd(result: {
  current: { isSuccess: boolean; hasNextPage: boolean };
}) {
  return () => {
    if (!result.current.isSuccess || result.current.hasNextPage) {
      throw new Error("the walk has not read every page yet");
    }
  };
}

describe("agentComponentTokenTrendKeys", () => {
  it("detail() is scoped per slug + user and distinct from the ranking slice", () => {
    expect(agentComponentTokenTrendKeys.detail("skill::rtk")).toEqual([
      "agent-component-token-trend",
      "skill::rtk",
      "all",
    ]);
    expect(agentComponentTokenTrendKeys.detail("skill::rtk", "user-1")).toEqual(
      ["agent-component-token-trend", "skill::rtk", "user-1"]
    );
    expect(agentComponentTokenTrendKeys.detail("a")).not.toEqual(
      agentComponentTokenTrendKeys.detail("b")
    );
  });

  it("tokenTrendQueryData() is the one-page cache entry the hook reads back", async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(
      agentComponentTokenTrendKeys.detail("skill::rtk"),
      tokenTrendQueryData(response)
    );

    // The test client's `staleTime` is 0, which would refetch the seed on
    // mount; the story harness pins it fresh, and so does this.
    const { result } = renderHook(
      () =>
        useAgentComponentTokenTrend("skill::rtk", undefined, {
          staleTime: Number.POSITIVE_INFINITY,
        }),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(response);
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });
});

describe("useAgentComponentTokenTrend", () => {
  it("GETs the URL-encoded slug token-trend endpoint (success state)", async () => {
    mockApiClient.get.mockResolvedValueOnce(response);

    const { result } = renderHook(
      () => useAgentComponentTokenTrend("skill::rtk"),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(response);
    // "skill::rtk" must be percent-encoded on the wire (":" -> "%3A"), and
    // ISS-9851 hands the read the query's signal so leaving the page ends the
    // walk instead of fetching pages nobody will read.
    expect(mockApiClient.get).toHaveBeenCalledWith(
      FIRST_PAGE_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("appends the userId query param when provided", async () => {
    mockApiClient.get.mockResolvedValueOnce(response);

    const { result } = renderHook(
      () => useAgentComponentTokenTrend("skill::rtk", "user-1"),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiClient.get).toHaveBeenCalledWith(
      `${FIRST_PAGE_URL}?userId=user-1`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("is disabled for an empty slug — never calls the API", () => {
    renderHook(() => useAgentComponentTokenTrend(""), {
      wrapper: createWrapper(),
    });
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  // ISS-9851 gave the hook its OWN retry predicate, which overrides the test
  // client's `retry: false`, so a bare rejection now costs three attempts on a
  // real backoff. `retry: false` through the hook's options argument restores
  // the single attempt this case was always about; the assertion is unchanged.
  it("surfaces isError when the request fails", async () => {
    mockApiClient.get.mockRejectedValueOnce(new Error("500"));

    const { result } = renderHook(
      () =>
        useAgentComponentTokenTrend("skill::rtk", undefined, { retry: false }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("follows the cursor and hands back the pages as one response", async () => {
    mockApiClient.get
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);

    const { result } = renderHook(
      () => useAgentComponentTokenTrend("skill::rtk", "user-1"),
      { wrapper: createWrapper() }
    );

    await waitFor(walkedToTheEnd(result));

    expect(mockApiClient.get).toHaveBeenCalledTimes(2);
    expect(mockApiClient.get).toHaveBeenNthCalledWith(
      2,
      SECOND_PAGE_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(result.current.data).toEqual({
      slug: "skill::rtk",
      points: [
        point("sess-1", "2026-06-01T10:00:00.000Z"),
        point("sess-2", "2026-06-02T10:00:00.000Z"),
      ],
      models: ["claude-opus-4-5", "claude-sonnet-4-5"],
      appliedWindow: { since: SINCE },
    });
  });

  // marisolashgrove (#6996): the components this walk exists for are the ones
  // past 20,000 rows, and they used to draw nothing until every page landed.
  it("hands back page one, disclosed as a prefix, before page two has landed", async () => {
    const gate = deferred<TokenTrendResponse>();
    mockApiClient.get
      .mockResolvedValueOnce(firstPage)
      .mockReturnValueOnce(gate.promise);

    const { result } = renderHook(
      () => useAgentComponentTokenTrend("skill::rtk", "user-1"),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isFetchingNextPage).toBe(true));

    // Page one is on screen while page two is in flight — and says it is a
    // prefix, because it still is one.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toEqual({
      slug: "skill::rtk",
      points: [point("sess-1", "2026-06-01T10:00:00.000Z")],
      models: ["claude-opus-4-5"],
      appliedWindow: { since: SINCE },
      truncated: true,
    });

    gate.resolve(secondPage);

    await waitFor(() => expect(result.current.isFetchingNextPage).toBe(false));
    expect(result.current.data?.points.map((p) => p.sessionId)).toEqual([
      "sess-1",
      "sess-2",
    ]);
    expect(Object.hasOwn(result.current.data ?? {}, "truncated")).toBe(false);
  });

  // marisolashgrove (#6996): with retry on a single queryFn, a transport error on
  // page 37 re-walked from page one. Each page is its own fetch now.
  it("retries a failed page from its own cursor, never from page one", async () => {
    mockApiClient.get
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(secondPage);

    const { result } = renderHook(
      () =>
        useAgentComponentTokenTrend("skill::rtk", "user-1", {
          retryDelay: 0,
        }),
      { wrapper: createWrapper() }
    );

    await waitFor(walkedToTheEnd(result));

    expect(result.current.isError).toBe(false);
    // One read of page one; page two paid for twice, page one never again.
    expect(mockApiClient.get.mock.calls.map((call) => call[0])).toEqual([
      `${FIRST_PAGE_URL}?userId=user-1`,
      SECOND_PAGE_URL,
      SECOND_PAGE_URL,
    ]);
    expect(result.current.data?.points.map((p) => p.sessionId)).toEqual([
      "sess-1",
      "sess-2",
    ]);
  });

  // Every page here settles in the same tick it was asked for, so TanStack
  // coalesces "fetching page N" and "page N landed" into one notification and
  // React renders once. An effect re-armed only by `hasNextPage` and
  // `isFetchingNextPage` never runs again after page two and leaves the walk
  // parked on a cursor with a green status.
  it("keeps walking when pages land faster than a render", async () => {
    const thirdPage: TokenTrendResponse = {
      slug: "skill::rtk",
      models: ["claude-haiku-4-5"],
      points: [point("sess-3", "2026-06-03T10:00:00.000Z")],
      appliedWindow: { since: SINCE },
    };
    mockApiClient.get
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce({ ...secondPage, nextCursor: "sess-2" })
      .mockResolvedValueOnce(thirdPage);

    const { result } = renderHook(
      () => useAgentComponentTokenTrend("skill::rtk", "user-1"),
      { wrapper: createWrapper() }
    );

    await waitFor(walkedToTheEnd(result));

    expect(mockApiClient.get).toHaveBeenCalledTimes(3);
    expect(result.current.data?.points.map((p) => p.sessionId)).toEqual([
      "sess-1",
      "sess-2",
      "sess-3",
    ]);
  });

  // ISS-10174: the walk used to re-arm on `dataUpdatedAt`, which query-core
  // stamps with `Date.now()`. Pinning the clock is what a loaded runner does by
  // accident — it stalls, then drains several settled pages into one
  // millisecond — and it left every dependency of the walk's effect unchanged,
  // so the walk parked on a cursor while reporting success. The clock is pinned
  // rather than raced, so this case fails every run against that hook, not half.
  it("keeps walking when every page lands in the SAME millisecond", async () => {
    dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(1_777_000_000_000);
    const thirdPage: TokenTrendResponse = {
      slug: "skill::rtk",
      models: ["claude-haiku-4-5"],
      points: [point("sess-3", "2026-06-03T10:00:00.000Z")],
      appliedWindow: { since: SINCE },
    };
    mockApiClient.get
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce({ ...secondPage, nextCursor: "sess-2" })
      .mockResolvedValueOnce(thirdPage);

    const { result } = renderHook(
      () => useAgentComponentTokenTrend("skill::rtk", "user-1"),
      { wrapper: createWrapper() }
    );

    await waitFor(walkedToTheEnd(result));

    expect(mockApiClient.get).toHaveBeenCalledTimes(3);
    expect(result.current.data?.points.map((p) => p.sessionId)).toEqual([
      "sess-1",
      "sess-2",
      "sess-3",
    ]);
  });

  // whitlockk: the SAME park, reached by the other door. A reader returning to a
  // partly-walked cache starts an ordinary refetch on mount; while it is in
  // flight `fetchNextPage({ cancelRefetch: false })` is a no-op, and a refetch
  // that returns the same pages settles with the page count, `hasNextPage`,
  // `isFetchingNextPage` and `isError` all exactly as they were — so a walk
  // armed on those alone never runs again and the chart stays truncated for
  // good. `isFetching` falling back to false is what re-arms it.
  it("resumes the walk after an ordinary refetch overlaps the mount", async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(
      agentComponentTokenTrendKeys.detail("skill::rtk", "user-1"),
      tokenTrendQueryData(firstPage)
    );
    // The seeded page is stale at mount, so the FIRST response here is that
    // refetch of page one — not the walk, which may only move after it settles.
    mockApiClient.get
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);

    const { result } = renderHook(
      () => useAgentComponentTokenTrend("skill::rtk", "user-1"),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await waitFor(walkedToTheEnd(result));

    expect(mockApiClient.get.mock.calls.map((call) => call[0])).toEqual([
      `${FIRST_PAGE_URL}?userId=user-1`,
      SECOND_PAGE_URL,
    ]);
    expect(result.current.data?.points.map((p) => p.sessionId)).toEqual([
      "sess-1",
      "sess-2",
    ]);
  });

  // whitlockk: `select` transformed the observer result too, so `refetch()` resolved
  // the same merged shape `data` carries. The merge moved into the hook for the
  // page count `select` hides; this pins that the refetch result moved with it,
  // rather than one hook handing its callers two shapes.
  it("resolves refetch() with the merged shape data already has", async () => {
    mockApiClient.get.mockResolvedValue(response);

    const { result } = renderHook(
      () => useAgentComponentTokenTrend("skill::rtk"),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const refetched = await act(() => result.current.refetch());

    // A merged response, not the raw `{ pages, pageParams }` the cache holds.
    expect(refetched.data).toEqual(response);
    expect(refetched.data).toEqual(result.current.data);
  });

  it("abandons the walk when the reader leaves after page one", async () => {
    const gate = deferred<TokenTrendResponse>();
    mockApiClient.get.mockReturnValueOnce(gate.promise);

    const { unmount } = renderHook(
      () => useAgentComponentTokenTrend("skill::rtk", "user-1"),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(mockApiClient.get).toHaveBeenCalledTimes(1));

    unmount();

    // The positive half, so the count below is not a non-occurrence nobody
    // caused: leaving the page really does abort the signal the fetch carries.
    const firstCallOptions = mockApiClient.get.mock.calls[0]?.[1] as {
      signal: AbortSignal;
    };
    expect(firstCallOptions.signal.aborted).toBe(true);

    gate.resolve(firstPage);
    await settleWalk();

    // Page one named a next cursor; nobody is left to read page two.
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);
  });

  it("does not retry a repeated cursor — it would loop the same way again", async () => {
    const looping: TokenTrendResponse = { ...firstPage, nextCursor: "sess-1" };
    mockApiClient.get.mockResolvedValue(looping);

    const { result } = renderHook(
      () => useAgentComponentTokenTrend("skill::rtk", "user-1"),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    await settleWalk();

    expect(result.current.error).toBeInstanceOf(TokenTrendCursorLoopError);
    // Exactly one walk: the first page, then the follow-up that re-offered the
    // position already read. The refused third request is never sent, and a
    // retried query would pay for the second page again.
    expect(mockApiClient.get).toHaveBeenCalledTimes(2);
  });

  it("errors when a later page fails, keeping page one disclosed as a prefix", async () => {
    mockApiClient.get
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce(new ApiError("boom", 500));

    const { result } = renderHook(
      () => useAgentComponentTokenTrend("skill::rtk", "user-1"),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    // What landed is still there, and still says it is not the whole window.
    expect(result.current.data?.truncated).toBe(true);
    expect(mockApiClient.get).toHaveBeenCalledTimes(2);
  });

  it("returns an unpageable producer's response verbatim, truncation and all", async () => {
    const oldServer: TokenTrendResponse = {
      slug: "skill::rtk",
      models: ["claude-opus-4-5"],
      points: [point("sess-1", "2026-06-01T10:00:00.000Z")],
      appliedWindow: { since: SINCE },
      truncated: true,
    };
    mockApiClient.get.mockResolvedValueOnce(oldServer);

    const { result } = renderHook(
      () => useAgentComponentTokenTrend("skill::rtk", "user-1"),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(oldServer);
  });
});
