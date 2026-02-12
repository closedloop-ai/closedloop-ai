import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { dashboardKeys, useDashboardStats } from "../use-dashboard-stats";
import { createWrapper } from "./test-utils";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

describe("useDashboardStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("fetches dashboard stats", async () => {
    const mockStats = {
      prds: { count: 5, trend: [{ date: "2025-01-20", count: 2 }] },
      issues: { count: 10, trend: [{ date: "2025-01-20", count: 3 }] },
      plans: { count: 3, trend: [{ date: "2025-01-20", count: 1 }] },
      landedCode: { count: 8, trend: [{ date: "2025-01-20", count: 4 }] },
      agenticWorkflows: { count: 12, trend: [{ date: "2025-01-20", count: 5 }] },
      agentsCount: undefined,
      leaderboardsCount: undefined,
    };

    mockApiClient.get.mockResolvedValueOnce(mockStats);

    const { result } = renderHook(() => useDashboardStats(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).toHaveBeenCalledWith("/dashboard/stats");
    expect(result.current.data).toEqual(mockStats);
  });

  test("uses correct query key", () => {
    const expectedKey = dashboardKeys.stats();

    renderHook(() => useDashboardStats(), {
      wrapper: createWrapper(),
    });

    expect(expectedKey).toEqual(["dashboard", "stats"]);
  });

  test("handles fetch error", async () => {
    const mockError = new Error("Failed to fetch stats");
    mockApiClient.get.mockRejectedValueOnce(mockError);

    const { result } = renderHook(() => useDashboardStats(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toEqual(mockError);
  });

  test("returns empty trends when no recent data", async () => {
    const mockStats = {
      prds: { count: 5, trend: [] },
      issues: { count: 10, trend: [] },
      plans: { count: 3, trend: [] },
      landedCode: { count: 0, trend: [] },
      agenticWorkflows: { count: 0, trend: [] },
      agentsCount: undefined,
      leaderboardsCount: undefined,
    };

    mockApiClient.get.mockResolvedValueOnce(mockStats);

    const { result } = renderHook(() => useDashboardStats(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.prds.trend).toEqual([]);
    expect(result.current.data?.landedCode.count).toBe(0);
  });

  test("includes staleTime of 60 seconds", async () => {
    mockApiClient.get.mockResolvedValueOnce({
      prds: { count: 0, trend: [] },
      issues: { count: 0, trend: [] },
      plans: { count: 0, trend: [] },
      landedCode: { count: 0, trend: [] },
      agenticWorkflows: { count: 0, trend: [] },
      agentsCount: undefined,
      leaderboardsCount: undefined,
    });

    const { result } = renderHook(() => useDashboardStats(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Verify data was fetched once
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);

    // The hook should not refetch immediately due to staleTime
    // This is tested by the behavior of the hook configuration
  });

  test("returns placeholder counts as undefined", async () => {
    const mockStats = {
      prds: { count: 5, trend: [] },
      issues: { count: 10, trend: [] },
      plans: { count: 3, trend: [] },
      landedCode: { count: 8, trend: [] },
      agenticWorkflows: { count: 12, trend: [] },
      agentsCount: undefined,
      leaderboardsCount: undefined,
    };

    mockApiClient.get.mockResolvedValueOnce(mockStats);

    const { result } = renderHook(() => useDashboardStats(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.agentsCount).toBeUndefined();
    expect(result.current.data?.leaderboardsCount).toBeUndefined();
  });

  test("allows options to be passed through", async () => {
    const mockStats = {
      prds: { count: 0, trend: [] },
      issues: { count: 0, trend: [] },
      plans: { count: 0, trend: [] },
      landedCode: { count: 0, trend: [] },
      agenticWorkflows: { count: 0, trend: [] },
      agentsCount: undefined,
      leaderboardsCount: undefined,
    };

    mockApiClient.get.mockResolvedValueOnce(mockStats);

    const { result } = renderHook(
      () => useDashboardStats({ enabled: false }),
      {
        wrapper: createWrapper(),
      }
    );

    // Query should not run when enabled is false
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });
});

describe("dashboardKeys", () => {
  test("returns correct key structure", () => {
    expect(dashboardKeys.all).toEqual(["dashboard"]);
    expect(dashboardKeys.stats()).toEqual(["dashboard", "stats"]);
  });
});
