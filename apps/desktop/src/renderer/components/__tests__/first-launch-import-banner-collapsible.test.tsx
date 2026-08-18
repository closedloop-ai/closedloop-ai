import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MaintenancePhase } from "../../../shared/maintenance-progress-contract";
import { installLocalStorage } from "../../__tests__/local-storage-fixture";
import type {
  IngestProgress,
  MaintenanceProgress,
} from "../../hooks/use-ingest-progress";
import { FirstLaunchImportBanner } from "../first-launch-import-banner";

// Same arrangement as the sibling banner suites: the splash's visibility comes
// entirely from the ingest + maintenance hooks, so mocking them makes every
// phase reachable without a live runtime.
const hooks = vi.hoisted(() => ({
  useIngestProgress: vi.fn(),
  useMaintenanceProgress: vi.fn(),
}));
vi.mock("../../hooks/use-ingest-progress", () => ({
  useIngestProgress: hooks.useIngestProgress,
  useMaintenanceProgress: hooks.useMaintenanceProgress,
}));

const STORAGE_KEY = "closedloop.desktop.import-splash.collapsed";
const HIDE_DETAILS_NAME = /hide import details/i;
const SHOW_DETAILS_NAME = /show import details/i;
const PAUSE_NAME = /^pause import$/i;
const RESUME_NAME = /^resume import$/i;
const DISMISS_NAME = /^dismiss$/i;
const OVERALL_PROGRESS_NAME = /overall import progress/i;

const THIRTY_PERCENT_TEXT = /30%/;
// MAINTENANCE_BRIDGE_MS in the component — how long the splash holds at Ready
// waiting for maintenance to appear before it dismisses itself.
const MAINTENANCE_BRIDGE_MS = 2500;
// STALL_GIVE_UP_MS / STALL_CHECK_INTERVAL_MS in the component.
const STALL_GIVE_UP_MS = 120_000;

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

// The renderer jsdom environment ships no usable `Storage`; the shared fixture
// installs an in-memory one (same fixture the app-shell sidebar suite uses).
let restoreLocalStorage: () => void = () => undefined;

function ingest(overrides: Partial<IngestProgress> = {}): IngestProgress {
  return {
    byHarness: [{ harness: "codex", total: 60, processed: 18 }],
    total: 60,
    processed: 18,
    preparing: false,
    complete: false,
    timedOut: false,
    ...overrides,
  };
}

function maintenance(active: boolean): MaintenanceProgress {
  return active
    ? { active: true, phase: MaintenancePhase.ArtifactLinks }
    : { active: false, phase: null };
}

function collapse(): void {
  fireEvent.click(screen.getByRole("button", { name: HIDE_DETAILS_NAME }));
}

beforeEach(() => {
  restoreLocalStorage = installLocalStorage();
  hooks.useIngestProgress.mockReturnValue(ingest());
  hooks.useMaintenanceProgress.mockReturnValue(maintenance(false));
});

afterEach(() => {
  cleanup();
  hooks.useIngestProgress.mockReset();
  hooks.useMaintenanceProgress.mockReset();
  vi.useRealTimers();
  restoreLocalStorage();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  Reflect.deleteProperty(window, "desktopApi");
});

describe("collapsible import splash (ISS-5258)", () => {
  it("honours a stored collapse with no feature-flag provider mounted", () => {
    // ISS-6118 retired `collapsible-import-splash` ENABLED. The banner reads no
    // flags at all now, so a bare mount — no `FeatureFlagAdapterProvider` — must
    // both render the disclosure and apply the stored preference. Before the
    // retirement this exact mount fell back to the flag-off default and came up
    // expanded with no control, so the assertion fails on the retired branch.
    window.localStorage.setItem(STORAGE_KEY, "true");
    render(<FirstLaunchImportBanner />);

    expect(
      screen.getByRole("button", { name: SHOW_DETAILS_NAME })
    ).toBeDefined();
    expect(
      screen.queryByRole("list", { name: "Import progress steps" })
    ).toBeNull();
  });

  it("collapses to the compact row and expands back to the per-source breakdown", () => {
    render(<FirstLaunchImportBanner />);

    // Expanded: the disclosure control reports itself expanded and points at
    // the panel it controls.
    const hide = screen.getByRole("button", { name: HIDE_DETAILS_NAME });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    const panelId = hide.getAttribute("aria-controls");
    expect(panelId).not.toBeNull();
    expect(document.getElementById(panelId ?? "")).not.toBeNull();
    expect(
      screen.getByRole("list", { name: "Import progress steps" })
    ).toBeDefined();

    collapse();

    // Collapsed: the compact essentials survive, the breakdown does not.
    const show = screen.getByRole("button", { name: SHOW_DETAILS_NAME });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Importing your agent history")).toBeDefined();
    expect(screen.getByText("18 / 60 transcripts")).toBeDefined();
    expect(screen.getByRole("button", { name: PAUSE_NAME })).toBeDefined();
    expect(
      screen.getByRole("progressbar", { name: OVERALL_PROGRESS_NAME })
    ).toBeDefined();
    expect(
      screen.queryByRole("list", { name: "Import progress steps" })
    ).toBeNull();
    expect(screen.queryByText("Codex")).toBeNull();

    fireEvent.click(show);

    expect(
      screen.getByRole("list", { name: "Import progress steps" })
    ).toBeDefined();
    expect(screen.getByText("Codex")).toBeDefined();
  });

  it("keeps the collapse across a remount, and re-expanding across one too", () => {
    const { unmount } = render(<FirstLaunchImportBanner />);
    collapse();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("true");

    // Remount is what navigating away and back does to this subtree.
    unmount();
    render(<FirstLaunchImportBanner />);
    expect(
      screen.getByRole("button", { name: SHOW_DETAILS_NAME })
    ).toBeDefined();
    expect(
      screen.queryByRole("list", { name: "Import progress steps" })
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: SHOW_DETAILS_NAME }));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("false");

    cleanup();
    render(<FirstLaunchImportBanner />);
    expect(
      screen.getByRole("button", { name: HIDE_DETAILS_NAME })
    ).toBeDefined();
    expect(
      screen.getByRole("list", { name: "Import progress steps" })
    ).toBeDefined();
  });

  it("says the import is paused while collapsed, and resumes from there", () => {
    const setAgentMonitorImportPaused = vi.fn(() => Promise.resolve());
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { setAgentMonitorImportPaused },
    });
    render(<FirstLaunchImportBanner />);

    fireEvent.click(screen.getByRole("button", { name: PAUSE_NAME }));
    collapse();

    // Collapsing is opting out of DETAIL, not out of the fact that nothing is
    // advancing. A frozen "30%" on its own would read as stalled or as working.
    expect(screen.getByText("Import paused")).toBeDefined();
    expect(screen.queryByText("Importing your agent history")).toBeNull();
    expect(screen.getByRole("button", { name: RESUME_NAME })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: RESUME_NAME }));
    expect(setAgentMonitorImportPaused).toHaveBeenLastCalledWith(false);
    expect(screen.getByText("Importing your agent history")).toBeDefined();
  });

  it("keeps a failed import visible while collapsed, without a cheerful percentage", () => {
    hooks.useIngestProgress.mockReturnValue(ingest({ timedOut: true }));
    render(<FirstLaunchImportBanner />);

    // The main-process watchdog signal surfaces the partial-import state
    // immediately; collapse from there.
    expect(screen.getByText("Import didn't finish")).toBeDefined();
    collapse();

    expect(screen.getByText("Import didn't finish")).toBeDefined();
    expect(screen.getByText("18 / 60 transcripts")).toBeDefined();
    expect(screen.queryByText(THIRTY_PERCENT_TEXT)).toBeNull();
    expect(
      screen.queryByRole("progressbar", { name: OVERALL_PROGRESS_NAME })
    ).toBeNull();
  });

  it("surfaces a stall that trips while the splash is already collapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
    render(<FirstLaunchImportBanner />);
    collapse();
    expect(screen.getByText("Importing your agent history")).toBeDefined();

    act(() => {
      vi.advanceTimersByTime(STALL_GIVE_UP_MS);
    });

    // Bad news reaches a user who collapsed the panel before it happened.
    expect(screen.getByText("Import didn't finish")).toBeDefined();
  });

  it("still dismisses itself at Ready when the user left it collapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
    const { rerender } = render(<FirstLaunchImportBanner />);
    collapse();

    hooks.useIngestProgress.mockReturnValue(
      ingest({
        byHarness: [{ harness: "codex", total: 60, processed: 60 }],
        complete: true,
        processed: 60,
      })
    );
    rerender(<FirstLaunchImportBanner />);
    // Ready is reached in the compact form and states what landed.
    expect(screen.getByText("60 transcripts imported")).toBeDefined();

    act(() => {
      vi.advanceTimersByTime(MAINTENANCE_BRIDGE_MS + 1);
    });

    const wrapper = screen.getByTestId("first-launch-import-banner");
    expect(wrapper.getAttribute("aria-hidden")).toBe("true");
    expect(wrapper.className).toContain("opacity-0");
  });

  it("moves focus to the counterpart control so the disclosure reads as one", () => {
    render(<FirstLaunchImportBanner />);

    const hide = screen.getByRole("button", { name: HIDE_DETAILS_NAME });
    hide.focus();
    fireEvent.click(hide);

    // The pressed button unmounted with its own subtree; without this a
    // keyboard user is dropped onto <body> and tabs from the top of the app.
    const show = screen.getByRole("button", { name: SHOW_DETAILS_NAME });
    expect(document.activeElement).toBe(show);

    fireEvent.click(show);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: HIDE_DETAILS_NAME })
    );
  });

  it("does not steal focus when it mounts collapsed from a stored choice", () => {
    window.localStorage.setItem(STORAGE_KEY, "true");
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();

    render(<FirstLaunchImportBanner />);

    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("keeps the way out of a failed import while collapsed", () => {
    hooks.useIngestProgress.mockReturnValue(ingest({ timedOut: true }));
    render(<FirstLaunchImportBanner />);
    collapse();

    // The expanded panel pairs the failure with a way out; a collapsed failure
    // must not become a red row the user cannot dismiss. Collapsed the control
    // says "Dismiss", because that is what it does to the strip in front of
    // the user -- "Continue to dashboard" named a place they are already looking at.
    fireEvent.click(screen.getByRole("button", { name: DISMISS_NAME }));

    const wrapper = screen.getByTestId("first-launch-import-banner");
    expect(wrapper.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps the rail sweeping through Compute even after an earlier pause", () => {
    const setAgentMonitorImportPaused = vi.fn(() => Promise.resolve());
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { setAgentMonitorImportPaused },
    });
    const { rerender } = render(<FirstLaunchImportBanner />);
    fireEvent.click(screen.getByRole("button", { name: PAUSE_NAME }));
    collapse();

    // The in-flight batch finishes anyway, and post-boot maintenance starts.
    hooks.useIngestProgress.mockReturnValue(
      ingest({
        byHarness: [{ harness: "codex", total: 60, processed: 60 }],
        complete: true,
        processed: 60,
      })
    );
    hooks.useMaintenanceProgress.mockReturnValue(maintenance(true));
    rerender(<FirstLaunchImportBanner />);

    // Pause governs the import collector, and there is nothing left to pause —
    // the expanded body keeps sweeping here, so the collapsed rail must too.
    // A held rail would read as hung on the exact same import.
    const rail = screen.getByRole("progressbar", {
      name: OVERALL_PROGRESS_NAME,
    });
    expect(rail.getAttribute("data-paused")).toBeNull();
  });
});
