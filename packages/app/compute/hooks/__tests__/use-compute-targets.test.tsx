import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { computeTargetKeys } from "../compute-target-query-keys";
import { useComputeTargetHealthCheckSnapshot } from "../use-compute-targets";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const CHECKED_AT = "2026-09-01T10:00:00.000Z";
const CREATED_AT = "2026-09-01T09:00:00.000Z";
const UPDATED_AT = "2026-09-01T11:00:00.000Z";

function wireSnapshot(extra: Record<string, unknown> = {}) {
  return {
    id: "snap-1",
    organizationId: "org-1",
    computeTargetId: TARGET_ID,
    checkedAt: CHECKED_AT,
    expectedMcpUrl: null,
    latestVersion: "1.2.3",
    result: { checks: [] },
    allRequiredPassed: true,
    requiredFailureIds: [],
    schemaVersion: 1,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...extra,
  };
}

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

describe("useComputeTargetHealthCheckSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("materializes the wire dates and defaults a missing auto-update flag to false", async () => {
    mockApiClient.get.mockResolvedValueOnce(wireSnapshot());
    const { wrapper } = setup();

    const { result } = renderHook(
      () => useComputeTargetHealthCheckSnapshot(TARGET_ID),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiClient.get).toHaveBeenCalledWith(
      `/compute-targets/${TARGET_ID}/health-check`
    );
    expect(result.current.data).toMatchObject({
      id: "snap-1",
      latestVersion: "1.2.3",
      pluginAutoUpdateEnabled: false,
      checkedAt: new Date(CHECKED_AT),
      createdAt: new Date(CREATED_AT),
      updatedAt: new Date(UPDATED_AT),
    });
    expect(result.current.data?.checkedAt).toBeInstanceOf(Date);
  });

  test("keeps a reported auto-update flag and keys the query by that mode", async () => {
    mockApiClient.get.mockResolvedValueOnce(
      wireSnapshot({ pluginAutoUpdateEnabled: true })
    );
    const { queryClient, wrapper } = setup();

    const { result } = renderHook(
      () => useComputeTargetHealthCheckSnapshot(TARGET_ID, true),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.pluginAutoUpdateEnabled).toBe(true);
    expect(
      queryClient.getQueryData(
        computeTargetKeys.healthCheckMode(TARGET_ID, true)
      )
    ).toBe(result.current.data);
    expect(
      queryClient.getQueryData(
        computeTargetKeys.healthCheckMode(TARGET_ID, false)
      )
    ).toBeUndefined();
  });

  test("returns null when the target has no stored snapshot", async () => {
    mockApiClient.get.mockResolvedValueOnce(null);
    const { wrapper } = setup();

    const { result } = renderHook(
      () => useComputeTargetHealthCheckSnapshot(TARGET_ID),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  test("does not fetch without a target", () => {
    const { wrapper } = setup();

    const { result } = renderHook(
      () => useComputeTargetHealthCheckSnapshot(null),
      { wrapper }
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  test("resolves null without a request when an override forces a target-less query on", async () => {
    const { queryClient, wrapper } = setup();

    const { result } = renderHook(
      () => useComputeTargetHealthCheckSnapshot(undefined, { enabled: true }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(mockApiClient.get).not.toHaveBeenCalled();
    // An options object in the second slot leaves the mode at no-auto-update,
    // and the missing target keys as "".
    expect(
      queryClient.getQueryState(computeTargetKeys.healthCheckMode("", false))
        ?.status
    ).toBe("success");
  });

  test("applies an options object passed in the second slot", () => {
    const { wrapper } = setup();

    const { result } = renderHook(
      () => useComputeTargetHealthCheckSnapshot(TARGET_ID, { enabled: false }),
      { wrapper }
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  test("applies the third-slot options when the second slot is the auto-update boolean", () => {
    const { queryClient, wrapper } = setup();

    const { result } = renderHook(
      () =>
        useComputeTargetHealthCheckSnapshot(TARGET_ID, true, {
          enabled: false,
        }),
      { wrapper }
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockApiClient.get).not.toHaveBeenCalled();
    expect(
      queryClient.getQueryState(
        computeTargetKeys.healthCheckMode(TARGET_ID, true)
      )
    ).toBeDefined();
  });
});
