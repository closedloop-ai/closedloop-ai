import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { queryKeys } from "@/lib/engineer/queries/keys";
import { useChatRunnerToken } from "../use-chat-runner-token";

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function makeWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function makeMintResponse(
  expiresAt: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      token: "test-jwt-token",
      apiBaseUrl: "http://localhost:3002",
      expiresAt,
      ...overrides,
    }),
  };
}

describe("useChatRunnerToken", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("fetches and caches the token on first render", async () => {
    const farFuture = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    mockFetch.mockResolvedValueOnce(makeMintResponse(farFuture));

    const queryClient = makeClient();
    const { result } = renderHook(() => useChatRunnerToken("chat-1"), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/chat/runner-token");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ chatKey: "chat-1" }));
    expect(result.current.token).toBe("test-jwt-token");
    expect(result.current.apiBaseUrl).toBe("http://localhost:3002");
  });

  test("does not refetch within the stale window", async () => {
    const farFuture = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    mockFetch.mockResolvedValueOnce(makeMintResponse(farFuture));

    const queryClient = makeClient();
    const wrapper = makeWrapper(queryClient);

    const { result, rerender } = renderHook(
      () => useChatRunnerToken("chat-1"),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    rerender();
    // No second fetch — the cached value is within stale time.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("ensureFresh returns cached value when >10m remain", async () => {
    const twentyMinAway = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    mockFetch.mockResolvedValueOnce(makeMintResponse(twentyMinAway));

    const queryClient = makeClient();
    const { result } = renderHook(() => useChatRunnerToken("chat-1"), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    let credentials: { token: string; apiBaseUrl: string } | null = null;
    await act(async () => {
      credentials = await result.current.ensureFresh();
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(credentials).toEqual({
      token: "test-jwt-token",
      apiBaseUrl: "http://localhost:3002",
    });
  });

  test("ensureFresh refetches when cached token has <10m remaining", async () => {
    const nearExpiry = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const refreshed = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    mockFetch
      .mockResolvedValueOnce(makeMintResponse(nearExpiry))
      .mockResolvedValueOnce(
        makeMintResponse(refreshed, { token: "refreshed-jwt-token" })
      );

    const queryClient = makeClient();
    const { result } = renderHook(() => useChatRunnerToken("chat-1"), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    let credentials: { token: string; apiBaseUrl: string } | null = null;
    await act(async () => {
      credentials = await result.current.ensureFresh();
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(credentials).toEqual({
      token: "refreshed-jwt-token",
      apiBaseUrl: "http://localhost:3002",
    });
  });

  test("ensureFresh fetches when no cached value exists", async () => {
    const farFuture = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    mockFetch.mockResolvedValueOnce(makeMintResponse(farFuture));

    const queryClient = makeClient();
    // Seed a consumer hook with chatKey="" so the query is disabled
    // and there is no cached value.
    const { result } = renderHook(() => useChatRunnerToken(""), {
      wrapper: makeWrapper(queryClient),
    });

    // Disabled query: nothing fetched yet.
    expect(mockFetch).not.toHaveBeenCalled();
    // With an empty chatKey, ensureFresh returns null without calling fetch.
    let emptyResult: unknown = "sentinel";
    await act(async () => {
      emptyResult = await result.current.ensureFresh();
    });
    expect(emptyResult).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();

    // Now verify the refetch path for a real key with no cache entry.
    const queryClient2 = makeClient();
    const { result: result2 } = renderHook(() => useChatRunnerToken("chat-2"), {
      wrapper: makeWrapper(queryClient2),
    });
    // Wait for the initial fetch triggered by useQuery, then clear the cache
    // entry to simulate "no cached value when ensureFresh runs".
    await waitFor(() => expect(result2.current.isSuccess).toBe(true));
    queryClient2.removeQueries({
      queryKey: queryKeys.chatRunnerToken("chat-2"),
    });

    const second = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    mockFetch.mockResolvedValueOnce(
      makeMintResponse(second, { token: "fresh-after-clear" })
    );

    let credentials: { token: string; apiBaseUrl: string } | null = null;
    await act(async () => {
      credentials = await result2.current.ensureFresh();
    });

    expect(credentials).toEqual({
      token: "fresh-after-clear",
      apiBaseUrl: "http://localhost:3002",
    });
  });

  test("surfaces mint failures as an error state without retry loop", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValueOnce("internal error"),
    });

    const queryClient = makeClient();
    const { result } = renderHook(() => useChatRunnerToken("chat-1"), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // ensureFresh should return null (no throw) on a failed refetch.
    let credentials: unknown = "sentinel";
    await act(async () => {
      credentials = await result.current.ensureFresh();
    });
    expect(credentials).toBeNull();
  });
});
