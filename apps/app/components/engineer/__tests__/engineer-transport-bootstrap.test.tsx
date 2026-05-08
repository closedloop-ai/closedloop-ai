import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks must be declared before imports ---

const mockUseAuth = vi.fn();
const mockUseApiClient = vi.fn();
const mockUseElectronDetection = vi.fn();
const mockUseComputeTargets = vi.fn();
const mockUseComputeTargetStatusStream = vi.fn();
const mockGetEngineerRoutingSelection = vi.fn();
const mockSetEngineerRoutingAutoSelection = vi.fn();
const mockSetEngineerRoutingManualSelection = vi.fn();
const mockEnsureLocalGatewaySession = vi.fn();
const mockSetLocalGatewayAuthTokenProvider = vi.fn();
const mockEnsureLocalGatewayApiNamespace = vi.fn();
const mockApiPut = vi.fn();

// Mutable flag so individual describe blocks can flip CLOUD_RELAY_ENABLED.
// The component reads this value at effect run time via the mock factory closure.
let mockCloudRelayEnabled = false;

vi.mock("@repo/auth/client", () => ({
  useAuth: (...args: unknown[]) => mockUseAuth(...args),
}));

vi.mock("@/lib/engineer/electron-detection", () => ({
  useElectronDetection: (...args: unknown[]) =>
    mockUseElectronDetection(...args),
}));

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: (...args: unknown[]) => mockUseApiClient(...args),
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

vi.mock("@/lib/engineer/local-gateway-session", () => ({
  ensureLocalGatewaySession: (...args: unknown[]) =>
    mockEnsureLocalGatewaySession(...args),
  setLocalGatewayAuthTokenProvider: (...args: unknown[]) =>
    mockSetLocalGatewayAuthTokenProvider(...args),
}));

vi.mock("@/lib/engineer/local-gateway-api-namespace", () => ({
  ensureLocalGatewayApiNamespace: (...args: unknown[]) =>
    mockEnsureLocalGatewayApiNamespace(...args),
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

function makeTarget(overrides: Partial<ComputeTarget> = {}): ComputeTarget {
  return {
    id: "target-owned",
    organizationId: "org-1",
    userId: "user-1",
    machineName: "my-machine",
    platform: "darwin",
    capabilities: {},
    supportedOperations: [],
    lastSeenAt: new Date("2026-04-15T00:00:00.000Z"),
    isOnline: true,
    isSharedWithOrg: false,
    createdAt: new Date("2026-04-15T00:00:00.000Z"),
    updatedAt: new Date("2026-04-15T00:00:00.000Z"),
    ...overrides,
  };
}

describe("EngineerTransportBootstrap (CLOUD_RELAY_ENABLED=false)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEngineerRoutingSelectionForTests();
    mockCloudRelayEnabled = false;

    mockUseAuth.mockReturnValue({
      getToken: vi.fn().mockResolvedValue("clerk-token"),
      userId: "user-1",
    });
    mockUseApiClient.mockReturnValue({ put: mockApiPut });
    mockUseElectronDetection.mockReturnValue(noElectron);
    mockUseComputeTargets.mockReturnValue({ data: [], isLoading: false });
    mockUseComputeTargetStatusStream.mockReturnValue(undefined);
    mockGetEngineerRoutingSelection.mockReturnValue(defaultAutoSelection);
    mockSetEngineerRoutingAutoSelection.mockReturnValue(defaultAutoSelection);
    mockSetEngineerRoutingManualSelection.mockReturnValue(defaultAutoSelection);
    mockEnsureLocalGatewaySession.mockResolvedValue("desktop-session-token");
    mockEnsureLocalGatewayApiNamespace.mockResolvedValue("engineer");
    mockApiPut.mockResolvedValue(undefined);
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

  it("syncs the compat capability to the owned local target", async () => {
    mockUseElectronDetection.mockReturnValue({
      ...detectedElectron,
      machineName: "my-machine",
    });
    mockUseComputeTargets.mockReturnValue({
      data: [
        makeTarget({
          id: "target-shared",
          userId: "teammate-1",
          isSharedWithOrg: true,
          ownerName: "Teammate",
        }),
        makeTarget(),
      ],
      isLoading: false,
    });

    render(<EngineerTransportBootstrap />);

    await waitFor(() =>
      expect(mockSetEngineerRoutingAutoSelection).toHaveBeenCalledWith(
        EngineerRoutingMode.LocalElectron,
        "target-owned",
        { force: true }
      )
    );
    await waitFor(() =>
      expect(mockApiPut).toHaveBeenCalledWith("/compute-targets/target-owned", {
        capabilities: { desktopApiNamespace: "engineer" },
      })
    );
  });

  it("does not sync compat metadata when the probe result is unknown", async () => {
    mockUseElectronDetection.mockReturnValue({
      ...detectedElectron,
      machineName: "my-machine",
    });
    mockUseComputeTargets.mockReturnValue({
      data: [makeTarget()],
      isLoading: false,
    });
    mockEnsureLocalGatewayApiNamespace.mockResolvedValue(undefined);

    render(<EngineerTransportBootstrap />);

    await waitFor(() =>
      expect(mockEnsureLocalGatewayApiNamespace).toHaveBeenCalled()
    );
    expect(mockApiPut).not.toHaveBeenCalled();
  });

  it("does not write compat metadata to a shared target with the same machine name", async () => {
    mockUseElectronDetection.mockReturnValue({
      ...detectedElectron,
      machineName: "my-machine",
    });
    mockUseComputeTargets.mockReturnValue({
      data: [
        makeTarget({
          id: "target-shared",
          userId: "teammate-1",
          isSharedWithOrg: true,
          ownerName: "Teammate",
        }),
      ],
      isLoading: false,
    });

    render(<EngineerTransportBootstrap />);

    await waitFor(() =>
      expect(mockSetEngineerRoutingAutoSelection).toHaveBeenCalledWith(
        EngineerRoutingMode.LocalElectron,
        null,
        { force: true }
      )
    );
    expect(mockEnsureLocalGatewaySession).not.toHaveBeenCalled();
    expect(mockApiPut).not.toHaveBeenCalled();
  });
});

describe("EngineerTransportBootstrap (CLOUD_RELAY_ENABLED=true)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEngineerRoutingSelectionForTests();
    mockCloudRelayEnabled = true;

    mockUseAuth.mockReturnValue({
      getToken: vi.fn().mockResolvedValue("clerk-token"),
      userId: "user-1",
    });
    mockUseApiClient.mockReturnValue({ put: mockApiPut });
    mockUseElectronDetection.mockReturnValue(noElectron);
    mockUseComputeTargets.mockReturnValue({ data: [], isLoading: false });
    mockUseComputeTargetStatusStream.mockReturnValue(undefined);
    mockGetEngineerRoutingSelection.mockReturnValue(defaultAutoSelection);
    mockSetEngineerRoutingAutoSelection.mockReturnValue(defaultAutoSelection);
    mockSetEngineerRoutingManualSelection.mockReturnValue(defaultAutoSelection);
    mockEnsureLocalGatewaySession.mockResolvedValue("desktop-session-token");
    mockEnsureLocalGatewayApiNamespace.mockResolvedValue("engineer");
    mockApiPut.mockResolvedValue(undefined);
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
