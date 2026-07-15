import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IngestProgress,
  MaintenanceProgress,
} from "../../hooks/use-ingest-progress";
import { FirstLaunchImportBanner } from "../first-launch-import-banner";
import { progressFillWidth } from "./progress-bar-test-helpers";

// The banner's visibility is driven entirely by the ingest + maintenance hooks;
// mock both so each state (importing / settled / maintenance / absent) is
// reachable without a live runtime.
const hooks = vi.hoisted(() => ({
  useIngestProgress: vi.fn(),
  useMaintenanceProgress: vi.fn(),
}));
vi.mock("../../hooks/use-ingest-progress", () => ({
  useIngestProgress: hooks.useIngestProgress,
  useMaintenanceProgress: hooks.useMaintenanceProgress,
}));

function ingest(
  total: number,
  processed: number,
  preparing = false,
  complete = false
): IngestProgress {
  return {
    byHarness: total > 0 ? [{ harness: "codex", total, processed }] : [],
    total,
    processed,
    preparing,
    complete,
  };
}

function maintenance(
  active: boolean,
  phase: MaintenanceProgress["phase"] = active ? "artifact-links" : null
): MaintenanceProgress {
  return { active, phase };
}

// Bridge window (MAINTENANCE_BRIDGE_MS in the component) — how long the banner
// waits after the import settles for maintenance to appear before collapsing
// when none is reported. Mirrored here so the timing tests stay in lockstep.
const MAINTENANCE_BRIDGE_MS = 2500;

// Module-scoped so the matcher isn't recompiled per assertion (useTopLevelRegex).
const PAUSE_RESUME_LABEL = /pause|resume/i;
const SESSION_IMPORT_PROGRESS_LABEL = /session import progress/i;

function bannerWrapper(): HTMLElement {
  return screen.getByTestId("first-launch-import-banner");
}

function importProgressbar(): HTMLElement {
  return screen.getByRole("progressbar", {
    name: SESSION_IMPORT_PROGRESS_LABEL,
  });
}

// The pause test installs a desktopApi; capture whatever was there so each test
// starts from a clean global.
const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

beforeEach(() => {
  // Default to "no maintenance reported" so each test opts into a maintenance
  // state explicitly; an unset mock would otherwise return undefined and the
  // bridge timing would depend on call order.
  hooks.useMaintenanceProgress.mockReturnValue(null);
});

afterEach(() => {
  hooks.useIngestProgress.mockReset();
  hooks.useMaintenanceProgress.mockReset();
  vi.useRealTimers();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("FirstLaunchImportBanner", () => {
  it("shows the import state and counts while importing", () => {
    hooks.useIngestProgress.mockReturnValue(ingest(7183, 612));
    render(<FirstLaunchImportBanner />);

    const wrapper = bannerWrapper();
    expect(wrapper.className).toContain("opacity-100");
    expect(wrapper.getAttribute("aria-hidden")).toBe("false");
    expect(screen.getByText("Importing your agent history")).toBeTruthy();
    expect(screen.getByText("612 / 7,183 sessions")).toBeTruthy();
    expect(wrapper.textContent).toContain(
      "The app may be slow until this finishes."
    );
  });

  it("uses the imported over total ratio for fractional progress", () => {
    hooks.useIngestProgress.mockReturnValue(ingest(8, 1));
    render(<FirstLaunchImportBanner />);

    const progressbar = importProgressbar();
    expect(screen.getByText("1 / 8 sessions")).toBeTruthy();
    expect(progressbar.getAttribute("aria-valuemin")).toBe("0");
    expect(progressbar.getAttribute("aria-valuemax")).toBe("100");
    expect(progressbar.getAttribute("aria-valuenow")).toBe("12.5");
    expect(progressFillWidth(progressbar)).toBe("12.5%");
  });

  it("keeps progressbar value updates outside the live status region", () => {
    hooks.useIngestProgress.mockReturnValue(ingest(8, 1));
    render(<FirstLaunchImportBanner />);

    const liveStatus = screen.getByRole("status");
    expect(liveStatus.textContent).toContain("Importing your agent history");
    expect(importProgressbar().closest('[role="status"]')).toBeNull();
  });

  it("updates the numerator and fill while preserving the total", () => {
    hooks.useIngestProgress.mockReturnValue(ingest(8, 1));
    const view = render(<FirstLaunchImportBanner />);
    expect(screen.getByText("1 / 8 sessions")).toBeTruthy();
    expect(progressFillWidth(importProgressbar())).toBe("12.5%");

    hooks.useIngestProgress.mockReturnValue(ingest(8, 2));
    view.rerender(<FirstLaunchImportBanner />);

    expect(screen.getByText("2 / 8 sessions")).toBeTruthy();
    expect(progressFillWidth(importProgressbar())).toBe("25%");
  });

  it("shows an indeterminate scanning state before the total is known", () => {
    hooks.useIngestProgress.mockReturnValue(ingest(0, 0, true));
    render(<FirstLaunchImportBanner />);

    const wrapper = bannerWrapper();
    expect(wrapper.className).toContain("opacity-100");
    expect(screen.getByText("Importing your agent history")).toBeTruthy();
    expect(screen.getByText("Scanning your local logs…")).toBeTruthy();
    expect(importProgressbar().getAttribute("aria-valuenow")).toBe("0");
    expect(progressFillWidth(importProgressbar())).toBe("0%");
  });

  it("renders zero progress with an empty fill", () => {
    hooks.useIngestProgress.mockReturnValue(ingest(10, 0));
    render(<FirstLaunchImportBanner />);

    expect(screen.getByText("0 / 10 sessions")).toBeTruthy();
    expect(importProgressbar().getAttribute("aria-valuenow")).toBe("0");
    expect(progressFillWidth(importProgressbar())).toBe("0%");
  });

  it("floors negative processed counts at zero", () => {
    hooks.useIngestProgress.mockReturnValue(ingest(10, -2));
    render(<FirstLaunchImportBanner />);

    expect(screen.getByText("0 / 10 sessions")).toBeTruthy();
    expect(importProgressbar().getAttribute("aria-valuenow")).toBe("0");
    expect(progressFillWidth(importProgressbar())).toBe("0%");
  });

  it("stops after a preparing scan that finds nothing to import", () => {
    vi.useFakeTimers();
    // A normal launch scans (preparing) but the total never materialises.
    hooks.useIngestProgress.mockReturnValue(ingest(0, 0, true));
    const view = render(<FirstLaunchImportBanner />);
    expect(bannerWrapper().className).toContain("opacity-100");

    // Scan finishes having found zero pending sources: preparing clears, total
    // stays 0. The banner must not treat this as an import it saw.
    hooks.useIngestProgress.mockReturnValue(ingest(0, 0, false));
    view.rerender(<FirstLaunchImportBanner />);
    expect(bannerWrapper().className).toContain("opacity-0");

    // The no-import give-up must still fire (sawImport never latched), so the
    // banner stops polling instead of polling for the rest of the session.
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(hooks.useIngestProgress).toHaveBeenLastCalledWith(false);
  });

  it("stays collapsed for an already-settled store (ordinary launch)", () => {
    // total > 0 but processed === total and importing was never observed.
    hooks.useIngestProgress.mockReturnValue(ingest(7183, 7183));
    render(<FirstLaunchImportBanner />);

    const wrapper = bannerWrapper();
    expect(wrapper.className).toContain("opacity-0");
    expect(wrapper.getAttribute("aria-hidden")).toBe("true");
  });

  it("stays collapsed when there is no ingest at all", () => {
    hooks.useIngestProgress.mockReturnValue(null);
    render(<FirstLaunchImportBanner />);
    expect(bannerWrapper().className).toContain("opacity-0");
  });

  it("shows full progress after a visible import completes", () => {
    hooks.useIngestProgress.mockReturnValue(ingest(10, 5));
    const view = render(<FirstLaunchImportBanner />);
    expect(progressFillWidth(importProgressbar())).toBe("50%");

    hooks.useIngestProgress.mockReturnValue(ingest(10, 10, false, true));
    view.rerender(<FirstLaunchImportBanner />);

    expect(screen.getByText("10 / 10 sessions")).toBeTruthy();
    expect(importProgressbar().getAttribute("aria-valuenow")).toBe("100");
    expect(progressFillWidth(importProgressbar())).toBe("100%");
  });

  it("does not display processed counts above total", () => {
    hooks.useIngestProgress.mockReturnValue(ingest(10, 5));
    const view = render(<FirstLaunchImportBanner />);
    expect(progressFillWidth(importProgressbar())).toBe("50%");

    hooks.useIngestProgress.mockReturnValue(ingest(10, 12));
    view.rerender(<FirstLaunchImportBanner />);

    expect(screen.getByText("10 / 10 sessions")).toBeTruthy();
    expect(bannerWrapper().textContent).not.toContain("12 / 10");
    expect(importProgressbar().getAttribute("aria-valuenow")).toBe("100");
    expect(progressFillWidth(importProgressbar())).toBe("100%");
  });

  it("collapses after the import settles when no maintenance is reported", () => {
    vi.useFakeTimers();
    hooks.useIngestProgress.mockReturnValue(ingest(100, 40));
    const view = render(<FirstLaunchImportBanner />);
    expect(bannerWrapper().className).toContain("opacity-100");

    // The whole boot import finishes (complete): still shown (the 100% hold),
    // then collapses once the maintenance bridge window elapses with no
    // post-boot maintenance ever reported.
    hooks.useIngestProgress.mockReturnValue(ingest(100, 100, false, true));
    view.rerender(<FirstLaunchImportBanner />);
    expect(bannerWrapper().className).toContain("opacity-100");

    act(() => {
      vi.advanceTimersByTime(MAINTENANCE_BRIDGE_MS);
    });
    expect(bannerWrapper().className).toContain("opacity-0");
  });

  it("stays visible across a gap between staggered harness imports", () => {
    vi.useFakeTimers();
    // First harness importing.
    hooks.useIngestProgress.mockReturnValue(ingest(1000, 500));
    const view = render(<FirstLaunchImportBanner />);
    expect(bannerWrapper().className).toContain("opacity-100");

    // First harness finished (processed === total) but the boot import is not
    // complete: a later harness has not registered its sources yet. The banner
    // must NOT collapse here, even after the settle-hold window elapses.
    hooks.useIngestProgress.mockReturnValue(ingest(1000, 1000, false, false));
    view.rerender(<FirstLaunchImportBanner />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(bannerWrapper().className).toContain("opacity-100");

    // The next harness registers its sources and imports.
    hooks.useIngestProgress.mockReturnValue(ingest(2000, 1000, false, false));
    view.rerender(<FirstLaunchImportBanner />);
    expect(bannerWrapper().className).toContain("opacity-100");

    // Everything finishes: now it settles and collapses once the maintenance
    // bridge window elapses with no maintenance reported.
    hooks.useIngestProgress.mockReturnValue(ingest(2000, 2000, false, true));
    view.rerender(<FirstLaunchImportBanner />);
    act(() => {
      vi.advanceTimersByTime(MAINTENANCE_BRIDGE_MS);
    });
    expect(bannerWrapper().className).toContain("opacity-0");
  });

  it("collapses if an import stalls without ever completing", () => {
    vi.useFakeTimers();
    // An import is observed but then makes no progress and never reports
    // `complete` (e.g. the collector stopped). The banner must not hang forever.
    hooks.useIngestProgress.mockReturnValue(ingest(1000, 300));
    render(<FirstLaunchImportBanner />);
    expect(bannerWrapper().className).toContain("opacity-100");

    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(bannerWrapper().className).toContain("opacity-0");
  });

  it("shows calm maintenance copy after the import settles into post-boot maintenance", () => {
    // Import runs, then completes; the main process reports it is now running
    // post-boot maintenance (the residual freeze window).
    hooks.useIngestProgress.mockReturnValue(ingest(7183, 4000));
    hooks.useMaintenanceProgress.mockReturnValue(maintenance(false));
    const view = render(<FirstLaunchImportBanner />);
    expect(bannerWrapper().className).toContain("opacity-100");

    hooks.useIngestProgress.mockReturnValue(ingest(7183, 7183, false, true));
    hooks.useMaintenanceProgress.mockReturnValue(maintenance(true, "rebuild"));
    view.rerender(<FirstLaunchImportBanner />);

    const wrapper = bannerWrapper();
    expect(wrapper.className).toContain("opacity-100");
    expect(wrapper.getAttribute("aria-hidden")).toBe("false");
    expect(
      screen.getByText("Finishing up importing your history")
    ).toBeTruthy();
    expect(
      screen.getByText("The app may be slow until this finishes.")
    ).toBeTruthy();
    // The import counts and pause control are gone — there is no import collector
    // left to pause during maintenance.
    expect(wrapper.textContent).not.toContain("7,183");
    expect(
      screen.queryByRole("button", { name: PAUSE_RESUME_LABEL })
    ).toBeNull();
  });

  it("holds across the import->maintenance gap, then collapses after maintenance finishes", () => {
    vi.useFakeTimers();
    hooks.useIngestProgress.mockReturnValue(ingest(1000, 400));
    hooks.useMaintenanceProgress.mockReturnValue(maintenance(false));
    const view = render(<FirstLaunchImportBanner />);
    expect(bannerWrapper().className).toContain("opacity-100");

    // Import completes but maintenance has not yet been observed active (the poll
    // gap). The banner must not collapse during the bridge window.
    hooks.useIngestProgress.mockReturnValue(ingest(1000, 1000, false, true));
    hooks.useMaintenanceProgress.mockReturnValue(maintenance(false));
    view.rerender(<FirstLaunchImportBanner />);
    act(() => {
      vi.advanceTimersByTime(MAINTENANCE_BRIDGE_MS - 500);
    });
    expect(bannerWrapper().className).toContain("opacity-100");

    // Maintenance now reports active: the bridge collapse is cancelled and the
    // banner holds indefinitely with calm copy while maintenance runs.
    hooks.useMaintenanceProgress.mockReturnValue(maintenance(true));
    view.rerender(<FirstLaunchImportBanner />);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(bannerWrapper().className).toContain("opacity-100");
    expect(
      screen.getByText("Finishing up importing your history")
    ).toBeTruthy();

    // Maintenance finishes: the banner holds the short settle window, then
    // collapses.
    hooks.useMaintenanceProgress.mockReturnValue(maintenance(false));
    view.rerender(<FirstLaunchImportBanner />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(bannerWrapper().className).toContain("opacity-0");
  });

  it("stays visible when the first poll already shows a completed import plus active maintenance", () => {
    // The renderer mounted after the import had already finished, but the main
    // process is still running post-boot maintenance. The mid-flight importing
    // state was never observed, yet the banner must still engage and surface the
    // maintenance copy rather than staying hidden.
    hooks.useIngestProgress.mockReturnValue(ingest(7183, 7183, false, true));
    hooks.useMaintenanceProgress.mockReturnValue(maintenance(true, "rebuild"));
    render(<FirstLaunchImportBanner />);

    const wrapper = bannerWrapper();
    expect(wrapper.className).toContain("opacity-100");
    expect(wrapper.getAttribute("aria-hidden")).toBe("false");
    expect(
      screen.getByText("Finishing up importing your history")
    ).toBeTruthy();
  });

  it("does not collapse while maintenance stays active, even past the safety cap", () => {
    vi.useFakeTimers();
    hooks.useIngestProgress.mockReturnValue(ingest(1000, 400));
    hooks.useMaintenanceProgress.mockReturnValue(maintenance(false));
    const view = render(<FirstLaunchImportBanner />);
    expect(bannerWrapper().className).toContain("opacity-100");

    // Import completes and maintenance is actively running.
    hooks.useIngestProgress.mockReturnValue(ingest(1000, 1000, false, true));
    hooks.useMaintenanceProgress.mockReturnValue(
      maintenance(true, "artifact-links")
    );
    view.rerender(<FirstLaunchImportBanner />);
    expect(bannerWrapper().className).toContain("opacity-100");

    // Advance well past the 15-minute absolute cap while maintenance is STILL
    // reported active: the banner must stay up across the whole maintenance
    // window rather than being collapsed by an elapsed-time ceiling.
    act(() => {
      vi.advanceTimersByTime(16 * 60_000);
    });
    expect(bannerWrapper().className).toContain("opacity-100");

    // Once maintenance finally reports inactive, the short settle hold collapses
    // it as usual.
    hooks.useMaintenanceProgress.mockReturnValue(maintenance(false));
    view.rerender(<FirstLaunchImportBanner />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(bannerWrapper().className).toContain("opacity-0");
  });

  it("keeps progress frozen while paused and advances from the current source after resume", () => {
    const setPaused = vi.fn().mockResolvedValue(undefined);
    (
      window as unknown as {
        desktopApi: { setAgentMonitorImportPaused: typeof setPaused };
      }
    ).desktopApi = { setAgentMonitorImportPaused: setPaused };
    hooks.useIngestProgress.mockReturnValue(ingest(10, 3));
    const view = render(<FirstLaunchImportBanner />);

    fireEvent.click(screen.getByRole("button", { name: "Pause import" }));
    expect(setPaused).toHaveBeenLastCalledWith(true);
    expect(screen.getByText("Import paused")).toBeTruthy();
    expect(screen.getByText("3 / 10 sessions")).toBeTruthy();
    expect(importProgressbar().getAttribute("aria-valuenow")).toBe("30");
    expect(progressFillWidth(importProgressbar())).toBe("30%");

    // The collector pause gate keeps the ingest source stable while paused, so
    // a polling rerender must not make the display drift independently.
    hooks.useIngestProgress.mockReturnValue(ingest(10, 3));
    view.rerender(<FirstLaunchImportBanner />);
    expect(screen.getByText("Import paused")).toBeTruthy();
    expect(screen.getByText("3 / 10 sessions")).toBeTruthy();
    expect(importProgressbar().getAttribute("aria-valuenow")).toBe("30");
    expect(progressFillWidth(importProgressbar())).toBe("30%");

    fireEvent.click(screen.getByRole("button", { name: "Resume import" }));
    expect(setPaused).toHaveBeenLastCalledWith(false);
    expect(screen.getByText("Importing your agent history")).toBeTruthy();
    expect(screen.getByText("3 / 10 sessions")).toBeTruthy();
    expect(importProgressbar().getAttribute("aria-valuenow")).toBe("30");
    expect(progressFillWidth(importProgressbar())).toBe("30%");

    hooks.useIngestProgress.mockReturnValue(ingest(10, 4));
    view.rerender(<FirstLaunchImportBanner />);

    expect(screen.getByText("Importing your agent history")).toBeTruthy();
    expect(screen.getByText("4 / 10 sessions")).toBeTruthy();
    expect(importProgressbar().getAttribute("aria-valuenow")).toBe("40");
    expect(progressFillWidth(importProgressbar())).toBe("40%");
  });

  it("keeps edge progress states consistent through pause and resume", () => {
    const setPaused = vi.fn().mockResolvedValue(undefined);
    (
      window as unknown as {
        desktopApi: { setAgentMonitorImportPaused: typeof setPaused };
      }
    ).desktopApi = { setAgentMonitorImportPaused: setPaused };
    hooks.useIngestProgress.mockReturnValue(ingest(10, 0));
    const view = render(<FirstLaunchImportBanner />);

    fireEvent.click(screen.getByRole("button", { name: "Pause import" }));
    expect(setPaused).toHaveBeenLastCalledWith(true);
    expect(screen.getByText("Import paused")).toBeTruthy();
    expect(screen.getByText("0 / 10 sessions")).toBeTruthy();
    expect(importProgressbar().getAttribute("aria-valuenow")).toBe("0");
    expect(progressFillWidth(importProgressbar())).toBe("0%");

    fireEvent.click(screen.getByRole("button", { name: "Resume import" }));
    expect(setPaused).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Pause import" }));
    expect(setPaused).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Resume import" }));
    expect(setPaused).toHaveBeenLastCalledWith(false);
    expect(screen.getByText("Importing your agent history")).toBeTruthy();
    expect(screen.getByText("0 / 10 sessions")).toBeTruthy();
    expect(importProgressbar().getAttribute("aria-valuenow")).toBe("0");
    expect(progressFillWidth(importProgressbar())).toBe("0%");

    hooks.useIngestProgress.mockReturnValue(ingest(10, 10, false, true));
    view.rerender(<FirstLaunchImportBanner />);
    expect(screen.getByText("10 / 10 sessions")).toBeTruthy();
    expect(importProgressbar().getAttribute("aria-valuenow")).toBe("100");
    expect(progressFillWidth(importProgressbar())).toBe("100%");
  });

  it("toggles pause/resume and notifies the main process", () => {
    const setPaused = vi.fn().mockResolvedValue(undefined);
    (
      window as unknown as {
        desktopApi: { setAgentMonitorImportPaused: typeof setPaused };
      }
    ).desktopApi = { setAgentMonitorImportPaused: setPaused };
    hooks.useIngestProgress.mockReturnValue(ingest(7183, 612));
    render(<FirstLaunchImportBanner />);

    expect(screen.getByText("Importing your agent history")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause import" }));
    expect(setPaused).toHaveBeenLastCalledWith(true);
    expect(screen.getByText("Import paused")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Resume import" }));
    expect(setPaused).toHaveBeenLastCalledWith(false);
    expect(screen.getByText("Importing your agent history")).toBeTruthy();
  });
});
