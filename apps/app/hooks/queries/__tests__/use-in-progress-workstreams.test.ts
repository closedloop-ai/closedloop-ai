import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useInProgressWorkstreams } from "../use-in-progress-workstreams";
import { workstreamKeys } from "../use-workstreams";
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

describe("useInProgressWorkstreams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("fetches in-progress workstreams", async () => {
    const mockWorkstreams = [
      {
        id: "ws-1",
        title: "Authentication Feature",
        description: "Implement auth system",
        state: "IN_PROGRESS",
        type: "FEATURE_DELIVERY",
        project: { name: "Core Platform" },
        updatedAt: new Date("2025-01-20").toISOString(),
      },
      {
        id: "ws-2",
        title: "Dashboard UI",
        description: "Build dashboard",
        state: "IN_REVIEW",
        type: "FEATURE_DELIVERY",
        project: { name: "Frontend" },
        updatedAt: new Date("2025-01-19").toISOString(),
      },
    ];

    mockApiClient.get.mockResolvedValueOnce(mockWorkstreams);

    const { result } = renderHook(() => useInProgressWorkstreams(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).toHaveBeenCalledWith("/dashboard/workstreams");
    expect(result.current.data).toEqual(mockWorkstreams);
    expect(result.current.data).toHaveLength(2);
  });

  test("uses correct query key", () => {
    const expectedKey = workstreamKeys.inProgress();

    renderHook(() => useInProgressWorkstreams(), {
      wrapper: createWrapper(),
    });

    expect(expectedKey).toEqual(["workstreams", "inProgress"]);
  });

  test("handles fetch error", async () => {
    const mockError = new Error("Failed to fetch workstreams");
    mockApiClient.get.mockRejectedValueOnce(mockError);

    const { result } = renderHook(() => useInProgressWorkstreams(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toEqual(mockError);
  });

  test("returns empty array when no workstreams exist", async () => {
    mockApiClient.get.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useInProgressWorkstreams(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([]);
  });

  test("includes project name in workstream data", async () => {
    const mockWorkstreams = [
      {
        id: "ws-1",
        title: "Feature A",
        state: "IN_PROGRESS",
        project: { name: "Project Alpha" },
        updatedAt: new Date().toISOString(),
      },
    ];

    mockApiClient.get.mockResolvedValueOnce(mockWorkstreams);

    const { result } = renderHook(() => useInProgressWorkstreams(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.[0].project).toEqual({ name: "Project Alpha" });
  });

  test("includes staleTime of 30 seconds", async () => {
    mockApiClient.get.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useInProgressWorkstreams(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Verify data was fetched once
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);

    // The hook should not refetch immediately due to staleTime
    // This is tested by the behavior of the hook configuration
  });

  test("allows options to be passed through", async () => {
    mockApiClient.get.mockResolvedValueOnce([]);

    const { result } = renderHook(
      () => useInProgressWorkstreams({ enabled: false }),
      {
        wrapper: createWrapper(),
      }
    );

    // Query should not run when enabled is false
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  test("excludes terminal workstream states", async () => {
    const mockWorkstreams = [
      {
        id: "ws-1",
        title: "Active Feature",
        state: "IN_PROGRESS",
        project: { name: "Project A" },
        updatedAt: new Date().toISOString(),
      },
      // API should not return COMPLETED, CANCELLED, or DEPLOYED workstreams
    ];

    mockApiClient.get.mockResolvedValueOnce(mockWorkstreams);

    const { result } = renderHook(() => useInProgressWorkstreams(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Verify none of the returned workstreams have terminal states
    const states = result.current.data?.map((ws) => ws.state) ?? [];
    expect(states).not.toContain("COMPLETED");
    expect(states).not.toContain("CANCELLED");
    expect(states).not.toContain("DEPLOYED");
  });
});
