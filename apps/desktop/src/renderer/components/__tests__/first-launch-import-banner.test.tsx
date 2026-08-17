import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MaintenancePhase } from "../../../shared/maintenance-progress-contract";
import type {
  IngestProgress,
  MaintenanceProgress,
} from "../../hooks/use-ingest-progress";
import { FirstLaunchImportBanner } from "../first-launch-import-banner";

// Module-scoped so the matcher isn't recompiled per assertion (useTopLevelRegex).
const HARDCODED_BYTE_CLAIM = /0 bytes/;

// The splash's visibility is driven entirely by the ingest + maintenance hooks;
// mock both so each state (scanning / importing / settled / maintenance /
// failed / absent) is reachable without a live runtime.
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
  complete = false,
  byHarness?: IngestProgress["byHarness"],
  timedOut = false,
  // ISS-5281: the PRODUCER's terminal signal. Defaults to the version-skew shape
  // (field absent), which the banner must read as NOT drained.
  drained?: boolean
): IngestProgress {
  return {
    byHarness:
      byHarness ?? (total > 0 ? [{ harness: "codex", total, processed }] : []),
    total,
    processed,
    preparing,
    complete,
    timedOut,
    drained,
  };
}

function maintenance(
  active: boolean,
  phase: MaintenancePhase = MaintenancePhase.ArtifactLinks
): MaintenanceProgress {
  if (!active) {
    return { active: false, phase: null };
  }
  // The union's discriminant: only `rebuild` may carry counts, so the two live
  // phases are separate members and cannot be built from one widened literal.
  if (phase === MaintenancePhase.Rebuild) {
    return { active: true, phase: MaintenancePhase.Rebuild };
  }
  return { active: true, phase };
}

// Bridge window (MAINTENANCE_BRIDGE_MS in the component) — how long the splash
// waits after the import settles for maintenance to appear before collapsing
// when none is reported. Mirrored here so the timing tests stay in lockstep.
const MAINTENANCE_BRIDGE_MS = 2500;
// Stall give-up window (STALL_GIVE_UP_MS) — how long a seen import can make no
// progress before the splash surfaces the graceful partial-failure state.
const STALL_GIVE_UP_MS = 120_000;
// ISS-6118: how long the producer must hold `drained` at N of N before the
// splash accepts it as the end of the import (DRAINED_SETTLE_CONFIRM_MS in the
// component). Mirrored here so the timing tests stay in lockstep.
const DRAINED_SETTLE_CONFIRM_MS = 15_000;

// Module-scoped so the matchers aren't recompiled per assertion (useTopLevelRegex).
const PAUSE_RESUME_LABEL = /pause|resume/i;
const OVERALL_PROGRESS_LABEL = /overall import progress/i;
// The aggregate stall carries no per-harness attribution, so the failure copy
// stays generic rather than blaming a harness the runtime cannot identify.
// ISS-5281: the shortfall now lives on the headline/detail above the alert, in
// the same noun ("transcripts") the rest of the splash uses for the
// processed/total pair; the alert now appears ONLY when it has a quarantine
// count, and the way forward is a plain line beside the Continue button.
const STALLED_GENERIC_COPY =
  /You can keep going with what imported, and we'll keep importing in the background\./;
const STALL_CHECK_INTERVAL_MS = 10_000;

function bannerWrapper(): HTMLElement {
  return screen.getByTestId("first-launch-import-banner");
}

function overallProgressbar(): HTMLElement {
  return screen.getByRole("progressbar", { name: OVERALL_PROGRESS_LABEL });
}

// The pause tests install a desktopApi; capture whatever was there so each test
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
  it("shows the import headline, overall count, and stepper while importing", () => {
    hooks.useIngestProgress.mockReturnValue(ingest(7183, 612));
    render(<FirstLaunchImportBanner />);

    const wrapper = bannerWrapper();
    expect(wrapper.className).toContain("opacity-100");
    expect(wrapper.getAttribute("aria-hidden")).toBe("false");
    expect(screen.getByText("Importing your agent history")).toBeTruthy();
    expect(screen.getByText("612 / 7,183 transcripts")).toBeTruthy();
    // FEA-4156: the import runs off the main thread (utility-process parsing,
    // cooperative yielding), so the reassurance tells the honest truth — it runs
    // in the background — rather than the old "the app may be slow" implication.
    // The footer keeps a single reassurance span; "the app stays usable" was cut
    // as a design pass (planted a worry the moving rail already answers).
    expect(wrapper.textContent).toContain("Runs in the background");
    expect(wrapper.textContent).not.toContain("The app may be slow");
    // ISS-5348: the footer no longer claims a byte count. The only source is a
    // 100-row sample, so any total from it would be a sample dressed up as one.
    expect(wrapper.textContent).not.toMatch(HARDCODED_BYTE_CLAIM);
    // Short, legible stepper labels (FEA-4057) — never truncated long forms.
    expect(
      screen.getByRole("list", { name: "Import progress steps" })
    ).toBeTruthy();
    expect(screen.getByText("Scan")).toBeTruthy();
    expect(screen.getByText("Compute")).toBeTruthy();
  });

  it("omits empty (0-of-0) harness rows and keeps the aggregate consistent", () => {
    // Two harnesses have sessions; Gemini has nothing to parse. The empty row
    // must not render, and the overall count must reflect only the shown rows.
    hooks.useIngestProgress.mockReturnValue(
      ingest(1600, 1000, false, false, [
        { harness: "claude", total: 1000, processed: 400 },
        { harness: "gemini", total: 0, processed: 0 },
        { harness: "codex", total: 600, processed: 600 },
      ])
    );
    render(<FirstLaunchImportBanner />);

    const wrapper = bannerWrapper();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    // No phantom Gemini row for a harness with nothing to import.
    expect(screen.queryByText("Gemini CLI")).toBeNull();
    // The aggregate stays consistent with the two shown harnesses (1000/1600).
    expect(wrapper.textContent).toContain("1,000 / 1,600 transcripts");
  });

  it("sets the overall progressbar value from the imported/total ratio", () => {
    hooks.useIngestProgress.mockReturnValue(ingest(8, 1));
    render(<FirstLaunchImportBanner />);

    const bar = overallProgressbar();
    expect(screen.getByText("1 / 8 transcripts")).toBeTruthy();
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    // The announced value is rounded so it feeds ARIA as an integer.
    expect(bar.getAttribute("aria-valuenow")).toBe("13");
  });

  it("keeps the churning session count out of the live status region", () => {
    hooks.useIngestProgress.mockReturnValue(ingest(8, 1));
    render(<FirstLaunchImportBanner />);

    const liveStatus = screen.getByRole("status");
    expect(liveStatus.textContent).toContain("Importing your agent history");
    // The count is not inside the aria-live region.
    expect(liveStatus.textContent).not.toContain("1 / 8 transcripts");
  });

  it("renders per-harness rows from the real ingest breakdown", () => {
    hooks.useIngestProgress.mockReturnValue(
      ingest(2000, 1400, false, false, [
        { harness: "claude", total: 1000, processed: 1000 },
        { harness: "codex", total: 1000, processed: 400 },
      ])
    );
    render(<FirstLaunchImportBanner />);

    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(
      screen.getByRole("progressbar", { name: "Claude Code import progress" })
    ).toBeTruthy();
    expect(
      screen.getByRole("progressbar", { name: "Codex import progress" })
    ).toBeTruthy();
    // The detail line names the tool being read right now.
    expect(screen.getByText("Reading your Codex sessions")).toBeTruthy();
  });

  it("shows the scanning state before any total is known", () => {
    hooks.useIngestProgress.mockReturnValue(ingest(0, 0, true));
    render(<FirstLaunchImportBanner />);

    const wrapper = bannerWrapper();
    expect(wrapper.className).toContain("opacity-100");
    expect(screen.getByText("Scanning your local logs")).toBeTruthy();
    expect(overallProgressbar().getAttribute("aria-valuenow")).toBe("0");
    // No concrete transcript count during the scan.
    expect(wrapper.textContent).not.toContain("transcripts");
  });

  it("floors negative processed counts at zero", () => {
    hooks.useIngestProgress.mockReturnValue(ingest(10, -2));
    render(<FirstLaunchImportBanner />);

    expect(screen.getByText("0 / 10 transcripts")).toBeTruthy();
    expect(overallProgressbar().getAttribute("aria-valuenow")).toBe("0");
  });

  it("does not display processed counts above total", () => {
    // Start mid-import (so the splash is visible), then a poll over-reports.
    hooks.useIngestProgress.mockReturnValue(ingest(10, 5));
    const view = render(<FirstLaunchImportBanner />);
    expect(bannerWrapper().getAttribute("aria-hidden")).toBe("false");

    hooks.useIngestProgress.mockReturnValue(ingest(10, 12));
    view.rerender(<FirstLaunchImportBanner />);

    expect(screen.getByText("10 / 10 transcripts")).toBeTruthy();
    expect(bannerWrapper().textContent).not.toContain("12 / 10");
    expect(overallProgressbar().getAttribute("aria-valuenow")).toBe("100");
  });

  it("stops after a preparing scan that finds nothing to import", () => {
    vi.useFakeTimers();
    hooks.useIngestProgress.mockReturnValue(ingest(0, 0, true));
    const view = render(<FirstLaunchImportBanner />);
    expect(bannerWrapper().className).toContain("opacity-100");

    hooks.useIngestProgress.mockReturnValue(ingest(0, 0, false));
    view.rerender(<FirstLaunchImportBanner />);
    expect(bannerWrapper().className).toContain("opacity-0");

    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(hooks.useIngestProgress).toHaveBeenLastCalledWith(false);
  });

  it("stays collapsed for an already-settled store (ordinary launch)", () => {
    hooks.useIngestProgress.mockReturnValue(ingest(7183, 7183));
    render(<FirstLaunchImportBanner />);

    const wrapper = bannerWrapper();
    expect(wrapper.className).toContain("opacity-0");
    expect(wrapper.getAttribute("aria-hidden")).toBe("true");
    // Collapsed: the subtree is inert so focus can't park on the now-invisible
    // Continue/Pause controls (an aria-hidden ancestor over focusable
    // descendants would itself be an a11y violation). React renders the boolean
    // inert as a present attribute.
    expect(wrapper.hasAttribute("inert")).toBe(true);
  });

  it("is not inert while the splash is visible", () => {
    hooks.useIngestProgress.mockReturnValue(ingest(7183, 612));
    render(<FirstLaunchImportBanner />);

    const wrapper = bannerWrapper();
    expect(wrapper.getAttribute("aria-hidden")).toBe("false");
    // Visible: not inert, so its controls stay reachable.
    expect(wrapper.hasAttribute("inert")).toBe(false);
  });

  it("stays collapsed when there is no ingest at all", () => {
    hooks.useIngestProgress.mockReturnValue(null);
    render(<FirstLaunchImportBanner />);
    expect(bannerWrapper().className).toContain("opacity-0");
  });

  it("shows the Ready summary after a visible import completes", () => {
    hooks.useIngestProgress.mockReturnValue(ingest(10, 5));
    const view = render(<FirstLaunchImportBanner />);
    expect(overallProgressbar().getAttribute("aria-valuenow")).toBe("50");

    hooks.useIngestProgress.mockReturnValue(ingest(10, 10, false, true));
    view.rerender(<FirstLaunchImportBanner />);

    expect(overallProgressbar().getAttribute("aria-valuenow")).toBe("100");
  });

  it("collapses after the import settles when no maintenance is reported", () => {
    vi.useFakeTimers();
    hooks.useIngestProgress.mockReturnValue(ingest(100, 40));
    const view = render(<FirstLaunchImportBanner />);
    expect(bannerWrapper().className).toContain("opacity-100");

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
    hooks.useIngestProgress.mockReturnValue(ingest(1000, 500));
    const view = render(<FirstLaunchImportBanner />);
    expect(bannerWrapper().className).toContain("opacity-100");

    hooks.useIngestProgress.mockReturnValue(ingest(1000, 1000, false, false));
    view.rerender(<FirstLaunchImportBanner />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(bannerWrapper().className).toContain("opacity-100");

    hooks.useIngestProgress.mockReturnValue(ingest(2000, 1000, false, false));
    view.rerender(<FirstLaunchImportBanner />);
    expect(bannerWrapper().className).toContain("opacity-100");

    hooks.useIngestProgress.mockReturnValue(ingest(2000, 2000, false, true));
    view.rerender(<FirstLaunchImportBanner />);
    act(() => {
      vi.advanceTimersByTime(MAINTENANCE_BRIDGE_MS);
    });
    expect(bannerWrapper().className).toContain("opacity-0");
  });

  it("surfaces the graceful partial-failure state when an import stalls", () => {
    vi.useFakeTimers();
    // An import is observed but then makes no progress and never reports
    // `complete` (e.g. the collector stopped). Instead of silently collapsing,
    // the splash surfaces what imported plus a way forward.
    hooks.useIngestProgress.mockReturnValue(
      ingest(1000, 300, false, false, [
        { harness: "claude", total: 700, processed: 300 },
        { harness: "codex", total: 300, processed: 0 },
      ])
    );
    render(<FirstLaunchImportBanner />);
    expect(bannerWrapper().className).toContain("opacity-100");

    act(() => {
      vi.advanceTimersByTime(STALL_GIVE_UP_MS);
    });

    const wrapper = bannerWrapper();
    expect(wrapper.className).toContain("opacity-100");
    expect(screen.getByText("Import didn't finish")).toBeTruthy();
    expect(
      screen.getByText("Stopped after 300 of 1,000 transcripts")
    ).toBeTruthy();
    // ISS-5281: 700 of the 1,000 discovered sessions never reached a terminal
    // outcome, and the detail line states that as 300 of 1,000 rather than
    // restating the total. Nothing was quarantined, so nothing claims to be
    // unreadable and the alert adds no second copy of the same arithmetic.
    expect(wrapper.textContent).not.toContain("couldn't be read");
    expect(wrapper.textContent).not.toContain("still to import");
    expect(screen.getByText(STALLED_GENERIC_COPY)).toBeTruthy();
    // The generic copy must not name a harness: an aggregate stall carries no
    // per-harness attribution, so the old "hit a problem reading your <tool>"
    // wording (which blamed whichever in-progress row sorted first) is gone.
    expect(wrapper.textContent).not.toContain("hit a problem reading your");
    // A partial-failure keeps the count honest; no background reassurance line.
    expect(wrapper.textContent).not.toContain(
      "Runs in the background · the app stays usable"
    );
  });

  it("clears the stall state when progress resumes after a stall trip", () => {
    vi.useFakeTimers();
    // A seen import that stops making progress long enough to trip the stall.
    hooks.useIngestProgress.mockReturnValue(ingest(1000, 300));
    const view = render(<FirstLaunchImportBanner />);

    act(() => {
      vi.advanceTimersByTime(STALL_GIVE_UP_MS);
    });
    expect(screen.getByText("Import didn't finish")).toBeTruthy();

    // Progress resumes: the next poll advances the count, so the stall clears
    // and the splash drops back out of the partial-failure state.
    hooks.useIngestProgress.mockReturnValue(ingest(1000, 600));
    view.rerender(<FirstLaunchImportBanner />);
    act(() => {
      vi.advanceTimersByTime(STALL_CHECK_INTERVAL_MS);
    });
    expect(screen.queryByText("Import didn't finish")).toBeNull();
    expect(screen.getByText("Importing your agent history")).toBeTruthy();
  });

  it("surfaces the partial-failure state immediately when the main process reports timedOut", () => {
    vi.useFakeTimers();
    // FEA-4156: the main-process watchdog authoritatively gave up on a wedged
    // harness (`timedOut`), while OTHER harnesses are still advancing the
    // aggregate. The renderer must surface the graceful failed state right away
    // — NOT wait out its own 120s stall window, which never trips while the
    // aggregate keeps moving.
    hooks.useIngestProgress.mockReturnValue(
      ingest(
        1000,
        300,
        false,
        false,
        [
          { harness: "claude", total: 700, processed: 300 },
          { harness: "codex", total: 300, processed: 0 },
        ],
        true
      )
    );
    render(<FirstLaunchImportBanner />);
    // No timer advance: the failed state is up on the first render.
    expect(screen.getByText("Import didn't finish")).toBeTruthy();
    expect(bannerWrapper().className).toContain("opacity-100");
  });

  it("keeps the partial-failure state up even if the aggregate keeps advancing after timedOut", () => {
    vi.useFakeTimers();
    hooks.useIngestProgress.mockReturnValue(
      ingest(1000, 300, false, false, undefined, true)
    );
    const view = render(<FirstLaunchImportBanner />);
    expect(screen.getByText("Import didn't finish")).toBeTruthy();

    // A still-running collector advances the count after the timeout. The failed
    // state must hold (the main process already gave up), rather than the
    // renderer's stall-reset clearing it as if progress meant recovery.
    hooks.useIngestProgress.mockReturnValue(
      ingest(1000, 600, false, false, undefined, true)
    );
    view.rerender(<FirstLaunchImportBanner />);
    act(() => {
      vi.advanceTimersByTime(STALL_CHECK_INTERVAL_MS);
    });
    expect(screen.getByText("Import didn't finish")).toBeTruthy();
  });

  // ISS-5281: a run the MAIN PROCESS reports as drained is a SUCCESS, even when
  // it has not reported `complete`. The renderer's stall give-up observes only
  // movement, and nothing can move once every begun pass has ended, so on a
  // drained run it is guaranteed to fire and what it caught is a completion the
  // boot-import lifecycle has not reported yet. The splash used to render that as
  // "Import didn't finish — Stopped after 90 of 90" while its own per-harness
  // rows all read complete.
  //
  // Two things are deliberately NOT eligible for that settle (wongk + bot
  // review): the 30-minute watchdog `timedOut`, which is an authoritative report
  // of a wedged harness rather than a movement heuristic, and any renderer-side
  // inference from the counters, which cannot see a yielded pass, a 0-total
  // harness, or a source `settlePass` left retryable.
  describe("a drained import (ISS-5281)", () => {
    const DRAINED_HARNESSES: IngestProgress["byHarness"] = [
      { harness: "claude", total: 85, processed: 85 },
      { harness: "codex", total: 4, processed: 4 },
      { harness: "opencode", total: 1, processed: 1 },
    ];
    const MID_FLIGHT_HARNESSES: IngestProgress["byHarness"] = [
      { harness: "claude", total: 85, processed: 40 },
      { harness: "codex", total: 4, processed: 0 },
      { harness: "opencode", total: 1, processed: 0 },
    ];

    /**
     * Drive the real production sequence: the splash engages mid-flight (which is
     * what latches `sawImport` and arms the renderer's stall window), then the
     * counts plateau at 90 / 90 with the given terminal signals, then the
     * give-up window elapses. Starting at the plateau would skip the latch and
     * test a state a first launch never passes through.
     */
    function settleAt(plateau: IngestProgress): void {
      hooks.useIngestProgress.mockReturnValue(
        ingest(90, 40, false, false, MID_FLIGHT_HARNESSES)
      );
      const view = render(<FirstLaunchImportBanner />);

      hooks.useIngestProgress.mockReturnValue(plateau);
      view.rerender(<FirstLaunchImportBanner />);
      act(() => {
        // The watcher resets its window on the poll that carried 40 -> 90, so the
        // give-up lands one check interval after that reset.
        vi.advanceTimersByTime(STALL_GIVE_UP_MS + STALL_CHECK_INTERVAL_MS);
      });
      view.rerender(<FirstLaunchImportBanner />);
    }

    it("settles into Ready instead of failing when the stall give-up fires on a drained queue", () => {
      vi.useFakeTimers();
      // Mid-flight first, so the splash engages exactly as it does on a real
      // first launch, then every harness finishes and the count plateaus at
      // 90 / 90 with `complete` never arriving.
      settleAt(ingest(90, 90, false, false, DRAINED_HARNESSES, false, true));

      const wrapper = bannerWrapper();
      expect(screen.queryByText("Import didn't finish")).toBeNull();
      expect(wrapper.textContent).not.toContain("couldn't be read");
      expect(wrapper.textContent).not.toContain("Stopped after");
      // It advances rather than parking on a dead Import step.
      expect(screen.getByText("You are all set")).toBeTruthy();
      expect(wrapper.textContent).toContain("90 transcripts imported");
    });

    // FEA-4156's contract, and the reason the watchdog is NOT a movement
    // heuristic: it fires only after 30 minutes and only because a harness's
    // first-import promise never settled, at which point main is authoritatively
    // reporting a wedge. A wedged harness the aggregate cannot see — one whose
    // total is 0, so `snapshot()` filters it out — contributes nothing to
    // `processed`/`total`, so "drained" says nothing about it.
    it("still surfaces the partial-import state when the watchdog times out on a drained queue", () => {
      vi.useFakeTimers();
      settleAt(ingest(90, 90, false, false, DRAINED_HARNESSES, true, true));

      expect(screen.queryByText("You are all set")).toBeNull();
      expect(
        screen.getByText("We couldn't finish scanning this device")
      ).toBeTruthy();
      // The way out has to be reachable, not just rendered.
      expect(bannerWrapper().className).toContain("opacity-100");
      expect(
        screen.getByRole("button", { name: "Continue to dashboard" })
      ).toBeTruthy();
    });

    it("keeps a drained-but-quarantined run honest: Ready, with the real failure count", () => {
      vi.useFakeTimers();
      settleAt({
        ...ingest(90, 90, false, false, DRAINED_HARNESSES, false, true),
        quarantinedCount: 2,
      });

      const wrapper = bannerWrapper();
      expect(screen.queryByText("Import didn't finish")).toBeNull();
      expect(screen.getByText("2 transcripts couldn't be read")).toBeTruthy();
      // The failure count is the quarantine count — never the transcript total —
      // and a partial never claims the full discovered total imported, because a
      // transcript that never parsed held an unknowable number of sessions.
      expect(wrapper.textContent).not.toContain("90 transcripts");
      // The headline softens rather than promising all-clear over the warning.
      expect(screen.getByText("Import finished")).toBeTruthy();
    });

    it("still fails, naming what remains, when the producer says NOT drained", () => {
      vi.useFakeTimers();
      hooks.useIngestProgress.mockReturnValue(
        ingest(
          90,
          61,
          false,
          false,
          [
            { harness: "claude", total: 85, processed: 61 },
            { harness: "codex", total: 5, processed: 0 },
          ],
          false,
          false
        )
      );
      render(<FirstLaunchImportBanner />);

      act(() => {
        vi.advanceTimersByTime(STALL_GIVE_UP_MS);
      });

      expect(screen.getByText("Import didn't finish")).toBeTruthy();
      expect(
        screen.getByText("Stopped after 61 of 90 transcripts")
      ).toBeTruthy();
    });

    // The bot review's pin: the counters plateau at `processed === total` with
    // `preparing` FALSE on every cooperative yield/resume, because reaching the
    // known total is what sends the loop back for the next quantum — and the
    // re-scan then grows `total`. The old renderer-side inference settled here.
    // The producer knows the pass is still in flight, so it says not drained.
    it("does not settle a re-entrant plateau the counters cannot tell from a finish", () => {
      vi.useFakeTimers();
      // Identical counters to the settling case above — `processed === total`,
      // `preparing` false — and the ONLY difference is the producer's answer.
      settleAt(ingest(90, 90, false, false, DRAINED_HARNESSES, false, false));

      expect(screen.queryByText("You are all set")).toBeNull();
      expect(
        screen.getByText("We couldn't finish scanning this device")
      ).toBeTruthy();
    });

    it("does not settle when an older main process omits the drained field", () => {
      vi.useFakeTimers();
      // Version skew: the field is absent, so the splash must fall back to the
      // pre-ISS-5281 behavior rather than assume the queue emptied.
      settleAt(ingest(90, 90, false, false, DRAINED_HARNESSES));

      expect(screen.queryByText("You are all set")).toBeNull();
      expect(
        screen.getByText("We couldn't finish scanning this device")
      ).toBeTruthy();
    });

    it("reads as loading — not success and not failure — before the give-up fires", () => {
      vi.useFakeTimers();
      hooks.useIngestProgress.mockReturnValue(
        ingest(90, 40, false, false, [
          { harness: "claude", total: 85, processed: 40 },
          { harness: "codex", total: 4, processed: 0 },
          { harness: "opencode", total: 1, processed: 0 },
        ])
      );
      const view = render(<FirstLaunchImportBanner />);

      hooks.useIngestProgress.mockReturnValue(
        ingest(90, 90, false, false, DRAINED_HARNESSES)
      );
      view.rerender(<FirstLaunchImportBanner />);
      act(() => {
        vi.advanceTimersByTime(STALL_CHECK_INTERVAL_MS);
      });

      const wrapper = bannerWrapper();
      expect(screen.getByText("Importing your agent history")).toBeTruthy();
      expect(screen.queryByText("Import didn't finish")).toBeNull();
      expect(screen.queryByText("You are all set")).toBeNull();
      // Loading is never rendered as a zero: the honest 90/90 count still shows.
      expect(wrapper.textContent).toContain("90 / 90 transcripts");
    });

    it("hides at N of N on the producer's drained signal, without waiting out the stall window (ISS-6118)", () => {
      vi.useFakeTimers();
      hooks.useIngestProgress.mockReturnValue(
        ingest(90, 40, false, false, MID_FLIGHT_HARNESSES)
      );
      const view = render(<FirstLaunchImportBanner />);
      expect(bannerWrapper().className).toContain("opacity-100");

      // Every harness finished and the producer says the queue is drained, but
      // `complete` never arrives (a wedged watchdog, a paused re-arm, a stop()).
      hooks.useIngestProgress.mockReturnValue(
        ingest(90, 90, false, false, DRAINED_HARNESSES, false, true)
      );
      view.rerender(<FirstLaunchImportBanner />);

      // Still up before the confirmation window closes — the splash never ends
      // an import on a single poll of the aggregate.
      act(() => {
        vi.advanceTimersByTime(DRAINED_SETTLE_CONFIRM_MS - 1000);
      });
      view.rerender(<FirstLaunchImportBanner />);
      expect(bannerWrapper().className).toContain("opacity-100");

      // Two steps: closing the confirmation window is what marks the import
      // settled, and only the re-render that follows arms the settle hold.
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      view.rerender(<FirstLaunchImportBanner />);
      act(() => {
        vi.advanceTimersByTime(MAINTENANCE_BRIDGE_MS);
      });
      view.rerender(<FirstLaunchImportBanner />);
      // Well inside STALL_GIVE_UP_MS: the header is gone on the producer's own
      // terminal signal, not on the 120s no-movement backstop.
      expect(bannerWrapper().className).toContain("opacity-0");
      expect(screen.queryByText("Import didn't finish")).toBeNull();
    });

    it("still settles a drained N-of-N import when Pause is pressed after it drained (ISS-6118)", () => {
      vi.useFakeTimers();
      hooks.useIngestProgress.mockReturnValue(
        ingest(90, 40, false, false, MID_FLIGHT_HARNESSES)
      );
      const view = render(<FirstLaunchImportBanner />);

      // Drained at N of N with `complete` still absent — the watcher's shared
      // drain promise is open on queued live work.
      hooks.useIngestProgress.mockReturnValue(
        ingest(90, 90, false, false, DRAINED_HARNESSES, false, true)
      );
      view.rerender(<FirstLaunchImportBanner />);

      // The LATE pause (wongk review): there is no historical pass left for it to
      // reach, and the live watcher tail it would have to stop is unpausable by
      // design. It must not pin the finished import open until Resume.
      fireEvent.click(screen.getByRole("button", { name: PAUSE_RESUME_LABEL }));
      view.rerender(<FirstLaunchImportBanner />);

      act(() => {
        vi.advanceTimersByTime(DRAINED_SETTLE_CONFIRM_MS);
      });
      view.rerender(<FirstLaunchImportBanner />);
      act(() => {
        vi.advanceTimersByTime(MAINTENANCE_BRIDGE_MS);
      });
      view.rerender(<FirstLaunchImportBanner />);

      // Well inside STALL_GIVE_UP_MS, and without a Resume ever arriving.
      expect(bannerWrapper().className).toContain("opacity-0");
      expect(screen.queryByText("Import didn't finish")).toBeNull();
    });

    it("keeps the splash up when a later harness registers inside the drained confirmation window (ISS-6118)", () => {
      vi.useFakeTimers();
      hooks.useIngestProgress.mockReturnValue(
        ingest(90, 40, false, false, MID_FLIGHT_HARNESSES)
      );
      const view = render(<FirstLaunchImportBanner />);

      // The staggered-harness gap the `complete` coupling exists to survive: the
      // first harness settles, so the aggregate reads N of N AND the producer
      // reports drained (a settled pass keeps its progress entry with no
      // shortfall, and the next harness has no tracker footprint until its own
      // deferred task fires — `ingest-progress-drained.test.ts` asserts exactly
      // this state).
      hooks.useIngestProgress.mockReturnValue(
        ingest(90, 90, false, false, DRAINED_HARNESSES, false, true)
      );
      view.rerender(<FirstLaunchImportBanner />);
      // The full production stagger span (1000ms per harness across the
      // collector set) elapses inside the gap. Stepped, with a commit between,
      // so a splash that settled on this state would get its settle hold armed
      // AND elapsed here — this is what makes the assertion below able to fail.
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      view.rerender(<FirstLaunchImportBanner />);
      act(() => {
        vi.advanceTimersByTime(MAINTENANCE_BRIDGE_MS);
      });
      view.rerender(<FirstLaunchImportBanner />);
      expect(bannerWrapper().className).toContain("opacity-100");

      // The later harness registers: the denominator grows and the producer
      // stops reporting drained.
      hooks.useIngestProgress.mockReturnValue(
        ingest(
          150,
          90,
          false,
          false,
          [
            ...DRAINED_HARNESSES,
            { harness: "cursor", total: 60, processed: 0 },
          ],
          false,
          false
        )
      );
      view.rerender(<FirstLaunchImportBanner />);
      act(() => {
        vi.advanceTimersByTime(
          DRAINED_SETTLE_CONFIRM_MS + MAINTENANCE_BRIDGE_MS
        );
      });
      view.rerender(<FirstLaunchImportBanner />);

      // The gap must not have ended the import: the second harness is still
      // being read, so the splash is still on screen reporting it.
      expect(bannerWrapper().className).toContain("opacity-100");
      expect(bannerWrapper().textContent).toContain("90 / 150 transcripts");
    });
  });

  it("stops polling once the splash is dismissed via Continue", () => {
    vi.useFakeTimers();
    hooks.useIngestProgress.mockReturnValue(ingest(1000, 300));
    render(<FirstLaunchImportBanner />);

    act(() => {
      vi.advanceTimersByTime(STALL_GIVE_UP_MS);
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to dashboard" })
    );
    expect(bannerWrapper().className).toContain("opacity-0");
    // Dismissal is terminal for the polling lifecycle: both status hooks are
    // called with enabled=false so the 1s subscriptions do not run forever.
    expect(hooks.useIngestProgress).toHaveBeenLastCalledWith(false);
    expect(hooks.useMaintenanceProgress).toHaveBeenLastCalledWith(false);
  });

  it("dismisses the splash from the partial-failure state via Continue", () => {
    vi.useFakeTimers();
    hooks.useIngestProgress.mockReturnValue(ingest(1000, 300));
    render(<FirstLaunchImportBanner />);

    act(() => {
      vi.advanceTimersByTime(STALL_GIVE_UP_MS);
    });
    expect(screen.getByText("Import didn't finish")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Continue to dashboard" })
    );
    expect(bannerWrapper().className).toContain("opacity-0");
  });

  it("shows the Compute stage after the import settles into post-boot maintenance", () => {
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
    expect(screen.getByText("Building your history timeline")).toBeTruthy();
    expect(screen.getByText("Rebuild history timeline")).toBeTruthy();
    // The pause control is gone — there is no import collector left to pause.
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

    hooks.useIngestProgress.mockReturnValue(ingest(1000, 1000, false, true));
    hooks.useMaintenanceProgress.mockReturnValue(maintenance(false));
    view.rerender(<FirstLaunchImportBanner />);
    act(() => {
      vi.advanceTimersByTime(MAINTENANCE_BRIDGE_MS - 500);
    });
    expect(bannerWrapper().className).toContain("opacity-100");

    hooks.useMaintenanceProgress.mockReturnValue(maintenance(true));
    view.rerender(<FirstLaunchImportBanner />);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(bannerWrapper().className).toContain("opacity-100");
    expect(screen.getByText("Building your history timeline")).toBeTruthy();

    hooks.useMaintenanceProgress.mockReturnValue(maintenance(false));
    view.rerender(<FirstLaunchImportBanner />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(bannerWrapper().className).toContain("opacity-0");
  });

  it("engages when the first poll already shows a completed import plus active maintenance", () => {
    hooks.useIngestProgress.mockReturnValue(ingest(7183, 7183, false, true));
    hooks.useMaintenanceProgress.mockReturnValue(maintenance(true, "rebuild"));
    render(<FirstLaunchImportBanner />);

    const wrapper = bannerWrapper();
    expect(wrapper.className).toContain("opacity-100");
    expect(wrapper.getAttribute("aria-hidden")).toBe("false");
    expect(screen.getByText("Building your history timeline")).toBeTruthy();
  });

  it("does not collapse while maintenance stays active, even past the safety cap", () => {
    vi.useFakeTimers();
    hooks.useIngestProgress.mockReturnValue(ingest(1000, 400));
    hooks.useMaintenanceProgress.mockReturnValue(maintenance(false));
    const view = render(<FirstLaunchImportBanner />);
    expect(bannerWrapper().className).toContain("opacity-100");

    hooks.useIngestProgress.mockReturnValue(ingest(1000, 1000, false, true));
    hooks.useMaintenanceProgress.mockReturnValue(
      maintenance(true, "artifact-links")
    );
    view.rerender(<FirstLaunchImportBanner />);
    expect(bannerWrapper().className).toContain("opacity-100");

    act(() => {
      vi.advanceTimersByTime(16 * 60_000);
    });
    expect(bannerWrapper().className).toContain("opacity-100");

    hooks.useMaintenanceProgress.mockReturnValue(maintenance(false));
    view.rerender(<FirstLaunchImportBanner />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(bannerWrapper().className).toContain("opacity-0");
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

  it("freezes the shimmer while paused (rail stops progressing)", () => {
    const setPaused = vi.fn().mockResolvedValue(undefined);
    (
      window as unknown as {
        desktopApi: { setAgentMonitorImportPaused: typeof setPaused };
      }
    ).desktopApi = { setAgentMonitorImportPaused: setPaused };
    hooks.useIngestProgress.mockReturnValue(ingest(10, 3));
    render(<FirstLaunchImportBanner />);

    fireEvent.click(screen.getByRole("button", { name: "Pause import" }));
    expect(screen.getByText("Import paused")).toBeTruthy();
    // The count stays put while paused; the collector pause gate holds the source.
    expect(screen.getByText("3 / 10 transcripts")).toBeTruthy();
    expect(overallProgressbar().getAttribute("aria-valuenow")).toBe("30");
  });
});
