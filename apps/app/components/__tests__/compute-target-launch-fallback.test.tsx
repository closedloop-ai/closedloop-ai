import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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
const mockUseLatestElectronRelease = vi.fn();

const LAUNCH_DESKTOP_APP_PATTERN = /Launch Desktop App/i;
const RE_OPENING_DESKTOP = /Opening desktop app/i;
const RE_STILL_NO_RESPONSE = /Still no response from the desktop app/i;
const RE_DOWNLOAD_UPDATE = /Download update/i;

const originalLocation = globalThis.location;

vi.mock("@repo/auth/client", () => ({
  useUser: () => mockUseUser(),
}));

vi.mock("@repo/design-system/components/ui/sidebar", async () => {
  const fixtures = await import("./compute-target-popover-fixtures");
  return {
    SidebarMenuButton: fixtures.SidebarMenuButtonStub,
    useSidebar: () => mockUseSidebar(),
  };
});

vi.mock("@repo/design-system/components/ui/popover", async () => {
  const fixtures = await import("./compute-target-popover-fixtures");
  return {
    Popover: fixtures.PopoverStub,
    PopoverContent: fixtures.PopoverContentStub,
    PopoverTrigger: fixtures.PopoverTriggerStub,
  };
});

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

vi.mock("@/hooks/queries/use-compute-target-status-stream", () => ({
  useComputeTargetStatusStream: (...args: unknown[]) =>
    mockUseComputeTargetStatusStream(...args),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (...args: unknown[]) =>
    mockUseFeatureFlagEnabled(...args),
}));

vi.mock("@repo/app/desktop/hooks/use-electron-release", () => ({
  useLatestElectronRelease: (...args: unknown[]) =>
    mockUseLatestElectronRelease(...args),
}));

import { DESKTOP_DEEP_LINK_URL } from "@repo/api/src/types/desktop-deep-link";
import {
  DESKTOP_LAUNCH_FALLBACK_DELAY_MS,
  DESKTOP_LAUNCH_FALLBACK_FEATURE_FLAG_KEY,
  DESKTOP_LAUNCH_REACHABILITY_POLL_MS,
} from "@/hooks/use-desktop-launch-fallback";
import { ComputeTargetPopover } from "../compute-target-popover";
import {
  defaultSidebar,
  offlineTarget,
  onlineTarget,
  sharedOnlineTarget,
} from "./compute-target-popover-fixtures";

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
    mockUseLatestElectronRelease.mockReturnValue({
      data: null,
      isLoading: false,
    });
  });

  // ISS-6109. Firing `closedloop://` is unobservable from the browser: an
  // unregistered scheme no-ops with no error event, so a desktop build older
  // than the one that started registering the scheme leaves this button looking
  // successful while doing nothing. These drive the real click path and assert
  // the bounded verdict that replaces that silence.
  describe("launch fallback: nothing answered the deep link", () => {
    function renderOfflineWithLaunchFallback(options: {
      fallbackEnabled: boolean;
      targets?: unknown[];
      refetch?: () => Promise<unknown>;
    }) {
      mockUseComputeTargets.mockReturnValue({
        data: options.targets ?? [offlineTarget],
        isLoading: false,
        refetch: options.refetch,
      });
      mockUseComputePreference.mockReturnValue({
        data: { preferredComputeMode: "LOCAL" },
        isLoading: false,
      });
      mockUseFeatureFlagEnabled.mockImplementation(
        (key: string) =>
          key === DESKTOP_LAUNCH_FALLBACK_FEATURE_FLAG_KEY &&
          options.fallbackEnabled
      );
      return render(<ComputeTargetPopover />);
    }

    // `fireEvent`, not `userEvent`: user-event schedules its own timers, which
    // deadlock against the fake clock these tests need to drive the bound.
    function clickLaunch() {
      act(() => {
        fireEvent.click(
          screen.getByRole("button", { name: LAUNCH_DESKTOP_APP_PATTERN })
        );
      });
    }

    beforeEach(() => {
      vi.useFakeTimers();
      // jsdom throws on a real navigation; the deep link only needs to be
      // recorded, and the assertions below are about what the UI then reports.
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: { ...originalLocation, href: originalLocation.href },
        writable: true,
      });
    });

    afterEach(() => {
      vi.useRealTimers();
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: originalLocation,
        writable: true,
      });
    });

    it("fires the shared deep-link URL, not a re-spelled literal", () => {
      renderOfflineWithLaunchFallback({ fallbackEnabled: true });

      clickLaunch();

      expect(globalThis.location.href).toBe(DESKTOP_DEEP_LINK_URL);
    });

    it("reports waiting, then still-unreachable, once the bound elapses", async () => {
      renderOfflineWithLaunchFallback({ fallbackEnabled: true });

      clickLaunch();

      // Mid-flight the outcome is genuinely unknown, and the UI says so rather
      // than claiming either success or failure.
      expect(
        screen.getByRole("button", { name: RE_OPENING_DESKTOP })
      ).toBeDisabled();
      expect(screen.queryByTestId("desktop-launch-fallback")).toBeNull();

      await act(() => {
        vi.advanceTimersByTime(DESKTOP_LAUNCH_FALLBACK_DELAY_MS);
      });

      expect(screen.getByTestId("desktop-launch-fallback")).toBeInTheDocument();
      expect(screen.getByText(RE_STILL_NO_RESPONSE)).toBeInTheDocument();
    });

    it("offers the validated download URL as the next step", async () => {
      mockUseLatestElectronRelease.mockReturnValue({
        data: { downloadUrl: "https://github.com/example/Closedloop.dmg" },
        isLoading: false,
      });
      renderOfflineWithLaunchFallback({ fallbackEnabled: true });

      clickLaunch();
      await act(() => {
        vi.advanceTimersByTime(DESKTOP_LAUNCH_FALLBACK_DELAY_MS);
      });

      expect(
        screen.getByRole("link", { name: RE_DOWNLOAD_UPDATE })
      ).toHaveAttribute("href", "https://github.com/example/Closedloop.dmg");
    });

    it("stays silent before the bound elapses", async () => {
      renderOfflineWithLaunchFallback({ fallbackEnabled: true });

      clickLaunch();
      await act(() => {
        vi.advanceTimersByTime(DESKTOP_LAUNCH_FALLBACK_DELAY_MS - 1);
      });

      expect(screen.queryByTestId("desktop-launch-fallback")).toBeNull();
    });

    it("cancels the pending verdict when the desktop actually comes online", () => {
      const { rerender } = renderOfflineWithLaunchFallback({
        fallbackEnabled: true,
      });

      clickLaunch();
      expect(
        screen.getByRole("button", { name: RE_OPENING_DESKTOP })
      ).toBeDisabled();

      // The launch worked: a target reports online before the bound elapses.
      mockUseComputeTargets.mockReturnValue({
        data: [onlineTarget],
        isLoading: false,
      });
      act(() => {
        rerender(<ComputeTargetPopover />);
      });
      act(() => {
        vi.advanceTimersByTime(DESKTOP_LAUNCH_FALLBACK_DELAY_MS * 2);
      });

      // No "still no response" verdict may survive a launch that succeeded.
      expect(screen.queryByTestId("desktop-launch-fallback")).toBeNull();
    });

    it("blocks a second launch while the first is still pending", () => {
      renderOfflineWithLaunchFallback({ fallbackEnabled: true });

      clickLaunch();

      // The disabled pending button is what actually prevents a stacked wait —
      // `startLaunchAttempt`'s own clearPendingTimer() is defence behind it, not
      // the reachable guard. Pin the reachable one.
      const button = screen.getByRole("button", { name: RE_OPENING_DESKTOP });
      expect(button).toBeDisabled();
      fireEvent.click(button);

      act(() => {
        vi.advanceTimersByTime(DESKTOP_LAUNCH_FALLBACK_DELAY_MS);
      });

      // Exactly one verdict, timed from the one launch that was allowed.
      expect(screen.getAllByTestId("desktop-launch-fallback")).toHaveLength(1);
    });

    it("is closed by default: the flag off leaves the button exactly as it was", async () => {
      renderOfflineWithLaunchFallback({ fallbackEnabled: false });

      clickLaunch();

      // Asserted BEFORE any timer advance: the hook's own isAwaitingLaunch is
      // true right here, so only the `launchFallbackEnabled &&` gate on the prop
      // keeps the button idle. Checking only after the delay would pass even
      // with that gate deleted, because the timer resolves the flag back to
      // false on its own.
      expect(
        screen.getByRole("button", { name: LAUNCH_DESKTOP_APP_PATTERN })
      ).toBeEnabled();
      expect(screen.queryByText(RE_OPENING_DESKTOP)).toBeNull();
      await act(() => {
        vi.advanceTimersByTime(DESKTOP_LAUNCH_FALLBACK_DELAY_MS * 2);
      });

      expect(screen.queryByTestId("desktop-launch-fallback")).toBeNull();
      expect(
        screen.getByRole("button", { name: LAUNCH_DESKTOP_APP_PATTERN })
      ).toBeEnabled();
      // The deep link still fires — the flag gates the new reporting UI only,
      // never the fix itself.
      expect(globalThis.location.href).toBe(DESKTOP_DEEP_LINK_URL);
    });

    it("re-reads the user's own targets for the whole pending window", async () => {
      // The list is otherwise refreshed only by the status SSE, which is exactly
      // the signal that can be down when it matters (it backs off up to 30s
      // between reconnects and stops for good once its budget is spent). A
      // verdict taken off that cache reports a desktop that DID launch as never
      // answering.
      const refetch = vi.fn(() => Promise.resolve({}));
      renderOfflineWithLaunchFallback({ fallbackEnabled: true, refetch });

      expect(refetch).not.toHaveBeenCalled();

      clickLaunch();
      expect(refetch).toHaveBeenCalledTimes(1);

      await act(() => {
        vi.advanceTimersByTime(DESKTOP_LAUNCH_REACHABILITY_POLL_MS);
      });
      expect(refetch).toHaveBeenCalledTimes(2);

      await act(() => {
        vi.advanceTimersByTime(DESKTOP_LAUNCH_FALLBACK_DELAY_MS);
      });
      expect(screen.getByTestId("desktop-launch-fallback")).toBeInTheDocument();

      // The poll is scoped to the pending window and stops with it.
      const callsAtVerdict = refetch.mock.calls.length;
      await act(() => {
        vi.advanceTimersByTime(DESKTOP_LAUNCH_REACHABILITY_POLL_MS * 5);
      });
      expect(refetch).toHaveBeenCalledTimes(callsAtVerdict);
    });

    it("holds the verdict until a reachability read has actually settled", async () => {
      // Reaching the bound with nothing back yet is not evidence of anything.
      // Announcing "still no response" off a pre-click cache is the false
      // verdict this whole path exists to avoid.
      let settleRefetch: (() => void) | null = null;
      const pending = new Promise<unknown>((resolvePending) => {
        settleRefetch = () => resolvePending({});
      });
      renderOfflineWithLaunchFallback({
        fallbackEnabled: true,
        refetch: () => pending,
      });

      clickLaunch();
      await act(() => {
        vi.advanceTimersByTime(DESKTOP_LAUNCH_FALLBACK_DELAY_MS * 2);
      });

      expect(screen.queryByTestId("desktop-launch-fallback")).toBeNull();
      expect(
        screen.getByRole("button", { name: RE_OPENING_DESKTOP })
      ).toBeDisabled();

      await act(async () => {
        settleRefetch?.();
        await pending;
      });

      expect(screen.getByTestId("desktop-launch-fallback")).toBeInTheDocument();
    });

    it("keeps the verdict on screen when only a teammate's target reconnects", async () => {
      // `allOffline` spans EVERY target, so a shared machine coming online
      // clears the banner that hosts this control — unmounting the verdict while
      // the user's OWN desktop is still unreachable, which is the one thing the
      // owner-scoped reachability above is meant to prevent.
      const { rerender } = renderOfflineWithLaunchFallback({
        fallbackEnabled: true,
      });

      clickLaunch();
      await act(() => {
        vi.advanceTimersByTime(DESKTOP_LAUNCH_FALLBACK_DELAY_MS);
      });
      expect(screen.getByTestId("desktop-launch-fallback")).toBeInTheDocument();

      mockUseComputeTargets.mockReturnValue({
        data: [offlineTarget, sharedOnlineTarget],
        isLoading: false,
      });
      await act(() => {
        rerender(<ComputeTargetPopover />);
      });

      expect(screen.getByTestId("desktop-launch-fallback")).toBeInTheDocument();
    });

    it("does not fetch the desktop release until a launch is in flight", () => {
      // This popover lives in the global sidebar footer, so a gate any broader
      // than "an attempt is actually pending" fetches /electron-release on every
      // authenticated page for a Local user who never presses Launch.
      renderOfflineWithLaunchFallback({ fallbackEnabled: true });

      expect(mockUseLatestElectronRelease).toHaveBeenLastCalledWith({
        enabled: false,
      });

      clickLaunch();

      expect(mockUseLatestElectronRelease).toHaveBeenLastCalledWith({
        enabled: true,
      });
    });
  });
});
