import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const mockUseUser = vi.fn();
const mockUseSidebar = vi.fn();
const mockUseComputeTargets = vi.fn();
const mockUseComputePreference = vi.fn();
const mockUseSetComputePreference = vi.fn();
const mockMutate = vi.fn();
const mockUseComputeTargetStatusStream = vi.fn();

vi.mock("@repo/auth/client", () => ({
  useUser: () => mockUseUser(),
}));

vi.mock("@repo/design-system/components/ui/sidebar", () => ({
  SidebarMenuButton: ({
    children,
    "aria-label": ariaLabel,
    tooltip,
  }: {
    children: React.ReactNode;
    "aria-label"?: string;
    tooltip?: string;
  }) => (
    <button
      aria-label={ariaLabel}
      data-testid="sidebar-menu-button"
      title={tooltip}
      type="button"
    >
      {children}
    </button>
  ),
  useSidebar: () => mockUseSidebar(),
}));

vi.mock("@repo/design-system/components/ui/popover", () => ({
  Popover: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open: boolean;
    onOpenChange: (next: boolean) => void;
  }) => (
    <div data-open={open} data-testid="popover">
      {children}
    </div>
  ),
  PopoverTrigger: ({
    children,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
  }) => <div data-testid="popover-trigger">{children}</div>,
  PopoverContent: ({
    children,
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode;
    "aria-label"?: string;
  }) => (
    <section aria-label={ariaLabel} data-testid="popover-content">
      {children}
    </section>
  ),
}));

vi.mock("@/hooks/queries/use-compute-preference", () => ({
  useComputePreference: (...args: unknown[]) =>
    mockUseComputePreference(...args),
  useSetComputePreference: (...args: unknown[]) =>
    mockUseSetComputePreference(...args),
}));

vi.mock("@/hooks/queries/use-compute-targets", () => ({
  useComputeTargets: (...args: unknown[]) => mockUseComputeTargets(...args),
}));

vi.mock("@/hooks/queries/use-compute-target-status-stream", () => ({
  useComputeTargetStatusStream: (...args: unknown[]) =>
    mockUseComputeTargetStatusStream(...args),
}));

import type React from "react";
import { ComputeTargetPopover } from "../compute-target-popover";

const RE_SELECT_CLOUD = /Select Cloud compute target/i;
const RE_SELECT_LOCAL = /Select Local compute target/i;
const RE_SELECT_MY_MAC = /Select my-mac compute target/i;
const RE_INSTALL_DESKTOP = /Install Desktop App/i;
const RE_LOCAL_COMPUTE_REQUIRES =
  /Local compute requires the ClosedLoop Desktop app/i;
const RE_DESKTOP_OFFLINE = /Desktop app is offline/i;
const RE_NOT_REACHABLE = /Your local compute target is not reachable/i;
const RE_LIVE_UNAVAILABLE = /Live status updates unavailable/i;
const RE_RECONNECT_EXHAUSTED = /Reconnect attempts exhausted/i;

const defaultSidebar = { open: true };

const onlineTarget = {
  id: "ct-local",
  machineName: "my-mac",
  platform: "macOS",
  isOnline: true,
  organizationId: "org-1",
  userId: "user-1",
  capabilities: {},
  supportedOperations: [],
  lastSeenAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const offlineTarget = {
  ...onlineTarget,
  id: "ct-offline",
  isOnline: false,
};

describe("ComputeTargetPopover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUser.mockReturnValue({ user: { id: "user-1" } });
    mockUseSidebar.mockReturnValue(defaultSidebar);
    mockUseComputeTargets.mockReturnValue({ data: [], isLoading: false });
    mockUseComputePreference.mockReturnValue({
      data: { preferredComputeMode: "CLOUD" },
      isLoading: false,
    });
    mockMutate.mockReset();
    mockUseSetComputePreference.mockReturnValue({
      mutate: mockMutate,
      isPending: false,
    });
    mockUseComputeTargetStatusStream.mockReturnValue(undefined);
  });

  describe("default render", () => {
    it("shows Cloud option", () => {
      render(<ComputeTargetPopover />);

      expect(
        screen.getByRole("button", { name: RE_SELECT_CLOUD })
      ).toBeInTheDocument();
    });

    it("shows Local option when targets are registered", () => {
      mockUseComputeTargets.mockReturnValue({
        data: [onlineTarget],
        isLoading: false,
      });

      render(<ComputeTargetPopover />);

      expect(
        screen.getByRole("button", { name: RE_SELECT_MY_MAC })
      ).toBeInTheDocument();
    });

    it("shows Local option with not-installed state when no targets", () => {
      render(<ComputeTargetPopover />);

      expect(
        screen.getByRole("button", { name: RE_SELECT_LOCAL })
      ).toBeInTheDocument();
    });

    it("trigger label shows Compute: Cloud when preference is Cloud", () => {
      render(<ComputeTargetPopover />);

      const trigger = screen.getByTestId("sidebar-menu-button");
      expect(trigger).toHaveAttribute("aria-label", "Compute: Cloud");
    });

    it("trigger label shows Compute: Local when preference is Local with online target", () => {
      mockUseComputeTargets.mockReturnValue({
        data: [onlineTarget],
        isLoading: false,
      });
      mockUseComputePreference.mockReturnValue({
        data: { preferredComputeMode: "LOCAL" },
        isLoading: false,
      });

      render(<ComputeTargetPopover />);

      const trigger = screen.getByTestId("sidebar-menu-button");
      expect(trigger).toHaveAttribute("aria-label", "Compute: my-mac");
    });
  });

  describe("popover open/close", () => {
    it("popover content is always rendered (controlled by open prop)", () => {
      render(<ComputeTargetPopover />);

      expect(screen.getByTestId("popover-content")).toBeInTheDocument();
    });

    it("popover data-open starts as false", () => {
      render(<ComputeTargetPopover />);

      const popover = screen.getByTestId("popover");
      expect(popover).toHaveAttribute("data-open", "false");
    });
  });

  describe("selection calls setComputePreference", () => {
    it("clicking Cloud option calls mutate with CLOUD", async () => {
      const user = userEvent.setup();
      mockUseComputeTargets.mockReturnValue({
        data: [onlineTarget],
        isLoading: false,
      });
      mockUseComputePreference.mockReturnValue({
        data: { preferredComputeMode: "LOCAL" },
        isLoading: false,
      });

      render(<ComputeTargetPopover />);

      await user.click(screen.getByRole("button", { name: RE_SELECT_CLOUD }));

      expect(mockMutate).toHaveBeenCalledWith("CLOUD");
    });

    it("clicking an online local target calls mutate with LOCAL", async () => {
      const user = userEvent.setup();
      mockUseComputeTargets.mockReturnValue({
        data: [onlineTarget],
        isLoading: false,
      });
      mockUseComputePreference.mockReturnValue({
        data: { preferredComputeMode: "CLOUD" },
        isLoading: false,
      });

      render(<ComputeTargetPopover />);

      await user.click(screen.getByRole("button", { name: RE_SELECT_MY_MAC }));

      expect(mockMutate).toHaveBeenCalledWith("LOCAL");
    });
  });

  describe("download prompt: zero targets", () => {
    it("clicking Local (not installed) shows download prompt and popover stays open", async () => {
      const user = userEvent.setup();
      // No targets registered
      mockUseComputeTargets.mockReturnValue({ data: [], isLoading: false });

      render(<ComputeTargetPopover />);

      await user.click(screen.getByRole("button", { name: RE_SELECT_LOCAL }));

      // Download prompt visible
      expect(screen.getByText(RE_INSTALL_DESKTOP)).toBeInTheDocument();
      expect(screen.getByText(RE_LOCAL_COMPUTE_REQUIRES)).toBeInTheDocument();

      // Preference was NOT changed
      expect(mockMutate).not.toHaveBeenCalled();

      // Popover did not close (mock popover still reflects open=false since setOpen not called by component)
      const popover = screen.getByTestId("popover");
      expect(popover).toHaveAttribute("data-open", "false");
    });
  });

  describe("offline warning: all targets offline", () => {
    it("shows offline warning banner and popover stays rendered when local is preferred and all offline", () => {
      mockUseComputeTargets.mockReturnValue({
        data: [offlineTarget],
        isLoading: false,
      });
      mockUseComputePreference.mockReturnValue({
        data: { preferredComputeMode: "LOCAL" },
        isLoading: false,
      });

      render(<ComputeTargetPopover />);

      expect(screen.getByText(RE_DESKTOP_OFFLINE)).toBeInTheDocument();
      expect(screen.getByText(RE_NOT_REACHABLE)).toBeInTheDocument();

      // Popover content still present
      expect(screen.getByTestId("popover-content")).toBeInTheDocument();
    });

    it("does not show offline banner when cloud is preferred", () => {
      mockUseComputeTargets.mockReturnValue({
        data: [offlineTarget],
        isLoading: false,
      });
      mockUseComputePreference.mockReturnValue({
        data: { preferredComputeMode: "CLOUD" },
        isLoading: false,
      });

      render(<ComputeTargetPopover />);

      expect(screen.queryByText(RE_DESKTOP_OFFLINE)).toBeNull();
    });
  });

  describe("SSE stream-failed: degraded indicator", () => {
    it("shows amber degraded indicator (not green Online) when streamReconnectAttempts >= 3", () => {
      render(<ComputeTargetPopover streamReconnectAttempts={3} />);

      // Degraded banner with SSE exhausted message is visible
      expect(screen.getByText(RE_LIVE_UNAVAILABLE)).toBeInTheDocument();
      expect(screen.getByText(RE_RECONNECT_EXHAUSTED)).toBeInTheDocument();

      // Trigger icon should be the degraded (AlertTriangle) variant — assert via aria-label
      expect(screen.getByLabelText("SSE stream degraded")).toBeInTheDocument();

      // No "Online" indicator present — degraded state replaces green Online
      expect(screen.queryByText("Online")).toBeNull();
    });

    it("does not show degraded banner when attempts < 3", () => {
      render(<ComputeTargetPopover streamReconnectAttempts={2} />);

      expect(screen.queryByText(RE_LIVE_UNAVAILABLE)).toBeNull();
    });

    it("onExhausted mock: degraded indicator visible after prop update to exhausted count", () => {
      // Simulate parent tracking reconnect attempts and passing the count down.
      // The component becomes degraded at >= SSE_MAX_RECONNECT_ATTEMPTS (3).
      const { rerender } = render(
        <ComputeTargetPopover streamReconnectAttempts={2} />
      );

      // Not yet degraded
      expect(screen.queryByText(RE_LIVE_UNAVAILABLE)).toBeNull();

      // Parent increments to 3 (exhausted)
      rerender(<ComputeTargetPopover streamReconnectAttempts={3} />);

      // Now shows degraded grey indicator — NOT green Online
      expect(screen.getByText(RE_LIVE_UNAVAILABLE)).toBeInTheDocument();
      expect(screen.getByLabelText("SSE stream degraded")).toBeInTheDocument();
    });
  });
});
