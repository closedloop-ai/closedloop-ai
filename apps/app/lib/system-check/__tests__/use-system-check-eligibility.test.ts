import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseComputeTargets = vi.fn();
const mockUseElectronDetection = vi.fn();
const mockUseEngineerRoutingSelection = vi.fn();

vi.mock("@/hooks/queries/use-compute-targets", () => ({
  useComputeTargets: (...args: unknown[]) => mockUseComputeTargets(...args),
}));

vi.mock("@/lib/engineer/electron-detection", () => ({
  useElectronDetection: (...args: unknown[]) =>
    mockUseElectronDetection(...args),
}));

vi.mock("@/lib/engineer/routing-store", () => ({
  useEngineerRoutingSelection: () => mockUseEngineerRoutingSelection(),
}));

vi.mock("@/lib/environment", () => ({
  appEnvironment: "local",
}));

import { useSystemCheckEligibility } from "../use-system-check-eligibility";

describe("useSystemCheckEligibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseComputeTargets.mockReturnValue({
      data: [],
      isLoading: false,
    });
    mockUseElectronDetection.mockReturnValue({
      detected: false,
      loading: false,
      port: null,
      version: null,
      machineName: null,
      capabilities: null,
      checkedAt: null,
    });
    mockUseEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: null,
      source: "manual",
      updatedAt: Date.now(),
    });
  });

  it("runs when the selected cloud relay target is online", () => {
    mockUseEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: "target-2",
      source: "manual",
      updatedAt: Date.now(),
    });
    mockUseComputeTargets.mockReturnValue({
      data: [
        {
          id: "target-1",
          machineName: "Laptop",
          isOnline: false,
        },
        {
          id: "target-2",
          machineName: "Desktop",
          isOnline: true,
        },
      ],
      isLoading: false,
    });

    const { result } = renderHook(() => useSystemCheckEligibility());

    expect(result.current.shouldRunSystemCheck).toBe(true);
    expect(result.current.selectedCloudTargetOnline).toBe(true);
    expect(mockUseElectronDetection).toHaveBeenCalledWith(false);
  });

  it("runs when LocalElectron is selected and detected", () => {
    mockUseEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.LocalElectron,
      computeTargetId: null,
      source: "manual",
      updatedAt: Date.now(),
    });
    mockUseElectronDetection.mockReturnValue({
      detected: true,
      loading: false,
      port: 19_432,
      version: "1.0.0",
      machineName: "desktop",
      capabilities: {},
      checkedAt: Date.now(),
    });

    const { result } = renderHook(() => useSystemCheckEligibility());

    expect(result.current.shouldRunSystemCheck).toBe(true);
    expect(result.current.selectedLocalElectronReady).toBe(true);
    expect(mockUseElectronDetection).toHaveBeenCalledWith(true);
  });

  it("runs when LocalDev is selected on localhost", () => {
    mockUseEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.LocalDev,
      computeTargetId: null,
      source: "manual",
      updatedAt: Date.now(),
    });

    const { result } = renderHook(() => useSystemCheckEligibility());

    expect(result.current.shouldRunSystemCheck).toBe(true);
    expect(result.current.selectedLocalDevReady).toBe(true);
    expect(mockUseElectronDetection).toHaveBeenCalledWith(false);
  });

  it("stays disabled when the selected cloud target is offline", () => {
    mockUseEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: "target-1",
      source: "manual",
      updatedAt: Date.now(),
    });
    mockUseComputeTargets.mockReturnValue({
      data: [
        {
          id: "target-1",
          machineName: "Desktop",
          isOnline: false,
        },
      ],
      isLoading: false,
    });

    const { result } = renderHook(() => useSystemCheckEligibility());

    expect(result.current.shouldRunSystemCheck).toBe(false);
  });
});
