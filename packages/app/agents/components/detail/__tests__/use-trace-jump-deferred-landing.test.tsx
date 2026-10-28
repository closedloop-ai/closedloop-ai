import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TraceRowTranslators } from "../../../lib/timeline-row-space";
import {
  TRACE_FLASH_CLASS,
  TRACE_SCROLL_OUTCOME_MESSAGE,
  TraceScrollOutcome,
} from "../../../lib/trace-scroll-target";
import type { SessionTraceHandle } from "../session-trace-contract";
import { useTraceJump } from "../use-trace-jump";

/**
 * ISS-12276 review: a jump into a group outside the windowed trace lands frames
 * after the call. The reader's position (ISS-5843), the arrival flash and the
 * outcome toast must follow the landing that actually ran, and the pending
 * landing must neither fight the reader's own scroll nor leave the scroll
 * handler's ignore flag armed for a scroll that never happened.
 */

const { mockToastInfo } = vi.hoisted(() => ({ mockToastInfo: vi.fn() }));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { info: mockToastInfo },
}));

const TARGET_ROW = 1500;
const NEARBY_ROW = 1460;
const PARKED_SCROLL_TOP_PX = 4000;
const REVEALED_SCROLL_TOP_PX = 90_000;
/** `TRACE_REVEAL_MAX_FRAMES` in the hook. */
const REVEAL_FRAME_BUDGET = 60;
/** Where the target row sits in the scroller's content once it mounts. */
const TARGET_CONTENT_TOP_PX = 90_400;
/** The same row after the rows above it are measured shorter on the way in. */
const SHIFTED_CONTENT_TOP_PX = 90_064;
/** `TRACE_STICKY_CLEARANCE_PX`: no sticky head in this harness, only the gap. */
const STICKY_CLEARANCE_PX = 14;

let frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;

function runNextFrame() {
  const pending = [...frames.values()];
  frames = new Map();
  act(() => {
    for (const frame of pending) {
      frame(0);
    }
  });
}

/** A scroller whose `scrollTop` round-trips, which jsdom's does not. */
function makeScroller(): HTMLElement {
  const scroller = document.createElement("div");
  let top = PARKED_SCROLL_TOP_PX;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  const trace = document.createElement("div");
  trace.className = "st";
  scroller.append(trace);
  document.body.append(scroller);
  return scroller;
}

function mountAnchor(scroller: HTMLElement, row: number): HTMLElement {
  const anchor = document.createElement("div");
  anchor.dataset.row = String(row);
  scroller.querySelector(".st")?.append(anchor);
  return anchor;
}

/**
 * A mounted anchor with layout: its viewport top follows the scroller, and
 * `layout.contentTop` can move under it, as measuring the rows above does.
 */
function mountLaidOutAnchor(scroller: HTMLElement, row: number) {
  const anchor = mountAnchor(scroller, row);
  const layout = { contentTop: TARGET_CONTENT_TOP_PX };
  anchor.getBoundingClientRect = () =>
    DOMRect.fromRect({ y: layout.contentTop - scroller.scrollTop });
  return { anchor, layout };
}

function setup() {
  const scroller = makeScroller();
  const onActiveRowChange = vi.fn();
  const ignoreNextTraceScrollRef = { current: false };
  // An unmounted group: each reveal moves the scroller to its estimate.
  const revealRow = vi.fn<(row: number) => boolean>(() => {
    scroller.scrollTop = REVEALED_SCROLL_TOP_PX;
    return false;
  });
  const traceRef: { current: SessionTraceHandle | null } = {
    current: { revealRow, scrollToRow: vi.fn() },
  };
  const translators: TraceRowTranslators = {
    hasRenderedRows: true,
    toRendered: (row) => row,
    toTrace: (row) => row,
  };
  const { result } = renderHook(() =>
    useTraceJump({
      cancelPendingTraceScroll: vi.fn(),
      ignoreNextTraceScrollRef,
      onActiveRowChange,
      scrollRef: { current: scroller },
      traceRef,
      traceRowTranslatorsRef: { current: translators },
    })
  );
  return {
    ignoreNextTraceScrollRef,
    onActiveRowChange,
    result,
    revealRow,
    scroller,
    traceRef,
  };
}

beforeEach(() => {
  frames = new Map();
  mockToastInfo.mockReset();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrameId += 1;
    frames.set(nextFrameId, callback);
    return nextFrameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("useTraceJump deferred landing (ISS-12276)", () => {
  it("commits the active row only once the revealed row has landed", () => {
    const { onActiveRowChange, result, revealRow, scroller } = setup();

    act(() => result.current.jumpToTimelineRow(TARGET_ROW));
    expect(onActiveRowChange).not.toHaveBeenCalled();

    const { anchor: target } = mountLaidOutAnchor(scroller, TARGET_ROW);
    revealRow.mockReturnValue(true);
    // The frame the row mounts corrects onto it; the next confirms it held.
    runNextFrame();
    expect(onActiveRowChange).not.toHaveBeenCalled();
    runNextFrame();

    expect(onActiveRowChange).toHaveBeenCalledWith(TARGET_ROW);
    expect(target).toHaveClass(TRACE_FLASH_CLASS);
    expect(scroller.scrollTop).toBe(
      TARGET_CONTENT_TOP_PX - STICKY_CLEARANCE_PX
    );
    expect(mockToastInfo).not.toHaveBeenCalled();
  });

  it("re-lands on the measured row when measuring the rows above shifts it", () => {
    const { onActiveRowChange, result, revealRow, scroller } = setup();

    act(() => result.current.jumpToTimelineRow(TARGET_ROW));
    const { anchor: target, layout } = mountLaidOutAnchor(scroller, TARGET_ROW);
    revealRow.mockReturnValue(true);
    runNextFrame();

    // Rows above measure shorter than their estimate and pull the target up,
    // under the sticky header. Committing here was the ISS-12276 defect.
    layout.contentTop = SHIFTED_CONTENT_TOP_PX;
    runNextFrame();
    expect(onActiveRowChange).not.toHaveBeenCalled();
    expect(target).not.toHaveClass(TRACE_FLASH_CLASS);

    runNextFrame();
    expect(scroller.scrollTop).toBe(
      SHIFTED_CONTENT_TOP_PX - STICKY_CLEARANCE_PX
    );
    expect(onActiveRowChange).toHaveBeenCalledWith(TARGET_ROW);
    expect(target).toHaveClass(TRACE_FLASH_CLASS);
    expect(frames.size).toBe(0);
  });

  it("does not commit, and reports the landing, when the trace unmounts mid-landing", () => {
    const { onActiveRowChange, result, traceRef } = setup();

    act(() => result.current.jumpToTimelineRow(TARGET_ROW));
    traceRef.current = null;
    runNextFrame();

    expect(onActiveRowChange).not.toHaveBeenCalled();
    expect(mockToastInfo).toHaveBeenCalledWith(
      TRACE_SCROLL_OUTCOME_MESSAGE[TraceScrollOutcome.EmptyTranscript],
      expect.anything()
    );
  });

  it("never flashes or commits a nearby turn when the target never mounts", () => {
    const { onActiveRowChange, result, scroller } = setup();
    const nearby = mountAnchor(scroller, NEARBY_ROW);

    act(() => result.current.jumpToTimelineRow(TARGET_ROW));
    for (let frame = 0; frame < REVEAL_FRAME_BUDGET; frame += 1) {
      runNextFrame();
    }

    expect(frames.size).toBe(0);
    expect(nearby).not.toHaveClass(TRACE_FLASH_CLASS);
    expect(onActiveRowChange).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(REVEALED_SCROLL_TOP_PX);
    expect(mockToastInfo).not.toHaveBeenCalled();
  });

  it("abandons the landing when the reader scrolls", () => {
    const {
      ignoreNextTraceScrollRef,
      onActiveRowChange,
      result,
      revealRow,
      scroller,
    } = setup();

    act(() => result.current.jumpToTimelineRow(TARGET_ROW));
    expect(revealRow).toHaveBeenCalledTimes(1);
    scroller.dispatchEvent(new WheelEvent("wheel"));
    expect(ignoreNextTraceScrollRef.current).toBe(false);

    scroller.scrollTop = PARKED_SCROLL_TOP_PX;
    runNextFrame();

    expect(revealRow).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTop).toBe(PARKED_SCROLL_TOP_PX);
    expect(onActiveRowChange).not.toHaveBeenCalled();
  });

  it("arms the ignore flag for every reveal that scrolls, and for none that does not", () => {
    const { ignoreNextTraceScrollRef, result, revealRow, scroller } = setup();
    // First reveal: the virtualizer has no offset yet, so nothing moves.
    revealRow.mockImplementationOnce(() => false);

    act(() => result.current.jumpToTimelineRow(TARGET_ROW));
    expect(ignoreNextTraceScrollRef.current).toBe(false);

    // A later reveal does move the scroller.
    runNextFrame();
    expect(scroller.scrollTop).toBe(REVEALED_SCROLL_TOP_PX);
    expect(ignoreNextTraceScrollRef.current).toBe(true);

    // The scroll handler consumes it; the next reveal that moves re-arms it.
    ignoreNextTraceScrollRef.current = false;
    scroller.scrollTop = PARKED_SCROLL_TOP_PX;
    runNextFrame();
    expect(ignoreNextTraceScrollRef.current).toBe(true);
  });
});
