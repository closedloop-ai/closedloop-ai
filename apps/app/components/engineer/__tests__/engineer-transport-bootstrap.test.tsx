import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks must be declared before imports ---

const mockUseElectronDetection = vi.fn();
const mockUseComputeTargets = vi.fn();
const mockUseComputeTargetStatusStream = vi.fn();
const mockGetEngineerRoutingSelection = vi.fn();
const mockSetEngineerRoutingAutoSelection = vi.fn();
const mockSetEngineerRoutingManualSelection = vi.fn();

// Mutable flag so individual describe blocks can flip CLOUD_RELAY_ENABLED.
// The component reads this value at effect run time via the mock factory closure.
let mockCloudRelayEnabled = false;

vi.mock("@/lib/engineer/electron-detection", () => ({
  useElectronDetection: (...args: unknown[]) =>
    mockUseElectronDetection(...args),
}));

vi.mock("@/hooks/queries/use-compute-targets", () => ({
  useComputeTargets: (...args: unknown[]) => mockUseComputeTargets(...args),
}));

vi.mock("@/hooks/queries/use-compute-target-status-stream", () => ({
  useComputeTargetStatusStream: () => mockUseComputeTargetStatusStream(),
}));

vi.mock("@/lib/engineer/routing-store", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/engineer/routing-store")>();
  return {
    ...actual,
    getEngineerRoutingSelection: (...args: unknown[]) =>
      mockGetEngineerRoutingSelection(...args),
    setEngineerRoutingAutoSelection: (...args: unknown[]) =>
      mockSetEngineerRoutingAutoSelection(...args),
    setEngineerRoutingManualSelection: (...args: unknown[]) =>
      mockSetEngineerRoutingManualSelection(...args),
  };
});

vi.mock("@/lib/engineer/engineer-fetch-interceptor", () => ({
  installEngineerFetchInterceptor: () => () => {},
}));

// Use a factory that closes over `mockCloudRelayEnabled` so tests can flip it.
vi.mock("@/lib/engineer/constants", () => ({
  get CLOUD_RELAY_ENABLED() {
    return mockCloudRelayEnabled;
  },
  COMPUTE_TARGETS_QUERY_OPTIONS: {
    staleTime: 30_000,
    refetchInterval: 30_000,
  },
}));

// Import after mocks are registered
import { resetEngineerRoutingSelectionForTests } from "@/lib/engineer/routing-store";
import { EngineerTransportBootstrap } from "../engineer-transport-bootstrap";

// --- Shared state factories ---

const detectedElectron = {
  detected: true,
  loading: false,
  port: 19_432,
  version: null,
  machineName: null,
  capabilities: null,
  checkedAt: Date.now(),
};

const noElectron = {
  detected: false,
  loading: false,
  port: null,
  version: null,
  machineName: null,
  capabilities: null,
  checkedAt: Date.now(),
};

const cloudRelayManualSelection = {
  mode: EngineerRoutingMode.CloudRelay,
  computeTargetId: null,
  source: "manual" as const,
  updatedAt: Date.now(),
};

const defaultAutoSelection = {
  mode: EngineerRoutingMode.CloudRelay,
  computeTargetId: null,
  source: "auto" as const,
  updatedAt: 0,
};

describe("EngineerTransportBootstrap (CLOUD_RELAY_ENABLED=false)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEngineerRoutingSelectionForTests();
    mockCloudRelayEnabled = false;

    mockUseElectronDetection.mockReturnValue(noElectron);
    mockUseComputeTargets.mockReturnValue({ data: [], isLoading: false });
    mockUseComputeTargetStatusStream.mockReturnValue(undefined);
    mockGetEngineerRoutingSelection.mockReturnValue(defaultAutoSelection);
    mockSetEngineerRoutingAutoSelection.mockReturnValue(defaultAutoSelection);
    mockSetEngineerRoutingManualSelection.mockReturnValue(defaultAutoSelection);
  });

  it("calls setEngineerRoutingAutoSelection(LocalElectron) when Electron is detected and current selection is CloudRelay manual", () => {
    // With CLOUD_RELAY_ENABLED=false and source=manual and mode=CloudRelay:
    // the guard `(CLOUD_RELAY_ENABLED || mode !== CloudRelay)` = `(false || false)` = false
    // so the manual guard does NOT fire, and Electron detection takes priority.
    mockUseElectronDetection.mockReturnValue(detectedElectron);
    mockGetEngineerRoutingSelection.mockReturnValue(cloudRelayManualSelection);

    act(() => {
      render(<EngineerTransportBootstrap />);
    });

    expect(mockSetEngineerRoutingAutoSelection).toHaveBeenCalledWith(
      EngineerRoutingMode.LocalElectron,
      null,
      { force: true }
    );
  });

  it("does NOT call setEngineerRoutingAutoSelection when Electron is NOT detected with default store state", () => {
    mockUseElectronDetection.mockReturnValue(noElectron);
    mockGetEngineerRoutingSelection.mockReturnValue(defaultAutoSelection);

    act(() => {
      render(<EngineerTransportBootstrap />);
    });

    expect(mockSetEngineerRoutingAutoSelection).not.toHaveBeenCalled();
  });

  it("does NOT call setEngineerRoutingAutoSelection when Electron is NOT detected with explicit manual CloudRelay selection", () => {
    mockUseElectronDetection.mockReturnValue(noElectron);
    mockGetEngineerRoutingSelection.mockReturnValue(cloudRelayManualSelection);

    act(() => {
      render(<EngineerTransportBootstrap />);
    });

    expect(mockSetEngineerRoutingAutoSelection).not.toHaveBeenCalled();
  });
});

describe("EngineerTransportBootstrap (CLOUD_RELAY_ENABLED=true)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEngineerRoutingSelectionForTests();
    mockCloudRelayEnabled = true;

    mockUseElectronDetection.mockReturnValue(noElectron);
    mockUseComputeTargets.mockReturnValue({ data: [], isLoading: false });
    mockUseComputeTargetStatusStream.mockReturnValue(undefined);
    mockGetEngineerRoutingSelection.mockReturnValue(defaultAutoSelection);
    mockSetEngineerRoutingAutoSelection.mockReturnValue(defaultAutoSelection);
    mockSetEngineerRoutingManualSelection.mockReturnValue(defaultAutoSelection);
  });

  it("does NOT call setEngineerRoutingAutoSelection when manual guard preserves CloudRelay manual selection", () => {
    // With CLOUD_RELAY_ENABLED=true and source=manual and mode=CloudRelay:
    // the guard `(CLOUD_RELAY_ENABLED || mode !== CloudRelay)` = `(true || false)` = true
    // so the manual guard fires and returns early — auto selection is NOT called.
    mockUseElectronDetection.mockReturnValue(detectedElectron);
    mockGetEngineerRoutingSelection.mockReturnValue(cloudRelayManualSelection);

    act(() => {
      render(<EngineerTransportBootstrap />);
    });

    expect(mockSetEngineerRoutingAutoSelection).not.toHaveBeenCalled();
  });
});
