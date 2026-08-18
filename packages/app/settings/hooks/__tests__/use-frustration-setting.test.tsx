import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { insightsKeys } from "../../../insights/hooks/use-insights";
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

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function createWrapperWithClient(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

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
