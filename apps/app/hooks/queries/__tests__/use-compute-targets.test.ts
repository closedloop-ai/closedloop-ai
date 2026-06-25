import {
  COMMAND_SIGNING_CAPABILITY_KEY,
  type ComputeTarget,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheComputeTargetsForSigning,
  getCachedComputeTargetForSigning,
  isCachedComputeTargetSigningEffective,
} from "@/lib/desktop-command-signing/compute-target-signing-cache";
import { useComputeTargets } from "../use-compute-targets";
import { createWrapper } from "./test-utils";

const mockApiClient = {
  get: vi.fn(),
};

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

type ComputeTargetWire = Omit<
  ComputeTarget,
  "lastSeenAt" | "createdAt" | "updatedAt"
> & {
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

function makeWireTarget(
  id: string,
  overrides: Partial<ComputeTargetWire> = {}
): ComputeTargetWire {
  return {
    id,
    organizationId: "org-1",
    userId: "user-1",
    machineName: `target-${id}`,
    platform: "darwin",
    capabilities: { [COMMAND_SIGNING_CAPABILITY_KEY]: true },
    supportedOperations: [],
    lastSeenAt: "2026-05-10T12:00:00.000Z",
    isOnline: true,
    isSharedWithOrg: false,
    serverCapabilities: { computeTargetSigning: true },
    selectedHarness: HarnessType.Claude,
    createdAt: "2026-05-10T12:00:00.000Z",
    updatedAt: "2026-05-10T12:00:00.000Z",
    ...overrides,
  };
}

describe("useComputeTargets signing cache refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheComputeTargetsForSigning([]);
  });

  it("writes parsed compute-target snapshots into the signing cache", async () => {
    mockApiClient.get.mockResolvedValueOnce([makeWireTarget("target-1")]);

    const { result } = renderHook(() => useComputeTargets(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).toHaveBeenCalledWith("/compute-targets");
    const cached = getCachedComputeTargetForSigning("target-1");
    expect(cached?.lastSeenAt).toEqual(new Date("2026-05-10T12:00:00.000Z"));
    expect(isCachedComputeTargetSigningEffective("target-1")).toBe(true);
  });

  it("replaces stale cached targets after a successful refetch", async () => {
    mockApiClient.get
      .mockResolvedValueOnce([makeWireTarget("target-1")])
      .mockResolvedValueOnce([
        makeWireTarget("target-2", { serverCapabilities: {} }),
      ]);

    const { result } = renderHook(() => useComputeTargets(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await result.current.refetch();

    expect(getCachedComputeTargetForSigning("target-1")).toBeNull();
    expect(getCachedComputeTargetForSigning("target-2")?.id).toBe("target-2");
    expect(isCachedComputeTargetSigningEffective("target-2")).toBe(false);
  });
});
