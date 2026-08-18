import {
  ACTIVITY_PHASE_LABEL,
  UNKNOWN_ACTIVITY_PHASE_LABEL,
} from "@repo/api/src/activity-phase-labels";
import type { SyncedActivitySegmentRow } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import {
  BRANCH_ACTIVITY_ORDER,
  UNATTRIBUTED_KEY,
} from "./branches/activity-rollup.js";
import {
  buildActivitySegments,
  IDLE_PHASE_KEY,
  OTHER_PHASE_KEY,
} from "./sessions/activity-segment-aggregation.js";

/**
 * ISS-4790 — the catch-all bucket used to be spelled two different ways for the
 * SAME concept: the branch bar said "Other" while the session breakdown, the
 * session breakdown's hand-copied fallback literal, and the wire
 * `ActivitySegment.label` all said "Other / unclassified". These tests pin the
 * ONE-SOURCE property: every producer and every display map resolves a phase
 * bucket through {@link ACTIVITY_PHASE_LABEL}, so a call site that re-hardcodes
 * a divergent literal fails here rather than shipping a third spelling.
 *
 * `unattributed` is NOT another spelling of `other` — it is a SEPARATE bucket
 * with separate semantics (`other` is spend the classifier tiled but could not
 * classify; `unattributed` is spend it never saw), and the assertions below
 * pin that the two never collapse onto one label.
 *
 * This test lives in `@repo/lib` because it is the lowest layer that can see
 * BOTH the canonical map (`@repo/api`) and the phase-key constants that map is
 * keyed by. The per-surface resolver assertions live in each feature's own
 * colocated test (`packages/app/branches/lib/__tests__/activity-taxonomy-display.test.ts`,
 * `packages/app/agents/lib/__tests__/session-activity-phases.test.ts`), so no
 * test reaches across the `packages/app` feature/shared boundary.
 */

function row(
  phase: string,
  startMs: number,
  endMs: number
): SyncedActivitySegmentRow {
  return {
    phase,
    startMs,
    endMs,
    confidence: 0.9,
    evidenceLayers: [],
    version: 1,
  };
}

describe("ACTIVITY_PHASE_LABEL", () => {
  it("pins every canonical label to its exact user-facing string", () => {
    // The map is the SSOT, so this is the ONE place a label literal belongs.
    // Every other suite in the repo derives its expectation FROM the map, which
    // makes those assertions one-source checks rather than wording checks — they
    // would happily agree with a silently reworded label. This assertion is what
    // forces a wording change to be made deliberately, here, in the diff that
    // changes what users read.
    expect(ACTIVITY_PHASE_LABEL).toEqual({
      explore: "Explore",
      plan: "Plan",
      implement: "Implement",
      review: "Review",
      validate: "Validate",
      rework: "Rework",
      idle: "Idle",
      other: "Other",
      unattributed: "Unattributed",
    });
    expect(UNKNOWN_ACTIVITY_PHASE_LABEL).toBe("Unknown");
  });

  it("names every phase in the canonical branch taxonomy order", () => {
    // Driven from BRANCH_ACTIVITY_ORDER (the canonical phase list) rather than a
    // local copy, so ADDING a taxonomy phase without giving it a label fails
    // here instead of leaving this suite green against a stale duplicate.
    for (const phase of BRANCH_ACTIVITY_ORDER) {
      expect(ACTIVITY_PHASE_LABEL[phase]).toBeTruthy();
    }
    expect(Object.keys(ACTIVITY_PHASE_LABEL).sort()).toEqual(
      [...BRANCH_ACTIVITY_ORDER, UNATTRIBUTED_KEY].sort()
    );
  });

  it("is keyed by the shared @repo/lib phase-key constants", () => {
    // The label map deliberately does not import these constants (`@repo/api` is
    // the lower layer), so this is where the alignment is enforced: renaming a
    // key in @repo/lib without renaming it there orphans a label and fails here.
    // Asserted against the map's own named members, not against the label
    // wording: what is under test here is that each KEY constant still indexes
    // the entry it is supposed to. Repeating the literals would duplicate the
    // wording pin above and make a rewording fail in two places for one reason.
    expect(ACTIVITY_PHASE_LABEL[OTHER_PHASE_KEY]).toBe(
      ACTIVITY_PHASE_LABEL.other
    );
    expect(ACTIVITY_PHASE_LABEL[IDLE_PHASE_KEY]).toBe(
      ACTIVITY_PHASE_LABEL.idle
    );
    expect(ACTIVITY_PHASE_LABEL[UNATTRIBUTED_KEY]).toBe(
      ACTIVITY_PHASE_LABEL.unattributed
    );
  });

  it("keeps the two catch-all buckets distinguishable", () => {
    // They render as separate rows in the same branch panel, so collapsing them
    // onto one label would make the panel show two identically-named rows.
    expect(ACTIVITY_PHASE_LABEL.other).not.toBe(
      ACTIVITY_PHASE_LABEL.unattributed
    );
  });
});

describe("the wire label is the canonical label", () => {
  it("serializes ActivitySegment.label from ACTIVITY_PHASE_LABEL", () => {
    const segments = buildActivitySegments(
      [
        row("implement", 0, 100),
        row(OTHER_PHASE_KEY, 100, 200),
        row(IDLE_PHASE_KEY, 200, 300),
      ],
      []
    );

    const labelByKey = new Map(segments.map((s) => [s.key, s.label]));
    expect(labelByKey.get("implement")).toBe(ACTIVITY_PHASE_LABEL.implement);
    expect(labelByKey.get(OTHER_PHASE_KEY)).toBe(ACTIVITY_PHASE_LABEL.other);
    expect(labelByKey.get(IDLE_PHASE_KEY)).toBe(ACTIVITY_PHASE_LABEL.idle);
  });

  it("titleizes a phase key outside the taxonomy rather than dropping it", () => {
    const segments = buildActivitySegments([row("handoff", 0, 100)], []);
    expect(segments.find((s) => s.key === "handoff")?.label).toBe("Handoff");
  });

  it("titleizes a COMPOUND unknown key the way the display maps do", () => {
    // The wire producer ran its own capitalize copy, so a future classifier key
    // like `auto-review` serialized as "Auto-review" while the branch panel
    // rendered "Auto Review" for the same key. Producer and both display maps
    // now share one `labelize`, which is what the `ActivitySegment.label`
    // docstring promises API consumers.
    const segments = buildActivitySegments([row("auto-review", 0, 100)], []);
    expect(segments.find((s) => s.key === "auto-review")?.label).toBe(
      "Auto Review"
    );
  });

  it("does not resolve an inherited Object.prototype key as a label", () => {
    // `phase` is a bounded free string on the wire, so a key like `constructor`
    // is reachable. It must titleize like any other unknown key, never leak a
    // non-label value out of the canonical map.
    const segments = buildActivitySegments([row("constructor", 0, 100)], []);
    expect(segments.find((s) => s.key === "constructor")?.label).toBe(
      "Constructor"
    );
  });
});
