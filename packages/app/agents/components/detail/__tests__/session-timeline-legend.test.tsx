import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import { SESSION_TIMELINE_LEGEND_FLAG_KEY } from "@repo/api/src/types/session-timeline-legend-flag";
import {
  type DotColor,
  getDotSemantic,
  getDotShape,
  getDotShapeClassName,
} from "@repo/app/agents/components/detail/activity-dot-rendering";
import type { DotCell } from "@repo/app/agents/components/detail/session-timeline-dot-cells";
import {
  SESSION_TIMELINE_LEGEND_BARS_LABEL,
  SESSION_TIMELINE_LEGEND_DOTS_LABEL,
  SessionTimelineLegend,
} from "@repo/app/agents/components/detail/session-timeline-legend";
import type { TimelineDotEvent } from "@repo/app/agents/components/detail/session-timeline-strip-parts";
import {
  buildTimelineTokenTypeStacks,
  type TimelineStackSegment,
} from "@repo/app/agents/lib/session-timeline-stacks";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { SESSION_TIMELINE_LEGEND_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  getTimelineMarkerSemanticLabel,
  TIMELINE_MARKER_SEMANTIC_ORDER,
} from "@repo/app/shared/lib/timeline-marker-semantics";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * ISS-10598 — the Session Timeline's colour key.
 *
 * Every label asserted here is read from the constant the component renders
 * from, never re-typed: the group names from the component's own exports, the
 * dot names from `timeline-marker-semantics`. A test holding its own copy of
 * the words keeps passing after a rename while the rendered key names nothing.
 *
 * The token-type names are the one place that would invite a derivation from
 * the code under test, so the case that polices the fallback FILTER asserts a
 * count instead — see its own comment. The only deliberate literals are in the
 * last case, which pins what the desktop e2e spec re-types.
 */

/**
 * Two columns that DISAGREE about which segments they carry — the union case.
 * `buildTimelineStacks` filters each column to its own positive segments, so a
 * key built from either column alone silently drops one of these two. Distinct
 * `colorVar`s so a swatch cannot be asserted by accident.
 */
const MODEL_A: TimelineStackSegment = {
  colorVar: "var(--chart-1)",
  key: "model-alpha",
  label: "model-alpha",
  value: 3,
};
const MODEL_B: TimelineStackSegment = {
  colorVar: "var(--chart-2)",
  key: "model-beta",
  label: "model-beta",
  value: 7,
};
const DISJOINT_COLUMNS: TimelineStackSegment[][] = [[MODEL_A], [MODEL_B]];

const DOT_LABELS = TIMELINE_MARKER_SEMANTIC_ORDER.map((semantic) =>
  getTimelineMarkerSemanticLabel(semantic)
);
/**
 * A bucket that spent on all three token types, and one that spent on none.
 * `buildTimelineTokenTypeStacks` filters per column exactly as
 * `buildTimelineStacks` does, so the second contributes nothing.
 */
const FULL_BUCKET = makeBucket({ cCache: 5, cIn: 3, cOut: 4 });
const CACHE_ONLY_BUCKET = makeBucket({ cCache: 5, cIn: 0, cOut: 0 });
const EMPTY_BUCKET = makeBucket({ cCache: 0, cIn: 0, cOut: 0 });
/** Every token-type label, read from the builder rather than re-typed. */
const TOKEN_TYPE_LABELS = [
  ...new Set(
    buildTimelineTokenTypeStacks([FULL_BUCKET]).flatMap((column) =>
      column.map((segment) => segment.label)
    )
  ),
].sort((left, right) => left.localeCompare(right));

/** One dot in every lane — the strip that plots all three kinds. */
const ALL_LANE_CELLS: DotCell[] = [
  { b: [makeDotEvent()], g: [makeDotEvent()], r: [makeDotEvent()] },
];
/** Human steering only: no commit and no failure was ever plotted. */
const STEERING_ONLY_CELLS: DotCell[] = [{ b: [makeDotEvent()], g: [], r: [] }];
const NO_DOT_CELLS: DotCell[] = [{ b: [], g: [], r: [] }];
/** The rail's lanes in `TIMELINE_MARKER_SEMANTIC_ORDER`, the key's order. */
const DOT_LANES_IN_ORDER = (["b", "g", "r"] as DotColor[]).sort(
  (left, right) =>
    TIMELINE_MARKER_SEMANTIC_ORDER.indexOf(getDotSemantic(left)) -
    TIMELINE_MARKER_SEMANTIC_ORDER.indexOf(getDotSemantic(right))
);

describe("SessionTimelineLegend (ISS-10598)", () => {
  /**
   * THE load-bearing negative. ISS-4779 requires a perceivable UI change to
   * ship shut, and a legend that renders regardless of the gate looks exactly
   * like a legend that is correctly gated on every screen where the flag
   * happens to be on.
   */
  it("renders nothing at all while its gate is closed", () => {
    renderLegend({ flagOn: false });

    expect(readGroupNames()).toEqual([]);
    for (const label of DOT_LABELS) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("names both colour systems, and unions the bar segments across columns", () => {
    renderLegend({ flagOn: true, stacks: DISJOINT_COLUMNS });

    expect(readGroupNames()).toEqual([
      SESSION_TIMELINE_LEGEND_BARS_LABEL,
      SESSION_TIMELINE_LEGEND_DOTS_LABEL,
    ]);
    // Both models, though neither column carries both — the union, not the
    // first column's own list.
    expect(readGroupEntries(SESSION_TIMELINE_LEGEND_BARS_LABEL)).toEqual([
      MODEL_A.label,
      MODEL_B.label,
    ]);
    expect(readGroupEntries(SESSION_TIMELINE_LEGEND_DOTS_LABEL)).toEqual(
      DOT_LABELS
    );
  });

  /**
   * The grouping marisolashgrove's review asked for: each group is its own `<dl>`
   * with its name in the `<dt>`, so "Bars" is tied to the three entries that
   * follow it in the ACCESSIBILITY tree rather than flattening into one run of
   * words. Asserting the two entry lists are disjoint is what makes this a
   * structural claim and not a restatement of the case above.
   */
  it("keeps each group's entries inside that group's own list", () => {
    renderLegend({ flagOn: true, stacks: DISJOINT_COLUMNS });

    const barEntries = readGroupEntries(SESSION_TIMELINE_LEGEND_BARS_LABEL);
    const dotEntries = readGroupEntries(SESSION_TIMELINE_LEGEND_DOTS_LABEL);

    expect(barEntries.some((entry) => dotEntries.includes(entry))).toBe(false);

    // WCAG 1.4.1 and the one-statement rule, on the SWATCH ELEMENT itself.
    // Every entry has one, so a selector that matched nothing would be the
    // vacuous pass this pair exists to rule out (tamsinb, #7602).
    const swatches = [...document.querySelectorAll("dd > [aria-hidden]")];
    expect(swatches).toHaveLength(barEntries.length + dotEntries.length);
    // The word beside the swatch is the ONLY statement of what the colour
    // means: an accessible name on the swatch would state the kind twice.
    for (const swatch of swatches) {
      expect(swatch.getAttribute("aria-label")).toBeNull();
      expect(swatch.getAttribute("title")).toBeNull();
      expect(swatch.textContent).toBe("");
    }
  });

  /**
   * The ordinal fallback (`useSessionTimelineScale` returns `stacks: null` when
   * no projection resolves). `renderBarStack` still paints the legacy
   * `.cb-cache`/`.cb-out`/`.cb-in` bars there, so the bar key must still be
   * present — an empty branch would leave the only coloured thing on the strip
   * unexplained.
   */
  it("still keys the bars on the null-stacks fallback the strip still paints", () => {
    renderLegend({ buckets: [FULL_BUCKET, EMPTY_BUCKET], flagOn: true });

    expect(readGroupEntries(SESSION_TIMELINE_LEGEND_BARS_LABEL)).toEqual(
      TOKEN_TYPE_LABELS
    );
  });

  /**
   * The same fallback, on a session that only ever spent on one token type.
   * Printing the three constants unconditionally named two colours the strip
   * paints at zero height — the bar-key twin of the dot case below.
   */
  it("names only the token types the fallback columns actually carry", () => {
    renderLegend({ buckets: [CACHE_ONLY_BUCKET], flagOn: true });

    /*
     * The COUNT is the claim, and it is asserted against a literal rather than
     * against anything `buildTimelineTokenTypeStacks` returns: an expectation
     * derived from the function under test agrees with that function's own
     * mistake. One spent token type, one row — three would be the two colours
     * this bucket's bars paint at zero height.
     */
    const entries = readGroupEntries(SESSION_TIMELINE_LEGEND_BARS_LABEL);
    expect(entries).toHaveLength(1);
    expect(TOKEN_TYPE_LABELS).toHaveLength(3);
    expect(TOKEN_TYPE_LABELS).toContain(entries[0]);
  });

  /**
   * Every bucket cost 0 on the fallback, where `renderBarStack` returns null
   * for every bar — so there is no bar key, and with no dot plotted either the
   * component renders nothing at all rather than an empty shell.
   */
  it("renders nothing when the strip paints neither a segment nor a dot", () => {
    renderLegend({
      buckets: [EMPTY_BUCKET],
      cells: NO_DOT_CELLS,
      flagOn: true,
    });

    expect(readGroupNames()).toEqual([]);
  });

  /**
   * `SessionTimelineDotRail` plots a dot only where `cell[color].length > 0`,
   * so a session that never failed and never delivered must not be told what
   * red and green mean — it has neither on screen. The steering row surviving
   * is what stops a blanket "drop the dot key" passing this.
   */
  it("names only the dot kinds the rail actually plotted", () => {
    renderLegend({
      cells: STEERING_ONLY_CELLS,
      flagOn: true,
      stacks: DISJOINT_COLUMNS,
    });

    expect(readGroupEntries(SESSION_TIMELINE_LEGEND_DOTS_LABEL)).toEqual([
      DOT_LABELS[0],
    ]);
  });

  /**
   * ISS-12117: every lane has its own shape (square, circle, diamond), since
   * hue alone cannot separate them. A key that showed different shapes would
   * teach the reader marks the strip does not draw. The rail's own DOM is
   * asserted against the same class in `session-timeline-marker-shapes.test.tsx`.
   */
  it("draws each dot row in the shape its mark has on the rail", () => {
    renderLegend({ flagOn: true, stacks: DISJOINT_COLUMNS });

    const dots = readGroupList(SESSION_TIMELINE_LEGEND_DOTS_LABEL);
    const marks = [...dots.querySelectorAll("dd [aria-hidden]")];
    expect(marks).toHaveLength(DOT_LANES_IN_ORDER.length);
    DOT_LANES_IN_ORDER.forEach((color, index) => {
      // The class is what draws the shape; the attribute alone draws nothing.
      expect(marks[index]).toHaveClass(getDotShapeClassName(color));
      expect(marks[index]).toHaveAttribute("data-shape", getDotShape(color));
    });
  });

  /**
   * `costUnmeasured` makes `renderBarStack` return NO stack, so there is no
   * coloured segment on screen for a bar key to name. The dot key is unaffected
   * — dots are events, not money — and asserting it survives is what stops a
   * blanket "render nothing" passing this.
   */
  it("withdraws the bar key, and only the bar key, when no stack is painted", () => {
    renderLegend({
      costUnmeasured: true,
      flagOn: true,
      stacks: DISJOINT_COLUMNS,
    });

    expect(readGroupNames()).toEqual([SESSION_TIMELINE_LEGEND_DOTS_LABEL]);
    expect(readGroupEntries(SESSION_TIMELINE_LEGEND_DOTS_LABEL)).toEqual(
      DOT_LABELS
    );
  });

  /**
   * `apps/desktop/test/e2e/session-timeline-synthesized-cost.spec.ts` seeds this gate as a
   * LITERAL — its module's extension-less `@repo/api/src/types/...` specifiers
   * do not resolve under Playwright's ESM loader, and a spec-level import
   * failure aborts the whole desktop-e2e suite at load time. This case is that
   * literal's pin: a rename fails here, naming the spec, rather than leaving
   * it seeding a key nothing reads. The web twin imports the constants
   * directly and re-types nothing, so it needs no pin.
   */
  it("gates on the key, and renders the word, the desktop e2e spec re-types", () => {
    expect(SESSION_TIMELINE_LEGEND_FEATURE_FLAG_KEY).toBe(
      SESSION_TIMELINE_LEGEND_FLAG_KEY
    );
    expect(SESSION_TIMELINE_LEGEND_FLAG_KEY).toBe("session-timeline-legend");
    expect(SESSION_TIMELINE_LEGEND_BARS_LABEL).toBe("Bars");
  });
});

function renderLegend({
  buckets = [],
  cells = ALL_LANE_CELLS,
  costUnmeasured = false,
  flagOn,
  stacks = null,
}: {
  buckets?: readonly ActivityBucket[];
  cells?: readonly DotCell[];
  costUnmeasured?: boolean;
  flagOn: boolean;
  stacks?: readonly (readonly TimelineStackSegment[])[] | null;
}) {
  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: flagOn ? [SESSION_TIMELINE_LEGEND_FEATURE_FLAG_KEY] : [],
      })}
    >
      <SessionTimelineLegend
        buckets={buckets}
        cells={cells}
        costUnmeasured={costUnmeasured}
        stacks={stacks}
      />
    </FeatureFlagAdapterProvider>
  );
}

/** Every rendered group, named by its own `<dt>`, in render order. */
function readGroupNames(): string[] {
  return [...document.querySelectorAll("dl")].map(
    (list) => list.querySelector("dt")?.textContent ?? ""
  );
}

/** One group's entries, read from the `<dd>`s of the `<dl>` that `<dt>` names. */
function readGroupEntries(groupName: string): string[] {
  return [...readGroupList(groupName).querySelectorAll("dd")].map(
    (entry) => entry.textContent ?? ""
  );
}

/** The `<dl>` its own `<dt>` names. */
function readGroupList(groupName: string): HTMLDListElement {
  const list = [...document.querySelectorAll("dl")].find(
    (candidate) => candidate.querySelector("dt")?.textContent === groupName
  );
  if (!list) {
    throw new Error(`No legend group named "${groupName}" was rendered`);
  }
  return list;
}

/** An `ActivityBucket` carrying only the three cost fields the key reads. */
function makeBucket(
  costs: Readonly<{ cCache: number; cIn: number; cOut: number }>
): ActivityBucket {
  return {
    byModel: {},
    label: "bucket",
    tl0: null,
    toolStart: 0,
    total: 0,
    ...costs,
  };
}

/** A plotted marker, reduced to the shape a dot lane holds. */
function makeDotEvent(): TimelineDotEvent {
  return { kind: "prompt", label: "seeded", t: "00:00" };
}
