import { describe, expect, it } from "vitest";
import {
  costPhases,
  headlineCostUsd,
  leadIdlePct,
  leadLegend,
  leadPrOpenedPct,
  leadSegments,
  PhaseKey,
} from "./mock";
import {
  BREAKDOWN_VIEW,
  BreakdownViewKind,
  focusTargetOnBack,
  openSessionView,
  toggleKey,
} from "./phase-breakdown-state";

const CENTS = 2;

describe("cost breakdown reconciliation", () => {
  it("derives each phase cost from the sum of its sessions", () => {
    for (const phase of costPhases) {
      const sessionSum = phase.sessions.reduce(
        (sum, session) => sum + session.costUsd,
        0
      );
      expect(sessionSum).toBeCloseTo(phase.costUsd, CENTS);
    }
  });

  it("sums phase costs to the headline so the rows never leave it high or low", () => {
    const phaseSum = costPhases.reduce((sum, phase) => sum + phase.costUsd, 0);
    expect(phaseSum).toBeCloseTo(headlineCostUsd, CENTS);
  });

  it("keeps the bar percentages a partition of 100", () => {
    const total = costPhases.reduce((sum, phase) => sum + phase.pct, 0);
    expect(total).toBe(100);
  });

  it("carries an Unattributed fallback so omitted-segment sessions still count", () => {
    const unattributed = costPhases.find(
      (phase) => phase.key === PhaseKey.Unattributed
    );
    expect(unattributed).toBeDefined();
    expect(unattributed?.sessions.length).toBeGreaterThan(0);
    // The residual phase has no place on the lead-time line.
    expect(unattributed?.elapsedLabel).toBeNull();
  });
});

describe("lead-time timeline", () => {
  it("draws every legend entry as a real segment (idle included)", () => {
    const segmentKeys = new Set(leadSegments.map((segment) => segment.key));
    for (const item of leadLegend) {
      expect(segmentKeys.has(item.key)).toBe(true);
    }
    expect(segmentKeys.has("idle")).toBe(true);
  });

  it("keeps the segment widths a partition of 100", () => {
    const total = leadSegments.reduce((sum, segment) => sum + segment.pct, 0);
    expect(total).toBe(100);
  });

  it("puts the PR-opened marker at the end of Build and reports idle honestly", () => {
    const build = leadSegments.find(
      (segment) => segment.key === PhaseKey.Build
    );
    expect(leadPrOpenedPct).toBe(build?.pct);
    expect(leadIdlePct).toBeGreaterThan(0);
  });
});

describe("view-state transitions", () => {
  it("toggles a phase key without mutating the previous list", () => {
    const opened = toggleKey([], PhaseKey.Build);
    expect(opened).toEqual([PhaseKey.Build]);
    const closed = toggleKey(opened, PhaseKey.Build);
    expect(closed).toEqual([]);
    // Original list is untouched (state lives above the view switch).
    expect(opened).toEqual([PhaseKey.Build]);
  });

  it("opens a session detail view and returns focus to that session on back", () => {
    const view = openSessionView("cs_9f21");
    expect(view.kind).toBe(BreakdownViewKind.Session);
    expect(focusTargetOnBack(view)).toBe("cs_9f21");
  });

  it("has no focus target when already on the breakdown", () => {
    expect(focusTargetOnBack(BREAKDOWN_VIEW)).toBeNull();
  });
});
