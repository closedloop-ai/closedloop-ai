import type { SessionFrustrationSettingResponse } from "@repo/api/src/types/settings";
import { createTestQueryClient } from "@repo/app/shared/test-utils";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { insightsKeys } from "../../../insights/hooks/use-insights";
import { queryCacheScopeOf } from "../../../shared/query/query-cache-scope";
import {
  makeQueryClient,
  setQueryCacheScope,
} from "../../../shared/query/query-client";
import {
  frustrationSettingKeys,
  useSetFrustrationSetting,
} from "../use-frustration-setting";

const mockApiClient = {
  get: vi.fn(),
  put: vi.fn(),
};

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

function createWrapperWithClient(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const ORG_A = queryCacheScopeOf("user-1", "org-a");
const ORG_B = queryCacheScopeOf("user-1", "org-b");

describe("useSetFrustrationSetting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the setting cache AND invalidates insights so the frustration chart re-derives against the new gate (T0/T21)", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const setQueryDataSpy = vi.spyOn(queryClient, "setQueryData");
    mockApiClient.put.mockResolvedValue({ calculateSessionFrustration: true });

    const { result } = renderHook(() => useSetFrustrationSetting(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() => {
      result.current.mutate(true);
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.put).toHaveBeenCalledWith("/settings/frustration", {
      calculateSessionFrustration: true,
    });
    // The setting cache is primed with the server response.
    expect(setQueryDataSpy).toHaveBeenCalledWith(frustrationSettingKeys.all, {
      calculateSessionFrustration: true,
    });
    // And every insights section is invalidated — the Agents query caches with
    // staleTime: Infinity, so without this the chart would stay stale.
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: insightsKeys.all,
    });
  });

  it("drops the cache write when the tenant changed while the mutation was in flight (ISS-7442)", async () => {
    const queryClient = makeQueryClient();
    setQueryCacheScope(queryClient, ORG_A);
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const put = deferred<SessionFrustrationSettingResponse>();
    mockApiClient.put.mockReturnValue(put.promise);

    const { result } = renderHook(() => useSetFrustrationSetting(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() => {
      result.current.mutate(true);
    });
    await waitFor(() => expect(result.current.isPending).toBe(true));

    // The user switches organizations while org A's PUT is still in flight, and
    // only then does it resolve.
    setQueryCacheScope(queryClient, ORG_B);
    await act(async () => {
      put.resolve({ calculateSessionFrustration: true });
      await put.promise;
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Org B must not be able to read org A's response. Asserted through the
    // cache rather than a spy: the write is routed by the HASH, so only a read
    // under org B's identity proves it is unreachable there.
    expect(
      queryClient.getQueryData(frustrationSettingKeys.all)
    ).toBeUndefined();
    // Nor may org A's toggle invalidate org B's insights.
    expect(invalidateSpy).not.toHaveBeenCalled();

    // And it was dropped, not redirected into the departed identity's slot —
    // the shell clears the cache on the switch, so an entry surviving there
    // would outlive the clear that was supposed to remove it.
    setQueryCacheScope(queryClient, ORG_A);
    expect(
      queryClient.getQueryData(frustrationSettingKeys.all)
    ).toBeUndefined();
  });

  it("writes through the same in-flight window when the tenant is unchanged (ISS-7442)", async () => {
    // The counterweight: identical shape minus the switch, so the case above
    // cannot be satisfied by a guard that simply never writes.
    const queryClient = makeQueryClient();
    setQueryCacheScope(queryClient, ORG_A);
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const put = deferred<SessionFrustrationSettingResponse>();
    mockApiClient.put.mockReturnValue(put.promise);

    const { result } = renderHook(() => useSetFrustrationSetting(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() => {
      result.current.mutate(true);
    });
    await waitFor(() => expect(result.current.isPending).toBe(true));

    await act(async () => {
      put.resolve({ calculateSessionFrustration: true });
      await put.promise;
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryData(frustrationSettingKeys.all)).toEqual({
      calculateSessionFrustration: true,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: insightsKeys.all });
  });

  it("surfaces mutation failure via isError so the card can render an inline error (T4)", async () => {
    const queryClient = createTestQueryClient();
    mockApiClient.put.mockRejectedValue(new Error("network"));

    const { result } = renderHook(() => useSetFrustrationSetting(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() => {
      result.current.mutate(true);
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

/**
 * A promise the test resolves by hand, so a mutation can be held PENDING across
 * an organization switch. A fixed timer would only prove the callback ran late,
 * not that it ran after the switch.
 */
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    // Replaced synchronously by the Promise executor below.
  };
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
