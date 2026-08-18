import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComputeChecklist } from "../compute-checklist";
import {
  ComputeStep,
  deriveImportSplashState,
  ImportPhase,
  type ImportSplashState,
  PhaseStep,
} from "../import-splash-state";
import { SyncFootnoteState } from "../sync-footnote-state";

function baseState(overrides: Partial<ImportSplashState>): ImportSplashState {
  return {
    phase: ImportPhase.Computing,
    activeStep: PhaseStep.Compute,
    computeStep: ComputeStep.Rebuild,
    // ISS-6241: no compute population by default — the honest indeterminate
    // state every phase but a live, measurable rebuild is in.
    computeProgress: null,
    overallPct: 100,
    processed: 500,
    total: 500,
    paused: false,
    failed: false,
    inMaintenancePhase: true,
    // ISS-6241: the default fixture is a LIVE pass on a named phase, so the
    // liveness bit is set. Cases about the wind-down tail override it.
    maintenanceActive: true,
    headline: "Building your history timeline",
    detail: "Your dashboard is ready to use now",
    // ISS-5281: the failed state's alert copy lives on the state; Compute has no
    // alert, so both are null here.
    alertTitle: null,
    alertDetail: null,
    perHarness: [],
    couldNotImportCount: 0,
    couldNotImportLabel: null,
    // ISS-5348: the footnote ships unflagged, so there is no nullable
    // flag-off branch left. `Loading` is the pre-read default every fixture
    // starts from; cases that care about a settled row override it.
    syncFootnote: SyncFootnoteState.Loading,
    ...overrides,
  };
}

// Module-scoped so the matcher is not recompiled per assertion (useTopLevelRegex).
const STANDALONE_OF = /\bof\b/;

function stepListItem(label: string): HTMLElement {
  const el = screen.getByText(label).closest("li");
  if (!el) {
    throw new Error(`Expected a <li> ancestor for "${label}"`);
  }
  return el;
}

describe("ComputeChecklist", () => {
  it("pluralizes the tool count summary for multiple harnesses", () => {
    render(
      <ComputeChecklist
        state={baseState({
          total: 1500,
          perHarness: [
            {
              id: "claude",
              label: "Claude Code",
              total: 1000,
              processed: 1000,
              pct: 100,
              state: "done",
            },
            {
              id: "codex",
              label: "Codex",
              total: 500,
              processed: 500,
              pct: 100,
              state: "done",
            },
          ],
        })}
      />
    );

    expect(
      screen.getByText("Imported 1,500 transcripts from 2 tools")
    ).toBeDefined();
  });

  it("uses the singular tool label for exactly one harness", () => {
    render(
      <ComputeChecklist
        state={baseState({
          total: 500,
          perHarness: [
            {
              id: "claude",
              label: "Claude Code",
              total: 500,
              processed: 500,
              pct: 100,
              state: "done",
            },
          ],
        })}
      />
    );

    expect(
      screen.getByText("Imported 500 transcripts from 1 tool")
    ).toBeDefined();
  });

  it("omits the tool-count clause when no harness has a total", () => {
    render(
      <ComputeChecklist state={baseState({ total: 500, perHarness: [] })} />
    );

    expect(screen.getByText("Imported 500 transcripts")).toBeDefined();
  });

  it("shows the active step's dot as pulsing and the upcoming step as pending", () => {
    render(
      <ComputeChecklist
        state={baseState({ computeStep: ComputeStep.Rebuild })}
      />
    );

    const rebuildItem = stepListItem("Rebuild history timeline");
    expect(rebuildItem.querySelector("[data-ob-motion]")).not.toBeNull();

    const linksItem = stepListItem("Link sessions to branches and PRs");
    expect(linksItem.querySelector("[data-ob-motion]")).toBeNull();
    expect(linksItem.textContent).toContain(
      "Link sessions to branches and PRs"
    );
    const linksLabel = screen.getByText("Link sessions to branches and PRs");
    expect(linksLabel.className).toContain("text-muted-foreground");
  });

  it("marks a step before the active one as done via a check icon", () => {
    render(
      <ComputeChecklist state={baseState({ computeStep: ComputeStep.Links })} />
    );

    const rebuildItem = stepListItem("Rebuild history timeline");
    expect(rebuildItem.querySelector("svg")).not.toBeNull();
    expect(rebuildItem.querySelector("[data-ob-motion]")).toBeNull();
  });

  it("reads every step as done once maintenance winds down (reported inactive)", () => {
    // ISS-6241 (review): re-targeted onto the GENUINE wind-down. This used to
    // pin `computeStep: null` alone as the wind-down signal, but a null phase is
    // also what a LIVE pass degrades to when it names a phase this build has
    // never heard of — the case below. `maintenanceActive: false` is what
    // actually says the pass is over.
    render(
      <ComputeChecklist
        state={baseState({ computeStep: null, maintenanceActive: false })}
      />
    );

    // Both "done" and "active" share the non-muted label class, so that
    // alone can't prove Links stopped pulsing as active. Check icons (done)
    // vs. the pulsing dot (active) distinguish the two.
    const rebuildItem = stepListItem("Rebuild history timeline");
    const linksItem = stepListItem("Link sessions to branches and PRs");
    expect(rebuildItem.querySelector("svg")).not.toBeNull();
    expect(linksItem.querySelector("svg")).not.toBeNull();
    expect(rebuildItem.querySelector("[data-ob-motion]")).toBeNull();
    expect(linksItem.querySelector("[data-ob-motion]")).toBeNull();

    const rebuildLabel = screen.getByText("Rebuild history timeline");
    const linksLabel = screen.getByText("Link sessions to branches and PRs");
    expect(rebuildLabel.className).not.toContain("text-muted-foreground");
    expect(linksLabel.className).not.toContain("text-muted-foreground");
  });
  it("green-checks nothing while a live pass names an unknown phase (ISS-6241)", () => {
    // The version-skew degrade: a newer main process reports a phase this build
    // has no sub-step for, so the validator keeps `active` and drops the phase.
    // Reading that null as "finished" would check off both steps for the whole
    // duration of a running pass.
    //
    // Driven through the REAL derivation rather than a hand-built fixture, so
    // this covers the wiring too: a payload off the wire has to reach the render
    // still carrying its liveness.
    render(
      <ComputeChecklist
        state={deriveImportSplashState({
          ingest: null,
          processed: 0,
          total: 0,
          paused: false,
          inMaintenancePhase: true,
          complete: false,
          maintenance: { active: true, phase: null },
          failed: false,
        })}
      />
    );

    const rebuildItem = stepListItem("Rebuild history timeline");
    const linksItem = stepListItem("Link sessions to branches and PRs");
    // No check icon on either row: nothing here has finished.
    expect(rebuildItem.querySelector("svg")).toBeNull();
    expect(linksItem.querySelector("svg")).toBeNull();
    // And neither is claimed as the live one, because we do not know which is.
    expect(rebuildItem.querySelector("[data-ob-motion]")).toBeNull();
    expect(linksItem.querySelector("[data-ob-motion]")).toBeNull();
    expect(screen.getByText("Rebuild history timeline").className).toContain(
      "text-muted-foreground"
    );
    expect(
      screen.getByText("Link sessions to branches and PRs").className
    ).toContain("text-muted-foreground");
  });

  it("puts the real count on the ACTIVE step only (ISS-6241)", () => {
    render(
      <ComputeChecklist
        state={baseState({
          computeStep: ComputeStep.Rebuild,
          computeProgress: { processed: 412, total: 1299 },
        })}
      />
    );

    // The seeded population, rendered verbatim on the step that measured it.
    const rebuildItem = stepListItem("Rebuild history timeline");
    expect(rebuildItem.textContent).toContain("412 of 1,299 sessions");
    // The pending step measured nothing, so it says nothing.
    const linksItem = stepListItem("Link sessions to branches and PRs");
    expect(linksItem.textContent).not.toContain("of 1,299");
  });

  it("renders no count at all when the phase has no population (ISS-6241)", () => {
    // The honest indeterminate state: an active dot and a label, exactly as the
    // step shipped. Never a synthesized "0 of 0", and never a "100%".
    render(
      <ComputeChecklist
        state={baseState({
          computeStep: ComputeStep.Links,
          computeProgress: null,
        })}
      />
    );

    const linksItem = stepListItem("Link sessions to branches and PRs");
    expect(linksItem.querySelector("[data-ob-motion]")).not.toBeNull();
    expect(linksItem.textContent).not.toMatch(STANDALONE_OF);
    expect(linksItem.textContent).not.toContain("0 of 0");
    expect(linksItem.textContent).not.toContain("%");
  });

  it("drops the count once the step it belonged to is done (ISS-6241)", () => {
    // A finished step's last count is stale the moment the phase advances, so it
    // must not linger beside a check mark as if it were a result.
    render(
      <ComputeChecklist
        state={baseState({
          computeStep: ComputeStep.Links,
          computeProgress: { processed: 88, total: 88 },
        })}
      />
    );

    const rebuildItem = stepListItem("Rebuild history timeline");
    expect(rebuildItem.querySelector("svg")).not.toBeNull();
    expect(rebuildItem.textContent).not.toContain("88");
  });
});
