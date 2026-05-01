import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "@/env";
import { createTestQueryClient } from "@/hooks/queries/__tests__/test-utils";
import { getHealthCheckTargetKey } from "@/lib/engineer/queries/health-check";
import { queryKeys } from "@/lib/engineer/queries/keys";

const RE_SYSTEM_CHECK = /system check/i;
const RE_RECHECK = /re-check/i;
const RE_LAST_CHECKED = /Last checked /;
const RE_SYSTEM_CHECKS_UNAVAILABLE =
  /System checks are available when the desktop client is connected\./;
const RE_UPGRADE_SECURITY = /Upgrade security/i;
const RE_DOWNLOAD_UPDATE = /Download update/i;
const RE_DOWNLOAD_UNAVAILABLE = /Download unavailable/i;
const RE_UPDATE_REQUIRED = /Update required/i;
const TEST_DESKTOP_DOWNLOAD_URL = "https://example.com/closedloop.dmg";

const mockUseComputeTargets = vi.fn();
const mockUseDeleteComputeTarget = vi.fn();
const mockUseSystemCheckEligibility = vi.fn();
const mockDeleteMutate = vi.fn();
const mockDispatchDesktopCommandMutate = vi.fn();
const mockUseLatestElectronRelease = vi.fn();

vi.mock("@/hooks/queries/use-compute-targets", () => ({
  useComputeTargets: (...args: unknown[]) => mockUseComputeTargets(...args),
  useDeleteComputeTarget: () => mockUseDeleteComputeTarget(),
  useDesktopCommandStatus: () => ({ data: undefined, isError: false }),
  useDispatchDesktopCommand: () => ({
    isPending: false,
    mutate: mockDispatchDesktopCommandMutate,
  }),
  useToggleComputeTargetSharing: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/system-check/use-system-check-eligibility", () => ({
  useSystemCheckEligibility: () => mockUseSystemCheckEligibility(),
}));

vi.mock("@/hooks/queries/use-electron-release", () => ({
  useLatestElectronRelease: () => mockUseLatestElectronRelease(),
}));

// Resolve the expected MCP URL the same way the component does so that
// query-cache seeds and URL assertions stay in sync with the env value.
const expectedMcpUrl = env.NEXT_PUBLIC_MCP_SERVER_URL ?? null;

import { LocalComputeTargetsCard } from "../local-compute-targets-card";

function renderWithClient(queryClient = createTestQueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <LocalComputeTargetsCard />
    </QueryClientProvider>
  );
}

describe("ComputeTargetsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseComputeTargets.mockReturnValue({
      data: [],
      isLoading: false,
    });
    mockUseDeleteComputeTarget.mockReturnValue({
      isPending: false,
      mutate: mockDeleteMutate,
    });
    mockUseSystemCheckEligibility.mockReturnValue({
      shouldRunSystemCheck: true,
      isLoading: false,
    });
    mockUseLatestElectronRelease.mockReturnValue({
      data: {
        downloadUrl: TEST_DESKTOP_DOWNLOAD_URL,
        version: "9.9.9",
        releaseNotes: "",
      },
      isLoading: false,
    });

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: vi.fn().mockResolvedValue(
        Response.json({
          checks: [],
          allRequiredPassed: true,
        })
      ),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders cached system-check results immediately while auto-refreshing in the background", () => {
    const queryClient = createTestQueryClient();
    const healthCheckTargetKey = getHealthCheckTargetKey({
      mode: "cloud-relay",
      computeTargetId: null,
    });
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as typeof fetch;
    // Seed cache using the same key the component will use (includes expectedMcpUrl)
    queryClient.setQueryData(
      queryKeys.healthCheck(healthCheckTargetKey, expectedMcpUrl),
      {
        checks: [
          {
            id: "git",
            label: "Git",
            required: true,
            passed: false,
            error: "Not found",
            remediation: "Install git",
          },
        ],
        allRequiredPassed: false,
      }
    );

    renderWithClient(queryClient);

    // The component appends expectedMcpUrl as a query param when it is set
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/gateway/health-check")
    );
    expect(screen.getByText("1 failure")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: RE_SYSTEM_CHECK }));

    expect(screen.getByText("Install git")).toBeInTheDocument();
  });

  it("shows the last checked timestamp when cached results exist", () => {
    const queryClient = createTestQueryClient();
    const healthCheckTargetKey = getHealthCheckTargetKey({
      mode: "cloud-relay",
      computeTargetId: null,
    });
    // Seed cache using the same key the component will use (includes expectedMcpUrl)
    queryClient.setQueryData(
      queryKeys.healthCheck(healthCheckTargetKey, expectedMcpUrl),
      {
        checks: [
          {
            id: "git",
            label: "Git",
            required: true,
            passed: true,
            version: "2.49.0",
          },
        ],
        allRequiredPassed: true,
      }
    );

    renderWithClient(queryClient);

    expect(screen.getByText(RE_LAST_CHECKED)).toBeInTheDocument();
  });

  it("renders MCP rows when cached health-check data includes mcpServers", () => {
    const queryClient = createTestQueryClient();
    const healthCheckTargetKey = getHealthCheckTargetKey({
      mode: "cloud-relay",
      computeTargetId: null,
    });
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as typeof fetch;
    // Seed cache using the same key the component will use (includes expectedMcpUrl)
    queryClient.setQueryData(
      queryKeys.healthCheck(healthCheckTargetKey, expectedMcpUrl),
      {
        checks: [
          {
            id: "git",
            label: "Git",
            required: true,
            passed: true,
            version: "2.49.0",
          },
        ],
        allRequiredPassed: true,
        mcpServers: {
          claude: {
            available: true,
            serverName: "team-claude",
            matchedUrl: "https://example.com/mcp",
            checkedAt: "2026-04-13T18:41:00.000Z",
          },
          codex: {
            available: true,
            serverName: "team-codex",
            matchedUrl: "https://example.com/mcp",
            checkedAt: "2026-04-13T18:41:00.000Z",
          },
        },
      }
    );

    renderWithClient(queryClient);

    fireEvent.click(screen.getByRole("button", { name: RE_SYSTEM_CHECK }));

    expect(screen.getByText("Claude MCP")).toBeInTheDocument();
    expect(screen.getByText("Codex MCP")).toBeInTheDocument();
    expect(screen.getByText("team-claude")).toBeInTheDocument();
  });

  it("auto-runs the first system check when the active target is eligible", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      Response.json({
        checks: [
          {
            id: "git",
            label: "Git",
            required: true,
            passed: true,
            version: "2.49.0",
          },
        ],
        allRequiredPassed: true,
      })
    ) as typeof fetch;

    renderWithClient();

    await waitFor(() => {
      // The component appends expectedMcpUrl as a query param when it is set
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/gateway/health-check")
      );
    });

    await waitFor(() => {
      expect(screen.getByText("All checks passed")).toBeInTheDocument();
    });
  });

  it("disables manual recheck when the current execution target is ineligible", () => {
    mockUseSystemCheckEligibility.mockReturnValue({
      shouldRunSystemCheck: false,
      isLoading: false,
    });

    renderWithClient();

    expect(screen.getByRole("button", { name: RE_RECHECK })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: RE_SYSTEM_CHECK }));

    expect(screen.getByText(RE_SYSTEM_CHECKS_UNAVAILABLE)).toBeInTheDocument();
  });

  it("allows manual recheck after the automatic check has completed", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      Response.json({
        checks: [
          {
            id: "git",
            label: "Git",
            required: true,
            passed: true,
            version: "2.49.0",
          },
        ],
        allRequiredPassed: true,
      })
    ) as typeof fetch;

    renderWithClient();

    await waitFor(() => {
      // The component appends expectedMcpUrl as a query param when it is set
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/gateway/health-check")
      );
    });

    fireEvent.click(screen.getByRole("button", { name: RE_RECHECK }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    await waitFor(() => {
      expect(screen.getByText("All checks passed")).toBeInTheDocument();
    });
  });

  it("links eligible security upgrades to the target-specific upgrade page", () => {
    mockUseComputeTargets.mockReturnValue({
      data: [
        {
          id: "target-1",
          machineName: "Daniel-MBP",
          platform: "darwin",
          lastSeenAt: new Date("2026-04-28T12:00:00.000Z"),
          isOnline: true,
          isSharedWithOrg: false,
          supportedOperations: [],
          capabilities: {},
          security: {
            status: "upgrade_available",
            reason: "NO_BOUND_MANAGED_KEY",
            upgradeSupported: true,
          },
          createdAt: new Date("2026-04-28T12:00:00.000Z"),
          updatedAt: new Date("2026-04-28T12:00:00.000Z"),
        },
      ],
      isLoading: false,
    });

    renderWithClient();

    expect(
      screen.getByRole("link", { name: RE_UPGRADE_SECURITY })
    ).toHaveAttribute(
      "href",
      "/settings/compute-targets/target-1/security-upgrade"
    );
  });

  it("links update-required targets to a desktop download", () => {
    mockUseComputeTargets.mockReturnValue({
      data: [
        {
          id: "target-1",
          machineName: "Daniel-MBP",
          platform: "darwin",
          lastSeenAt: new Date("2026-04-28T12:00:00.000Z"),
          isOnline: true,
          isSharedWithOrg: false,
          supportedOperations: [],
          capabilities: {},
          security: {
            status: "update_required",
            reason: "UNSUPPORTED_DESKTOP_VERSION",
            upgradeSupported: false,
          },
          createdAt: new Date("2026-04-28T12:00:00.000Z"),
          updatedAt: new Date("2026-04-28T12:00:00.000Z"),
        },
      ],
      isLoading: false,
    });

    renderWithClient();

    expect(screen.getByText(RE_UPDATE_REQUIRED)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: RE_DOWNLOAD_UPDATE })
    ).toHaveAttribute("href", TEST_DESKTOP_DOWNLOAD_URL);
    expect(
      screen.queryByRole("link", { name: RE_UPGRADE_SECURITY })
    ).not.toBeInTheDocument();
  });

  it("does not fall back to a hardcoded update URL when release data is unavailable", () => {
    mockUseLatestElectronRelease.mockReturnValue({
      data: undefined,
      isLoading: false,
    });
    mockUseComputeTargets.mockReturnValue({
      data: [
        {
          id: "target-1",
          machineName: "Daniel-MBP",
          platform: "darwin",
          lastSeenAt: new Date("2026-04-28T12:00:00.000Z"),
          isOnline: true,
          isSharedWithOrg: false,
          supportedOperations: [],
          capabilities: {},
          security: {
            status: "update_required",
            reason: "MISSING_GATEWAY_ID",
            upgradeSupported: false,
          },
          createdAt: new Date("2026-04-28T12:00:00.000Z"),
          updatedAt: new Date("2026-04-28T12:00:00.000Z"),
        },
      ],
      isLoading: false,
    });

    renderWithClient();

    expect(
      screen.queryByRole("link", { name: RE_DOWNLOAD_UPDATE })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: RE_DOWNLOAD_UNAVAILABLE })
    ).toBeDisabled();
  });
});
