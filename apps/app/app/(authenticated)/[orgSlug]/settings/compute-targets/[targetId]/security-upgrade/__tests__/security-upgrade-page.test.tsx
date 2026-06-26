import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ orgSlug: "test-org", targetId: "target-1" })),
  usePathname: vi.fn(
    () => "/test-org/settings/compute-targets/target-1/security-upgrade"
  ),
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
}));

const mockUseComputeTargets = vi.fn();
const mockUseStartDesktopSecurityUpgrade = vi.fn();
const mockUseLatestElectronRelease = vi.fn();
const mockMutate = vi.fn();
const RE_SEND_UPGRADE_COMMAND = /Send upgrade command/i;
const RE_DOWNLOAD_UPDATE = /Download update/i;
const RE_DOWNLOAD_UNAVAILABLE = /Download unavailable/i;
const RE_UPDATE_REQUIRED = /Update required/i;
const TEST_DESKTOP_DOWNLOAD_URL =
  "https://github.com/closedloop-ai/symphony-alpha/releases/download/desktop-v0.15.115/Closedloop-0.15.115-universal.dmg";
vi.mock("@/hooks/queries/use-compute-targets", () => ({
  useComputeTargets: (...args: unknown[]) => mockUseComputeTargets(...args),
  useStartDesktopSecurityUpgrade: () => mockUseStartDesktopSecurityUpgrade(),
}));

vi.mock("@repo/app/desktop/hooks/use-electron-release", () => ({
  useLatestElectronRelease: () => mockUseLatestElectronRelease(),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { DesktopSecurityUpgradePage } from "../security-upgrade-page";

const eligibleTarget = {
  id: "target-1",
  gatewayId: "550e8400-e29b-41d4-a716-446655440000",
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
};

describe("DesktopSecurityUpgradePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseComputeTargets.mockReturnValue({
      data: [eligibleTarget],
      isLoading: false,
    });
    mockUseStartDesktopSecurityUpgrade.mockReturnValue({
      data: undefined,
      isPending: false,
      mutate: mockMutate,
    });
    mockUseLatestElectronRelease.mockReturnValue({
      data: {
        downloadUrl: TEST_DESKTOP_DOWNLOAD_URL,
        version: "9.9.9",
        releaseNotes: "",
      },
      isLoading: false,
    });
  });

  it("dispatches the upgrade command from the target-specific page", () => {
    mockMutate.mockImplementation((_input, options) => {
      options.onSuccess();
    });

    render(<DesktopSecurityUpgradePage targetId="target-1" />);

    fireEvent.click(
      screen.getByRole("button", { name: RE_SEND_UPGRADE_COMMAND })
    );

    expect(mockMutate).toHaveBeenCalledWith(
      {
        targetId: "target-1",
        webAppOrigin: "http://localhost:3000",
      },
      expect.objectContaining({
        onError: expect.any(Function),
        onSuccess: expect.any(Function),
      })
    );
  });

  it("blocks dispatch when the target is no longer upgradeable", () => {
    mockUseComputeTargets.mockReturnValue({
      data: [
        {
          ...eligibleTarget,
          security: {
            status: "protected",
            reason: "BOUND_DESKTOP_MANAGED_KEY",
            upgradeSupported: false,
          },
        },
      ],
      isLoading: false,
    });

    render(<DesktopSecurityUpgradePage targetId="target-1" />);

    expect(
      screen.getByText("This target already uses a Desktop-managed key.")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RE_SEND_UPGRADE_COMMAND })
    ).not.toBeInTheDocument();
  });

  it("shows a download action when Desktop must be updated first", () => {
    mockUseComputeTargets.mockReturnValue({
      data: [
        {
          ...eligibleTarget,
          security: {
            status: "update_required",
            reason: "UNSUPPORTED_DESKTOP_VERSION",
            upgradeSupported: false,
          },
        },
      ],
      isLoading: false,
    });

    render(<DesktopSecurityUpgradePage targetId="target-1" />);

    expect(
      screen.getByText(
        "Update Desktop to a version that supports the security-upgrade protocol."
      )
    ).toBeInTheDocument();
    expect(screen.getByText(RE_UPDATE_REQUIRED)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: RE_DOWNLOAD_UPDATE })
    ).toHaveAttribute("href", TEST_DESKTOP_DOWNLOAD_URL);
    expect(
      screen.queryByRole("button", { name: RE_SEND_UPGRADE_COMMAND })
    ).not.toBeInTheDocument();
  });

  it("does not render a hardcoded update link when release data is unavailable", () => {
    mockUseLatestElectronRelease.mockReturnValue({
      data: undefined,
      isLoading: false,
    });
    mockUseComputeTargets.mockReturnValue({
      data: [
        {
          ...eligibleTarget,
          security: {
            status: "update_required",
            reason: "MISSING_GATEWAY_ID",
            upgradeSupported: false,
          },
        },
      ],
      isLoading: false,
    });

    render(<DesktopSecurityUpgradePage targetId="target-1" />);

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
        {
          ...eligibleTarget,
          security: {
            status: "update_required",
            reason: "MISSING_GATEWAY_ID",
            upgradeSupported: false,
          },
        },
      ],
      isLoading: false,
    });

    render(<DesktopSecurityUpgradePage targetId="target-1" />);

    expect(
      screen.queryByRole("link", { name: RE_DOWNLOAD_UPDATE })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: RE_DOWNLOAD_UNAVAILABLE })
    ).toBeDisabled();
  });
});
