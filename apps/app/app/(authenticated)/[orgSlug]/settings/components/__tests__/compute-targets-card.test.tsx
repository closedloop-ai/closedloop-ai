import {
  COMMAND_SIGNING_CAPABILITY_KEY,
  type ComputeTarget,
  DesktopSecurityStatus,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "@/env";
import { createTestQueryClient } from "@/hooks/queries/__tests__/test-utils";
import { COMPUTE_TARGET_HEADER } from "@/lib/desktop-command-signing/constants";
import { GATEWAY_RELAY_HEALTH_CHECK_PATH } from "@/lib/engineer/constants";
import { getHealthCheckTargetKey } from "@/lib/engineer/queries/health-check";
import { queryKeys } from "@/lib/engineer/queries/keys";

const RE_SYSTEM_CHECK = /system check/i;
const RE_RUN_CHECK = /run check/i;
const RE_RECHECK = /re-check/i;
const RE_LAST_CHECKED = /Last checked /;
const RE_TARGET_SYSTEM_CHECKS_UNAVAILABLE =
  /System checks are available when this compute target is online\./;
const RE_UPGRADE_SECURITY = /Upgrade security/i;
const RE_DOWNLOAD_UPDATE = /Download update/i;
const RE_DOWNLOAD_UNAVAILABLE = /Download unavailable/i;
const RE_UPDATE_REQUIRED = /Update required/i;
const RE_REGISTER_BROWSER = /Register Browser/i;
const RE_UNREGISTER = /Unregister/i;
const TEST_TARGET_ID = "target-1";
const TEST_TARGET_NAME = "Daniel-MBP";
const TEST_DESKTOP_DOWNLOAD_URL =
  "https://github.com/closedloop-ai/symphony-alpha/releases/download/desktop-v0.15.115/Closedloop-0.15.115-universal.dmg";

vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ orgSlug: "test-org" })),
  usePathname: vi.fn(() => "/test-org/settings"),
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
}));

const mockUseComputeTargets = vi.fn();
const mockUseDeleteComputeTarget = vi.fn();
const mockDeleteMutate = vi.fn();
const mockDispatchDesktopCommandMutate = vi.fn();
const mockRegisterBrowserKeyMutate = vi.fn();
const mockUnregisterBrowserKeyMutate = vi.fn();
const mockUseLatestElectronRelease = vi.fn();
const mockUseRegisterBrowserCommandKey = vi.fn();
const mockUseUnregisterBrowserCommandKey = vi.fn();

function mockUnexpectedHealthCheckFetch() {
  globalThis.fetch = vi
    .fn()
    .mockRejectedValue(
      new Error("Unexpected health-check fetch during cached render")
    ) as typeof fetch;
}

function makeComputeTarget(
  overrides: Partial<ComputeTarget> = {}
): ComputeTarget {
  const timestamp = new Date("2026-04-28T12:00:00.000Z");
  return {
    id: TEST_TARGET_ID,
    organizationId: "org-1",
    userId: "user-1",
    machineName: TEST_TARGET_NAME,
    platform: "darwin",
    lastSeenAt: timestamp,
    isOnline: true,
    isSharedWithOrg: false,
    supportedOperations: [],
    capabilities: {},
    security: {
      status: DesktopSecurityStatus.Unknown,
      reason: "FEATURE_DISABLED",
      upgradeSupported: false,
    },
    selectedHarness: HarnessType.Claude,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

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

vi.mock("@repo/app/desktop/hooks/use-electron-release", () => ({
  useLatestElectronRelease: () => mockUseLatestElectronRelease(),
}));

vi.mock("@/hooks/queries/use-public-keys", () => ({
  useRegisterBrowserCommandKey: () => mockUseRegisterBrowserCommandKey(),
  useUnregisterBrowserCommandKey: () => mockUseUnregisterBrowserCommandKey(),
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
      data: [makeComputeTarget()],
      isLoading: false,
    });
    mockUseDeleteComputeTarget.mockReturnValue({
      isPending: false,
      mutate: mockDeleteMutate,
    });
    mockUseLatestElectronRelease.mockReturnValue({
      data: {
        downloadUrl: TEST_DESKTOP_DOWNLOAD_URL,
        version: "9.9.9",
        releaseNotes: "",
      },
      isLoading: false,
    });
    mockUseRegisterBrowserCommandKey.mockReturnValue({
      isPending: false,
      mutate: mockRegisterBrowserKeyMutate,
    });
    mockUseUnregisterBrowserCommandKey.mockReturnValue({
      isPending: false,
      mutate: mockUnregisterBrowserKeyMutate,
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

  it("renders cached system-check results immediately without auto-refreshing", () => {
    const queryClient = createTestQueryClient();
    const healthCheckTargetKey = getHealthCheckTargetKey({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: TEST_TARGET_ID,
    });
    mockUnexpectedHealthCheckFetch();
    // Seed cache using the same key the component will use.
    queryClient.setQueryData(
      queryKeys.healthCheck(healthCheckTargetKey, expectedMcpUrl, "9.9.9"),
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

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(screen.getByText("1 failure")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: RE_SYSTEM_CHECK }));

    expect(screen.getByText("Install git")).toBeInTheDocument();
  });

  it("shows the last checked timestamp when cached results exist", () => {
    const queryClient = createTestQueryClient();
    const healthCheckTargetKey = getHealthCheckTargetKey({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: TEST_TARGET_ID,
    });
    // Seed cache using the same key the component will use.
    queryClient.setQueryData(
      queryKeys.healthCheck(healthCheckTargetKey, expectedMcpUrl, "9.9.9"),
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

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(screen.getByText(RE_LAST_CHECKED)).toBeInTheDocument();
  });

  it("renders MCP rows when cached health-check data includes mcpServers", () => {
    const queryClient = createTestQueryClient();
    const healthCheckTargetKey = getHealthCheckTargetKey({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: TEST_TARGET_ID,
    });
    mockUnexpectedHealthCheckFetch();
    // Seed cache using the same key the component will use.
    queryClient.setQueryData(
      queryKeys.healthCheck(healthCheckTargetKey, expectedMcpUrl, "9.9.9"),
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

    expect(globalThis.fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: RE_SYSTEM_CHECK }));

    expect(screen.getByText("Claude MCP")).toBeInTheDocument();
    expect(screen.getByText("Codex MCP")).toBeInTheDocument();
    expect(screen.getByText("team-claude")).toBeInTheDocument();
  });

  it("runs the first system check only after the target button is clicked", async () => {
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

    expect(globalThis.fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: RE_RUN_CHECK }));

    await waitFor(() => {
      // The component appends expectedMcpUrl as a query param when it is set
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining(GATEWAY_RELAY_HEALTH_CHECK_PATH),
        expect.objectContaining({
          headers: {
            [COMPUTE_TARGET_HEADER]: TEST_TARGET_ID,
          },
        })
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("latestVersion=9.9.9"),
        expect.objectContaining({
          headers: {
            [COMPUTE_TARGET_HEADER]: TEST_TARGET_ID,
          },
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByText("All checks passed")).toBeInTheDocument();
    });
  });

  it("renders a terminal system-check row when a manual check fails", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("gateway unavailable")) as typeof fetch;

    renderWithClient();

    fireEvent.click(screen.getByRole("button", { name: RE_RUN_CHECK }));

    await waitFor(() => {
      expect(screen.getByText("1 failure")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: RE_SYSTEM_CHECK }));

    expect(screen.getByText("gateway unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Retry System Check. If this persists, update Closedloop plugins manually and try again."
      )
    ).toBeInTheDocument();
  });

  it("waits for latest release data to settle before manual system checks can run", () => {
    mockUseLatestElectronRelease.mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    renderWithClient();

    const runCheckButton = screen.getByRole("button", { name: RE_RUN_CHECK });

    expect(runCheckButton).toBeDisabled();

    fireEvent.click(runCheckButton);

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("keeps feature-disabled Standard targets eligible for system checks", async () => {
    renderWithClient();

    expect(screen.getByText("Standard")).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: RE_RUN_CHECK }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining(GATEWAY_RELAY_HEALTH_CHECK_PATH),
        expect.objectContaining({
          headers: {
            [COMPUTE_TARGET_HEADER]: TEST_TARGET_ID,
          },
        })
      );
    });
  });

  it("keeps each target's health check scoped to that target", async () => {
    const secondTargetId = "target-2";
    mockUseComputeTargets.mockReturnValue({
      data: [
        makeComputeTarget(),
        makeComputeTarget({
          id: secondTargetId,
          machineName: "Ops-Mac",
        }),
      ],
      isLoading: false,
    });

    renderWithClient();

    expect(globalThis.fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: RE_RUN_CHECK })[1]);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining(GATEWAY_RELAY_HEALTH_CHECK_PATH),
        expect.objectContaining({
          headers: {
            [COMPUTE_TARGET_HEADER]: secondTargetId,
          },
        })
      );
    });
  });

  it("disables manual checks for offline targets", () => {
    mockUseComputeTargets.mockReturnValue({
      data: [makeComputeTarget({ isOnline: false })],
      isLoading: false,
    });

    renderWithClient();

    expect(screen.getByRole("button", { name: RE_RUN_CHECK })).toBeDisabled();
    expect(globalThis.fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: RE_SYSTEM_CHECK }));

    expect(
      screen.getByText(RE_TARGET_SYSTEM_CHECKS_UNAVAILABLE)
    ).toBeInTheDocument();
  });

  it("allows manual recheck after the first manual check has completed", async () => {
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

    expect(globalThis.fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: RE_RUN_CHECK }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    await screen.findByText("All checks passed");
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
        makeComputeTarget({
          security: {
            status: DesktopSecurityStatus.UpgradeAvailable,
            reason: "NO_BOUND_MANAGED_KEY",
            upgradeSupported: true,
          },
        }),
      ],
      isLoading: false,
    });

    renderWithClient();

    expect(
      screen.getByRole("link", { name: RE_UPGRADE_SECURITY })
    ).toHaveAttribute(
      "href",
      "/test-org/settings/compute-targets/target-1/security-upgrade"
    );
  });

  it("links update-required targets to a desktop download", () => {
    mockUseComputeTargets.mockReturnValue({
      data: [
        makeComputeTarget({
          security: {
            status: DesktopSecurityStatus.UpdateRequired,
            reason: "UNSUPPORTED_DESKTOP_VERSION",
            upgradeSupported: false,
          },
        }),
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
        makeComputeTarget({
          security: {
            status: DesktopSecurityStatus.UpdateRequired,
            reason: "MISSING_GATEWAY_ID",
            upgradeSupported: false,
          },
        }),
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

  it("does not render an update link when the release hook rejects cached data", () => {
    mockUseLatestElectronRelease.mockReturnValue({
      data: null,
      isLoading: false,
    });
    mockUseComputeTargets.mockReturnValue({
      data: [
        makeComputeTarget({
          security: {
            status: DesktopSecurityStatus.UpdateRequired,
            reason: "UNSUPPORTED_DESKTOP_VERSION",
            upgradeSupported: false,
          },
        }),
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

  it("offers browser key unregister after the current key is registered", async () => {
    mockUseComputeTargets.mockReturnValue({
      data: [
        makeComputeTarget({
          capabilities: {
            [COMMAND_SIGNING_CAPABILITY_KEY]: true,
          },
          serverCapabilities: {
            computeTargetSigning: true,
          },
        }),
      ],
      isLoading: false,
    });
    mockRegisterBrowserKeyMutate.mockImplementation((_variables, options) => {
      options.onSuccess({
        id: "key-1",
        userId: "user-1",
        organizationId: "org-1",
        publicKeyBase64: "public-key",
        fingerprint: "cl:registered-browser-key",
        createdAt: "2026-05-09T00:00:00.000Z",
      });
    });

    renderWithClient();

    const registerButton = screen.getByRole("button", {
      name: RE_REGISTER_BROWSER,
    });
    expect(registerButton).toBeEnabled();

    fireEvent.click(registerButton);

    expect(
      await screen.findByText("Registered key cl:registered-browser-key")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RE_REGISTER_BROWSER })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: RE_UNREGISTER })).toBeEnabled();
  });

  it("unregisters the current browser key and returns to registration state", async () => {
    mockUseComputeTargets.mockReturnValue({
      data: [
        makeComputeTarget({
          capabilities: {
            [COMMAND_SIGNING_CAPABILITY_KEY]: true,
          },
          serverCapabilities: {
            computeTargetSigning: true,
          },
        }),
      ],
      isLoading: false,
    });
    mockRegisterBrowserKeyMutate.mockImplementation((_variables, options) => {
      options.onSuccess({
        id: "key-1",
        userId: "user-1",
        organizationId: "org-1",
        publicKeyBase64: "public-key",
        fingerprint: "cl:registered-browser-key",
        createdAt: "2026-05-09T00:00:00.000Z",
      });
    });
    mockUnregisterBrowserKeyMutate.mockImplementation(
      (_fingerprint, options) => {
        options.onSuccess({ deleted: true });
      }
    );

    renderWithClient();

    fireEvent.click(screen.getByRole("button", { name: RE_REGISTER_BROWSER }));
    fireEvent.click(await screen.findByRole("button", { name: RE_UNREGISTER }));

    expect(mockUnregisterBrowserKeyMutate).toHaveBeenCalledWith(
      "cl:registered-browser-key",
      expect.any(Object)
    );
    expect(
      screen.getByRole("button", { name: RE_REGISTER_BROWSER })
    ).toBeEnabled();
  });
});
