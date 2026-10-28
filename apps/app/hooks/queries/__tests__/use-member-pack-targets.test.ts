import {
  COMPUTE_TARGETS_POLL_INTERVAL_MS,
  COMPUTE_TARGETS_QUERY_OPTIONS,
} from "@repo/app/compute/hooks/compute-target-query-options";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useMemberPackTargets } from "../use-member-pack-targets";

type ComputeTargetsOptions = {
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: (query: { state: { status: string } }) => number | false;
};

const { useComputeTargetsMock } = vi.hoisted(() => ({
  useComputeTargetsMock: vi.fn((_options: ComputeTargetsOptions) => ({
    data: undefined,
    error: null,
    isLoading: false,
  })),
}));

vi.mock("@/hooks/queries/use-compute-targets", () => ({
  useComputeTargets: useComputeTargetsMock,
}));
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: () => ({ data: undefined, error: null, isLoading: false }),
}));

// ISS-12784 T-1.8: the app-wide compute-target poll is gone, so the member
// targets block keeps its own 30s cadence or its online badges go stale.
describe("useMemberPackTargets", () => {
  it("reads compute targets with the shared poll options", () => {
    renderHook(() => useMemberPackTargets(false));

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
