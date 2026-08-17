import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import { TIMELINE_VISIBLE_COLUMNS } from "@repo/app/agents/lib/session-timeline-scale";
import {
  stubContainerWidthPx,
  stubResizableContainerWidthPx,
} from "@repo/app/test/mocks/container-width";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatBucketBarLabel,
  formatBucketTooltipTotal,
  getBucketCost,
} from "../activity-bucket-rendering";
import {
  createAgentSessionDetailFixture,
  createTurnItemsSpanning,
  withProducerBinBounds,
} from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import { buildBucketAccessibleCosts } from "../session-timeline-bar-labels";
import { withProviders } from "./agent-session-detail-view.test-helpers";

/**
 * ISS-5761, through the composed view — the production wiring, not the helper.
 *
 * The reported strip: a 3h35m session, 37 buckets, every one of them priced
 * highly enough to clear `getBarStyle`'s label threshold, printed into a rail
 * that gives each label about 19px. The labels do not truncate, they ABUT, and
 * the reader is handed `$724.0` — `$7` and `$24.0` touching — a figure no bucket
 * holds.
 *
 * ISS-5999 note on the shape of these fixtures: ISS-5819's clock window is now
 * unconditional, so the rail always has exactly `TIMELINE_VISIBLE_COLUMNS`
 * cells — the producer's own bin count no longer reaches the DOM. The bin count
 * therefore stopped being the density lever and WIDTH is the whole decision,
 * which is what these now vary. The fixtures span two hours so the projection
 * actually fills those columns; a shorter run leaves most of them empty and
 * would test the label rule on a strip that is mostly blank.
 *
 * Mounting the composed view is what makes this a regression test rather than a
 * unit test of the rail: the rail only receives 37 labels because
 * `buildBucketBarLabels` decided to print them, and the accessible names below
 * only carry money because `agent-session-detail-view.tsx` threads
 * `buildBucketAccessibleCosts` into `getBucketButtonLabel`. Deleting either call
 * site has to fail here.
 *
 * Shared verbatim by `apps/app` and the desktop renderer through `@repo/app`, so
 * pinning the composed view pins both surfaces — neither has its own copy of the
 * strip, the rail, or the bar button.
 */

const RAIL_SELECTOR = ".sd3-bars2-lbls";
const RAIL_CELL_SELECTOR = ".sd3-bar2-lbl";
const BAR_SELECTOR = ".sd3-bar2";

/** A normal session-detail content width for the strip. */
const DETAIL_RAIL_WIDTH_PX = 720;

/** Wide enough that every column has room, to isolate width alone. */
const VERY_WIDE_RAIL_WIDTH_PX = 6000;

/** The window's fixed column count — what the rail lays labels out over. */
const RENDERED_COLUMNS = TIMELINE_VISIBLE_COLUMNS;

/** Two hours of run, so the 24 five-minute columns are all occupied. */
const RUN_START_ISO = "2026-06-10T10:00:00.000Z";
const RUN_END_ISO = "2026-06-10T12:00:00.000Z";

/** A printed rail figure. */
const PRINTED_MONEY_RE = /^\$/;

/**
 * The most expensive of the 24 rendered columns for the 37-bin fixture — the one
 * figure the rail keeps when it cannot print them all. A literal, because the
 * contract is that the SURVIVOR is the peak; re-deriving the maximum here would
 * assert the rail agrees with this test's own arithmetic rather than with the
 * strip.
 */
const PEAK_COLUMN_LABEL = "$40.65";

/** A bucket button's accessible name with a cost appended to the action. */
const NAMED_WITH_COST_RE = /activity bucket .+, \$/i;

/**
 * The reported session's shape: 37 five-minute buckets across 3h35m, each
 * costing enough to clear the 16%-of-peak label threshold, so the rail is asked
 * to print all 37.
 */
function createDenseBuckets(count: number): ActivityBucket[] {
  return Array.from({ length: count }, (_, index) => {
    // 8.55 → 45.5, the reported band, without any bucket falling under 16% of
    // the peak (which would drop its label and thin the rail for the wrong
    // reason).
    const cost = 8.55 + (index % 7) * 3.2;
    return {
      key: `dense-${index}`,
      label: `${index * 5}m`,
      cIn: cost * 0.5,
      cOut: cost * 0.3,
      cCache: cost * 0.2,
      total: 6,
      toolStart: 2,
      tl0: index,
      byModel: {
        "gpt-5.5": { cIn: cost * 0.5, cOut: cost * 0.3, cCache: cost * 0.2 },
      },
    } satisfies ActivityBucket;
  });
}

function denseSession(bucketCount: number) {
  return createAgentSessionDetailFixture({
    // ISS-5819 review (wongk): stamped with the producer bin bounds a real strip
    // carries, because the clock projection this case is about refuses to run on
    // bins that cannot say which clock they were measured on.
    activityBuckets: withProducerBinBounds(createDenseBuckets(bucketCount), {
      endMs: Date.parse(RUN_END_ISO),
      startMs: Date.parse(RUN_START_ISO),
    }),
    turnItems: createTurnItemsSpanning(RUN_START_ISO, RUN_END_ISO),
  });
}

function renderStrip(bucketCount: number, railWidthPx: number) {
  const restore = stubContainerWidthPx(railWidthPx);
  const result = render(
    withProviders(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={denseSession(bucketCount)}
      />
    )
  );
  return { restore, ...result };
}

function printedLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll(RAIL_CELL_SELECTOR)]
    .map((cell) => cell.textContent ?? "")
    .filter((text) => text.length > 0);
}

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

describe("Session Timeline cost rail density (ISS-5761)", () => {
  it("prints the peak alone at a normal detail width", () => {
    const { container, restore } = renderStrip(37, DETAIL_RAIL_WIDTH_PX);
    restoreContainerWidth = restore;

    // The rail is still there, one cell per rendered column, so the strip below
    // it does not move — it has simply stopped printing a figure into each of
    // the ~30px the window's columns leave.
    expect(container.querySelector(RAIL_SELECTOR)).not.toBeNull();
    expect(container.querySelectorAll(RAIL_CELL_SELECTOR)).toHaveLength(
      RENDERED_COLUMNS
    );
    const labels = printedLabels(container);
    expect(labels).toHaveLength(1);
    // The survivor is the strip's most expensive column, not an arbitrary one —
    // an arbitrary survivor is what would make the rail ambiguous again.
    expect(labels[0]).toMatch(PRINTED_MONEY_RE);
    expect(labels).toEqual([PEAK_COLUMN_LABEL]);
  });

  it("prints every label on the same columns when the rail is wide enough", () => {
    // Guards against a fix that always hides: the decision must be about width,
    // or a wide desktop pane loses labels it can afford.
    const { container, restore } = renderStrip(37, VERY_WIDE_RAIL_WIDTH_PX);
    restoreContainerWidth = restore;

    expect(printedLabels(container)).toHaveLength(RENDERED_COLUMNS);
  });

  it("makes the same call for a sparse producer strip as a dense one", () => {
    // ISS-5999: the producer's bin count is no longer the lever — six bins and
    // thirty-seven both project onto the same 24 columns — so the rail must not
    // start printing again just because fewer bins arrived.
    const { container, restore } = renderStrip(6, DETAIL_RAIL_WIDTH_PX);
    restoreContainerWidth = restore;

    expect(container.querySelectorAll(RAIL_CELL_SELECTOR)).toHaveLength(
      RENDERED_COLUMNS
    );
    const labels = printedLabels(container);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(PRINTED_MONEY_RE);
  });

  it("keeps every bucket's cost in the accessible name when the rail is quiet", () => {
    // ISS-5761's bar: if the labels are not rendered, the values must be
    // reachable another way — and not exclusively through a hover card, which is
    // what the bucket tooltip is (it opens on `onMouseEnter` alone).
    const { container, restore } = renderStrip(37, DETAIL_RAIL_WIDTH_PX);
    restoreContainerWidth = restore;

    const named = [...container.querySelectorAll("button.sd3-bar2")].map(
      (bar) => bar.getAttribute("aria-label") ?? ""
    );
    expect(named).not.toHaveLength(0);
    for (const name of named) {
      expect(name).toMatch(NAMED_WITH_COST_RE);
    }
  });

  it("goes quiet when the pane is dragged narrow, and speaks again when it widens", () => {
    // The rail measures itself, so the decision has to survive a live resize —
    // a fix that only read the width once at mount would leave a user who
    // narrowed the detail pane looking at the collision again.
    const { restore, setWidth } = stubResizableContainerWidthPx(
      VERY_WIDE_RAIL_WIDTH_PX
    );
    restoreContainerWidth = restore;
    const { container } = render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={denseSession(37)}
        />
      )
    );
    expect(printedLabels(container)).toHaveLength(RENDERED_COLUMNS);

    act(() => setWidth(DETAIL_RAIL_WIDTH_PX));
    expect(printedLabels(container)).toHaveLength(1);
    // The cells stay, so the strip below has not moved.
    expect(container.querySelectorAll(RAIL_CELL_SELECTOR)).toHaveLength(
      RENDERED_COLUMNS
    );

    act(() => setWidth(VERY_WIDE_RAIL_WIDTH_PX));
    expect(printedLabels(container)).toHaveLength(RENDERED_COLUMNS);
  });

  it("never nests a rail cell inside a bar, so no bar-scoped rule can govern it", () => {
    // ISS-5548 (PR #4634) shipped `.sd3-bar2.reach .sd3-bar2-lbl { visibility:
    // hidden }` on the premise that the label was a child of the bar. ISS-5563
    // (PR #4642) had already moved it into the sibling rail two hours earlier,
    // so that descendant selector matched nothing on the day it merged. This
    // pins the structure that made it dead, so the guard cannot be reinstated
    // as if it worked.
    const { container, restore } = renderStrip(37, DETAIL_RAIL_WIDTH_PX);
    restoreContainerWidth = restore;

    expect(
      container.querySelectorAll(`${BAR_SELECTOR} ${RAIL_CELL_SELECTOR}`)
    ).toHaveLength(0);
    expect(
      container.querySelectorAll(RAIL_CELL_SELECTOR).length
    ).toBeGreaterThan(0);
  });
});

/**
 * `buildBucketAccessibleCosts` directly, because it is the leg ISS-5761's bar
 * stands on: if the rail may print nothing, the figure has to survive somewhere
 * a keyboard and a screen reader can reach. The composed tests above prove the
 * wiring; these prove the two branches that decide whether there is a figure at
 * all.
 */
describe("buildBucketAccessibleCosts (ISS-5761)", () => {
  it("names every priced bucket's cost", () => {
    expect(
      buildBucketAccessibleCosts({
        buckets: createDenseBuckets(3),
        costsSynthesized: false,
      })
    ).toEqual(["$8.55", "$11.75", "$14.95"]);
  });

  it("names a four-figure bucket EXACTLY, not with the rail's abbreviation", () => {
    // Code review (wongk): the rail prints `~$1.1k` because four significant
    // digits do not fit in an 18px bar — a pixel-width constraint that an
    // accessible name does not have. Borrowing `formatBucketBarLabel` here left
    // a screen-reader user with an approximation while a sighted user hovering
    // the same bar got the exact figure from the tooltip, so the precise value
    // was reachable by POINTER ONLY. That is the access gap this function
    // exists to close, reopened one formatter deep.
    const [bucket] = createDenseBuckets(1);
    expect(
      buildBucketAccessibleCosts({
        buckets: [
          { ...bucket, cIn: 900.5, cOut: 150.25, cCache: 58.11 },
          { ...bucket, cIn: 1_000_000, cOut: 0, cCache: 0 },
        ],
        costsSynthesized: false,
      })
    ).toEqual(["$1,108.86", "$1,000,000.00"]);
  });

  it("agrees with the bucket tooltip's total, which is the exact figure's home", () => {
    // The name and the hover card are the two places the exact figure lives, so
    // they must be the same string. Pinned against the tooltip formatter itself
    // rather than a copied literal, so a change to either has to be made to both.
    const [bucket] = createDenseBuckets(1);
    const priced = { ...bucket, cIn: 900.5, cOut: 150.25, cCache: 58.11 };
    expect(
      buildBucketAccessibleCosts({
        buckets: [priced],
        costsSynthesized: false,
      })
    ).toEqual([formatBucketTooltipTotal(getBucketCost(priced))]);
  });

  it("keeps the rail's compact print, so only the NAME gained precision", () => {
    // The other half of the same decision: this fix must not quietly widen the
    // printed label, which is width-constrained and correctly abbreviated.
    expect(formatBucketBarLabel(1108.86)).toBe("~$1.1k");
  });

  it("names nothing on a synthesized strip, which publishes no figures", () => {
    // ISS-5566 withdrew printed costs from a strip priced off the
    // `MIN_ACTIVITY_COST` floor. A name that announced them would republish
    // exactly what the rail withdrew, one keystroke away.
    expect(
      buildBucketAccessibleCosts({
        buckets: createDenseBuckets(3),
        costsSynthesized: true,
      })
    ).toEqual([null, null, null]);
  });

  it("names nothing for a zero-cost bucket rather than announcing $0.00", () => {
    const [bucket] = createDenseBuckets(1);
    expect(
      buildBucketAccessibleCosts({
        buckets: [{ ...bucket, cIn: 0, cOut: 0, cCache: 0 }],
        costsSynthesized: false,
      })
    ).toEqual([null]);
  });
});
