import type {
  ActivityBucket,
  AgentSessionDetail,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  TIMELINE_SYNTHESIZED_COST_LEGEND,
  TIMELINE_SYNTHESIZED_COST_TOOLTIP,
  TIMELINE_SYNTHESIZED_IDLE_TOOLTIP,
} from "../activity-bucket-rendering";
import {
  createAgentSessionDetailFixture,
  withProducerBinBounds,
} from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";

/**
 * ISS-5566: the Session Timeline must not present SYNTHESIZED per-bucket cost as
 * if it were measured.
 *
 * When a session arrives with no persisted `activityBuckets`, the strip is
 * reconstructed from the transcript and every dollar on it is manufactured: the
 * total is `Math.max(estimatedCost, 0.01)`, each bucket's share comes from a
 * `turns + toolCalls * 3` guess, and the in/out/cache split is three fixed
 * ratios — which is why an identical 69/23/8 ratio repeating on every bar is the
 * documented tell that a strip is synthesized.
 *
 * THE DISCRIMINATOR is the pair of sessions below. They differ in exactly one
 * respect — one carries persisted buckets and one does not — and are otherwise
 * identical, including `estimatedCost`. Any assertion that passes for both is
 * not testing provenance. So the measured session is asserted to keep its
 * dollars with the flag ON, which is what stops this fix from being "hide the
 * cost column"; and the synthesized session is asserted to keep its dollars with
 * the flag OFF, which is what proves the ISS-4779 closed default rather than a
 * behavior change that happens to ship dark.
 *
 * Driven through `AgentSessionDetailView` — the production entry point — rather
 * than through the extracted `buildActivityBuckets`, because the defect was
 * never in the arithmetic. The arithmetic is unchanged by this fix; what changed
 * is that the renderer now knows the difference and says so.
 */

const STARTED_AT = "2026-06-10T12:00:00.000Z";
const ENDED_AT = "2026-06-10T12:20:00.000Z";

const ACTOR = {
  color: "var(--primary)",
  harness: "codex",
  human: null,
  name: "gpt-5.5",
  sessionId: "session-iss-5566",
};

/** Any dollar figure at all — `$0.0025`, `$1.11`, `$4`. */
const ANY_MONEY_RE = /\$\d/;
/** The bar's accessible name, so a bucket can be hovered by role. */
const ANY_BUCKET_NAME_RE = /activity bucket/i;
/** The tooltip's measured meta row — event and tool-call counts, never money. */
const MEASURED_EVENT_COUNT_RE = /events/;
/** The strip's own empty state, when there is no transcript to plot. */
const NO_ACTIVITY_RECORDED_COPY = "No activity recorded for this session.";
/** The MEASURED strip's idle line. A synthesized strip must never claim it. */
const NO_TOKENS_BILLED_COPY =
  "Agent asleep | scheduled wake-up | no tokens billed";
const SYNTHESIZED_FLAGS = [SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY];

function promptRow(row: number, at: string): TurnItem {
  return {
    _row: row,
    actor: ACTOR,
    cum: 0,
    t: at,
    tMs: Date.parse(at),
    text: `turn ${row}`,
    type: "prompt",
  };
}

function toolsRow(row: number, at: string): TurnItem {
  return {
    _row: row,
    actor: ACTOR,
    cats: { tool: 1 },
    cum: 0,
    endMs: Date.parse(at) + 1000,
    failN: 0,
    hasFail: false,
    items: [{ detail: `call ${row}`, err: false, label: "rg" }],
    summary: `Ran 1 tool at turn ${row}`,
    t: at,
    tMs: Date.parse(at),
    type: "tools",
  };
}

/**
 * Four timed rows, two of them tool calls, so the synthesis path produces bars
 * of DIFFERING weight — a flat strip would let a bug that zeroes every bar pass
 * as "the labels are gone".
 */
function transcriptRows(): TurnItem[] {
  return [
    promptRow(0, "2026-06-10T12:01:00.000Z"),
    toolsRow(1, "2026-06-10T12:06:00.000Z"),
    toolsRow(2, "2026-06-10T12:11:00.000Z"),
    promptRow(3, "2026-06-10T12:16:00.000Z"),
  ];
}

/**
 * Rows with no usable timestamp, so `hasTimedTraceRow` rejects every one and
 * synthesis falls through to `buildEvenActivityBuckets`.
 */
function untimedRows(): TurnItem[] {
  return [
    { actor: ACTOR, cum: 0, text: "opening", type: "prompt" } as TurnItem,
    { actor: ACTOR, cum: 0, text: "middle", type: "prompt" } as TurnItem,
    { actor: ACTOR, cum: 0, text: "closing", type: "prompt" } as TurnItem,
  ];
}

/**
 * Two bursts separated by a long quiet stretch, so the time-bucketed synthesis
 * leaves interior buckets at zero weight — the `.idle` / `.cb-gap` case.
 */
function sparseRows(): TurnItem[] {
  return [
    promptRow(0, "2026-06-10T12:00:30.000Z"),
    toolsRow(1, "2026-06-10T12:01:00.000Z"),
    promptRow(2, "2026-06-10T12:18:30.000Z"),
    toolsRow(3, "2026-06-10T12:19:00.000Z"),
  ];
}

/**
 * Real per-model splits, and deliberately NOT in the 8/23/69 proportion the
 * synthesizer would have produced — so an implementation that quietly re-derived
 * the split for measured buckets too would show up here.
 */
function measuredBuckets(): ActivityBucket[] {
  return [
    {
      byModel: { "gpt-5.5": { cCache: 0.4, cIn: 1.1, cOut: 0.6 } },
      cCache: 0.4,
      cIn: 1.1,
      cOut: 0.6,
      key: "measured-0",
      label: "0m",
      tl0: 0,
      toolStart: 1,
      total: 2,
    },
    {
      byModel: { "gpt-5.5": { cCache: 0.3, cIn: 1.7, cOut: 0.72 } },
      cCache: 0.3,
      cIn: 1.7,
      cOut: 0.72,
      key: "measured-1",
      label: "10m",
      tl0: 2,
      toolStart: 1,
      total: 2,
    },
  ];
}

function baseSession(overrides: Partial<AgentSessionDetail> = {}) {
  return createAgentSessionDetailFixture({
    endedAt: new Date(ENDED_AT),
    estimatedCost: 4.82,
    markers: [],
    name: "Synthesized cost session",
    startedAt: new Date(STARTED_AT),
    turnItems: transcriptRows(),
    ...overrides,
  });
}

/** No persisted buckets — the strip is manufactured from the transcript. */
function synthesizedSession(): AgentSessionDetail {
  return baseSession({ activityBuckets: [] });
}

/** Persisted buckets — the strip carries real measured per-model cost. */
function measuredSession(): AgentSessionDetail {
  // ISS-5819 review (wongk): a measured strip states the clock its bins were
  // binned over; without that the clock projection refuses to run and this case
  // would be exercising the ordinal fallback instead.
  return baseSession({
    activityBuckets: withProducerBinBounds(measuredBuckets(), {
      endMs: Date.parse(ENDED_AT),
      startMs: Date.parse(STARTED_AT),
    }),
  });
}

function renderDetail(session: AgentSessionDetail, enabledFlags: string[]) {
  render(
    <AppCoreStoryProviders enabledFlags={enabledFlags}>
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={session}
      />
    </AppCoreStoryProviders>
  );
}

/** The strip's own bars, so a dollar elsewhere on the screen cannot answer for it. */
function timelineBars(): HTMLElement[] {
  return screen.getAllByRole("button", { name: ANY_BUCKET_NAME_RE });
}

/**
 * The first bar carrying a rendered cost stack.
 *
 * ISS-5999: ISS-5819's clock window is unconditional now, so (a) the strip is
 * always 24 columns wide and the ones past the fixture's own run are empty, so
 * the FIRST bar is no longer guaranteed to be a priced one, and (b) the stack is
 * painted from the "Group by" segments rather than the three hardcoded
 * `.cb-cache`/`.cb-out`/`.cb-in` elements, which now only render when no source
 * window resolves at all. Selecting on the stack ELEMENT rather than on either
 * an index or a class keeps this about whether measured dollars reach the strip.
 */
function firstStackedBar(): HTMLElement {
  const bar = timelineBars().find(
    (candidate) => candidate.querySelector("i") != null
  );
  if (!bar) {
    throw new Error("the strip rendered no bar carrying a cost stack");
  }
  return bar;
}

describe("Session Timeline, session with no persisted activityBuckets (ISS-5566)", () => {
  it("prints no manufactured dollar figure on the strip, and says why", () => {
    renderDetail(synthesizedSession(), SYNTHESIZED_FLAGS);

    const bars = timelineBars();
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      // The `$0.0025`-class label. Before the fix each weighted bar carried one.
      expect(bar.textContent ?? "").not.toMatch(ANY_MONEY_RE);
      // The in/out/cache stack is the strip's visual claim about WHERE the money
      // went, and behind a synthesized bar that split is three fixed ratios.
      expect(bar.querySelector(".cb-cache")).toBeNull();
      expect(bar.querySelector(".cb-out")).toBeNull();
      expect(bar.querySelector(".cb-in")).toBeNull();
    }

    // Named once beneath the strip, not per bar — the eye reads the strip before
    // it reads any caption, so the bars had to change too, and they did above.
    expect(
      screen.getByText(TIMELINE_SYNTHESIZED_COST_LEGEND)
    ).toBeInTheDocument();
  });

  it("drops the per-model dollar table from the hover readout", async () => {
    const user = userEvent.setup();
    renderDetail(synthesizedSession(), SYNTHESIZED_FLAGS);

    // A bar with weight, so the pre-fix tooltip would have had a table to draw.
    const bar = timelineBars()[0];
    await user.hover(bar);

    const tooltip = await screen.findByText(TIMELINE_SYNTHESIZED_COST_TOOLTIP);
    const readout = tooltip.closest<HTMLElement>(".sd3-tip");
    if (!readout) {
      throw new Error("Expected the bucket tooltip");
    }
    // The 69/23/8 table — the single most legible fabrication on this screen.
    expect(readout.querySelector(".sd3-tip-tbl")).toBeNull();
    expect(readout.textContent ?? "").not.toMatch(ANY_MONEY_RE);
    // The counts ARE measured; withdrawing them would be its own dishonesty.
    expect(within(readout).getByText(MEASURED_EVENT_COUNT_RE)).toBeVisible();
  });

  it("keeps the bars, because their heights are honest relative activity", () => {
    renderDetail(synthesizedSession(), SYNTHESIZED_FLAGS);

    const heights = timelineBars().map((bar) => bar.style.height);
    expect(heights.length).toBeGreaterThan(1);
    // Not a flat strip and not a collapsed one: the shape still distinguishes a
    // busy slice from a quiet one, which is the part the transcript can support.
    expect(new Set(heights).size).toBeGreaterThan(1);
  });
});

describe("Session Timeline, session WITH persisted activityBuckets (ISS-5566)", () => {
  it("still shows its measured dollars while the flag is on", async () => {
    const user = userEvent.setup();
    renderDetail(measuredSession(), SYNTHESIZED_FLAGS);

    expect(screen.queryByText(TIMELINE_SYNTHESIZED_COST_LEGEND)).toBeNull();

    const bar = firstStackedBar();

    await user.hover(bar);
    const table = await screen.findByRole("table");
    /*
     * ISS-5999: the hover card's table now states the CURRENT "Group by" cut
     * rather than always the per-model one — ISS-5819 made the two agree
     * deliberately, so the colours in the bar and the rows in the card cannot
     * describe different splits, and the default cut is Token Type. The contract
     * this case owns is unchanged: a measured session's real dollars still reach
     * the card. Both halves are asserted so a card that rendered its labels with
     * no figures, or figures with no labels, fails.
     */
    expect(within(table).getByText("Input")).toBeVisible();
    expect(table.textContent ?? "").toMatch(ANY_MONEY_RE);
  });
});

/*
 * Review (logical-parsing-integrity-auditor): `buildActivityBuckets` has four
 * branches and the suite above reached only the timed-rows one, because every
 * fixture row carries `t`/`tMs`. The other three are exercised here — the
 * even-bucket fallback, the empty transcript, and a zero-weight bucket inside an
 * otherwise-synthesized strip — so a regression in any of them fails a test
 * instead of needing to be traced by hand.
 */
describe("Session Timeline, other synthesis branches (ISS-5566)", () => {
  it("withholds cost on the even-bucket fallback too, not just the timed path", () => {
    // No `t`/`tMs` anywhere, so `hasTimedTraceRow` filters everything out and
    // `buildEvenActivityBuckets` runs instead of `buildTimedActivityBuckets`.
    renderDetail(
      baseSession({ activityBuckets: [], turnItems: untimedRows() }),
      SYNTHESIZED_FLAGS
    );

    const bars = timelineBars();
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar.textContent ?? "").not.toMatch(ANY_MONEY_RE);
      expect(bar.querySelector(".cb-cache")).toBeNull();
    }
    expect(
      screen.getByText(TIMELINE_SYNTHESIZED_COST_LEGEND)
    ).toBeInTheDocument();
  });

  it("captions nothing when there is no transcript to synthesize from", () => {
    renderDetail(
      baseSession({ activityBuckets: [], turnItems: [] }),
      SYNTHESIZED_FLAGS
    );

    // An empty strip is not a synthesized one: there is no bar to disclaim, and
    // a caption here would describe bars the reader cannot see.
    expect(screen.queryByText(TIMELINE_SYNTHESIZED_COST_LEGEND)).toBeNull();
    expect(screen.getByText(NO_ACTIVITY_RECORDED_COPY)).toBeInTheDocument();
  });

  it("keeps a zero-activity bucket saying so, rather than 'cost not recorded'", async () => {
    const user = userEvent.setup();
    // A long quiet gap between two bursts, so the middle buckets catch no turn
    // at all and land at zero weight inside a synthesized strip.
    renderDetail(
      baseSession({ activityBuckets: [], turnItems: sparseRows() }),
      SYNTHESIZED_FLAGS
    );

    const idleBar = timelineBars().find(
      (bar) =>
        bar.classList.contains("idle") || bar.classList.contains("cb-gap")
    );
    if (!idleBar) {
      throw new Error(
        "Expected at least one zero-cost bucket in a sparse strip"
      );
    }
    // The hatch that means "nothing happened here" must survive: `.synthesized`
    // ties with `.idle`/`.cb-gap` on specificity, so layering it here would
    // repaint a quiet slice as an active-but-unpriced one.
    expect(idleBar.classList.contains("synthesized")).toBe(false);

    await user.hover(idleBar);
    // We DO know this slice was quiet — that is measured from the transcript.
    // What we must not say is the measured strip's "no tokens billed".
    expect(
      await screen.findByText(TIMELINE_SYNTHESIZED_IDLE_TOOLTIP)
    ).toBeInTheDocument();
    expect(screen.queryByText(NO_TOKENS_BILLED_COPY)).toBeNull();
  });
});

describe("Session Timeline synthesized-cost caption, cross-adapter pin", () => {
  it("matches the literal the Electron e2e spec asserts against", () => {
    /*
     * `apps/desktop/test/e2e/session-timeline-synthesized-cost.spec.ts` cannot
     * import this constant — a `@repo/app` subpath import aborts the whole
     * Electron suite at load time — so it pins the copy as a local literal.
     * Restating it here makes a copy edit fail HERE, with this comment naming
     * the file to update, instead of failing there as an unexplained "element
     * not found" three minutes into a launched-app run.
     */
    expect(TIMELINE_SYNTHESIZED_COST_LEGEND).toBe(
      "Cost over time wasn't recorded for this session; taller bars saw more activity."
    );
  });
});

describe("Session Timeline synthesized-cost disclosure, flag off (ISS-4779)", () => {
  it("leaves the synthesized strip exactly as it renders today", () => {
    renderDetail(synthesizedSession(), []);

    expect(screen.queryByText(TIMELINE_SYNTHESIZED_COST_LEGEND)).toBeNull();
    const bars = timelineBars();
    expect(bars.length).toBeGreaterThan(0);
    // The pre-fix behavior, asserted so the closed default is a real default
    // rather than a change that shipped dark and was never exercised either way.
    expect(firstStackedBar()).toBeInTheDocument();
  });
});
