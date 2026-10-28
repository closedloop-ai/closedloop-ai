import {
  BROWSER_SESSION_OFFSET_MAX,
  BROWSER_SESSION_PAGE_LIMIT_DEFAULT,
  BROWSER_SESSION_PAGE_LIMIT_MAX,
  BrowserSessionErrorCode,
} from "@repo/api/src/types/browser-session";
import { ApiError } from "@repo/app/shared/api/api-error";
import {
  createTestQueryClient,
  createWrapper,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserSessionKeys,
  useBrowserSessions,
  useRevokeBrowserSession,
} from "../use-browser-sessions";

const mockApiClient = {
  get: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const PAGE = {
  sessions: [],
  totalCount: 0,
  limit: BROWSER_SESSION_PAGE_LIMIT_DEFAULT,
  offset: 0,
  currentSessionKnown: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useBrowserSessions", () => {
  it("sends both bounds explicitly rather than leaving them to the route default", async () => {
    mockApiClient.get.mockResolvedValueOnce(PAGE);

    const { result } = renderHook(() => useBrowserSessions(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiClient.get).toHaveBeenCalledWith(
      `/settings/browser-sessions?limit=${BROWSER_SESSION_PAGE_LIMIT_DEFAULT}&offset=0`
    );
  });

  it("surfaces the provider total alongside the returned page", async () => {
    mockApiClient.get.mockResolvedValueOnce({
      ...PAGE,
      sessions: [{ id: "sess-1" }],
      totalCount: 7,
    });

    const { result } = renderHook(() => useBrowserSessions({ limit: 1 }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.totalCount).toBe(7);
    expect(result.current.data?.sessions).toHaveLength(1);
  });

  // The client deliberately does NOT clamp (ISS-8734): the route's
  // `clampPageLimit`/`clampPageOffset` are the one clamp, and a second copy
  // here could round differently and make the query key claim a page the
  // response never was. These cases fail if a client-side clamp comes back.
  it.each([
    [
      { limit: BROWSER_SESSION_PAGE_LIMIT_MAX + 1 },
      `limit=${BROWSER_SESSION_PAGE_LIMIT_MAX + 1}&offset=0`,
    ],
    [{ limit: 0 }, "limit=0&offset=0"],
    [{ limit: 12.7 }, "limit=12.7&offset=0"],
    [{ offset: -1 }, `limit=${BROWSER_SESSION_PAGE_LIMIT_DEFAULT}&offset=-1`],
    [
      { offset: BROWSER_SESSION_OFFSET_MAX + 1 },
      `limit=${BROWSER_SESSION_PAGE_LIMIT_DEFAULT}&offset=${BROWSER_SESSION_OFFSET_MAX + 1}`,
    ],
  ])("sends %o to the route verbatim as %s", async (bounds, expectedQuery) => {
    mockApiClient.get.mockResolvedValueOnce(PAGE);

    const { result } = renderHook(() => useBrowserSessions(bounds), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiClient.get).toHaveBeenCalledWith(
      `/settings/browser-sessions?${expectedQuery}`
    );
  });

  it("keys each page separately so a second page cannot answer for the first", () => {
    expect(browserSessionKeys.list(20, 0)).not.toEqual(
      browserSessionKeys.list(20, 20)
    );
  });
});

describe("useRevokeBrowserSession", () => {
  it("deletes the session by id and invalidates every cached page", async () => {
    mockApiClient.delete.mockResolvedValueOnce({ revoked: true });
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useRevokeBrowserSession(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() => {
      result.current.mutate("sess_2f/9");
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The id is one encoded path segment: the desktop bridge's DELETE
    // allowlist entry is anchored to exactly one, so an unencoded separator
    // would be refused before it left the renderer.
    expect(mockApiClient.delete).toHaveBeenCalledWith(
      "/settings/browser-sessions/sess_2f%2F9"
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: browserSessionKeys.all,
    });
  });

  it("re-reads the list when the session was already gone", async () => {
    // The panel's sentence for this code tells the user the list has been
    // refreshed. Without this the stale row — and its Sign out button, offering
    // to end something that has ended — stays on screen saying otherwise.
    mockApiClient.delete.mockRejectedValueOnce(
      new ApiError("gone", 404, BrowserSessionErrorCode.SessionNotFound)
    );
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useRevokeBrowserSession(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() => {
      result.current.mutate("sess-1");
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: browserSessionKeys.all,
    });
  });

  it.each([
    [
      "the caller's own current session",
      new ApiError(
        "current",
        409,
        BrowserSessionErrorCode.CurrentSessionNotRevocable
      ),
    ],
    [
      "an unreachable provider",
      new ApiError(
        "provider",
        503,
        BrowserSessionErrorCode.ProviderUnavailable
      ),
    ],
    ["an uncoded failure", new ApiError("boom", 500)],
  ])("leaves the list alone for %s", async (_label, error) => {
    // A 409 is about the row the user is holding and a 503 could not read the
    // provider at all, so re-reading would change nothing or fail the same way.
    mockApiClient.delete.mockRejectedValueOnce(error);
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useRevokeBrowserSession(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() => {
      result.current.mutate("sess-1");
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("carries the suppress-default-toast meta so a refusal is reported once", async () => {
    mockApiClient.delete.mockRejectedValueOnce(new Error("provider refused"));
    const queryClient = createTestQueryClient();

    const { result } = renderHook(() => useRevokeBrowserSession(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() => {
      result.current.mutate("sess-1");
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    const [mutation] = queryClient.getMutationCache().getAll();
    expect(mutation.options.meta).toEqual({ suppressDefaultErrorToast: true });
  });
});
