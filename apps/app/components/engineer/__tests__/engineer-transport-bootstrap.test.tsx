import {
  type ComputeTarget,
  HarnessType,
} from "@repo/api/src/types/compute-target";
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
const mockUsePath = vi.fn();

// Mutable flag so individual describe blocks can flip CLOUD_RELAY_ENABLED.
// The component reads this value at effect run time via the mock factory closure.
let mockCloudRelayEnabled = false;

vi.mock("@repo/auth/client", () => ({
  useAuth: (...args: unknown[]) => mockUseAuth(...args),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => mockUsePath(),
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

/**
 * The signed-in user's CLERK id -- the only id a browser ever holds, and what
 * `useAuth().userId` returns. Deliberately NOT the shape of
 * `ComputeTarget.userId`, which is the internal `User.id` UUID: keeping the two
 * visibly distinct is what stops these tests passing on a comparison that can
 * never be true in production (see `VIEWER_INTERNAL_USER_ID`).
 */
const VIEWER_CLERK_USER_ID = "user_2abcCLERK";
/**
 * The same person's INTERNAL id, as the API stamps onto `ComputeTarget.userId`.
 * A target the viewer owns carries this, never `VIEWER_CLERK_USER_ID` -- so a
 * `target.userId === useAuth().userId` check is false even for the owner, which
 * is exactly the bug these fixtures now make visible.
 */
const VIEWER_INTERNAL_USER_ID = "3f7c1b8e-0000-4000-8000-000000000001";
const TEAMMATE_INTERNAL_USER_ID = "3f7c1b8e-0000-4000-8000-000000000002";

/**
 * A compute target the VIEWER owns. Ownership is carried by the absence of
 * `ownerName` -- the viewer-relative signal the API populates only for targets
 * somebody else owns -- not by an id comparison the browser cannot make.
 */
function makeTarget(overrides: Partial<ComputeTarget> = {}): ComputeTarget {
  return {
    id: "target-owned",
    organizationId: "org-1",
    userId: VIEWER_INTERNAL_USER_ID,
    machineName: "my-machine",
    platform: "darwin",
    capabilities: {},
    supportedOperations: [],
    lastSeenAt: new Date("2026-04-15T00:00:00.000Z"),
    isOnline: true,
    isSharedWithOrg: false,
    selectedHarness: HarnessType.Claude,
    createdAt: new Date("2026-04-15T00:00:00.000Z"),
    updatedAt: new Date("2026-04-15T00:00:00.000Z"),
    ...overrides,
  };
}

/**
 * A teammate's org-shared compute target, exactly as `GET /compute-targets`
 * returns one: a different internal owner id AND the `ownerName` the API
 * populates for every target the viewer does not own.
 */
function makeTeammateTarget(
  overrides: Partial<ComputeTarget> = {}
): ComputeTarget {
  return makeTarget({
    id: "target-teammate",
    userId: TEAMMATE_INTERNAL_USER_ID,
    isSharedWithOrg: true,
    ownerName: "Teammate",
    ...overrides,
  });
}

describe("EngineerTransportBootstrap (CLOUD_RELAY_ENABLED=false)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEngineerRoutingSelectionForTests();
    mockCloudRelayEnabled = false;

    mockUseAuth.mockReturnValue({
      getToken: vi.fn().mockResolvedValue("clerk-token"),
      userId: VIEWER_CLERK_USER_ID,
    });
    mockUseApiClient.mockReturnValue({ put: mockApiPut });
    mockUseElectronDetection.mockReturnValue(noElectron);
    mockUseComputeTargets.mockReturnValue({ data: [], isLoading: false });
    mockUseComputeTargetStatusStream.mockReturnValue(undefined);
    mockUsePath.mockReturnValue("/closedloop-ai/build/123");
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

  it("does not probe the local desktop gateway on insights routes", () => {
    mockUsePath.mockReturnValue("/closedloop-ai/insights");
    mockUseElectronDetection.mockReturnValue(detectedElectron);

    render(<EngineerTransportBootstrap />);

    expect(mockUseElectronDetection).toHaveBeenCalledWith(false, {
      ambient: true,
      desktopKnown: false,
    });
    expect(mockSetEngineerRoutingAutoSelection).not.toHaveBeenCalled();
    expect(mockEnsureLocalGatewaySession).not.toHaveBeenCalled();
  });

  // ISS-6084: this is the ONE ambient detection loop, so it is the one that
  // must carry `ambient` -- without it the store cannot tell a background
  // bootstrap apart from a user asking for the desktop app, and every visitor
  // pays a four-port loopback sweep per page load.
  it("marks the layout-wide detection loop ambient and reports no desktop by default", () => {
    mockUseElectronDetection.mockReturnValue(noElectron);
    mockGetEngineerRoutingSelection.mockReturnValue(defaultAutoSelection);

    act(() => {
      render(<EngineerTransportBootstrap />);
    });

    expect(mockUseElectronDetection).toHaveBeenCalledWith(true, {
      ambient: true,
      desktopKnown: false,
    });
  });

  // The other half of ISS-6084: the gate must OPEN for someone who really has a
  // desktop app, or LocalElectron never bootstraps on a fresh browser profile.
  //
  // The owned fixture's `userId` is the internal `User.id` UUID and the mocked
  // `useAuth().userId` is a Clerk id, so this case FAILS against any
  // `target.userId === userId` implementation -- which is the point. Before the
  // identity fix the two fixtures were both spelled "user-1", collapsing the
  // domains and letting a comparison that is false for every real user still
  // pass this assertion.
  it("reports desktopKnown once the user owns a registered compute target", () => {
    const ownedTarget = makeTarget();
    // Guard the guard: if these ever converge, this test silently goes vacuous.
    expect(ownedTarget.userId).not.toBe(VIEWER_CLERK_USER_ID);
    mockUseElectronDetection.mockReturnValue(noElectron);
    mockUseComputeTargets.mockReturnValue({
      data: [ownedTarget],
      isLoading: false,
    });

    act(() => {
      render(<EngineerTransportBootstrap />);
    });

    expect(mockUseElectronDetection).toHaveBeenCalledWith(true, {
      ambient: true,
      desktopKnown: true,
    });
  });

  it("does not report desktopKnown for a teammate's shared compute target", () => {
    mockUseElectronDetection.mockReturnValue(noElectron);
    mockUseComputeTargets.mockReturnValue({
      data: [makeTeammateTarget()],
      isLoading: false,
    });

    act(() => {
      render(<EngineerTransportBootstrap />);
    });

    // An org-shared target belonging to someone else is not evidence that THIS
    // user has a desktop app on THIS machine, so it must not open the gate.
    expect(mockUseElectronDetection).toHaveBeenCalledWith(true, {
      ambient: true,
      desktopKnown: false,
    });
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
      data: [makeTeammateTarget({ id: "target-shared" }), makeTarget()],
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
        // withDesktopApiNamespaceCapability now deletes the legacy key, leaving an
        // empty capabilities object for the current /api/gateway/ namespace.
        capabilities: {},
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
      data: [makeTeammateTarget({ id: "target-shared" })],
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
      userId: VIEWER_CLERK_USER_ID,
    });
    mockUseApiClient.mockReturnValue({ put: mockApiPut });
    mockUseElectronDetection.mockReturnValue(noElectron);
    mockUseComputeTargets.mockReturnValue({ data: [], isLoading: false });
    mockUseComputeTargetStatusStream.mockReturnValue(undefined);
    mockUsePath.mockReturnValue("/closedloop-ai/build/123");
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
