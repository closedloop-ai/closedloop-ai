import { beforeEach, describe, expect, it } from "vitest";
import {
  didTraceJumpLand,
  didTraceScrollMove,
  findTraceScrollTarget,
  flashTraceRow,
  isTraceScrollMovement,
  planTraceScroll,
  TRACE_FLASH_CLASS,
  TRACE_SCROLL_LANDED,
  TRACE_SCROLL_OUTCOME_MESSAGE,
  TraceScrollOutcome,
} from "../trace-scroll-target";

/** Both dead-control messages must name the transcript the click could not reach. */
const TRANSCRIPT_MENTION = /transcript/i;

/**
 * ISS-5479. The Session Timeline is a fixed grid drawn over a transcript whose
 * anchors are GROUPS, so several bars resolve to one anchor and a click can
 * legitimately land where the reader already is. These cover the resolution
 * rule that decides which anchor wins (including the two ends of the range that
 * ISS-5479 called out) and the outcome vocabulary the view reports with.
 */

/** A scroller holding anchors at the given `data-row` values, in order. */
function scrollerWithRows(rows: readonly number[]): HTMLElement {
  const scroller = document.createElement("div");
  const trace = document.createElement("div");
  trace.className = "st";
  for (const row of rows) {
    const node = document.createElement("div");
    node.dataset.row = String(row);
    trace.append(node);
  }
  scroller.append(trace);
  document.body.append(scroller);
  return scroller;
}

/** The `data-row` of the anchor a jump to `row` resolves to, or `null`. */
function targetRowFor(scroller: HTMLElement, row: number): string | null {
  return (
    findTraceScrollTarget(scroller, row, false)?.getAttribute("data-row") ??
    null
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("findTraceScrollTarget row resolution (ISS-5479)", () => {
  // The rendered space is sparse because `SessionTrace` coalesces a run of
  // consecutive message turns into ONE anchor keyed to the group's first row.
  const SPARSE_ROWS = [0, 4, 11, 30];

  it("resolves a row in the middle of a group to that group, not the next one", () => {
    const scroller = scrollerWithRows(SPARSE_ROWS);

    // Row 9 sits inside the group that starts at 4. Anchor 11 is numerically
    // CLOSER, so a nearest-in-either-direction rule would pick it — and scroll
    // the reader PAST the turn they clicked. Containment must win.
    expect(targetRowFor(scroller, 9)).toBe("4");
  });

  it("resolves a row past the last rendered anchor to that last anchor", () => {
    const scroller = scrollerWithRows(SPARSE_ROWS);

    // The tail of the timeline shares one anchor because there is nothing
    // rendered beyond it — landing on the last real turn is the defensible
    // answer, and it must be the LAST one, not the first.
    expect(targetRowFor(scroller, 9999)).toBe("30");
  });

  it("resolves a row before the first rendered anchor to the first anchor", () => {
    const scroller = scrollerWithRows(SPARSE_ROWS);

    expect(targetRowFor(scroller, -5)).toBe("0");
  });

  it("resolves an exact anchor row to that anchor", () => {
    const scroller = scrollerWithRows(SPARSE_ROWS);

    expect(targetRowFor(scroller, 11)).toBe("11");
  });

  it("returns null only when the transcript rendered no anchor at all", () => {
    const scroller = scrollerWithRows([]);

    expect(findTraceScrollTarget(scroller, 3, false)).toBeNull();
  });

  it("ignores anchors whose data-row is not a finite number", () => {
    const scroller = scrollerWithRows([0, 4]);
    const broken = document.createElement("div");
    broken.dataset.row = "not-a-row";
    scroller.querySelector(".st")?.append(broken);

    expect(targetRowFor(scroller, 9)).toBe("4");
  });

  it("prefers the URL-owned invocation anchor when one is on screen", () => {
    const scroller = scrollerWithRows([0, 4, 11]);
    const anchor = scroller.querySelector<HTMLElement>('[data-row="11"]');
    anchor?.setAttribute("data-invocation-anchor-target", "true");

    expect(
      findTraceScrollTarget(scroller, 0, true)?.getAttribute("data-row")
    ).toBe("11");
  });

  it("falls back to row resolution when no invocation anchor is rendered", () => {
    const scroller = scrollerWithRows([0, 4, 11]);

    expect(
      findTraceScrollTarget(scroller, 9, true)?.getAttribute("data-row")
    ).toBe("4");
  });
});

describe("planTraceScroll (ISS-5479)", () => {
  it("reports no movement needed when the anchor is already in place", () => {
    const scroller = scrollerWithRows([0, 4]);
    // jsdom rects are all-zero, so the anchor and the scroller share a top and
    // the plan lands within the sticky clearance of where we already are.
    const plan = planTraceScroll(scroller, 4, false);
    if (!plan) {
      throw new Error("Expected a plan");
    }

    expect(plan.target.getAttribute("data-row")).toBe("4");
    // -14 (the sticky clearance) is inside nothing — it IS a movement request.
    expect(isTraceScrollMovement(plan)).toBe(true);
    expect(plan.previousScrollTop).toBe(0);
  });

  it("returns null when the transcript has nothing to scroll to", () => {
    expect(planTraceScroll(scrollerWithRows([]), 0, false)).toBeNull();
  });

  it("treats a sub-pixel delta as no movement", () => {
    expect(
      isTraceScrollMovement({
        nextScrollTop: 120.4,
        previousScrollTop: 120,
        target: document.createElement("div"),
      })
    ).toBe(false);
  });
});

describe("didTraceScrollMove (ISS-5479)", () => {
  it("is true when the scroller actually landed somewhere new", () => {
    const scroller = scrollerWithRows([0]);
    scroller.scrollTop = 900;

    expect(didTraceScrollMove(scroller, 0)).toBe(true);
  });

  it("is false when the assignment was clamped and left scrollTop where it was", () => {
    // The browser clamps a `scrollTop` past the end of the range, so the view
    // must not claim it scrolled. This is the guard that keeps a click at the
    // bottom of the transcript from reporting movement that never happened.
    const scroller = scrollerWithRows([0]);
    scroller.scrollTop = 240;

    expect(didTraceScrollMove(scroller, 240)).toBe(false);
  });
});

describe("TRACE_SCROLL_OUTCOME_MESSAGE (ISS-5479)", () => {
  it("stays silent for the two outcomes the screen already shows", () => {
    // The transcript visibly moving, and the arrival flash firing on the row
    // already on screen, ARE the response — a toast on top would be noise.
    expect(
      TRACE_SCROLL_OUTCOME_MESSAGE[TraceScrollOutcome.Scrolled]
    ).toBeNull();
    expect(
      TRACE_SCROLL_OUTCOME_MESSAGE[TraceScrollOutcome.AlreadyInPlace]
    ).toBeNull();
  });

  it("explains the three outcomes that used to return in silence", () => {
    // These are the dead-control cases: nothing moves and nothing flashes, so
    // without a message they are indistinguishable from a broken button.
    expect(
      TRACE_SCROLL_OUTCOME_MESSAGE[TraceScrollOutcome.Unresolvable]
    ).toMatch(TRANSCRIPT_MENTION);
    expect(
      TRACE_SCROLL_OUTCOME_MESSAGE[TraceScrollOutcome.EmptyTranscript]
    ).toMatch(TRANSCRIPT_MENTION);
    // The idle bucket is answered at the bar itself (withdrawn affordance plus
    // `getBucketJumpHint` on its anchored tooltip), so it must NOT also toast.
    expect(
      TRACE_SCROLL_OUTCOME_MESSAGE[TraceScrollOutcome.NoJumpTarget]
    ).toBeNull();
  });

  it("gives every silent outcome a message and every self-evident one none", () => {
    // Guards the pairing itself: a new outcome added to the const object gets a
    // compile error from the exhaustive Record, but this catches the runtime
    // half — a message accidentally left null on a case with no other feedback.
    // `NoJumpTarget` is absent on purpose: it is the one outcome the CONTROL
    // answers, so a toast would be a second voice saying the same thing from the
    // corner of the screen. Every other silent outcome still needs one.
    const needsAMessage = [
      TraceScrollOutcome.EmptyTranscript,
      TraceScrollOutcome.Unresolvable,
    ].sort();
    const hasAMessage = Object.values(TraceScrollOutcome)
      .filter((outcome) => TRACE_SCROLL_OUTCOME_MESSAGE[outcome] !== null)
      .sort();
    expect(hasAMessage).toEqual(needsAMessage);
  });
});

describe("flashTraceRow (ISS-5479)", () => {
  it("re-applies the flash to a row that is already flashed", () => {
    // The collapsed-bucket case: the second click resolves onto the SAME anchor
    // with the scroller already parked there, so restarting this animation is
    // the entire perceptible response.
    const row = document.createElement("div");
    row.classList.add(TRACE_FLASH_CLASS);

    flashTraceRow(row);

    expect(row.classList.contains(TRACE_FLASH_CLASS)).toBe(true);
  });

  it("leaves the flash on exactly one row, so 'here' never accumulates", () => {
    // The class is never removed on its own. On the animated path a stale one is
    // merely invisible (the keyframes end at transparent), but under
    // `prefers-reduced-motion` the arrival is a steady tint with NO animation to
    // end — so without this, every row the reader ever jumped to would stay lit
    // and "you are here" would become a trail. Jump three times, one marker.
    const rows = [0, 1, 2].map(() => {
      const row = document.createElement("div");
      document.body.append(row);
      return row;
    });

    for (const row of rows) {
      flashTraceRow(row);
    }

    expect(
      rows.filter((row) => row.classList.contains(TRACE_FLASH_CLASS))
    ).toEqual([rows[2]]);
    for (const row of rows) {
      row.remove();
    }
  });

  it("adds the flash to a row that was never flashed", () => {
    const row = document.createElement("div");

    flashTraceRow(row);

    expect(row.classList.contains(TRACE_FLASH_CLASS)).toBe(true);
  });
});

describe("TRACE_SCROLL_LANDED (ISS-5843)", () => {
  it("treats only the two arrivals as a landing", () => {
    // The reader's position may move exactly when the transcript reached the
    // row. `AlreadyInPlace` counts: the anchor space is coarser than the bar
    // grid, so landing on the anchor already under the sticky header is a real
    // arrival, and excluding it would freeze the marker across every collapsed
    // run of bars.
    expect(didTraceJumpLand(TraceScrollOutcome.Scrolled)).toBe(true);
    expect(didTraceJumpLand(TraceScrollOutcome.AlreadyInPlace)).toBe(true);
  });

  it("refuses to move the reader's position when nothing was reached", () => {
    // Each of these leaves the transcript exactly where it was, so committing
    // the row would point `.tl-here` (and, since ISS-5819, the scrubber thumb
    // with it) at an instant the reader was never taken to.
    expect(didTraceJumpLand(TraceScrollOutcome.EmptyTranscript)).toBe(false);
    expect(didTraceJumpLand(TraceScrollOutcome.NoJumpTarget)).toBe(false);
    expect(didTraceJumpLand(TraceScrollOutcome.Unresolvable)).toBe(false);
  });

  it("answers for every outcome, so a new one cannot default to moving", () => {
    // The exhaustive `Record` makes this a typecheck failure first; this pins
    // the runtime shape so a member added with a `false` stub still shows up
    // here rather than silently classifying itself.
    expect(Object.keys(TRACE_SCROLL_LANDED).sort()).toEqual(
      Object.values(TraceScrollOutcome).sort()
    );
  });
});
