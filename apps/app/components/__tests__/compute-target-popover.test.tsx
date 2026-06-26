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
const mockUseFeatureFlagEnabled = vi.fn();
const mockMutate = vi.fn();
const mockUseComputeTargetStatusStream = vi.fn();
const mockUseComputeTargetHealthCheckSnapshot = vi.fn();
const mockUseUpdateComputeTargetHarness = vi.fn();
const mockUpdateHarnessMutate = vi.fn();

// Regex patterns at top level to avoid performance issues
const SELECT_NEWER_MAC_PATTERN = /Select newer-mac compute target/i;
const SELECT_OLDER_MAC_PATTERN = /Select older-mac compute target/i;
const AVAILABLE_TARGETS_PATTERN = /Available compute targets/i;
const LAUNCH_DESKTOP_APP_PATTERN = /Launch Desktop App/i;
const RE_CHANGE_HARNESS = /change-harness/i;

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

vi.mock("@repo/app/compute/hooks/use-compute-preference", () => ({
  useComputePreference: (...args: unknown[]) =>
    mockUseComputePreference(...args),
  useSetComputePreference: (...args: unknown[]) =>
    mockUseSetComputePreference(...args),
}));

vi.mock("@/hooks/queries/use-compute-targets", () => ({
  useComputeTargets: (...args: unknown[]) => mockUseComputeTargets(...args),
  useComputeTargetHealthCheckSnapshot: (...args: unknown[]) =>
    mockUseComputeTargetHealthCheckSnapshot(...args),
  useUpdateComputeTargetHarness: (...args: unknown[]) =>
    mockUseUpdateComputeTargetHarness(...args),
}));

// Stand-in HarnessSelector: surfaces the props the popover computes and lets a
// test trigger a harness change deterministically (no Radix internals). The
// real pure helpers (deriveAvailableHarnessesFromSnapshot, resolveDefaultHarness)
// are kept so the popover's availability/selection logic is exercised for real.
vi.mock("@/components/engineer/harness-selector", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/components/engineer/harness-selector")
    >();
  return {
    ...original,
    HarnessSelector: ({
      availableHarnesses,
      selectedHarness,
      onHarnessChange,
    }: {
      availableHarnesses: HarnessType[];
      selectedHarness: HarnessType;
      onHarnessChange: (harness: HarnessType) => void;
    }) => (
      <div
        data-available={availableHarnesses.join(",")}
        data-selected={selectedHarness}
        data-testid="harness-selector"
      >
        <button
          onClick={() => onHarnessChange(HarnessType.Codex)}
          type="button"
        >
          change-harness
        </button>
      </div>
    ),
  };
});

vi.mock("@/hooks/queries/use-compute-target-status-stream", () => ({
  useComputeTargetStatusStream: (...args: unknown[]) =>
    mockUseComputeTargetStatusStream(...args),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (...args: unknown[]) =>
    mockUseFeatureFlagEnabled(...args),
}));

import {
  type ComputeTargetHealthCheckSnapshot,
  EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY,
  HARNESS_SELECTION_FEATURE_FLAG_KEY,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import type React from "react";
import { ComputeTargetPopover } from "../compute-target-popover";

const RE_SELECT_CLOUD = /Select Cloud compute target/i;
const RE_SELECT_LOCAL = /Select Local compute target/i;
const RE_SELECT_MY_MAC = /Select my-mac compute target/i;
const RE_INSTALL_DESKTOP = /Install Desktop App/i;
const RE_LOCAL_COMPUTE_REQUIRES =
  /Local compute requires the Closedloop Desktop app/i;
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
    mockUseFeatureFlagEnabled.mockReturnValue(false);
    mockMutate.mockReset();
    mockUseSetComputePreference.mockReturnValue({
      mutate: mockMutate,
      isPending: false,
    });
    mockUseComputeTargetStatusStream.mockReturnValue(undefined);
    mockUpdateHarnessMutate.mockReset();
    mockUseUpdateComputeTargetHarness.mockReturnValue({
      mutate: mockUpdateHarnessMutate,
    });
    mockUseComputeTargetHealthCheckSnapshot.mockReturnValue({ data: null });
  });

  // Enable the explicit-selection and harness-selection flags independently.
  function setFlags({
    explicit,
    harness,
  }: {
    explicit: boolean;
    harness: boolean;
  }) {
    mockUseFeatureFlagEnabled.mockImplementation((key: string) => {
      if (key === EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY) {
        return explicit;
      }
      if (key === HARNESS_SELECTION_FEATURE_FLAG_KEY) {
        return harness;
      }
      return false;
    });
  }

  function snapshotWith(harnesses: HarnessType[]): {
    data: ComputeTargetHealthCheckSnapshot;
  } {
    const mcpServers: Record<string, { available: boolean }> = {};
    for (const harness of harnesses) {
      mcpServers[harness] = { available: true };
    }
    // Partial fixture — deriveAvailableHarnessesFromSnapshot only reads
    // result.mcpServers.
    return {
      data: { result: { mcpServers } } as ComputeTargetHealthCheckSnapshot,
    };
  }

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

      expect(mockMutate).toHaveBeenCalledWith({ mode: "CLOUD" });
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

      expect(mockMutate).toHaveBeenCalledWith({
        mode: "LOCAL",
        computeTargetId: "ct-local",
      });
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

      expect(screen.getByTestId("sidebar-menu-button")).toHaveAttribute(
        "aria-label",
        "Compute: Local offline"
      );
      expect(screen.getByText(RE_DESKTOP_OFFLINE)).toBeInTheDocument();
      expect(screen.getByText(RE_NOT_REACHABLE)).toBeInTheDocument();
      expect(screen.getByTestId("offline-remediation-actions")).toHaveClass(
        "flex-col"
      );
      expect(
        screen.getByRole("button", { name: LAUNCH_DESKTOP_APP_PATTERN })
      ).toHaveClass("w-full");

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

    it("does not render inferred Cloud as selected when explicit selection is required", () => {
      mockUseFeatureFlagEnabled.mockReturnValue(true);
      mockUseComputeTargets.mockReturnValue({
        data: [offlineTarget],
        isLoading: false,
      });
      mockUseComputePreference.mockReturnValue({
        data: { preferredComputeMode: "CLOUD", isExplicit: false },
        isLoading: false,
      });

      render(<ComputeTargetPopover />);

      expect(screen.getByTestId("sidebar-menu-button")).toHaveAttribute(
        "aria-label",
        "Select target"
      );
      expect(
        screen.getByRole("button", { name: RE_SELECT_CLOUD })
      ).toHaveAttribute("aria-pressed", "false");
    });
  });

  describe("checkmark: only one target selected when multiple are online", () => {
    const olderOnlineTarget = {
      ...onlineTarget,
      id: "ct-older",
      machineName: "older-mac",
      lastSeenAt: new Date("2024-01-01T00:00:00Z"),
    };
    const newerOnlineTarget = {
      ...onlineTarget,
      id: "ct-newer",
      machineName: "newer-mac",
      lastSeenAt: new Date("2024-06-01T00:00:00Z"),
    };

    it("selects the most-recently-active target when no computeTargetId is persisted", () => {
      mockUseComputeTargets.mockReturnValue({
        data: [olderOnlineTarget, newerOnlineTarget],
        isLoading: false,
      });
      mockUseComputePreference.mockReturnValue({
        data: { preferredComputeMode: "LOCAL" },
        isLoading: false,
      });

      render(<ComputeTargetPopover />);

      const newerButton = screen.getByRole("button", {
        name: SELECT_NEWER_MAC_PATTERN,
      });
      const olderButton = screen.getByRole("button", {
        name: SELECT_OLDER_MAC_PATTERN,
      });

      expect(newerButton).toHaveAttribute("aria-pressed", "true");
      expect(olderButton).toHaveAttribute("aria-pressed", "false");
    });

    it("exactly one target has aria-pressed true when multiple are online", () => {
      mockUseComputeTargets.mockReturnValue({
        data: [olderOnlineTarget, newerOnlineTarget],
        isLoading: false,
      });
      mockUseComputePreference.mockReturnValue({
        data: { preferredComputeMode: "LOCAL" },
        isLoading: false,
      });

      render(<ComputeTargetPopover />);

      // All TargetOption buttons within the listbox
      const listbox = screen.getByRole("listbox", {
        name: AVAILABLE_TARGETS_PATTERN,
      });
      const allButtons = Array.from(
        listbox.querySelectorAll("button[aria-pressed]")
      );
      const selectedButtons = allButtons.filter(
        (btn) => btn.getAttribute("aria-pressed") === "true"
      );

      expect(selectedButtons).toHaveLength(1);
    });

    it("selects the persisted computeTargetId even when a newer target exists", () => {
      mockUseComputeTargets.mockReturnValue({
        data: [olderOnlineTarget, newerOnlineTarget],
        isLoading: false,
      });
      mockUseComputePreference.mockReturnValue({
        data: {
          preferredComputeMode: "LOCAL",
          computeTargetId: "ct-older",
        },
        isLoading: false,
      });

      render(<ComputeTargetPopover />);

      const olderButton = screen.getByRole("button", {
        name: SELECT_OLDER_MAC_PATTERN,
      });
      const newerButton = screen.getByRole("button", {
        name: SELECT_NEWER_MAC_PATTERN,
      });

      expect(olderButton).toHaveAttribute("aria-pressed", "true");
      expect(newerButton).toHaveAttribute("aria-pressed", "false");
    });

    it("falls back to most-recently-active when persisted target is offline", () => {
      const offlineTarget = {
        ...onlineTarget,
        id: "ct-offline",
        machineName: "offline-mac",
        isOnline: false,
        lastSeenAt: new Date("2023-01-01T00:00:00Z"),
      };
      mockUseComputeTargets.mockReturnValue({
        data: [offlineTarget, olderOnlineTarget, newerOnlineTarget],
        isLoading: false,
      });
      mockUseComputePreference.mockReturnValue({
        data: {
          preferredComputeMode: "LOCAL",
          computeTargetId: "ct-offline",
        },
        isLoading: false,
      });

      render(<ComputeTargetPopover />);

      const newerButton = screen.getByRole("button", {
        name: SELECT_NEWER_MAC_PATTERN,
      });
      const olderButton = screen.getByRole("button", {
        name: SELECT_OLDER_MAC_PATTERN,
      });

      expect(newerButton).toHaveAttribute("aria-pressed", "true");
      expect(olderButton).toHaveAttribute("aria-pressed", "false");
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

  describe("AI harness section", () => {
    const localTarget = {
      ...onlineTarget,
      id: "ct-local",
      selectedHarness: HarnessType.Claude,
    };

    it("Cloud selection renders a Claude/Codex picker and routes change to setComputePreference", async () => {
      const user = userEvent.setup();
      setFlags({ explicit: true, harness: true });
      mockUseComputeTargets.mockReturnValue({ data: [], isLoading: false });
      mockUseComputePreference.mockReturnValue({
        data: {
          preferredComputeMode: "CLOUD",
          isExplicit: true,
          selectedHarness: HarnessType.Claude,
        },
        isLoading: false,
      });

      render(<ComputeTargetPopover />);

      const selector = screen.getByTestId("harness-selector");
      expect(selector).toHaveAttribute(
        "data-available",
        `${HarnessType.Claude},${HarnessType.Codex}`
      );
      expect(selector).toHaveAttribute("data-selected", HarnessType.Claude);

      await user.click(screen.getByRole("button", { name: RE_CHANGE_HARNESS }));

      expect(mockMutate).toHaveBeenCalledWith({
        mode: "CLOUD",
        selectedHarness: HarnessType.Codex,
      });
      expect(mockUpdateHarnessMutate).not.toHaveBeenCalled();
    });

    it("Local target with a two-harness snapshot routes change to updateComputeTargetHarness", async () => {
      const user = userEvent.setup();
      setFlags({ explicit: true, harness: true });
      mockUseComputeTargets.mockReturnValue({
        data: [localTarget],
        isLoading: false,
      });
      mockUseComputePreference.mockReturnValue({
        data: {
          preferredComputeMode: "LOCAL",
          isExplicit: true,
          computeTargetId: "ct-local",
        },
        isLoading: false,
      });
      mockUseComputeTargetHealthCheckSnapshot.mockReturnValue(
        snapshotWith([HarnessType.Claude, HarnessType.Codex])
      );

      render(<ComputeTargetPopover />);

      const selector = screen.getByTestId("harness-selector");
      expect(selector).toHaveAttribute(
        "data-available",
        `${HarnessType.Claude},${HarnessType.Codex}`
      );

      await user.click(screen.getByRole("button", { name: RE_CHANGE_HARNESS }));

      expect(mockUpdateHarnessMutate).toHaveBeenCalledWith({
        id: "ct-local",
        harness: HarnessType.Codex,
      });
      expect(mockMutate).not.toHaveBeenCalled();
    });

    it("Local target with a single-harness snapshot offers only that harness", () => {
      setFlags({ explicit: true, harness: true });
      mockUseComputeTargets.mockReturnValue({
        data: [localTarget],
        isLoading: false,
      });
      mockUseComputePreference.mockReturnValue({
        data: {
          preferredComputeMode: "LOCAL",
          isExplicit: true,
          computeTargetId: "ct-local",
        },
        isLoading: false,
      });
      mockUseComputeTargetHealthCheckSnapshot.mockReturnValue(
        snapshotWith([HarnessType.Claude])
      );

      render(<ComputeTargetPopover />);

      expect(screen.getByTestId("harness-selector")).toHaveAttribute(
        "data-available",
        HarnessType.Claude
      );
    });

    it("hides the harness section when harness-selection is OFF", () => {
      setFlags({ explicit: true, harness: false });
      mockUseComputePreference.mockReturnValue({
        data: { preferredComputeMode: "CLOUD", isExplicit: true },
        isLoading: false,
      });

      render(<ComputeTargetPopover />);

      expect(screen.queryByTestId("harness-selector")).toBeNull();
    });

    it("hides the harness section when explicit-compute-selection is OFF (existing behavior unchanged)", () => {
      setFlags({ explicit: false, harness: true });
      mockUseComputePreference.mockReturnValue({
        data: { preferredComputeMode: "CLOUD", isExplicit: true },
        isLoading: false,
      });

      render(<ComputeTargetPopover />);

      expect(screen.queryByTestId("harness-selector")).toBeNull();
      // Existing Cloud control still rendered.
      expect(
        screen.getByRole("button", { name: RE_SELECT_CLOUD })
      ).toBeInTheDocument();
    });
  });
});
