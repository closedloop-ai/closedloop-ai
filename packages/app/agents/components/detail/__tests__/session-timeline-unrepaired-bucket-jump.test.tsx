import type {
  ActivityBucket,
  AgentSessionDetail,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { info: vi.fn() },
}));

import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import {
  makeDbPromptRow,
  makeTimelineBucket,
  stubScrollAwareRowRects,
} from "./session-timeline-scroll-harness";

/**
 * ISS-5124: the Session Timeline bars that ANNOUNCE a jump and do not make one.
 *
 * A production VQA pass drove two real sessions with CDP pointer events,
 * resetting the transcript scroller to 0 before every click. Of the controls
 * whose accessible name read `Jump to activity bucket …`, 11 of 15 moved
 * nothing on one session and 19 of 26 on the other, and four DISTINCT buckets
 * on the long session all landed on one identical `scrollTop` near the bottom
 * of the transcript.
 *
 * Both signatures come from the same place. `alignBucketRowsToTranscript` is
 * the only thing that converts the desktop producer's sync-time TIMELINE-EVENT
 * index into a transcript `turnItems._row`, and it bails — returning the
 * buckets untouched — when the session carries no timed transcript row. The
 * raw index survives into `tl0`, which is the entire basis on which
 * `getBucketButtonLabel` promises `Jump to activity bucket …`. Nothing between
 * there and the click re-checks it: `toRendered` returns the row unchanged
 * whenever the two projections coincide, and `findTraceScrollTarget`'s contract
 * is "greatest `[data-row]` ≤ row", so an index that overshoots every rendered
 * anchor resolves to the LAST one — every such bar landing on the same place.
 *
 * This suite drives the real component and asserts LABEL-VS-BEHAVIOUR
 * agreement, which is the ticket's own acceptance bar: a control that says
 * "Jump to" must move the transcript, and a control that cannot must not say
 * it. It is written so the pre-fix behaviour fails it in both directions.
 */

const SESSION_ID = "session-unrepaired-buckets";
const JUMP_TO_ACTIVITY_BUCKET_NAME = /jump to activity bucket/i;
const INERT_ACTIVITY_BUCKET_NAME = /^activity bucket/i;

/**
 * The producer's raw sync-time timeline-event indices. All three overshoot the
 * four rendered `[data-row]` anchors, which is what makes them collapse onto
 * the last one instead of failing loudly.
 */
const RAW_SYNC_INDEX_BUCKETS: readonly number[] = [40, 41, 42];

/**
 * Transcript rows carrying `_row` but NO parseable instant — the shape that
 * makes the repair impossible. This is a real population (a projection whose
 * turn timestamps never synced), and it is precisely the input on which the
 * repair used to hand the raw index straight through.
 */
function untimedTurnItems(): TurnItem[] {
  return [0, 1, 2, 3].map((row) =>
    makeDbPromptRow({
      row,
      sessionId: SESSION_ID,
      t: "",
      text: `turn ${row}`,
    })
  );
}

function unrepairableBuckets(): ActivityBucket[] {
  return RAW_SYNC_INDEX_BUCKETS.map((tl0, index) =>
    makeTimelineBucket({ label: `${index * 30}m`, tl0 })
  );
}

/**
 * No `transcripts` entry, so the panel renders the projected fallback — which
 * IS `session.turnItems`, by reference. That makes `toRendered` the identity,
 * which is the case where an unrepaired index silently resolves to a real
 * anchor instead of being rejected. (The divergent-cloud case is covered in
 * `session-timeline-transcript-scroll.test.tsx`.)
 */
function unrepairableSession(): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    id: SESSION_ID,
    harness: "claude",
    startedAt: new Date("2026-06-10T12:00:00.000Z"),
    endedAt: new Date("2026-06-10T13:31:00.000Z"),
    updatedAt: new Date("2026-06-10T13:31:00.000Z"),
    lastActivityAt: new Date("2026-06-10T13:31:00.000Z"),
    transcripts: [],
    turnItems: untimedTurnItems(),
    activityBuckets: unrepairableBuckets(),
    markers: [],
  });
}

async function renderUnrepairableDetail(): Promise<HTMLElement> {
  render(
    <AppCoreStoryProviders>
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={unrepairableSession()}
      />
    </AppCoreStoryProviders>
  );
  await screen.findByText("turn 3");
  const scroller = document.querySelector<HTMLElement>(".sd3-scroll");
  if (!scroller) {
    throw new Error("Expected the transcript scroll container");
  }
  stubScrollAwareRowRects(scroller);
  scroller.scrollTop = 0;
  return scroller;
}

describe("Session Timeline bars whose jump row could not be repaired (ISS-5124)", () => {
  it("never announces a jump it cannot make", async () => {
    await renderUnrepairableDetail();

    // Pre-fix: all three bars carried the raw index, so all three were named
    // "Jump to activity bucket …" — the promise the VQA pass measured and found
    // unkept. They are inert controls now, named for what they are.
    expect(
      screen.queryAllByRole("button", { name: JUMP_TO_ACTIVITY_BUCKET_NAME })
    ).toHaveLength(0);
    /*
     * Every rendered column, not `RAW_SYNC_INDEX_BUCKETS.length`: ISS-5999 made
     * ISS-5819's clock window unconditional, so the producer's bins are
     * projected onto the window's fixed column count. What the count must still
     * prove is that NONE of them slipped through named as a jump, which the
     * zero-length assertion above and the total below say together.
     */
    const inert = screen.getAllByRole("button", {
      name: INERT_ACTIVITY_BUCKET_NAME,
    });
    expect(inert.length).toBeGreaterThanOrEqual(RAW_SYNC_INDEX_BUCKETS.length);
    expect(inert).toHaveLength(costBars().length);
  });

  it("does not scroll the transcript to an anchor the bar never pointed at", async () => {
    const user = userEvent.setup();
    const scroller = await renderUnrepairableDetail();

    // Selected by element, NOT by accessible name: the name is one of the things
    // this change alters, so a name-based query would make the pre-fix run fail
    // on a missing element instead of on the wrong scroll — which is the
    // behaviour under test.
    const bars = costBars();
    await user.click(bars[0]);

    // Pre-fix this scrolled (measured: `scrollTop` -14, not 0). `toRendered(40)`
    // passed the raw index straight through and `findTraceScrollTarget` clamped
    // it onto an anchor the bar never pointed at — the index names no rendered
    // row, so the landing spot is an artefact of the clamp, not of the bucket.
    expect(scroller.scrollTop).toBe(0);
    expect(document.querySelector(".st-flash")).toBeNull();
  });

  it("cannot land two distinct bars on one identical scroll position", async () => {
    const user = userEvent.setup();
    const scroller = await renderUnrepairableDetail();

    const bars = costBars();
    await user.click(bars[0]);
    const afterFirst = scroller.scrollTop;
    scroller.scrollTop = 0;
    await user.click(bars[2]);

    // The reported signature was two different buckets resolving to the SAME
    // `scrollTop`. Pre-fix both of these landed on an identical -14 — the same
    // clamped anchor, reached from two unrelated time slices. Both are honestly
    // inert now, so neither moves and the collapse has nowhere to happen.
    expect(afterFirst).toBe(0);
    expect(scroller.scrollTop).toBe(0);
  });

  it("withdraws the affordance too, not just the name", async () => {
    await renderUnrepairableDetail();

    const bars = screen.getAllByRole("button", {
      name: INERT_ACTIVITY_BUCKET_NAME,
    });
    // ISS-5479's treatment reads the same `tl0 == null` this demotion produces,
    // so a demoted bar is styled and announced exactly like a genuinely idle
    // one — there is no third, half-dressed state.
    expect(bars[0]).toHaveAttribute("aria-disabled", "true");
    expect(bars[0].className).toContain("no-jump");
  });
});

/**
 * The cost bars as ELEMENTS, independent of what they are named. The accessible
 * name is one of the things ISS-5124 changes, so a name-keyed query cannot be
 * used by the assertions that measure where a click lands — it would report a
 * missing element rather than the wrong scroll.
 */
function costBars(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("button.sd3-bar2")];
}
