import {
  ACTIVITY_PHASE_LABEL,
  UNKNOWN_ACTIVITY_PHASE_LABEL,
} from "@repo/api/src/activity-phase-labels";
import { UNATTRIBUTED_KEY } from "@repo/lib/branches/activity-rollup";
import {
  IDLE_PHASE_KEY,
  OTHER_PHASE_KEY,
} from "@repo/lib/sessions/activity-segment-aggregation";
import { describe, expect, it } from "vitest";
import { getPhaseDisplay } from "../session-activity-phases";

/**
 * ISS-4790 — the session-surface half of the one-source property: this display
 * map owns the session COLORS and must take every LABEL from the canonical
 * {@link ACTIVITY_PHASE_LABEL}. A literal re-hardcoded here fails this suite.
 *
 * The branch surface has the mirror assertions in its own feature-owned test
 * (`packages/app/branches/lib/__tests__/activity-taxonomy-display.test.ts`), and
 * the cross-layer contract (canonical map vs the `@repo/lib` phase-key constants
 * and the wire label) is pinned in `packages/lib/activity-phase-labels.test.ts`.
 */
describe("getPhaseDisplay", () => {
  it("resolves every mapped phase label through the canonical map", () => {
    for (const [phase, label] of Object.entries(ACTIVITY_PHASE_LABEL)) {
      expect(getPhaseDisplay(phase).label).toBe(label);
    }
  });

  it("gives the client-synthesized unattributed residual a real entry", () => {
    // The session breakdown's no-tiling fallback renders through this map. It
    // must get the canonical word and a muted swatch, not titleize onto the
    // unknown-phase chart color and read as a real classifier phase.
    const display = getPhaseDisplay(UNATTRIBUTED_KEY);
    expect(display.label).toBe(ACTIVITY_PHASE_LABEL.unattributed);
    expect(display.colorVar).toContain("var(--muted-foreground)");
  });

  it("resolves the catch-all and idle buckets to the canonical labels", () => {
    expect(getPhaseDisplay(OTHER_PHASE_KEY).label).toBe(
      ACTIVITY_PHASE_LABEL.other
    );
    expect(getPhaseDisplay(IDLE_PHASE_KEY).label).toBe(
      ACTIVITY_PHASE_LABEL.idle
    );
  });

  it("keeps the catch-all and idle swatches visually distinct", () => {
    // Both are muted greys, but an idle slice adjacent to an `other` slice in
    // the proportional bar must not paint as one continuous block — the bar
    // would then show one bucket where the rows show two.
    expect(getPhaseDisplay(OTHER_PHASE_KEY).colorVar).not.toBe(
      getPhaseDisplay(IDLE_PHASE_KEY).colorVar
    );
  });

  it("titleizes a phase key outside the taxonomy rather than crashing", () => {
    expect(getPhaseDisplay("handoff").label).toBe("Handoff");
    expect(getPhaseDisplay("").label).toBe(UNKNOWN_ACTIVITY_PHASE_LABEL);
  });

  it("titleizes a COMPOUND unknown key the way the branch surface does", () => {
    // The two surfaces ran separate titleize copies: this one capitalized only
    // the first letter, so a future classifier key like `auto-review` read
    // "Auto-review" here while branch detail read "Auto Review" — one key, two
    // words, which is the drift this whole change exists to remove.
    expect(getPhaseDisplay("auto-review").label).toBe("Auto Review");
    expect(getPhaseDisplay("code_review").label).toBe("Code Review");
    expect(getPhaseDisplay("__").label).toBe(UNKNOWN_ACTIVITY_PHASE_LABEL);
  });

  it("does not resolve an inherited Object.prototype key as a phase", () => {
    expect(getPhaseDisplay("constructor").label).toBe("Constructor");
  });
});
