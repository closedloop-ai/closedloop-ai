import type {
  ActivityBucket,
  AgentSessionDetail,
} from "@repo/api/src/types/agent-session";
import { TIMELINE_VISIBLE_COLUMNS } from "@repo/app/agents/lib/session-timeline-scale";
import { SESSION_TIMELINE_COLUMN_HIT_TARGET_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  createAgentSessionDetailFixture,
  createTurnItemsSpanning,
  withProducerBinBounds,
} from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";

/**
 * ISS-5548 regression: `.sd3-bars2` is `align-items: flex-end` and a bar's
 * height IS its value, so the `<button>` — which is the control — is also the
 * whole click target. `getBarStyle` floors an active bar at 9% of a ~62px
 * column, about 6px, and the quiet buckets a reader is most likely to probe end
 * up the hardest to hit.
 *
 * The fix hangs a full-column hit box off `.sd3-bar2.reach`, and `.reach` is
 * applied only to a bar that HAS a transcript anchor. These tests assert that
 * class contract through the rendered view, because jsdom implements no layout:
 * every rect here is zero and `elementFromPoint` is unimplemented, so the pixel
 * geometry cannot be observed at this level and asserting on it would be a lie.
 * The geometry itself is proven in a real browser — Chromium via Playwright
 * `setContent` over this exact stylesheet, measuring `elementFromPoint` down the
 * column — and recorded on the PR: the 9% bar goes from 6/62px reachable to
 * 62/62px while its rendered height stays 6px, and the anchorless bar stays at
 * 7/7px. What is locked in HERE is the input that geometry keys off, which is
 * the part a future edit can silently break.
 */

const SESSION_ID = "session-hit-target-1";
const BUCKET_BUTTON_NAME = /activity bucket/i;
const REACH_CLASS = "reach";
/**
 * ISS-5999: ISS-5819's clock window is now unconditional, so the two source bins
 * below are projected onto the window's 24 columns rather than rendered one bar
 * each. The fixture spans two hours so the split is clean — the anchored bin
 * owns the first half of the window and the anchorless bin the second — which
 * keeps the jumpable/anchorless axis this suite is about intact.
 */
const RUN_START_ISO = "2026-06-10T10:00:00.000Z";
const RUN_END_ISO = "2026-06-10T12:00:00.000Z";
/**
 * The anchorless column's accessible name. Matched by SHAPE rather than in full
 * because the window labels its columns by CLOCK TIME, which is rendered in the
 * runner's local zone. The two halves that matter are still pinned: the ACTION
 * clause is "Activity bucket", never "Jump to activity bucket", and ISS-5761's
 * cost still rides the name.
 */
const ANCHORLESS_NAME_RE = /^Activity bucket .+, \$\d/;

/**
 * Two buckets. The first is a real but tiny spend WITH a transcript anchor —
 * `getBarStyle` puts it on the 9% floor, which is the sliver ISS-5548 is about.
 * The second carries MORE events than the first but no anchor (`tl0: null`), so
 * it has nowhere to send a click; the two differ on jumpability alone, which is
 * exactly the axis the fix keys off.
 */
function buckets(): ActivityBucket[] {
  return [
    {
      label: "12:00",
      cIn: 0.001,
      cOut: 0.001,
      cCache: 0,
      total: 2,
      toolStart: 1,
      tl0: 0,
      byModel: {},
    },
    {
      label: "12:30",
      cIn: 0.4,
      cOut: 0.3,
      cCache: 0.2,
      total: 9,
      toolStart: 4,
      tl0: null,
      byModel: {},
    },
  ];
}

function session(): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    id: SESSION_ID,
    harness: "claude",
    // ISS-5819 review (wongk): a real producer's bins carry the clock they were
    // binned over, and the projection refuses a strip that does not.
    activityBuckets: withProducerBinBounds(buckets(), {
      endMs: Date.parse(RUN_END_ISO),
      startMs: Date.parse(RUN_START_ISO),
    }),
    turnItems: createTurnItemsSpanning(RUN_START_ISO, RUN_END_ISO),
  });
}

function renderTimeline(enabledFlags: string[]): HTMLElement[] {
  render(
    <AppCoreStoryProviders enabledFlags={enabledFlags}>
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={session()}
      />
    </AppCoreStoryProviders>
  );
  return screen.getAllByRole("button", { name: BUCKET_BUTTON_NAME });
}

describe("Session Timeline column hit target (ISS-5548)", () => {
  it("gives a low-value bar the full-column hit target once the flag is on", () => {
    const [tinyBar] = renderTimeline([
      SESSION_TIMELINE_COLUMN_HIT_TARGET_FEATURE_FLAG_KEY,
    ]);

    // The bar a reader can barely hit today is the one that must grow a target.
    expect(tinyBar).toHaveClass(REACH_CLASS);
    // And the bar itself is untouched: still sized by its value, so the strip
    // keeps encoding magnitude honestly rather than fattening quiet columns.
    expect(tinyBar.style.height).toBe("9%");
  });

  it("leaves a bucket with no transcript anchor at its original target", () => {
    const anchorlessBar = lastBar(
      renderTimeline([SESSION_TIMELINE_COLUMN_HIT_TARGET_FEATURE_FLAG_KEY])
    );

    // ISS-5479 (PR #4615) fixed bars that LOOKED live and dropped the click.
    // Growing this one's hit box would rebuild that defect at four times the
    // size, so an anchorless bucket is deliberately excluded even flag-on.
    expect(anchorlessBar).not.toHaveClass(REACH_CLASS);
  });

  it("does not name an anchorless bucket as a jump, flag on", () => {
    const anchorlessBar = lastBar(
      renderTimeline([SESSION_TIMELINE_COLUMN_HIT_TARGET_FEATURE_FLAG_KEY])
    );

    // The accessible name still refuses to promise a jump it cannot make, so an
    // unreachable bar and a reachable-but-inert bar stay distinguishable to a
    // screen-reader user with this flag on and #4615 not yet landed.
    //
    // ISS-5761 appended the bucket's COST to the name. That is additive to the
    // contract this test guards — the ACTION clause is still "Activity bucket",
    // not "Jump to activity bucket" — and the matcher still requires the money,
    // so it would notice the cost going missing.
    expect(anchorlessBar.getAttribute("aria-label")).toMatch(
      ANCHORLESS_NAME_RE
    );
  });

  it("keeps every bar at today's hit target while the flag is off", () => {
    const bars = renderTimeline([]);

    // ISS-4779 closed-by-default: nothing about the strip may change until the
    // COLUMN-HIT-TARGET flag is deliberately turned on, on each surface.
    //
    // The count is the WINDOW's, not the producer's two bins — ISS-5999 retired
    // the prototype-parity gate that used to be the other half of this render.
    // Pinned exactly rather than `toBeGreaterThan(0)`: a render that collapsed
    // to a single bar would still be "greater than 0", so the loose form could
    // not fail on the very thing that changed here.
    expect(bars).toHaveLength(TIMELINE_VISIBLE_COLUMNS);
    for (const bar of bars) {
      expect(bar).not.toHaveClass(REACH_CLASS);
    }
  });
});

/** The window's last column, which the anchorless source bin owns. */
function lastBar(bars: HTMLElement[]): HTMLElement {
  const bar = bars.at(-1);
  if (!bar) {
    throw new Error("the timeline rendered no bars");
  }
  return bar;
}
