import type {
  AgentSessionDetail,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import {
  buildTimelineModelColors,
  buildTimelineStacks,
  TimelineStackGrouping,
  type TimelineStackSegment,
  UNKNOWN_MODEL_LABEL,
  UNKNOWN_OWNER_LABEL,
} from "@repo/app/agents/lib/session-timeline-stacks";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  type ActivityBucketStrip,
  buildActivityBuckets,
} from "../activity-bucket-synthesis";
import { ActivityBucketTooltip } from "../activity-bucket-tooltip";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";

/**
 * ISS-5634: the fallback strip's model column must not print a name the session
 * does not have.
 *
 * This is the RENDERED half of the fix — the synthesis half is pinned by
 * `activity-bucket-synthesis-model-attribution.test.ts`. It drives the real
 * `ActivityBucketTooltip` over buckets the real `buildActivityBuckets` produced,
 * because the `byModel` key reaches the reader through two different shapes and
 * both are live:
 *
 *   - WITHOUT a "Group by" cut (no source window resolves, so the strip has no
 *     controls) the card prints `Object.entries(bucket.byModel)` verbatim under
 *     a `<th>model</th>` header; and
 *   - WITH the Model cut, `buildModelStack` uses the same keys as segment
 *     LABELS, in the card and as the bar's own colours.
 *
 * Both are asserted. The Radix select is deliberately not driven — per the
 * precedent in `session-timeline-controls.test.tsx`, that tests Radix; feeding
 * the card the stack a grouping change actually produces tests our wiring.
 *
 * `costUnmeasured` is false throughout, which is the shipped default: the
 * ISS-5566 disclosure withdraws this table entirely, so asserting with it on
 * would pass whatever key the synthesizer chose.
 */

const STARTED_AT = "2026-06-10T12:00:00.000Z";
const ENDED_AT = "2026-06-10T12:20:00.000Z";
const WINDOW = {
  endMs: Date.parse(ENDED_AT),
  startMs: Date.parse(STARTED_AT),
};

const ACTOR = {
  color: "var(--primary)",
  harness: "codex",
  human: null,
  name: "gpt-5.5",
  sessionId: "session-iss-5634",
};

/** jsdom lays nothing out, so the card is anchored at the viewport origin. */
const ANCHOR = { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 };
/** The header the offending cell sat under. */
const MODEL_COLUMN_HEADER = "model";
/** A strip bar's accessible name, so a bucket can be hovered by role. */
const ANY_BUCKET_NAME_RE = /activity bucket/i;

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
 * The ISS-5572 errored-turn-one shape: a run that produced turns but never
 * resolved a model, so nothing on the record can name one.
 */
function unresolvedModelSession(): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    activityBuckets: [],
    endedAt: new Date(ENDED_AT),
    estimatedCost: 4.82,
    markers: [],
    model: null,
    models: [],
    name: "Errored turn-one session",
    primaryModel: null,
    startedAt: new Date(STARTED_AT),
    tokenUsageByModel: [],
    turnItems: [
      toolsRow(0, "2026-06-10T12:01:00.000Z"),
      toolsRow(1, "2026-06-10T12:06:00.000Z"),
      toolsRow(2, "2026-06-10T12:11:00.000Z"),
    ],
  });
}

function fallbackStrip(): ActivityBucketStrip {
  return buildActivityBuckets(unresolvedModelSession(), [], WINDOW);
}

/** The first bucket the strip actually priced — an idle one draws no table. */
function firstPricedIndex(strip: ActivityBucketStrip): number {
  const index = strip.buckets.findIndex(
    (bucket) => bucket.cIn + bucket.cOut + bucket.cCache > 0
  );
  if (index < 0) {
    throw new Error("the fallback strip priced no bucket");
  }
  return index;
}

/** The Model cut, exactly as the "Group by" control would resolve it. */
function modelStacks(strip: ActivityBucketStrip): TimelineStackSegment[][] {
  return buildTimelineStacks({
    buckets: strip.buckets,
    grouping: TimelineStackGrouping.Model,
    modelColors: buildTimelineModelColors(strip.buckets),
    ownerLabel: UNKNOWN_OWNER_LABEL,
  });
}

/**
 * The same unresolved-model session on the ORDINAL synthesis path.
 *
 * `idle`/`end`/`sessionstart` are the `TurnItem` variants that carry no
 * `_row`+`t` pair, so `hasTimedTraceRow` rejects every one and
 * `buildEvenActivityBuckets` runs. That matters for the mounted case below:
 * those bins are ordinal and deliberately state no `binStartMs`/`binEndMs`, so
 * no clock projection resolves, `useSessionTimelineScale` returns no controls,
 * and the hover card falls to the UNGROUPED body — the one that prints
 * `byModel`'s keys verbatim under a `model` header. It is the one mounted state
 * that puts this fix's output in front of a reader without driving the Radix
 * "Group by" listbox, which the precedent in `session-timeline-controls.test.tsx`
 * declines to do because it tests Radix rather than our wiring.
 */
function unresolvedModelOrdinalSession(): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    activityBuckets: [],
    endedAt: new Date(ENDED_AT),
    estimatedCost: 4.82,
    markers: [],
    model: null,
    models: [],
    name: "Errored turn-one session",
    primaryModel: null,
    startedAt: new Date(STARTED_AT),
    tokenUsageByModel: [],
    turnItems: [
      { actor: ACTOR, t: STARTED_AT, type: "sessionstart" },
      { gap: 90_000, type: "idle" },
      { gap: 120_000, type: "idle" },
      { text: "Session ended", type: "end" },
    ],
  });
}

describe("fallback strip model column, through the mounted session detail view", () => {
  /*
   * ISS-5634 review (whitlockk): every case below this block drives
   * `ActivityBucketTooltip` directly, so none of them proves the key survives
   * the view that actually mounts it — a strip that stopped passing its
   * synthesized buckets to the card would leave them all green. This case
   * mounts `AgentSessionDetailView`, the production entry point, and hovers a
   * real bar.
   *
   * The rendered-state regression on the two SHELLS (web and launched Electron)
   * is tracked separately as ISS-6808; this is the in-process half, and it is
   * the half that pins the wiring between the synthesizer and the card.
   *
   * No feature flags: the ISS-5566 disclosure withdraws this table entirely
   * when it is on, so asserting with it enabled would pass whatever key the
   * synthesizer chose. Off is also the shipped default.
   */
  it("prints the unknown label in the hover card's model cell", async () => {
    const user = userEvent.setup();
    render(
      <AppCoreStoryProviders enabledFlags={[]}>
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={unresolvedModelOrdinalSession()}
        />
      </AppCoreStoryProviders>
    );

    const bars = screen.getAllByRole("button", { name: ANY_BUCKET_NAME_RE });
    const priced = bars.find((bar) => bar.querySelector("i") != null);
    if (!priced) {
      throw new Error("the mounted fallback strip priced no bucket");
    }
    await user.hover(priced);

    const table = await screen.findByRole("table");
    expect(
      within(table).getByRole("columnheader", { name: MODEL_COLUMN_HEADER })
    ).toBeVisible();
    const modelCell = within(table).getAllByRole("cell")[0];
    expect(modelCell).toHaveTextContent(UNKNOWN_MODEL_LABEL);
    // The pre-fix render: the literal placeholder under a header saying `model`.
    expect(modelCell.textContent?.trim()).not.toBe(MODEL_COLUMN_HEADER);
  });
});

describe("fallback strip hover card, model column (ISS-5634)", () => {
  it("renders the fallback strip these cases are about", () => {
    // Guards both cases below: a session carrying persisted `activityBuckets`
    // would key `byModel` off the measured producer and prove nothing here.
    expect(fallbackStrip().synthesized).toBe(true);
  });

  it("names the unknown instead of the placeholder word, ungrouped", () => {
    const strip = fallbackStrip();
    const index = firstPricedIndex(strip);
    render(
      <ActivityBucketTooltip
        anchor={ANCHOR}
        block={null}
        bucket={strip.buckets[index]}
      />
    );

    const table = screen.getByRole("table");
    // Pins that this IS the per-model table — if the header stops rendering,
    // the cell assertion below stops meaning what it says.
    expect(
      within(table).getByRole("columnheader", { name: MODEL_COLUMN_HEADER })
    ).toBeVisible();

    const modelCell = within(table).getAllByRole("cell")[0];
    expect(modelCell).toHaveTextContent(UNKNOWN_MODEL_LABEL);
    // The pre-fix render: the literal placeholder, indistinguishable from a
    // real model name sitting under a header that says `model`.
    expect(modelCell.textContent?.trim()).not.toBe(MODEL_COLUMN_HEADER);
  });

  it("names the unknown under the Model cut, and still paints one segment", () => {
    const strip = fallbackStrip();
    const index = firstPricedIndex(strip);
    const segments = modelStacks(strip)[index];

    // Not empty: an absent segment leaves the bar's interior unpainted under
    // this cut, which reads as a rendering failure rather than as "unknown".
    expect(segments).toHaveLength(1);
    expect(segments[0].label).toBe(UNKNOWN_MODEL_LABEL);

    render(
      <ActivityBucketTooltip
        anchor={ANCHOR}
        block={null}
        bucket={strip.buckets[index]}
        grouping={TimelineStackGrouping.Model}
        segments={segments}
      />
    );

    const table = screen.getByRole("table");
    expect(
      within(table).getByRole("columnheader", { name: MODEL_COLUMN_HEADER })
    ).toBeVisible();
    expect(within(table).getAllByRole("cell")[0]).toHaveTextContent(
      UNKNOWN_MODEL_LABEL
    );
  });
});
