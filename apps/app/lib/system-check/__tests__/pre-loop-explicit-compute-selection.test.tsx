import {
  ComputePreference,
  ComputePreferenceRequiredMessage,
  EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY,
} from "@repo/api/src/types/compute-target";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { healthCheckOptions } from "@/lib/engineer/queries/health-check";
import { getPreLoopTargetKey } from "../pre-loop-health-check";
import {
  applyDefaultProviderMocks,
  computeState,
  createFeatureFlagMocker,
  createQueryClient,
  healthyResult,
  renderGate,
} from "./fixtures/pre-loop-provider-harness";

const mockCapture = vi.hoisted(() => vi.fn());
const mockError = vi.hoisted(() => vi.fn());
const mockUseFeatureFlag = vi.hoisted(() => vi.fn());
const mockUseComputePreference = vi.hoisted(() => vi.fn());
const mockUseComputeTargets = vi.hoisted(() => vi.fn());
const mockUseLatestElectronRelease = vi.hoisted(() => vi.fn());
const mockApiGet = vi.hoisted(() => vi.fn());
const mockUseUser = vi.hoisted(() => vi.fn());
const EXPECTED_MCP_URL = vi.hoisted(() => "https://mcp.closedloop.ai/mcp");

vi.mock("@repo/analytics/client", () => ({
  useAnalytics: () => ({
    capture: mockCapture,
    identify: vi.fn(),
    reset: vi.fn(),
  }),
  useFeatureFlag: (key: string) => mockUseFeatureFlag(key),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) =>
    mockUseFeatureFlag(key)?.enabled === true,
}));

vi.mock("@repo/auth/client", () => ({
  useUser: () => mockUseUser(),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: mockError, warning: vi.fn(), info: vi.fn() },
}));

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_MCP_SERVER_URL: EXPECTED_MCP_URL,
    NEXT_PUBLIC_POSTHOG_KEY: "test-posthog-key",
  },
}));

vi.mock("@repo/app/compute/hooks/use-compute-preference", () => ({
  useComputePreference: (...args: unknown[]) =>
    mockUseComputePreference(...args),
}));

vi.mock("@/hooks/queries/use-compute-targets", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/queries/use-compute-targets")
    >();
  return {
    ...actual,
    useComputeTargets: (...args: unknown[]) => mockUseComputeTargets(...args),
  };
});

vi.mock("@repo/app/desktop/hooks/use-electron-release", () => ({
  useLatestElectronRelease: (...args: unknown[]) =>
    mockUseLatestElectronRelease(...args),
}));

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: () => ({ get: mockApiGet }),
}));

// The Cloud pre-flight resolves a Settings deep-link (ISS-5172) through these
// two hooks on every provider render, so both need stubbing here.
vi.mock("@/hooks/use-org-slug", () => ({ useOrgSlug: () => "org-test" }));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

vi.mock("@/components/engineer/HealthCheckDialog", () => ({
  HealthCheckDialog: () => <div data-testid="blocking-dialog" />,
}));

const mockEnabledFeatureFlags = createFeatureFlagMocker(mockUseFeatureFlag);

/**
 * The explicit Local/Cloud selection gate, split out of
 * `pre-loop-system-check-provider.test.tsx` so that suite stops carrying a
 * second responsibility (and stays under its line ceiling).
 */
describe("PreLoopSystemCheckProvider — explicit compute selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyDefaultProviderMocks({
      mockUseUser,
      mockUseFeatureFlag,
      mockUseComputePreference,
      mockUseComputeTargets,
      mockUseLatestElectronRelease,
      mockApiGet,
    });
    mockEnabledFeatureFlags();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("blocks before target resolution when explicit selection is required and preference is not explicit", async () => {
    mockEnabledFeatureFlags(EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY);
    computeState.preference = {
      preferredComputeMode: ComputePreference.Cloud,
      computeTargetId: undefined,
    };
    const queryClient = createQueryClient();
    const execute = vi.fn();

    renderGate({ queryClient, execute });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(mockError).toHaveBeenCalledWith(ComputePreferenceRequiredMessage);
    });
    expect(execute).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledWith(
      "pre_loop_compute_selection_blocked",
      expect.objectContaining({
        reason: "missing_explicit_compute_selection",
      })
    );
  });

  it("honors explicit metadata target when explicit selection is required and preference is not explicit", async () => {
    mockEnabledFeatureFlags(EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY);
    computeState.preference = {
      preferredComputeMode: ComputePreference.Cloud,
      computeTargetId: undefined,
    };
    const queryClient = createQueryClient();
    const execute = vi.fn();
    queryClient.setQueryData(
      healthCheckOptions(getPreLoopTargetKey("target-1"), EXPECTED_MCP_URL, {
        relayTargetId: "target-1",
        latestVersion: "1.0.0",
      }).queryKey,
      healthyResult
    );

    renderGate({ queryClient, execute, computeTargetId: "target-1" });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith({ computeTargetId: "target-1" });
    });
    expect(mockError).not.toHaveBeenCalledWith(
      ComputePreferenceRequiredMessage
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("honors explicit metadata Cloud override when explicit selection is required and preference is not explicit", async () => {
    mockEnabledFeatureFlags(EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY);
    computeState.preference = {
      preferredComputeMode: ComputePreference.Cloud,
      computeTargetId: undefined,
    };
    const queryClient = createQueryClient();
    const execute = vi.fn();

    renderGate({ queryClient, execute, computeTargetId: null });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith({ computeTargetId: null });
    });
    expect(mockError).not.toHaveBeenCalledWith(
      ComputePreferenceRequiredMessage
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("passes an explicit Cloud override when explicit selection is required", async () => {
    mockEnabledFeatureFlags(EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY);
    computeState.preference = {
      preferredComputeMode: ComputePreference.Cloud,
      computeTargetId: undefined,
      isExplicit: true,
    };
    const queryClient = createQueryClient();
    const execute = vi.fn();

    renderGate({ queryClient, execute });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith({ computeTargetId: null });
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("passes the resolved explicit Local target after the local health check passes", async () => {
    mockEnabledFeatureFlags(EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY);
    computeState.preference = {
      preferredComputeMode: ComputePreference.Local,
      computeTargetId: "target-1",
      isExplicit: true,
    };
    const queryClient = createQueryClient();
    const execute = vi.fn();
    queryClient.setQueryData(
      healthCheckOptions(getPreLoopTargetKey("target-1"), EXPECTED_MCP_URL, {
        relayTargetId: "target-1",
        latestVersion: "1.0.0",
      }).queryKey,
      healthyResult
    );

    renderGate({ queryClient, execute });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith({ computeTargetId: "target-1" });
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
