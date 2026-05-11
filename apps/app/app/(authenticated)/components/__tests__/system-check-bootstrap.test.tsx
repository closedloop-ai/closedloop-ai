import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseSystemCheckEligibility = vi.fn();
const mockUseEngineerRoutingSelection = vi.fn();
const mockUseComputeTargets = vi.fn();
const mockUseComputeTargetHealthCheckSnapshot = vi.fn();
const mockHealthCheckDialog = vi.hoisted(() => vi.fn());
const mockHealthCheckQueryFn = vi.hoisted(() => vi.fn());
const EXPECTED_MCP_URL = vi.hoisted(() => "https://mcp.closedloop.ai/mcp");
const mockUseFeatureFlag = vi.hoisted(() => vi.fn());
const mockHealthCheckOptions = vi.hoisted(() =>
  vi.fn((_routing?: unknown, _expectedMcpUrl?: unknown, _config?: unknown) => ({
    queryKey: ["health-check"],
    queryFn: mockHealthCheckQueryFn,
    staleTime: 30_000,
  }))
);
const mockUseLatestElectronRelease = vi.hoisted(() => vi.fn());

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_MCP_SERVER_URL: EXPECTED_MCP_URL,
    NEXT_PUBLIC_POSTHOG_KEY: "test-posthog-key",
  },
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: (key: string) => mockUseFeatureFlag(key),
}));

vi.mock("@/components/engineer/HealthCheckDialog", () => ({
  HealthCheckDialog: (props: {
    latestVersionOverride?: string | null;
    pluginAutoUpdateEnabled?: boolean;
    relayTargetId?: string | null;
    targetKey?: string;
  }) => {
    mockHealthCheckDialog(props);
    return (
      <div
        data-latest-version={props.latestVersionOverride ?? ""}
        data-plugin-auto-update={String(props.pluginAutoUpdateEnabled ?? false)}
        data-relay-target-id={props.relayTargetId ?? ""}
        data-target-key={props.targetKey}
        data-testid="health-check-dialog"
      >
        Health Check Dialog
      </div>
    );
  },
}));

vi.mock("@/lib/engineer/queries/health-check", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/engineer/queries/health-check")
    >();
  return {
    ...actual,
    healthCheckOptions: (
      ...args: Parameters<typeof actual.healthCheckOptions>
    ) => mockHealthCheckOptions(...args),
  };
});

vi.mock("@/lib/engineer/routing-store", () => ({
  useEngineerRoutingSelection: () => mockUseEngineerRoutingSelection(),
}));

vi.mock("@/lib/system-check/use-system-check-eligibility", () => ({
  useSystemCheckEligibility: () => mockUseSystemCheckEligibility(),
}));

vi.mock("@/hooks/queries/use-compute-targets", () => ({
  useComputeTargets: () => mockUseComputeTargets(),
  useComputeTargetHealthCheckSnapshot: (
    targetId: string | null | undefined,
    pluginAutoUpdateEnabledOrOptions: unknown,
    options: unknown
  ) =>
    mockUseComputeTargetHealthCheckSnapshot(
      targetId,
      pluginAutoUpdateEnabledOrOptions,
      options
    ),
}));

vi.mock("@/hooks/queries/use-electron-release", () => ({
  useLatestElectronRelease: (options: unknown) =>
    mockUseLatestElectronRelease(options),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/my-tasks",
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
}));

import { PLUGIN_AUTO_UPDATE_FEATURE_FLAG_KEY } from "@/lib/system-check/plugin-auto-update";
import { SystemCheckBootstrap } from "../system-check-bootstrap";

function createBootstrapQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderBootstrap(queryClient = createBootstrapQueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <SystemCheckBootstrap />
    </QueryClientProvider>
  );
}

function rerenderBootstrap(rerender: (ui: ReactNode) => void) {
  const queryClient = createBootstrapQueryClient();

  rerender(
    <QueryClientProvider client={queryClient}>
      <SystemCheckBootstrap />
    </QueryClientProvider>
  );
}

describe("SystemCheckBootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHealthCheckQueryFn.mockResolvedValue({
      checks: [],
      allRequiredPassed: true,
    });
    mockUseLatestElectronRelease.mockReturnValue({
      data: {
        downloadUrl: "https://example.com/closedloop.dmg",
        releaseNotes: "",
        version: "1.0.0",
      },
      isLoading: false,
    });
    mockUseEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: null,
      source: "auto",
      updatedAt: Date.now(),
    });
    mockUseComputeTargets.mockReturnValue({ data: [] });
    mockUseComputeTargetHealthCheckSnapshot.mockReturnValue({
      data: null,
      isLoading: false,
    });
    mockUseFeatureFlag.mockReturnValue({ enabled: false });
  });

  it("does not render the dialog while eligibility is loading", () => {
    mockUseSystemCheckEligibility.mockReturnValue({
      shouldRunSystemCheck: false,
      isLoading: true,
    });

    renderBootstrap();

    expect(screen.queryByTestId("health-check-dialog")).toBeNull();
  });

  it("does not render the dialog when system checks are ineligible", () => {
    mockUseSystemCheckEligibility.mockReturnValue({
      shouldRunSystemCheck: false,
      isLoading: false,
    });

    renderBootstrap();

    expect(screen.queryByTestId("health-check-dialog")).toBeNull();
  });

  it("renders the dialog when the active execution target is eligible", () => {
    mockUseSystemCheckEligibility.mockReturnValue({
      shouldRunSystemCheck: true,
      isLoading: false,
    });

    renderBootstrap();

    expect(screen.getByTestId("health-check-dialog")).toBeInTheDocument();
  });

  it("uses a stable Local Gateway target key while the compute target id hydrates", () => {
    mockUseSystemCheckEligibility.mockReturnValue({
      shouldRunSystemCheck: true,
      isLoading: false,
    });
    mockUseEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.LocalElectron,
      computeTargetId: null,
      source: "auto",
      updatedAt: Date.now(),
    });

    const { rerender } = renderBootstrap();

    expect(screen.getByTestId("health-check-dialog")).toHaveAttribute(
      "data-target-key",
      "local-gateway"
    );

    mockUseEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.LocalElectron,
      computeTargetId: "target-1",
      source: "auto",
      updatedAt: Date.now(),
    });

    rerenderBootstrap(rerender);

    expect(screen.getByTestId("health-check-dialog")).toHaveAttribute(
      "data-target-key",
      "local-gateway"
    );
  });

  it("prefetches and renders with the shared cloud-relay target key", async () => {
    mockUseSystemCheckEligibility.mockReturnValue({
      shouldRunSystemCheck: true,
      isLoading: false,
    });
    mockUseEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: "target-1",
      source: "manual",
      updatedAt: Date.now(),
    });

    renderBootstrap();

    expect(screen.getByTestId("health-check-dialog")).toHaveAttribute(
      "data-target-key",
      "cloud-relay:target-1"
    );
    expect(screen.getByTestId("health-check-dialog")).toHaveAttribute(
      "data-relay-target-id",
      "target-1"
    );
    expect(screen.getByTestId("health-check-dialog")).toHaveAttribute(
      "data-latest-version",
      "1.0.0"
    );

    await waitFor(() => {
      expect(mockHealthCheckOptions).toHaveBeenCalledWith(
        "cloud-relay:target-1",
        EXPECTED_MCP_URL,
        expect.objectContaining({
          latestVersion: "1.0.0",
          relayTargetId: "target-1",
        })
      );
    });
  });

  it("treats a loading relay target as not owned before enabling plugin auto-update", async () => {
    mockUseSystemCheckEligibility.mockReturnValue({
      shouldRunSystemCheck: true,
      isLoading: false,
    });
    mockUseFeatureFlag.mockReturnValue({ enabled: true });
    mockUseEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: "target-1",
      source: "manual",
      updatedAt: Date.now(),
    });
    mockUseComputeTargets.mockReturnValue({ data: undefined });

    renderBootstrap();

    expect(screen.getByTestId("health-check-dialog")).toHaveAttribute(
      "data-plugin-auto-update",
      "false"
    );
    expect(mockUseComputeTargetHealthCheckSnapshot).toHaveBeenCalledWith(
      "target-1",
      false,
      expect.objectContaining({ enabled: true })
    );
    await waitFor(() => {
      expect(mockHealthCheckOptions).toHaveBeenCalledWith(
        "cloud-relay:target-1",
        EXPECTED_MCP_URL,
        expect.objectContaining({
          pluginAutoUpdateEnabled: false,
          relayTargetId: "target-1",
        })
      );
    });
  });

  it("enables plugin auto-update only for a loaded owned relay target", async () => {
    mockUseSystemCheckEligibility.mockReturnValue({
      shouldRunSystemCheck: true,
      isLoading: false,
    });
    mockUseFeatureFlag.mockImplementation((key: string) => ({
      enabled: key === PLUGIN_AUTO_UPDATE_FEATURE_FLAG_KEY,
    }));
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
          machineName: "Owner relay",
          ownerName: null,
        },
      ],
    });

    renderBootstrap();

    expect(screen.getByTestId("health-check-dialog")).toHaveAttribute(
      "data-plugin-auto-update",
      "true"
    );
    expect(mockUseFeatureFlag).toHaveBeenCalledWith(
      PLUGIN_AUTO_UPDATE_FEATURE_FLAG_KEY
    );
    await waitFor(() => {
      expect(mockHealthCheckOptions).toHaveBeenCalledWith(
        "cloud-relay:target-1",
        EXPECTED_MCP_URL,
        expect.objectContaining({
          pluginAutoUpdateEnabled: true,
          relayTargetId: "target-1",
        })
      );
    });
  });

  it("hydrates from a fresh persisted cloud-relay snapshot without live prefetching", async () => {
    mockUseSystemCheckEligibility.mockReturnValue({
      shouldRunSystemCheck: true,
      isLoading: false,
    });
    mockUseEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: "target-1",
      source: "manual",
      updatedAt: Date.now(),
    });
    mockUseComputeTargetHealthCheckSnapshot.mockReturnValue({
      data: {
        id: "snapshot-1",
        organizationId: "org-1",
        computeTargetId: "target-1",
        checkedAt: new Date(),
        expectedMcpUrl: EXPECTED_MCP_URL,
        latestVersion: "1.0.0",
        result: {
          checks: [{ id: "git", label: "Git", required: true, passed: true }],
          allRequiredPassed: true,
        },
        allRequiredPassed: true,
        requiredFailureIds: [],
        schemaVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      isLoading: false,
    });

    renderBootstrap();

    await waitFor(() => {
      expect(mockHealthCheckOptions).toHaveBeenCalledWith(
        "cloud-relay:target-1",
        EXPECTED_MCP_URL,
        expect.objectContaining({
          latestVersion: "1.0.0",
          relayTargetId: "target-1",
        })
      );
    });
    expect(mockHealthCheckQueryFn).not.toHaveBeenCalled();
  });

  it("does not overwrite a newer live health-check cache with an older persisted snapshot", async () => {
    const queryClient = createBootstrapQueryClient();
    const persistedCheckedAt = new Date(Date.now() - 60_000); // 1 minute ago (within freshness window)
    const liveResult = {
      checks: [{ id: "live-git", label: "Git", required: true, passed: true }],
      allRequiredPassed: true,
    };

    queryClient.setQueryData(["health-check"], liveResult);
    // Manually set dataUpdatedAt to a time newer than the persisted snapshot
    // so the component's guard (existingState.dataUpdatedAt >= snapshotUpdatedAt) holds.
    const cache = queryClient
      .getQueryCache()
      .find({ queryKey: ["health-check"] });
    if (cache) {
      cache.state.dataUpdatedAt = persistedCheckedAt.getTime() + 1000;
    }
    mockUseSystemCheckEligibility.mockReturnValue({
      shouldRunSystemCheck: true,
      isLoading: false,
    });
    mockUseEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: "target-1",
      source: "manual",
      updatedAt: Date.now(),
    });
    mockUseComputeTargetHealthCheckSnapshot.mockReturnValue({
      data: {
        id: "snapshot-1",
        organizationId: "org-1",
        computeTargetId: "target-1",
        checkedAt: persistedCheckedAt,
        expectedMcpUrl: EXPECTED_MCP_URL,
        latestVersion: "1.0.0",
        result: {
          checks: [
            {
              id: "git",
              label: "Git",
              required: true,
              passed: true,
            },
          ],
          allRequiredPassed: true,
        },
        allRequiredPassed: true,
        requiredFailureIds: [],
        schemaVersion: 1,
        createdAt: persistedCheckedAt,
        updatedAt: persistedCheckedAt,
      },
      isLoading: false,
    });

    renderBootstrap(queryClient);

    await waitFor(() => {
      expect(mockHealthCheckOptions).toHaveBeenCalledWith(
        "cloud-relay:target-1",
        EXPECTED_MCP_URL,
        expect.objectContaining({
          latestVersion: "1.0.0",
          relayTargetId: "target-1",
        })
      );
    });
    expect(queryClient.getQueryData(["health-check"])).toBe(liveResult);
    expect(mockHealthCheckQueryFn).not.toHaveBeenCalled();
  });
});
