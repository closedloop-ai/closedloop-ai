import type {
  ActivityBucket,
  AgentSessionDetail,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import {
  TRACE_ROW_SELECTOR,
  TRACE_SCROLL_OUTCOME_MESSAGE,
  TraceScrollOutcome,
} from "@repo/app/agents/lib/trace-scroll-target";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { toast } from "@repo/design-system/components/ui/sonner";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// The harness mounts no `<Toaster />`, so the reader-facing message is observed
// at the design-system boundary the view actually calls.
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { info: vi.fn() },
}));

import {
  createAgentSessionDetailFixture,
  withProducerBinBounds,
} from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import {
  makeDbPromptRow,
  makeDbSayRow,
  makeTimelineBucket,
  stubScrollAwareRowRects,
} from "./session-timeline-scroll-harness";

/**
 * ISS-5843: the "you are here" line must state where the reader ACTUALLY is.
 *
 * Since ISS-5819 the Session Timeline holds ONE position model — the active row
 * resolves to an absolute column that both the `.tl-here` marker and the
 * scrubber thumb read — so anything that moves the row moves both. `useTraceJump`
 * committed that row BEFORE it knew whether the transcript could land on it, so
 * a click resolving to `EmptyTranscript` still slid the marker onto a bucket the
 * transcript never went to.
 *
 * That state is reachable rather than theoretical, and the divergence is
 * documented on `TRACE_SCROLL_OUTCOME_MESSAGE`: the strip's `hasRenderedRows`
 * gate reads what the transcript panel RESOLVED, while `planTraceScroll` reads
 * what it PAINTED. On the oversized-desktop branch the bars stay live and
 * clickable beside a "Large transcript / Load full transcript" panel holding no
 * anchors at all, and the marker then announced an arrival next to a transcript
 * that had not moved.
 *
 * These assert the marker's RENDERED POSITION and the scroller's real offset —
 * never that a handler fired. ISS-5124 exists precisely because jump controls
 * that *appeared* wired did not move the transcript, and a handler-level
 * assertion stayed green throughout that bug.
 */

const SESSION_ID = "session-jump-position";
const JUMP_TO_ACTIVITY_BUCKET_NAME = /jump to activity bucket/i;

/** Four turns, four bars — so a bucket maps 1:1 onto a landable anchor. */
const TURN_TIMES = [
  "2026-06-10T12:00:00.000Z",
  "2026-06-10T12:30:00.000Z",
  "2026-06-10T13:00:00.000Z",
  "2026-06-10T13:30:00.000Z",
] as const;

/**
 * Where the marker lands: the centre of the column holding the transcript row
 * the click RESOLVED to, which is one column left of the column clicked — the
 * marker reads the active row's own position, not the pointer's.
 *
 * ISS-5999 made ISS-5819's clock window unconditional, so the strip is 24
 * columns wide regardless of how many bins the producer sent; before that this
 * fixture rendered four bars and the same click landed at 62.5%. Pinned as the
 * exact string production emits rather than recomputed from
 * `TIMELINE_VISIBLE_COLUMNS`, so this asserts the strip's own arithmetic instead
 * of agreeing with a copy of it.
 */
const RESOLVED_ROW_COLUMN_CENTRE = "47.91666666666667%";
/**
 * An idle bar's name. The accessible name opens with the ACTION, so a bar with
 * nowhere to send a click reads "Activity bucket …" and a jumpable one reads
 * "Jump to activity bucket …" — matched as a prefix because the label and the
 * bucket's cost follow.
 */
const IDLE_BUCKET_NAME = /^Activity bucket /;
/**
 * The column clicked throughout — deep enough into the window that it resolves
 * to a LATER transcript row, so a real scroll is observable. The window's
 * opening columns all resolve to row 0, where the transcript already sits.
 */
const CLICKED_COLUMN = 12;

/**
 * Prompt/response alternating, so `buildTraceGroups` cannot coalesce them.
 * Consecutive same-side turns collapse into ONE `[data-row]` anchor, and a suite
 * about where a click LANDS is meaningless with a single landable row.
 */
function timedTurnItems(): TurnItem[] {
  return TURN_TIMES.map((t, row) => {
    const options = { row, sessionId: SESSION_ID, t, text: `turn ${row}` };
    return row % 2 === 0 ? makeDbPromptRow(options) : makeDbSayRow(options);
  });
}

function jumpableBuckets(): ActivityBucket[] {
  return TURN_TIMES.map((_, index) =>
    makeTimelineBucket({ label: `${index * 30}m`, tl0: index })
  );
}

/** Bar 1's slice caught no transcript turn at all — the `NoTurn` block. */
function bucketsWithIdleSlice(): ActivityBucket[] {
  const buckets = jumpableBuckets();
  buckets[1] = makeTimelineBucket({ label: "30m", tl0: null });
  return buckets;
}

/**
 * No `transcripts` entry, so the panel renders the projected fallback — which IS
 * `session.turnItems` by reference, making `toRendered` the identity. That keeps
 * this suite about the POSITION rather than about row-space translation, which
 * `session-timeline-transcript-scroll.test.tsx` already owns.
 */
function positionSession(buckets: ActivityBucket[]): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    id: SESSION_ID,
    harness: "claude",
    startedAt: new Date(TURN_TIMES[0]),
    endedAt: new Date("2026-06-10T13:31:00.000Z"),
    updatedAt: new Date("2026-06-10T13:31:00.000Z"),
    lastActivityAt: new Date("2026-06-10T13:31:00.000Z"),
    transcripts: [],
    turnItems: timedTurnItems(),
    // ISS-5819 review (wongk): stamped over the run the turn items span, so the
    // strip states the clock its bins were measured on and the clock projection
    // this suite drives can run at all.
    activityBuckets: withProducerBinBounds(buckets, {
      endMs: Date.parse("2026-06-10T13:31:00.000Z"),
      startMs: Date.parse(TURN_TIMES[0]),
    }),
    markers: [],
  });
}

async function renderDetail(
  buckets: ActivityBucket[] = jumpableBuckets()
): Promise<HTMLElement> {
  render(
    <AppCoreStoryProviders>
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={positionSession(buckets)}
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
  vi.mocked(toast.info).mockClear();
  return scroller;
}

/** The "you are here" line, or `null` when the strip states no position. */
function hereMarker(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".sd3-bars2-wrap .tl-here");
}

function jumpableBars(): HTMLElement[] {
  return screen.getAllByRole("button", { name: JUMP_TO_ACTIVITY_BUCKET_NAME });
}

/**
 * Strip the transcript's landable anchors WITHOUT unmounting them, reproducing
 * the state where the panel resolved rows — so the strip stays live and
 * clickable — but painted none. `findTraceScrollTarget` reads exactly this
 * selector, so removing the attribute is the same fact it observes.
 */
function unpaintTranscriptAnchors(scroller: HTMLElement): void {
  for (const row of scroller.querySelectorAll<HTMLElement>(
    TRACE_ROW_SELECTOR
  )) {
    row.removeAttribute("data-row");
  }
}

describe("a Session Timeline click moves the line to the clicked bucket (ISS-5843)", () => {
  it("puts the line on that bucket and takes the transcript with it", async () => {
    const user = userEvent.setup();
    const scroller = await renderDetail();

    // Before any interaction the strip states no position rather than guessing.
    expect(hereMarker()).toBeNull();

    await user.click(jumpableBars()[CLICKED_COLUMN]);

    expect(hereMarker()?.style.left).toBe(RESOLVED_ROW_COLUMN_CENTRE);
    // …and the transcript genuinely went there. Asserting only the marker would
    // pass for a line that moved on its own.
    expect(scroller.scrollTop).toBeGreaterThan(0);
  });
});

describe("a Session Timeline jump that cannot land moves nothing (ISS-5843)", () => {
  it("leaves the line off rather than pointing at a place the transcript never reached", async () => {
    const user = userEvent.setup();
    const scroller = await renderDetail();
    unpaintTranscriptAnchors(scroller);

    await user.click(jumpableBars()[CLICKED_COLUMN]);

    // Pre-fix the active row was committed before the scroll was attempted, so
    // the marker rendered on the resolved row's column while the transcript sat
    // exactly where it was — the UI claiming an arrival that never happened.
    expect(scroller.scrollTop).toBe(0);
    expect(hereMarker()).toBeNull();
  });

  it("still tells the reader why, because the bar could not have warned them", async () => {
    const user = userEvent.setup();
    const scroller = await renderDetail(jumpableBuckets());
    unpaintTranscriptAnchors(scroller);

    await user.click(jumpableBars()[CLICKED_COLUMN]);

    // ISS-5479 kept this toast deliberately, and ISS-5843 leaves it alone: a
    // transcript still loading is not something the bar's appearance could have
    // shown in advance, and silence would make "not ready" indistinguishable
    // from "nothing there".
    expect(toast.info).toHaveBeenCalledWith(
      TRACE_SCROLL_OUTCOME_MESSAGE[TraceScrollOutcome.EmptyTranscript],
      { id: `trace-jump-${TraceScrollOutcome.EmptyTranscript}` }
    );
    expect(hereMarker()).toBeNull();
  });

  it("says nothing at all when the bucket had nowhere to go", async () => {
    const user = userEvent.setup();
    const scroller = await renderDetail(bucketsWithIdleSlice());

    // The first column the idle source bin reaches. `getAllByRole` rather than
    // `getByRole`: one idle bin now spans several of the window's columns.
    const [idle] = screen.getAllByRole("button", { name: IDLE_BUCKET_NAME });
    await user.click(idle);

    // "If there is nowhere to move we can't move things" — no scroll, no line,
    // and no toast, because the bar already withdrew its affordance at rest.
    expect(scroller.scrollTop).toBe(0);
    expect(hereMarker()).toBeNull();
    expect(toast.info).not.toHaveBeenCalled();
  });
});
