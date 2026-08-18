import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImportSplashBody } from "../import-splash-body";
import {
  ComputeStep,
  ImportPhase,
  type ImportSplashState,
  PhaseStep,
} from "../import-splash-state";
import { SyncFootnoteState } from "../sync-footnote-state";

const PAUSE_OR_RESUME_NAME = /pause|resume/i;
// ISS-5281: the `processed`/`total` pair is source-file units, so the splash
// counts TRANSCRIPTS. The alert used to restate the DISCOVERED TOTAL as if it
// were a failure count; the shortfall now lives on the headline/detail above,
// and the alert renders at all only when it has a fact those lines cannot carry.
const TRANSCRIPT_COUNT_TEXT = /\/ .* transcripts/;
const FAILED_KEEP_GOING =
  /You can keep going with what imported, and we'll keep importing in the background\./;
// ISS-5258: the disclosure control that collapses the panel to the compact row.
const HIDE_DETAILS_NAME = /hide import details/i;

function baseState(overrides: Partial<ImportSplashState>): ImportSplashState {
  return {
    phase: ImportPhase.Scanning,
    activeStep: PhaseStep.Scan,
    computeStep: null,
    // ISS-6241: no compute population by default — the honest indeterminate
    // state every phase but a live, measurable rebuild is in.
    computeProgress: null,
    overallPct: 0,
    processed: 0,
    total: 0,
    paused: false,
    failed: false,
    inMaintenancePhase: false,
    // ISS-6241: the fixture starts in Scan, so no maintenance pass is live.
    maintenanceActive: false,
    headline: "Scanning your local logs",
    detail: "Looking for agent runs",
    perHarness: [],
    couldNotImportCount: 0,
    couldNotImportLabel: null,
    // ISS-5281 (review): the failed state's alert copy now lives on the state
    // beside headline/detail, so exactly one derivation owns the whole message.
    // Null on every non-failed phase, which is what these fixtures default to.
    alertTitle: null,
    alertDetail: null,
    // ISS-5348: the footnote ships unflagged, so there is no nullable
    // flag-off branch left. `Loading` is the pre-read default every fixture
    // starts from; cases that care about a settled row override it.
    syncFootnote: SyncFootnoteState.Loading,
    ...overrides,
  };
}

const noop = () => {
  // intentionally empty
};

describe("ImportSplashBody", () => {
  it("renders the headline and detail from state, and the scan skeleton placeholders", () => {
    const { container } = render(
      <ImportSplashBody
        onCollapse={noop}
        onContinue={noop}
        onTogglePause={noop}
        panelId="splash-panel"
        railPaused={false}
        state={baseState({
          headline: "Scanning your local logs",
          detail: "Looking for Claude Code, Codex, and other agent runs",
        })}
      />
    );

    expect(screen.getByText("Scanning your local logs")).toBeDefined();
    expect(
      screen.getByText("Looking for Claude Code, Codex, and other agent runs")
    ).toBeDefined();
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThanOrEqual(3);
  });

  it("shows the pause control only during the Importing phase and toggles on click", () => {
    const onTogglePause = vi.fn();
    render(
      <ImportSplashBody
        onCollapse={noop}
        onContinue={noop}
        onTogglePause={onTogglePause}
        panelId="splash-panel"
        railPaused={false}
        state={baseState({
          phase: ImportPhase.Importing,
          activeStep: PhaseStep.Import,
          total: 10,
          processed: 5,
          overallPct: 50,
          paused: false,
        })}
      />
    );

    const pauseButton = screen.getByRole("button", { name: "Pause import" });
    fireEvent.click(pauseButton);
    expect(onTogglePause).toHaveBeenCalledTimes(1);

    const rail = screen.getByRole("progressbar", {
      name: "Overall import progress",
    });
    expect(rail.querySelector('[data-slot="progress-sheen"]')).not.toBeNull();
  });

  it("labels the pause control Resume and stops the rail shimmer when the state is paused", () => {
    render(
      <ImportSplashBody
        onCollapse={noop}
        onContinue={noop}
        onTogglePause={noop}
        panelId="splash-panel"
        railPaused
        state={baseState({
          phase: ImportPhase.Importing,
          activeStep: PhaseStep.Import,
          total: 10,
          processed: 5,
          overallPct: 50,
          paused: true,
        })}
      />
    );

    expect(screen.getByRole("button", { name: "Resume import" })).toBeDefined();
    const rail = screen.getByRole("progressbar", {
      name: "Overall import progress",
    });
    expect(rail.querySelector('[data-slot="progress-sheen"]')).toBeNull();
  });

  it("hides the pause control outside the Importing phase", () => {
    render(
      <ImportSplashBody
        onCollapse={noop}
        onContinue={noop}
        onTogglePause={noop}
        panelId="splash-panel"
        railPaused={false}
        state={baseState({ phase: ImportPhase.Scanning })}
      />
    );

    expect(
      screen.queryByRole("button", { name: PAUSE_OR_RESUME_NAME })
    ).toBeNull();
  });

  it("renders the progress rail with the rounded percentage for in-flight phases", () => {
    render(
      <ImportSplashBody
        onCollapse={noop}
        onContinue={noop}
        onTogglePause={noop}
        panelId="splash-panel"
        railPaused={false}
        state={baseState({
          phase: ImportPhase.Importing,
          activeStep: PhaseStep.Import,
          total: 10,
          processed: 3,
          overallPct: 33.3,
        })}
      />
    );

    const rail = screen.getByRole("progressbar", {
      name: "Overall import progress",
    });
    expect(rail.getAttribute("aria-valuenow")).toBe("33");
  });

  it("omits the progress rail entirely in the Failed phase", () => {
    render(
      <ImportSplashBody
        onCollapse={noop}
        onContinue={noop}
        onTogglePause={noop}
        panelId="splash-panel"
        railPaused={false}
        state={baseState({
          phase: ImportPhase.Failed,
          activeStep: PhaseStep.Import,
          failed: true,
          processed: 4,
          total: 10,
          headline: "Import didn't finish",
          detail: "Stopped after 4 of 10 transcripts",
        })}
      />
    );

    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("shows the processed/total count only during Importing and Computing", () => {
    const { rerender } = render(
      <ImportSplashBody
        onCollapse={noop}
        onContinue={noop}
        onTogglePause={noop}
        panelId="splash-panel"
        railPaused={false}
        state={baseState({
          phase: ImportPhase.Importing,
          activeStep: PhaseStep.Import,
          processed: 3,
          total: 10,
          overallPct: 30,
        })}
      />
    );
    expect(screen.getByText("3 / 10 transcripts")).toBeDefined();

    rerender(
      <ImportSplashBody
        onCollapse={noop}
        onContinue={noop}
        onTogglePause={noop}
        panelId="splash-panel"
        railPaused={false}
        state={baseState({
          phase: ImportPhase.Computing,
          activeStep: PhaseStep.Compute,
          computeStep: ComputeStep.Rebuild,
          inMaintenancePhase: true,
          processed: 500,
          total: 500,
          overallPct: 100,
        })}
      />
    );
    expect(screen.getByText("500 / 500 transcripts")).toBeDefined();

    rerender(
      <ImportSplashBody
        onCollapse={noop}
        onContinue={noop}
        onTogglePause={noop}
        panelId="splash-panel"
        railPaused={false}
        state={baseState({
          phase: ImportPhase.Scanning,
          processed: 0,
          total: 0,
        })}
      />
    );
    expect(screen.queryByText(TRANSCRIPT_COUNT_TEXT)).toBeNull();
  });

  it("renders the Ready count as a plain line, not a third celebratory box", () => {
    const { container } = render(
      <ImportSplashBody
        onCollapse={noop}
        onContinue={noop}
        onTogglePause={noop}
        panelId="splash-panel"
        railPaused={false}
        state={baseState({
          phase: ImportPhase.Ready,
          activeStep: PhaseStep.Ready,
          total: 1000,
          processed: 1000,
          overallPct: 100,
          headline: "You are all set",
          detail: "Your dashboard is ready",
        })}
      />
    );

    // ISS-5281 (review): "You are all set" and "Your dashboard is ready" already
    // sit directly above this, so a tinted, bordered, icon-bearing box for one
    // count was a third victory lap. It is a plain line now — and the count is
    // in TRANSCRIPTS, the population `processed`/`total` actually measures.
    expect(container.textContent).toContain("1,000 transcripts imported");
    expect(container.textContent).not.toContain("1,000 sessions");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders the failure alert with a Continue action that dismisses the splash", () => {
    const onContinue = vi.fn();
    render(
      <ImportSplashBody
        onCollapse={noop}
        onContinue={onContinue}
        onTogglePause={noop}
        panelId="splash-panel"
        railPaused={false}
        state={baseState({
          phase: ImportPhase.Failed,
          activeStep: PhaseStep.Import,
          failed: true,
          processed: 4,
          total: 10,
          headline: "Import didn't finish",
          detail: "Stopped after 4 of 10 transcripts",
          alertTitle: null,
          alertDetail:
            "You can keep going with what imported, and we'll keep importing in the background.",
          perHarness: [
            {
              id: "claude",
              label: "Claude Code",
              total: 4,
              processed: 4,
              pct: 100,
              state: "done",
            },
          ],
        })}
      />
    );

    // ISS-5281 (review): nothing was quarantined, so there is no second fact and
    // NO alert renders at all. The box used to hold nothing but this reassurance,
    // which made the loudest, assertively-announced element on the screen the one
    // saying it's fine while the actual failure sat above it in muted type. It is
    // now a plain line beside the control that acts on it.
    expect(screen.getByText(FAILED_KEEP_GOING)).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Claude Code")).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: "Continue to dashboard" })
    );
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  // ISS-5281: the four outcomes the splash must keep distinguishable. Each names
  // the population it actually measured — sessions (the processed/total pair) and
  // quarantined source transcripts (`couldNotImportCount`) are different counts, and
  // only the latter is ever "couldn't be read".
  it("reports the real quarantine count, not the total, when a stopped import also had unreadable transcripts", () => {
    render(
      <ImportSplashBody
        onCollapse={noop}
        onContinue={noop}
        onTogglePause={noop}
        panelId="splash-panel"
        railPaused={false}
        state={baseState({
          phase: ImportPhase.Failed,
          activeStep: PhaseStep.Import,
          failed: true,
          processed: 4,
          total: 10,
          couldNotImportCount: 2,
          couldNotImportLabel: "2 transcripts couldn't be read",
          headline: "Import didn't finish",
          detail: "Stopped after 4 of 10 transcripts",
          alertTitle: "2 transcripts couldn't be read",
          alertDetail:
            "You can keep going with what imported, and we'll keep importing in the background.",
        })}
      />
    );

    const alert = screen.getByRole("alert");
    expect(screen.getByText("2 transcripts couldn't be read")).toBeDefined();
    // The failure count is 2, never the discovered total.
    expect(alert.textContent).not.toContain("10 transcripts");
    // The alert speaks ONLY when it has this second fact — and even then it
    // carries just the fact; the way forward stays a plain line by the button.
    expect(alert.textContent).not.toContain("keep going with what imported");
    expect(screen.getByText(FAILED_KEEP_GOING)).toBeDefined();
  });

  it("names only the unreadable transcripts when every discovered session was processed", () => {
    render(
      <ImportSplashBody
        onCollapse={noop}
        onContinue={noop}
        onTogglePause={noop}
        panelId="splash-panel"
        railPaused={false}
        state={baseState({
          phase: ImportPhase.Failed,
          activeStep: PhaseStep.Import,
          failed: true,
          processed: 10,
          total: 10,
          couldNotImportCount: 1,
          couldNotImportLabel: "1 transcript couldn't be read",
          headline: "Import didn't finish",
          detail: "10 transcripts imported",
          alertTitle: "1 transcript couldn't be read",
          alertDetail:
            "You can keep going with what imported, and we'll keep importing in the background.",
        })}
      />
    );

    expect(screen.getByText("1 transcript couldn't be read")).toBeDefined();
    // Never the self-refuting "stopped after 10 of 10".
    expect(screen.getByRole("alert").textContent).not.toContain("10 of 10");
  });

  it("renders the Ready celebration as a partial when transcripts were quarantined", () => {
    render(
      <ImportSplashBody
        onCollapse={noop}
        onContinue={noop}
        onTogglePause={noop}
        panelId="splash-panel"
        railPaused={false}
        state={baseState({
          phase: ImportPhase.Ready,
          activeStep: PhaseStep.Ready,
          total: 1000,
          processed: 1000,
          overallPct: 100,
          couldNotImportCount: 3,
          couldNotImportLabel: "3 transcripts couldn't be read",
          // ISS-5281 (review): the derivation softens the Ready headline on this
          // branch, so an all-clear is never promised directly over a warning.
          headline: "Import finished",
          detail: "Your dashboard is ready",
        })}
      />
    );

    const alert = screen.getByRole("alert");
    expect(screen.getByText("3 transcripts couldn't be read")).toBeDefined();
    // A quarantined transcript never parsed, so how many sessions it held is
    // unknowable — the partial must NOT claim the full discovered total imported.
    expect(alert.textContent).not.toContain("1,000");
    // The quarantine count is the ONE new fact; the two lines above already did
    // the reassurance, so the alert adds no description of its own (review).
    expect(alert.textContent).not.toContain(
      "Everything else on this device imported"
    );
    // A partial is not a failure: no error step, and the flow still reads Ready.
    expect(screen.getByText("Import finished")).toBeDefined();
    expect(screen.queryByText("You are all set")).toBeNull();
  });

  it("routes the Computing phase to the compute checklist", () => {
    render(
      <ImportSplashBody
        onCollapse={noop}
        onContinue={noop}
        onTogglePause={noop}
        panelId="splash-panel"
        railPaused={false}
        state={baseState({
          phase: ImportPhase.Computing,
          activeStep: PhaseStep.Compute,
          computeStep: ComputeStep.Rebuild,
          inMaintenancePhase: true,
          total: 500,
          processed: 500,
          overallPct: 100,
        })}
      />
    );

    expect(screen.getByText("Rebuild history timeline")).toBeDefined();
  });

  it("fires onCollapse from the disclosure and points aria-controls at the panel", () => {
    const onCollapse = vi.fn();
    render(
      <ImportSplashBody
        onCollapse={onCollapse}
        onContinue={noop}
        onTogglePause={noop}
        panelId="splash-panel"
        railPaused={false}
        state={baseState({
          phase: ImportPhase.Importing,
          activeStep: PhaseStep.Import,
          total: 60,
          processed: 18,
          overallPct: 30,
        })}
      />
    );

    const collapseControl = screen.getByRole("button", {
      name: HIDE_DETAILS_NAME,
    });
    expect(collapseControl.getAttribute("aria-expanded")).toBe("true");
    expect(collapseControl.getAttribute("aria-controls")).toBe("splash-panel");
    fireEvent.click(collapseControl);
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });
});
