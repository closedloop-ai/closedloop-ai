import type {
  ActivityBucket,
  AgentSessionDetail,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
 * ISS-7115: scrolling FORWARD must never walk the "you are here" line backward.
 *
 * The reported defect, driven through the REAL screen rather than the hook: on a
 * session containing a sub-session, scrolling down the transcript threw the
 * marker to the far end of the timeline and then snapped it back to the middle.
 *
 * This exists as a SEPARATE suite from the hook's own unit test
 * (`use-session-timeline-scale.test.tsx`) because the two protect different
 * things, and the hook test cannot protect this one. The hook test proves
 * `resolveRowColumn` is monotonic when it is HANDED an instant. This proves the
 * screen actually hands it one — the `buildTraceRowInstants` memo, the
 * `toTrace` row-space hop, and the `activeRowMs` prop threaded down through
 * `SessionActivityTimeline`. Replacing that derivation with a literal `null`
 * type-checks cleanly (`activeRowMs` is `number | null`, so `null` is a legal
 * member of the type, not an absence), which means the required-field contract
 * does NOT catch the regression that matters. Only this does.
 *
 * The session deliberately FITS the 24-column window, so the strip never pans
 * and `.tl-here`'s percentage is comparable across steps rather than resetting
 * on a window move.
 */

const SESSION_ID = "session-subsession-scroll";
const TEST_TIMEZONE = "Asia/Kolkata";
const originalTimezone = process.env.TZ;
const SESSION_START = "2026-06-10T12:00:00.000Z";
const SESSION_END = "2026-06-10T13:31:00.000Z";
/**
 * The `_row` a sub-session turn is minted with — `projectAgentSessionTurnItems`
 * uses `_row = input.timeline.length + index`, far past every root turn's
 * ordinal, on an instant in the MIDDLE of the run.
 */
const SUB_SESSION_ROW = 900;

/**
 * Root turns every 15 minutes, with the sub-session between the 12:30 and 13:00
 * ones. Sides alternate so `buildTraceGroups` cannot coalesce them — consecutive
 * same-side turns collapse into ONE `[data-row]` anchor, and a suite about where
 * a SCROLL lands is meaningless with one landable row. The sub-session is
 * deliberately sandwiched between two human turns for the same reason: it is
 * agent-side, so a human turn on either side is what makes it its own anchor
 * carrying its own out-of-order `_row`.
 */
const ROOT_TURNS = [
  { at: "2026-06-10T12:00:00.000Z", human: true, row: 0 },
  { at: "2026-06-10T12:15:00.000Z", human: false, row: 1 },
  { at: "2026-06-10T12:30:00.000Z", human: true, row: 2 },
  { at: "2026-06-10T13:00:00.000Z", human: true, row: 3 },
  { at: "2026-06-10T13:15:00.000Z", human: false, row: 4 },
  { at: "2026-06-10T13:30:00.000Z", human: true, row: 5 },
] as const;
const SUB_SESSION_AT = "2026-06-10T12:45:00.000Z";
/** One bin per turn, so each row is its own bucket's earliest-by-time row. */
const BIN_COUNT = 7;
const ROW_SCROLL_STEP_PX = 1000;
/** Any non-null handle; the view only ever compares it against `null`. */
const SCROLL_FRAME_ID = 1;
/**
 * Explicit rather than inherited: this mounts the WHOLE session-detail screen
 * and then drives seven scroll steps through it, which is comfortably past the
 * 5s default on a loaded machine. Stated here so a slow render fails as a slow
 * render, instead of as a mystery timeout that reads like a hang.
 */
const FULL_RENDER_TIMEOUT_MS = 30_000;

beforeAll(() => {
  process.env.TZ = TEST_TIMEZONE;
});

afterAll(() => {
  if (originalTimezone === undefined) {
    Reflect.deleteProperty(process.env, "TZ");
    return;
  }
  process.env.TZ = originalTimezone;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a forward scroll across a sub-session boundary (ISS-7115)", () => {
  it(
    "never walks the 'you are here' line backward",
    async () => {
      const { scroller, runPendingFrame } = await renderDetail();
      const anchors = renderedRowAnchors(scroller);

      // The premise, proven rather than assumed: reading DOWN this transcript
      // walks `_row` non-monotonically, because the sub-session renders in TIME
      // order carrying an out-of-order ordinal. Without this the fixture would
      // pass under the broken code and prove nothing.
      expect(anchors).toContain(String(SUB_SESSION_ROW));
      expect(isAscendingNumeric(anchors)).toBe(false);

      const positions: number[] = [];
      for (let step = 0; step < anchors.length; step += 1) {
        scroller.scrollTop = step * ROW_SCROLL_STEP_PX;
        fireEvent.scroll(scroller);
        runPendingFrame();
        positions.push(hereMarkerPercent());
      }

      // `-1` would mean the line went away mid-scroll, which is its own bug.
      expect(Math.min(...positions)).toBeGreaterThanOrEqual(0);
      // The whole ticket. Compared against the sorted copy so a failure names the
      // step that went backward instead of just saying "false".
      expect(positions).toEqual([...positions].sort(byAscending));
      // …and it must actually TRAVEL. A line frozen at the left edge satisfies
      // monotonicity while telling the reader nothing.
      expect(positions.at(-1)).toBeGreaterThan(positions[0]);
    },
    FULL_RENDER_TIMEOUT_MS
  );
});

/**
 * The transcript as `projectAgentSessionTurnItems` emits it: sorted by TIME,
 * with the sub-session mid-run on a far-future `_row`.
 */
function subSessionTurnItems(): TurnItem[] {
  const items = ROOT_TURNS.map(({ at, human, row }) => {
    const options = { row, sessionId: SESSION_ID, t: at, text: `turn ${row}` };
    return human ? makeDbPromptRow(options) : makeDbSayRow(options);
  });
  // Time-ordered insertion, after the 12:30 turn and before the 13:00 one.
  return [
    ...items.slice(0, 3),
    makeSubagentRow(SUB_SESSION_ROW, SUB_SESSION_AT),
    ...items.slice(3),
  ];
}

function makeSubagentRow(row: number, at: string): TurnItem {
  return {
    _row: row,
    actor: {
      color: "#000",
      human: null,
      name: "assistant",
      sessionId: SESSION_ID,
    },
    body: [],
    cost: null,
    cum: 0,
    duration: null,
    model: null,
    status: "completed",
    sub: "Review lane",
    subagentType: "review",
    t: at,
    tMs: Date.parse(at),
    tokens: null,
    type: "subagent",
  };
}

/**
 * `tl0` is left to `alignBucketRowsToTranscript` to repair from the transcript
 * rather than hand-written, so this fixture cannot assert a bucket shape the
 * production repair step does not actually produce.
 */
function subSessionBuckets(): ActivityBucket[] {
  return Array.from({ length: BIN_COUNT }, (_, index) =>
    makeTimelineBucket({ label: `${index * 15}m`, tl0: index })
  );
}

/**
 * No `transcripts` entry, so the panel renders the projected fallback — which IS
 * `session.turnItems` by reference, making `toTrace` the identity. That keeps
 * this suite about the POSITION rather than about row-space translation, which
 * `session-timeline-transcript-scroll.test.tsx` already owns.
 */
function subSessionSession(): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    activityBuckets: withProducerBinBounds(subSessionBuckets(), {
      endMs: Date.parse(SESSION_END),
      startMs: Date.parse(SESSION_START),
    }),
    endedAt: new Date(SESSION_END),
    harness: "claude",
    id: SESSION_ID,
    lastActivityAt: new Date(SESSION_END),
    markers: [],
    startedAt: new Date(SESSION_START),
    transcripts: [],
    turnItems: subSessionTurnItems(),
    updatedAt: new Date(SESSION_END),
  });
}

/**
 * The scroll handler defers its read to an animation frame and guards on
 * `rafRef.current !== null`, so the frame must be captured and run AFTER
 * `requestAnimationFrame` has returned — running the callback inline from
 * inside the mock leaves the ref holding the returned id, and every later
 * scroll then short-circuits on that guard. (Which is exactly what an inline
 * mock did here first: the marker sat on column 0 for the whole scroll and the
 * monotonicity assertion passed vacuously.)
 */
async function renderDetail(): Promise<{
  runPendingFrame: () => void;
  scroller: HTMLElement;
}> {
  let pendingFrame: FrameRequestCallback | null = null;
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(
    (callback) => {
      pendingFrame = callback;
      return SCROLL_FRAME_ID;
    }
  );
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {
    pendingFrame = null;
  });
  render(
    <AppCoreStoryProviders>
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={subSessionSession()}
      />
    </AppCoreStoryProviders>
  );
  await screen.findByText("turn 5");
  const scroller = document.querySelector<HTMLElement>(".sd3-scroll");
  if (!scroller) {
    throw new Error("Expected the transcript scroll container");
  }
  stubScrollAwareRowRects(scroller);
  scroller.scrollTop = 0;
  return {
    runPendingFrame: () => {
      const frame = pendingFrame;
      if (!frame) {
        throw new Error("Expected the scroll handler to schedule a frame");
      }
      pendingFrame = null;
      act(() => frame(0));
    },
    scroller,
  };
}

/** Each rendered anchor's `data-row`, in DOCUMENT order — i.e. reading order. */
function renderedRowAnchors(scroller: HTMLElement): string[] {
  return [...scroller.querySelectorAll<HTMLElement>(".st [data-row]")].map(
    (node) => node.getAttribute("data-row") ?? ""
  );
}

/** The "you are here" line's left offset, or `-1` when the strip states none. */
function hereMarkerPercent(): number {
  const marker = document.querySelector<HTMLElement>(
    ".sd3-bars2-wrap .tl-here"
  );
  if (!marker) {
    return -1;
  }
  return Number.parseFloat(marker.style.left);
}

function isAscendingNumeric(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || Number(value) >= Number(values[index - 1])
  );
}

function byAscending(left: number, right: number): number {
  return left - right;
}
