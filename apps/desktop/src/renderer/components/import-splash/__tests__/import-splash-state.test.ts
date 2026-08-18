import { describe, expect, it } from "vitest";
import { MaintenancePhase } from "../../../../shared/maintenance-progress-contract";
import {
  emptyTranscriptStatusCounts,
  TranscriptEgressGate,
} from "../../../../shared/transcript-sync-status-contract";
import type {
  IngestProgress,
  MaintenanceProgress,
} from "../../../hooks/use-ingest-progress";
import {
  ComputeStep,
  deriveImportSplashState,
  describeImportShortfall,
  harnessDisplayLabel,
  harnessLabel,
  ImportPhase,
  type ImportSplashInput,
  PhaseStep,
} from "../import-splash-state";

function baseInput(overrides: Partial<ImportSplashInput>): ImportSplashInput {
  return {
    ingest: null,
    processed: 0,
    total: 0,
    paused: false,
    inMaintenancePhase: false,
    complete: false,
    maintenance: null,
    failed: false,
    ...overrides,
  };
}

function ingest(
  byHarness: IngestProgress["byHarness"],
  total: number,
  processed: number
): IngestProgress {
  return { byHarness, total, processed, preparing: false, complete: false };
}

function maintenance(phase: MaintenanceProgress["phase"]): MaintenanceProgress {
  if (phase === null) {
    return { active: false, phase: null };
  }
  // The union's discriminant: only `rebuild` may carry counts, so the two live
  // phases are separate members and cannot be built from one widened literal.
  if (phase === MaintenancePhase.Rebuild) {
    return { active: true, phase: MaintenancePhase.Rebuild };
  }
  return { active: true, phase };
}

describe("deriveImportSplashState", () => {
  it("reads a zero-total input as the Scan phase", () => {
    const state = deriveImportSplashState(baseInput({}));
    expect(state.phase).toBe(ImportPhase.Scanning);
    expect(state.activeStep).toBe(PhaseStep.Scan);
    expect(state.headline).toBe("Scanning your local logs");
    expect(state.overallPct).toBe(0);
  });

  it("reads a positive total as the Import phase and names the active tool", () => {
    const state = deriveImportSplashState(
      baseInput({
        ingest: ingest(
          [
            { harness: "claude", total: 1000, processed: 1000 },
            { harness: "codex", total: 1000, processed: 400 },
          ],
          2000,
          1400
        ),
        processed: 1400,
        total: 2000,
      })
    );
    expect(state.phase).toBe(ImportPhase.Importing);
    expect(state.activeStep).toBe(PhaseStep.Import);
    expect(state.overallPct).toBe(70);
    expect(state.detail).toBe("Reading your Codex sessions");
    const [claude, codex] = state.perHarness;
    expect(claude.state).toBe("done");
    expect(codex.state).toBe("active");
    expect(codex.pct).toBe(40);
  });

  it("clamps a processed count above total and floors negatives", () => {
    const over = deriveImportSplashState(
      baseInput({ processed: 12, total: 10, ingest: ingest([], 10, 12) })
    );
    expect(over.processed).toBe(10);
    expect(over.overallPct).toBe(100);

    const under = deriveImportSplashState(
      baseInput({ processed: -3, total: 10, ingest: ingest([], 10, -3) })
    );
    expect(under.processed).toBe(0);
    expect(under.overallPct).toBe(0);
  });

  it("maps the maintenance phase onto the Compute stage and pins the bar at 100%", () => {
    const rebuild = deriveImportSplashState(
      baseInput({
        processed: 2000,
        total: 2000,
        inMaintenancePhase: true,
        maintenance: maintenance("rebuild"),
      })
    );
    expect(rebuild.phase).toBe(ImportPhase.Computing);
    expect(rebuild.activeStep).toBe(PhaseStep.Compute);
    expect(rebuild.computeStep).toBe(ComputeStep.Rebuild);
    expect(rebuild.overallPct).toBe(100);
    expect(rebuild.headline).toBe("Building your history timeline");

    const links = deriveImportSplashState(
      baseInput({
        processed: 2000,
        total: 2000,
        inMaintenancePhase: true,
        maintenance: maintenance("artifact-links"),
      })
    );
    expect(links.computeStep).toBe(ComputeStep.Links);
  });

  it("reads a completed import with no maintenance as the Ready phase", () => {
    const state = deriveImportSplashState(
      baseInput({
        processed: 2000,
        total: 2000,
        complete: true,
        ingest: ingest([], 2000, 2000),
      })
    );
    expect(state.phase).toBe(ImportPhase.Ready);
    expect(state.activeStep).toBe(PhaseStep.Ready);
    expect(state.overallPct).toBe(100);
    expect(state.headline).toBe("You are all set");
  });

  it("keeps a mid-flight import on the Import phase even if complete is not yet set", () => {
    const state = deriveImportSplashState(
      baseInput({ processed: 500, total: 1000, ingest: ingest([], 1000, 500) })
    );
    expect(state.phase).toBe(ImportPhase.Importing);
  });

  it("surfaces the Failed phase with a frozen count but does not brand an individual harness errored", () => {
    const state = deriveImportSplashState(
      baseInput({
        ingest: ingest(
          [
            { harness: "claude", total: 700, processed: 300 },
            { harness: "codex", total: 300, processed: 0 },
          ],
          1000,
          300
        ),
        processed: 300,
        total: 1000,
        failed: true,
      })
    );
    expect(state.phase).toBe(ImportPhase.Failed);
    expect(state.failed).toBe(true);
    expect(state.activeStep).toBe(PhaseStep.Import);
    expect(state.headline).toBe("Import didn't finish");
    // The aggregate stall carries no per-harness attribution — the runtime
    // payload does not say which harness wedged, and imports overlap — so no
    // row is branded "error" (that would blame whichever row sorts first). The
    // mid-flight harness stays "active"; the failure is aggregate-level.
    const [claude, codex] = state.perHarness;
    expect(claude.state).toBe("active");
    expect(codex.state).toBe("pending");
    expect(state.perHarness.some((harness) => harness.state === "error")).toBe(
      false
    );
  });

  it("omits empty (0-total) harness rows and keeps the aggregate consistent", () => {
    const state = deriveImportSplashState(
      baseInput({
        ingest: ingest(
          [
            { harness: "claude", total: 1000, processed: 400 },
            // A harness with nothing to parse must never render a phantom row.
            { harness: "gemini", total: 0, processed: 0 },
            { harness: "codex", total: 600, processed: 600 },
          ],
          // A stale/mismatched banner aggregate must NOT leak into the display:
          // the aggregate is re-derived from the filtered rows.
          9999,
          9999
        ),
        processed: 9999,
        total: 9999,
      })
    );
    expect(state.perHarness.map((harness) => harness.id)).toEqual([
      "claude",
      "codex",
    ]);
    // 400 + 600 processed of 1000 + 600 total — derived from the shown rows.
    expect(state.processed).toBe(1000);
    expect(state.total).toBe(1600);
    expect(state.overallPct).toBe((1000 / 1600) * 100);
  });

  it("preserves the indeterminate scan aggregate before any harness registers", () => {
    // No rows yet (the source scan is still running): fall back to the banner's
    // preparing aggregate rather than collapsing to 0 from an empty filtered set.
    const state = deriveImportSplashState(
      baseInput({
        ingest: ingest([], 0, 0),
        processed: 0,
        total: 0,
      })
    );
    expect(state.perHarness).toEqual([]);
    expect(state.phase).toBe(ImportPhase.Scanning);
    expect(state.total).toBe(0);
  });

  it("uses the paused headline only during the Import phase", () => {
    const importing = deriveImportSplashState(
      baseInput({
        processed: 3,
        total: 10,
        paused: true,
        ingest: ingest([], 10, 3),
      })
    );
    expect(importing.headline).toBe("Import paused");

    const maintenancePaused = deriveImportSplashState(
      baseInput({
        processed: 10,
        total: 10,
        paused: true,
        inMaintenancePhase: true,
        maintenance: maintenance("rebuild"),
      })
    );
    expect(maintenancePaused.headline).toBe("Building your history timeline");
  });

  it("floors the overall rail at minOverallPct so a late harness cannot make it retreat", () => {
    // First harness alone: 900 of 1000 = 90% shown; the component latches this.
    const early = deriveImportSplashState(
      baseInput({
        ingest: ingest(
          [{ harness: "claude", total: 1000, processed: 900 }],
          1000,
          900
        ),
        processed: 900,
        total: 1000,
      })
    );
    expect(early.overallPct).toBe(90);

    // A second harness registers 1000 more sessions: the raw ratio is now
    // 900 / 2000 = 45%, but with the latched 90% floor the rail holds at 90%
    // instead of visibly retreating. The honest total still grows to 2000.
    const late = deriveImportSplashState(
      baseInput({
        ingest: ingest(
          [
            { harness: "claude", total: 1000, processed: 900 },
            { harness: "codex", total: 1000, processed: 0 },
          ],
          2000,
          900
        ),
        processed: 900,
        total: 2000,
        minOverallPct: early.overallPct,
      })
    );
    expect(late.total).toBe(2000);
    expect(late.overallPct).toBe(90);
  });

  it("clamps a stale minOverallPct floor to 100", () => {
    const state = deriveImportSplashState(
      baseInput({
        ingest: ingest([{ harness: "claude", total: 10, processed: 5 }], 10, 5),
        processed: 5,
        total: 10,
        minOverallPct: 999,
      })
    );
    expect(state.overallPct).toBe(100);
  });

  it("falls back to the raw id for an unmapped harness", () => {
    expect(harnessLabel("claude")).toBe("Claude Code");
    expect(harnessLabel("mystery-cli")).toBe("mystery-cli");
  });

  it("title-cases the unmapped fallback for display surfaces (ISS-5112)", () => {
    // Same map, so the labels can never drift from `harnessLabel` — only the
    // fallback differs, for surfaces that list harnesses beside each other.
    expect(harnessDisplayLabel("claude")).toBe("Claude Code");
    expect(harnessDisplayLabel("mystery-cli")).toBe("Mystery-cli");
    expect(harnessDisplayLabel("windsurf")).toBe("Windsurf");
  });
});

describe("honest sync copy (ISS-4716)", () => {
  const computing = {
    inMaintenancePhase: true,
    maintenance: maintenance("rebuild"),
    ingest: ingest([{ harness: "codex", total: 10, processed: 10 }], 10, 10),
    processed: 10,
    total: 10,
  };

  it("stops promising imminence and stops implying the dashboard is gated", () => {
    // The Compute phase is the DATA_REVISION rebuild — hours, not "finishing
    // up" — and the dashboard is usable throughout, which the old detail line
    // contradicted while the footer two lines below said the opposite.
    const state = deriveImportSplashState(baseInput(computing));
    expect(state.headline).toBe("Building your history timeline");
    expect(state.detail).toBe("Your dashboard is ready to use now");
  });

  it("derives the footnote on BOTH return paths", () => {
    // The footer sits outside the Failed phase's activity gate, so the early
    // `failed` return needs a footnote just as much as the main one.
    const ready = deriveImportSplashState(
      baseInput({
        transcriptSync: {
          state: "ready",
          snapshot: {
            enabled: false,
            online: false,
            tierGate: TranscriptEgressGate.Denied,
            storeReady: false,
            statusCounts: emptyTranscriptStatusCounts(),
          },
        },
      })
    );
    expect(ready.syncFootnote).toBe("disabled");

    const failed = deriveImportSplashState(
      baseInput({
        failed: true,
        transcriptSync: {
          state: "ready",
          snapshot: {
            enabled: false,
            online: false,
            tierGate: TranscriptEgressGate.Denied,
            storeReady: false,
            statusCounts: emptyTranscriptStatusCounts(),
          },
        },
      })
    );
    expect(failed.phase).toBe("failed");
    expect(failed.syncFootnote).toBe("disabled");
  });

  it("treats an input that has not polled yet as still loading", () => {
    // Never a settled empty state before the first read lands.
    expect(deriveImportSplashState(baseInput({})).syncFootnote).toBe("loading");
  });

  it("leaves the progress rail untouched — ISS-4715 owns that", () => {
    // The footer's sync state must never move the rail. Two DIFFERENT sync
    // states, same rail: comparing flag-off vs flag-on used to make this point,
    // and with the flag gone the meaningful contrast is between footnote states.
    const unpolled = deriveImportSplashState(baseInput(computing));
    const settled = deriveImportSplashState(
      baseInput({
        ...computing,
        transcriptSync: {
          state: "ready",
          snapshot: {
            enabled: false,
            online: false,
            tierGate: TranscriptEgressGate.Denied,
            storeReady: false,
            statusCounts: emptyTranscriptStatusCounts(),
          },
        },
      })
    );
    expect(unpolled.syncFootnote).not.toBe(settled.syncFootnote);
    expect(settled.overallPct).toBe(unpolled.overallPct);
  });
});

/**
 * ISS-4650 (ISS-4627 follow-up) — the backend `usage.byHarness` SQL rollup the
 * ISS-4627 guard covers feeds the Sessions harness FACET, not this splash. The
 * sync-progress / import splash derives its per-harness rows from
 * `ingest.byHarness`, so OpenCode being counted server-side is NOT evidence that
 * it renders here. This suite covers the renderer half directly.
 */
describe("deriveImportSplashState — OpenCode ingest rows (ISS-4650)", () => {
  it("renders an OpenCode harness row with its human label", () => {
    const state = deriveImportSplashState(
      baseInput({
        ingest: ingest(
          [
            { harness: "claude", total: 20, processed: 20 },
            { harness: "opencode", total: 10, processed: 4 },
          ],
          30,
          24
        ),
        total: 30,
        processed: 24,
      })
    );

    const opencode = state.perHarness.find((row) => row.id === "opencode");
    expect(opencode).toBeDefined();
    expect(opencode?.label).toBe("OpenCode");
    expect(opencode?.total).toBe(10);
    expect(opencode?.processed).toBe(4);
    expect(opencode?.state).toBe("active");
    // The aggregate is derived from the displayed rows, so a dropped OpenCode
    // row would also silently shrink the "N / M sessions" denominator.
    expect(state.total).toBe(30);
    // The detail line names the tool actively being read.
    expect(state.detail).toBe("Reading your OpenCode sessions");
  });

  it("renders an unknown/future harness row rather than omitting it (version-skew)", () => {
    const state = deriveImportSplashState(
      baseInput({
        ingest: ingest(
          [{ harness: "future-cli", total: 5, processed: 5 }],
          5,
          5
        ),
        total: 5,
        processed: 5,
      })
    );

    const future = state.perHarness.find((row) => row.id === "future-cli");
    expect(future).toBeDefined();
    // Unmapped harnesses fall back to the raw id — visible, never dropped.
    expect(future?.label).toBe("future-cli");
    expect(future?.state).toBe("done");
  });
});

// ISS-5281: the alert used to hardcode "Some transcripts couldn't be read" over
// "We stopped after ${processed} of ${total} transcripts" — a count that measured
// the DISCOVERED TOTAL rather than anything that failed, under a noun the rest of
// the splash reserves for the quarantine population. Sessions (the
// processed/total pair) and quarantined source transcripts are separate
// populations, and each branch must name the one it actually measured. One
// function owns headline + detail + alert so they cannot contradict each other.
describe("describeImportShortfall", () => {
  it("names the transcripts still to import, never the discovered total", () => {
    const failure = describeImportShortfall({
      processed: 300,
      total: 1000,
      couldNotImportLabel: null,
    });
    expect(failure.headline).toBe("Import didn't finish");
    expect(failure.detail).toBe("Stopped after 300 of 1,000 transcripts");
    // Nothing was quarantined, so the alert has no fact the detail lacks and
    // stays a way forward rather than restating the same arithmetic.
    expect(failure.alertTitle).toBeNull();
    expect(failure.alertDetail).not.toContain("couldn't be read");
  });

  it("counts unreadable transcripts separately from the transcripts still to import", () => {
    const failure = describeImportShortfall({
      processed: 300,
      total: 1000,
      couldNotImportLabel: "4 transcripts couldn't be read",
    });
    expect(failure.detail).toBe("Stopped after 300 of 1,000 transcripts");
    expect(failure.alertTitle).toBe("4 transcripts couldn't be read");
  });

  it("says the scan did not finish rather than inventing a transcript shortfall", () => {
    const failure = describeImportShortfall({
      processed: 90,
      total: 90,
      couldNotImportLabel: null,
    });
    // The headline must agree with the detail: everything discovered DID import,
    // so shouting "Import didn't finish" over "90 transcripts imported" would be the
    // same self-refuting shape this ticket exists to kill, one line down.
    expect(failure.headline).toBe("We couldn't finish scanning this device");
    expect(failure.detail).toBe("90 transcripts imported");
    // Never the self-refuting "stopped after 90 of 90".
    expect(failure.detail).not.toContain("90 of 90");
    expect(failure.alertTitle).toBeNull();
  });

  it("reports the quarantine count on a fully-processed run", () => {
    const failure = describeImportShortfall({
      processed: 90,
      total: 90,
      couldNotImportLabel: "1 transcript couldn't be read",
    });
    expect(failure.headline).toBe("We couldn't finish scanning this device");
    expect(failure.alertTitle).toBe("1 transcript couldn't be read");
  });

  it("degrades honestly when the scan never produced a total at all", () => {
    const failure = describeImportShortfall({
      processed: 0,
      total: 0,
      couldNotImportLabel: null,
    });
    // ISS-5281 (review): `total` is the pending population of THIS pass, so 0
    // legitimately means "nothing pending" on a returning machine whose scan
    // wedged — it must never be read out as a claim about the DEVICE.
    expect(failure.headline).toBe("We couldn't scan this device");
    expect(failure.detail).toBe("Nothing new has been imported yet");
    expect(failure.detail).not.toContain("0 of 0");
    // "couldn't be read" stays reserved for the quarantine population, which is
    // the only one this branch has actually measured (it measured nothing).
    expect(failure.headline).not.toContain("read");
    expect(failure.detail).not.toContain("No sessions");
    // There is no "what imported" to keep going with on this branch, so the
    // shared reassurance must NOT be used — that would state something untrue.
    expect(failure.alertDetail).toBe("We'll keep trying in the background.");
    expect(failure.alertDetail).not.toContain("what imported");
  });

  it("offers the keep-going reassurance on every branch that imported something", () => {
    const importedSomething = [
      { processed: 300, total: 1000, couldNotImportLabel: null },
      {
        processed: 300,
        total: 1000,
        couldNotImportLabel: "4 transcripts couldn't be read",
      },
      {
        processed: 90,
        total: 90,
        couldNotImportLabel: "1 transcript couldn't be read",
      },
      { processed: 90, total: 90, couldNotImportLabel: null },
    ];
    for (const input of importedSomething) {
      expect(describeImportShortfall(input).alertDetail).toBe(
        "You can keep going with what imported, and we'll keep importing in the background."
      );
    }
  });

  it("keeps every branch free of em dashes and engineering vocabulary", () => {
    const everyBranch = [
      { processed: 0, total: 0, couldNotImportLabel: null },
      { processed: 300, total: 1000, couldNotImportLabel: null },
      {
        processed: 300,
        total: 1000,
        couldNotImportLabel: "4 transcripts couldn't be read",
      },
      {
        processed: 90,
        total: 90,
        couldNotImportLabel: "1 transcript couldn't be read",
      },
      { processed: 90, total: 90, couldNotImportLabel: null },
    ];
    for (const input of everyBranch) {
      const failure = describeImportShortfall(input);
      const copy = [
        failure.headline,
        failure.detail,
        failure.alertTitle ?? "",
        failure.alertDetail,
      ].join(" ");
      expect(copy).not.toContain("\u2014");
      expect(copy).not.toContain("collector");
    }
  });
});

// ISS-5281: the quarantine count is threaded through the derivation so the Ready
// phase can render a partial (ran fully, some transcripts failed) instead of
// either a clean success or a failure.
describe("deriveImportSplashState — couldNotImportCount", () => {
  it("projects the main-process quarantine count onto every phase", () => {
    const state = deriveImportSplashState(
      baseInput({
        ingest: {
          ...ingest([{ harness: "claude", total: 90, processed: 90 }], 90, 90),
          quarantinedCount: 3,
        },
        processed: 90,
        total: 90,
        complete: true,
      })
    );
    expect(state.phase).toBe(ImportPhase.Ready);
    expect(state.couldNotImportCount).toBe(3);
  });

  it("degrades to 0 when an older main process omits the field", () => {
    const state = deriveImportSplashState(
      baseInput({
        ingest: ingest(
          [{ harness: "claude", total: 90, processed: 90 }],
          90,
          90
        ),
        processed: 90,
        total: 90,
        complete: true,
      })
    );
    expect(state.couldNotImportCount).toBe(0);
  });

  it("never says the run stopped after its own total in the Failed phase", () => {
    const state = deriveImportSplashState(
      baseInput({
        ingest: ingest(
          [{ harness: "claude", total: 90, processed: 90 }],
          90,
          90
        ),
        processed: 90,
        total: 90,
        failed: true,
      })
    );
    expect(state.detail).toBe("90 transcripts imported");
    expect(state.detail).not.toContain("Stopped after");
    // The headline is derived alongside the detail, so it cannot contradict it.
    expect(state.headline).toBe("We couldn't finish scanning this device");
  });
});

// ISS-5281 (review): three things the derivation now owns so no consumer can
// re-derive them and drift — the failed alert copy, the step the error dot lands
// on, and the Ready headline when a quarantine warning renders beneath it.
describe("deriveImportSplashState — failed-state ownership", () => {
  function failedState(processed: number, total: number, quarantined = 0) {
    return deriveImportSplashState(
      baseInput({
        ingest: {
          ...ingest(
            [{ harness: "claude", total, processed }],
            total,
            processed
          ),
          quarantinedCount: quarantined,
        },
        processed,
        total,
        failed: true,
      })
    );
  }

  it("puts the failed alert copy on the state beside the headline and detail", () => {
    const quarantined = failedState(300, 1000, 4);
    // The alert speaks only when it has a second fact; the way forward always
    // rides along, and both are read off the state rather than re-derived.
    expect(quarantined.alertTitle).toBe("4 transcripts couldn't be read");
    expect(quarantined.alertDetail).toBe(
      "You can keep going with what imported, and we'll keep importing in the background."
    );

    const clean = failedState(300, 1000);
    expect(clean.alertTitle).toBeNull();
    expect(clean.alertDetail).toBe(
      "You can keep going with what imported, and we'll keep importing in the background."
    );
  });

  it("leaves the alert fields null on every phase that has no alert", () => {
    const ready = deriveImportSplashState(
      baseInput({
        ingest: ingest(
          [{ harness: "claude", total: 90, processed: 90 }],
          90,
          90
        ),
        processed: 90,
        total: 90,
        complete: true,
      })
    );
    expect(ready.phase).toBe(ImportPhase.Ready);
    expect(ready.alertTitle).toBeNull();
    expect(ready.alertDetail).toBeNull();
  });

  it("lands the error dot on the step that actually failed", () => {
    // Sessions were left behind: the IMPORT is what stopped.
    expect(failedState(300, 1000).activeStep).toBe(PhaseStep.Import);
    // Everything discovered reached a terminal outcome, so the headline blames
    // the scan — the stepper must agree instead of green-checking Scan and
    // reddening Import.
    const scanFailed = failedState(90, 90);
    expect(scanFailed.headline).toBe("We couldn't finish scanning this device");
    expect(scanFailed.activeStep).toBe(PhaseStep.Scan);
    // A wedge that never produced a total at all is a scan failure too.
    expect(failedState(0, 0).activeStep).toBe(PhaseStep.Scan);
  });

  it("softens the Ready headline only when a quarantine warning renders under it", () => {
    const withQuarantine = deriveImportSplashState(
      baseInput({
        ingest: {
          ...ingest([{ harness: "claude", total: 90, processed: 90 }], 90, 90),
          quarantinedCount: 2,
        },
        processed: 90,
        total: 90,
        complete: true,
      })
    );
    expect(withQuarantine.phase).toBe(ImportPhase.Ready);
    expect(withQuarantine.headline).toBe("Import finished");

    const clean = deriveImportSplashState(
      baseInput({
        ingest: ingest(
          [{ harness: "claude", total: 90, processed: 90 }],
          90,
          90
        ),
        processed: 90,
        total: 90,
        complete: true,
      })
    );
    expect(clean.headline).toBe("You are all set");
  });
});

describe("Compute progress (ISS-6241)", () => {
  const rebuilding = (
    counts: Partial<{ processed: number; total: number }> = {}
  ): MaintenanceProgress => ({
    active: true,
    phase: "rebuild",
    ...counts,
  });

  it("surfaces the REAL population the rebuild reported", () => {
    // The known-total case: the pass seeded 1,299 and has finished 412, so that
    // exact pair must reach the view-state — not a re-derivation, not a ratio.
    const state = deriveImportSplashState(
      baseInput({
        inMaintenancePhase: true,
        maintenance: rebuilding({ processed: 412, total: 1299 }),
        showComputeProgress: true,
      })
    );

    expect(state.phase).toBe(ImportPhase.Computing);
    expect(state.computeProgress).toEqual({ processed: 412, total: 1299 });
  });

  it("stays indeterminate when the phase reports no population", () => {
    // The unavailable-total case, and the one the honesty bar is really about.
    // The artifact-link backfill runs inside the db host with no progress
    // channel out, so it has nothing to report — and the splash must NOT
    // synthesize a 0/0 or borrow the import's own transcript count.
    const state = deriveImportSplashState(
      baseInput({
        inMaintenancePhase: true,
        maintenance: { active: true, phase: "artifact-links" },
        showComputeProgress: true,
        ingest: ingest(
          [{ harness: "claude", total: 90, processed: 90 }],
          90,
          90
        ),
        processed: 90,
        total: 90,
      })
    );

    expect(state.phase).toBe(ImportPhase.Computing);
    expect(state.computeProgress).toBeNull();
    // The import's own 90 is RIGHT THERE and must not be reused as a denominator
    // for a different population.
    expect(state.total).toBe(90);
  });

  it("reports nothing while the flag is off, even when counts are available", () => {
    // ISS-4779 closed-by-default: the perceivable surface must not leak.
    const state = deriveImportSplashState(
      baseInput({
        inMaintenancePhase: true,
        maintenance: rebuilding({ processed: 412, total: 1299 }),
      })
    );

    expect(state.computeProgress).toBeNull();
  });

  it("carries no compute population into the failed state", () => {
    const state = deriveImportSplashState(
      baseInput({
        failed: true,
        maintenance: rebuilding({ processed: 412, total: 1299 }),
        showComputeProgress: true,
        ingest: ingest(
          [{ harness: "claude", total: 90, processed: 40 }],
          90,
          40
        ),
        processed: 40,
        total: 90,
      })
    );

    expect(state.phase).toBe(ImportPhase.Failed);
    expect(state.computeProgress).toBeNull();
  });

  it("keeps a live pass LIVE when it names a phase this build has never heard of", () => {
    // The version-skew degrade `parse-maintenance-progress` produces: an
    // unrecognised phase becomes `null` while `active` survives. `computeStep`
    // is null here for the same reason it is null once the pass ends, so the
    // liveness bit is the ONLY thing that tells the two apart — and without it
    // the checklist green-checks both sub-steps for the whole running pass.
    const live = deriveImportSplashState(
      baseInput({
        inMaintenancePhase: true,
        maintenance: { active: true, phase: null },
        showComputeProgress: true,
      })
    );

    expect(live.computeStep).toBeNull();
    expect(live.maintenanceActive).toBe(true);
    // What the renderer does with that pair — neither sub-step reading done — is
    // asserted against the REAL derived state in
    // `__tests__/compute-checklist.test.tsx`.

    // The genuine wind-down, for contrast: same null step, opposite liveness.
    const settled = deriveImportSplashState(
      baseInput({
        inMaintenancePhase: true,
        maintenance: { active: false, phase: null },
      })
    );
    expect(settled.computeStep).toBeNull();
    expect(settled.maintenanceActive).toBe(false);
  });

  it("reports nothing once maintenance goes inactive", () => {
    // This used to hand an INACTIVE payload a live `{processed, total}` pair to
    // prove the derivation ignored them. That shape is now unrepresentable —
    // counts ride an active `rebuild` or they do not exist — so it cannot be
    // built on this side of the boundary. The runtime case it was guarding
    // (counts riding an inactive payload off the wire) still has coverage where
    // untyped input actually arrives: "drops counts that ride an INACTIVE
    // payload" in `hooks/__tests__/parse-maintenance-progress.test.ts`.
    const state = deriveImportSplashState(
      baseInput({
        inMaintenancePhase: true,
        maintenance: { active: false, phase: null },
        showComputeProgress: true,
      })
    );

    expect(state.computeProgress).toBeNull();
  });
});
