import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  COMPUTE_TARGETS_POLL_INTERVAL_MS,
  COMPUTE_TARGETS_QUERY_OPTIONS,
} from "../../../compute/hooks/compute-target-query-options";
import { useDesktopAppRunning } from "../use-desktop-presence";

type ComputeTargetsOptions = {
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: (query: { state: { status: string } }) => number | false;
};

const useComputeTargetsMock = vi.hoisted(() =>
  vi.fn((_options: ComputeTargetsOptions) => ({ data: undefined }))
);

vi.mock("../../../compute/hooks/use-compute-targets", () => ({
  useComputeTargets: useComputeTargetsMock,
}));

// ISS-12784 T-1.8: the app-wide compute-target poll is gone, so this reader
// keeps its own 30s cadence or its online hint goes stale.
describe("useDesktopAppRunning", () => {
  it("reads compute targets with the shared poll options", () => {
    renderHook(() => useDesktopAppRunning(true));

    const options = useComputeTargetsMock.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      enabled: true,
      staleTime: COMPUTE_TARGETS_QUERY_OPTIONS.staleTime,
      refetchInterval: COMPUTE_TARGETS_QUERY_OPTIONS.refetchInterval,
    });
    expect(options?.refetchInterval?.({ state: { status: "success" } })).toBe(
      COMPUTE_TARGETS_POLL_INTERVAL_MS
    );
  });
});
