import { describe, expect, it } from "vitest";
import {
  CompactTone,
  deriveImportSplashCompactState,
} from "../import-splash-compact-state";
import {
  ImportPhase,
  type ImportSplashState,
  PhaseStep,
} from "../import-splash-state";
import { SyncFootnoteState } from "../sync-footnote-state";

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
    // ISS-5281: the failed state's alert copy lives on the state; the compact
    // row derives from these same fields, so the fixture carries them too.
    alertTitle: null,
    alertDetail: null,
    perHarness: [],
    couldNotImportCount: 0,
    couldNotImportLabel: null,
    syncFootnote: SyncFootnoteState.Loading,
    ...overrides,
  };
}

describe("deriveImportSplashCompactState (ISS-5258)", () => {
  it("carries the count and Pause while importing, and no percentage", () => {
    const compact = deriveImportSplashCompactState(
      baseState({
        phase: ImportPhase.Importing,
        activeStep: PhaseStep.Import,
        headline: "Importing your agent history",
        overallPct: 30,
        processed: 18,
        total: 60,
      })
    );

    expect(compact.tone).toBe(CompactTone.Progress);
    expect(compact.label).toBe("Importing your agent history");
    // The rail directly beneath is filled to exactly 30%, so printing "· 30%"
    // here would say the same thing twice in the row where horizontal room is
    // the whole constraint.
    expect(compact.metrics).toBe("18 / 60 transcripts");
    expect(compact.metrics).not.toContain("%");
    // Importing is the one phase that promotes the count, matching the expanded
    // body — it is the number someone collapses the splash in order to keep.
    expect(compact.promoteMetrics).toBe(true);
    expect(compact.showRail).toBe(true);
    expect(compact.railPct).toBe(30);
    expect(compact.showPause).toBe(true);
    expect(compact.paused).toBe(false);
    expect(compact.showContinue).toBe(false);
  });

  it("says paused rather than showing a frozen percentage alone", () => {
    const compact = deriveImportSplashCompactState(
      baseState({
        phase: ImportPhase.Importing,
        activeStep: PhaseStep.Import,
        // The expanded splash swaps its own headline when paused; the compact
        // row takes that headline verbatim so the two cannot drift.
        headline: "Import paused",
        overallPct: 30,
        paused: true,
        processed: 18,
        total: 60,
      })
    );

    expect(compact.tone).toBe(CompactTone.Paused);
    expect(compact.label).toBe("Import paused");
    expect(compact.paused).toBe(true);
    // The count is still honest — it is the LABEL that carries "stopped".
    expect(compact.metrics).toBe("18 / 60 transcripts");
  });

  it("keeps a failed import visible and drops the percentage", () => {
    const compact = deriveImportSplashCompactState(
      baseState({
        phase: ImportPhase.Failed,
        activeStep: PhaseStep.Import,
        failed: true,
        headline: "Import didn't finish",
        overallPct: 61,
        processed: 1503,
        total: 2452,
      })
    );

    expect(compact.tone).toBe(CompactTone.Attention);
    expect(compact.label).toBe("Import didn't finish");
    // A percentage beside a stopped import reads as progress still happening.
    expect(compact.metrics).toBe("1,503 / 2,452 transcripts");
    expect(compact.metrics).not.toContain("%");
    // A stopped import is not the number the user stayed collapsed for, and the
    // expanded body leaves it muted here too. Asserting the negative is what
    // stops the Importing promotion assertion from passing for every phase.
    expect(compact.promoteMetrics).toBe(false);
    // Mirrors the expanded body, which also drops the rail when it failed.
    expect(compact.showRail).toBe(false);
    expect(compact.showPause).toBe(false);
    // The expanded panel pairs its failure Alert with a way out; collapsing
    // must not strip the remedy and strand the user on a red row.
    expect(compact.showContinue).toBe(true);
  });

  it("claims no count during the scan, where no total is known yet", () => {
    const compact = deriveImportSplashCompactState(
      baseState({
        phase: ImportPhase.Scanning,
        headline: "Scanning your local logs",
        overallPct: 0,
        processed: 0,
        total: 0,
      })
    );

    expect(compact.tone).toBe(CompactTone.Progress);
    // Never a fabricated "0 / 0 · 0%".
    expect(compact.metrics).toBeNull();
    expect(compact.showPause).toBe(false);
    // An empty determinate track reads as "0% done"; the scan does not know how
    // far along it is, so the rail renders indeterminate instead.
    expect(compact.railPct).toBeNull();
  });

  it("names the compute work instead of implying the whole job is done", () => {
    const compact = deriveImportSplashCompactState(
      baseState({
        phase: ImportPhase.Computing,
        activeStep: PhaseStep.Compute,
        headline: "Building your history timeline",
        inMaintenancePhase: true,
        overallPct: 100,
        processed: 2452,
        total: 2452,
      })
    );

    expect(compact.tone).toBe(CompactTone.Progress);
    expect(compact.label).toBe("Building your history timeline");
    // The import really is complete; the REBUILD that follows has no percentage
    // of its own, so the row reports the count rather than a global "100% done".
    expect(compact.metrics).toBe("2,452 transcripts imported");
    expect(compact.metrics).not.toContain("%");
    // A full determinate bar reads as "finished" while the rebuild is still
    // running, so Compute takes the indeterminate treatment.
    expect(compact.railPct).toBeNull();
    expect(compact.showPause).toBe(false);
  });

  it("reads as done at Ready", () => {
    const compact = deriveImportSplashCompactState(
      baseState({
        phase: ImportPhase.Ready,
        activeStep: PhaseStep.Ready,
        headline: "You are all set",
        overallPct: 100,
        processed: 2452,
        total: 2452,
      })
    );

    expect(compact.tone).toBe(CompactTone.Done);
    expect(compact.metrics).toBe("2,452 transcripts imported");
    expect(compact.railPct).toBe(100);
  });

  it("claims no count on a failure that never got a total", () => {
    const compact = deriveImportSplashCompactState(
      baseState({
        phase: ImportPhase.Failed,
        activeStep: PhaseStep.Import,
        failed: true,
        headline: "Import didn't finish",
        overallPct: 0,
        processed: 0,
        total: 0,
      })
    );

    // A stall during the scan has no denominator. "0 / 0 transcripts" would be the
    // fabricated count this module promises never to print.
    expect(compact.metrics).toBeNull();
    expect(compact.tone).toBe(CompactTone.Attention);
    expect(compact.showContinue).toBe(true);
  });
});
