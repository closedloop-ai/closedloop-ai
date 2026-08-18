import { ACTIVITY_PHASE_LABEL } from "@repo/api/src/activity-phase-labels";
import { BranchVisibleLifecyclePhase } from "@repo/api/src/types/branch-phase-attribution";
import {
  BRANCH_ACTIVITY_ORDER,
  UNATTRIBUTED_KEY,
} from "@repo/lib/branches/activity-rollup";
import { describe, expect, it } from "vitest";
import { getActivityPhaseDisplay } from "../activity-taxonomy-display";

/**
 * FEA-2276: the sole per-phase display map for the branch cost-to-merge panel. The
 * module exists for its GRACEFUL fallback (a classifier phase the taxonomy grows
 * to include must still render an honest label + neutral swatch, never throw or
 * drop), so this exercises that path — not just the mapped phases the component
 * test already covers.
 *
 * ISS-4790 — the branch-surface half of the one-source property: this map owns
 * the branch COLORS and takes every LABEL from the canonical
 * {@link ACTIVITY_PHASE_LABEL}. The session surface has the mirror assertions in
 * its own feature-owned test
 * (`packages/app/agents/lib/__tests__/session-activity-phases.test.ts`).
 */
describe("getActivityPhaseDisplay", () => {
  it("resolves every canonical taxonomy phase label through the canonical map", () => {
    // Driven from BRANCH_ACTIVITY_ORDER so a phase added to the taxonomy without
    // a display entry fails here instead of passing against a local copy.
    for (const phase of BRANCH_ACTIVITY_ORDER) {
      expect(getActivityPhaseDisplay(phase).label).toBe(
        ACTIVITY_PHASE_LABEL[phase]
      );
    }
  });

  it("maps a known taxonomy phase to its label + themed chart token", () => {
    expect(getActivityPhaseDisplay("implement")).toEqual({
      label: ACTIVITY_PHASE_LABEL.implement,
      color: "var(--chart-3)",
    });
  });

  it("keeps the visible Build phase on the prototype's blue chart token", () => {
    expect(getActivityPhaseDisplay(BranchVisibleLifecyclePhase.Build)).toEqual({
      label: "Build",
      color: "var(--chart-1)",
    });
  });

  it("maps the rollup `unattributed` residual to its own label + muted swatch", () => {
    const display = getActivityPhaseDisplay(UNATTRIBUTED_KEY);
    expect(display.label).toBe(ACTIVITY_PHASE_LABEL.unattributed);
    // Muted-foreground family (a token-derived color-mix), never bespoke hex.
    expect(display.color).toContain("var(--muted-foreground)");
  });

  it("keeps `rework` on the danger token so backwards spend reads as such", () => {
    expect(getActivityPhaseDisplay("rework").color).toBe("var(--destructive)");
  });

  it("labelizes an unknown/compound phase (splits on -/_/:), with a neutral swatch", () => {
    const display = getActivityPhaseDisplay("auto-review");
    // labelize → "Auto Review", NOT the naive "Auto-review".
    expect(display.label).toBe("Auto Review");
    expect(display.color).toContain("var(--muted-foreground)");
  });

  it("handles an underscore-separated unknown phase", () => {
    expect(getActivityPhaseDisplay("code_review").label).toBe("Code Review");
  });

  it("does not resolve an inherited Object.prototype key as a phase", () => {
    // `phase` is a bounded free string, so "constructor" is reachable. Indexing
    // the plain map unguarded returns the real Object constructor (truthy), so
    // the `??` fallback would never fire and the row would render an undefined
    // label and color. Parity with the two sibling resolvers, which both guard.
    const display = getActivityPhaseDisplay("constructor");
    expect(display.label).toBe("Constructor");
    expect(display.color).toContain("var(--muted-foreground)");
  });

  it("falls back to the canonical catch-all for an empty/separator-only key", () => {
    expect(getActivityPhaseDisplay("").label).toBe(ACTIVITY_PHASE_LABEL.other);
    expect(getActivityPhaseDisplay("__").label).toBe(
      ACTIVITY_PHASE_LABEL.other
    );
  });
});
