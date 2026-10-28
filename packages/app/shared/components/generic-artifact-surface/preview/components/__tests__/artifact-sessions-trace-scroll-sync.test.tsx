import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { genericArtifactSessionTrace, genericArtifacts } from "../../fixtures";
import { ArtifactSessionsTrace } from "../artifact-sessions-trace";
import { sessionRows } from "../experimental/session/mock";
import {
  buildSessionDetail,
  type SessionDetail,
  type TraceTurn,
} from "../experimental/session/mock-detail";
import type { TraceCommentAnchor } from "../experimental/session/session-trace";

const ROW_HEIGHT_PX = 100;
const VIEWPORT_HEIGHT_PX = 300;
const CONTENT_HEIGHT_PX = 1000;
const SCROLLER_TOP_PX = 50;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const SCROLLER_SELECTOR = "[data-session-detail-scroll]";
const ACTIVE_ROW_CLASS = "opacity-100";
const TURN_TIMES = ["0:00", "0:30", "1:00", "1:30", "2:00"];
const SETTLE_MS = 5000;
const FRAME_MS = 16;

const [baseArtifact] = genericArtifacts;
const [baseRow] = sessionRows;
if (!(baseArtifact && baseRow)) {
  throw new Error("preview fixtures are missing the rows this suite reads");
}
const baseDetail = buildSessionDetail(baseRow);

let viewportHeightPx = VIEWPORT_HEIGHT_PX;
let contentHeightPx = CONTENT_HEIGHT_PX;
let reducedMotion = false;
let scrollTo: ReturnType<typeof vi.fn>;
const originalScrollTo = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollTo"
);

beforeEach(() => {
  viewportHeightPx = VIEWPORT_HEIGHT_PX;
  contentHeightPx = CONTENT_HEIGHT_PX;
  reducedMotion = false;
  vi.useFakeTimers();
  installGeometry();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalScrollTo) {
    Object.defineProperty(Element.prototype, "scrollTo", originalScrollTo);
  } else {
    Reflect.deleteProperty(Element.prototype, "scrollTo");
  }
});

describe("ArtifactSessionsTrace scroll synchronization", () => {
  it("moves the scrubber and the active turn to the transcript position the reader scrolls to", () => {
    renderTrace();
    const scroller = traceScroller();

    scroller.scrollTop = 288;
    fireEvent.scroll(scroller);
    advance(FRAME_MS);

    expect(scrubber()).toHaveValue("90");
    expect(activeRows()).toStrictEqual([3]);
  });

  it("leaves room below the last turn so it can scroll to the top of the viewport", () => {
    renderTrace();

    expect(traceContent()).toHaveStyle({
      paddingBottom: "188px",
    });
  });

  it("keeps the minimum tail padding in a viewport shorter than a turn", () => {
    viewportHeightPx = 60;
    renderTrace();

    expect(traceContent()).toHaveStyle({ paddingBottom: "40px" });
  });
});

describe("ArtifactSessionsTrace scrubber", () => {
  it("activates the nearest turn at once and eases the transcript to the scrubbed minute", () => {
    renderTrace();
    const scroller = traceScroller();

    fireEvent.change(scrubber(), { target: { value: "45" } });

    expect(scrubber()).toHaveValue("45");
    expect(activeRows()).toStrictEqual([1]);
    advance(FRAME_MS);
    expect(scroller.scrollTop).toBeCloseTo(22.48, 2);
    advance(SETTLE_MS);
    expect(scroller.scrollTop).toBe(138);
    expect(scrubber()).toHaveValue("45");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("jumps without easing when the reader prefers reduced motion", () => {
    reducedMotion = true;
    renderTrace();

    fireEvent.change(scrubber(), { target: { value: "45" } });

    expect(scrubber()).toHaveValue("45");
    expect(scrollTo).toHaveBeenCalledWith({
      behavior: "auto",
      top: 138,
    });
    advance(SETTLE_MS);
    expect(traceScroller().scrollTop).toBe(0);
  });

  it("stops easing where it is when the reader takes the wheel", () => {
    renderTrace();
    const scroller = traceScroller();
    fireEvent.change(scrubber(), { target: { value: "45" } });
    advance(FRAME_MS);
    const stoppedAt = scroller.scrollTop;

    fireEvent.wheel(scroller);
    advance(SETTLE_MS);

    expect(stoppedAt).toBeGreaterThan(0);
    expect(scroller.scrollTop).toBe(stoppedAt);
    expect(scrubber()).not.toHaveValue("45");
  });

  it("ignores transcript scroll events while the scrubber is driving", () => {
    renderTrace();
    const scroller = traceScroller();
    fireEvent.change(scrubber(), { target: { value: "45" } });

    fireEvent.scroll(scroller);
    advance(FRAME_MS);

    expect(scrubber()).toHaveValue("45");
    expect(activeRows()).toStrictEqual([1]);
  });

  it("drops a pending scroll sync once the scrubber takes over", () => {
    renderTrace();
    const scroller = traceScroller();
    scroller.scrollTop = 288;
    fireEvent.scroll(scroller);

    fireEvent.change(scrubber(), { target: { value: "45" } });
    advance(FRAME_MS);

    expect(scrubber()).toHaveValue("45");
    expect(activeRows()).toStrictEqual([1]);
  });

  it("retargets an ease already under way to the latest scrub", () => {
    renderTrace();
    const scroller = traceScroller();
    fireEvent.change(scrubber(), { target: { value: "45" } });
    advance(FRAME_MS);

    fireEvent.change(scrubber(), { target: { value: "90" } });
    advance(FRAME_MS);
    expect(scroller.scrollTop).toBeCloseTo(60.88, 2);
    advance(SETTLE_MS);

    expect(scroller.scrollTop).toBe(288);
    expect(scrubber()).toHaveValue("90");
    expect(activeRows()).toStrictEqual([3]);
  });

  it("caps the ease at eight viewport heights per second", () => {
    viewportHeightPx = 400;
    renderTrace();

    fireEvent.change(scrubber(), { target: { value: "120" } });
    advance(FRAME_MS);

    expect(traceScroller().scrollTop).toBeCloseTo(51.2, 2);
  });

  it("hands the transcript back to the reader once the ease lands", () => {
    renderTrace();
    const scroller = traceScroller();
    fireEvent.change(scrubber(), { target: { value: "45" } });
    advance(SETTLE_MS);

    scroller.scrollTop = 288;
    fireEvent.scroll(scroller);
    advance(FRAME_MS);

    expect(scrubber()).toHaveValue("90");
    expect(activeRows()).toStrictEqual([3]);
  });

  it("resumes transcript sync after a wheel gesture stops the ease", () => {
    renderTrace();
    const scroller = traceScroller();
    fireEvent.change(scrubber(), { target: { value: "45" } });
    advance(FRAME_MS);
    fireEvent.wheel(scroller);

    scroller.scrollTop = 288;
    fireEvent.scroll(scroller);
    advance(FRAME_MS);

    expect(scrubber()).toHaveValue("90");
    expect(activeRows()).toStrictEqual([3]);
  });

  it("holds its position when the transcript has no turns to land on", () => {
    renderTrace({ detail: syncDetail([]) });

    fireEvent.change(scrubber(), { target: { value: "60" } });
    advance(SETTLE_MS);

    expect(scrubber()).toHaveValue("0");
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe("ArtifactSessionsTrace jump requests", () => {
  it("smooth-scrolls to the requested turn and leaves activation to the scroll", () => {
    renderTrace({ traceJumpRequest: { nonce: 1, row: 3 } });

    advance(FRAME_MS);

    expect(scrollTo).toHaveBeenCalledWith({
      behavior: "smooth",
      top: 288,
    });
    expect(activeRows()).toStrictEqual([0]);
  });

  it("scrolls without animation for a reader who prefers reduced motion", () => {
    reducedMotion = true;
    renderTrace({ traceJumpRequest: { nonce: 1, row: 3 } });

    advance(FRAME_MS);

    expect(scrollTo).toHaveBeenCalledWith({
      behavior: "auto",
      top: 288,
    });
  });

  it("places turns that carry no row by their position in the trace", () => {
    renderTrace({
      detail: syncDetail(turns().map(({ row: _row, ...turn }) => turn)),
      traceJumpRequest: { nonce: 1, row: 2 },
    });

    advance(FRAME_MS);

    expect(scrollTo).toHaveBeenCalledWith({
      behavior: "smooth",
      top: 188,
    });
  });

  it("reads an elapsed label without minutes as whole hours", () => {
    renderTrace({
      detail: syncDetail(
        turns().map((turn) =>
          turn.row === 2 ? { ...turn, timeLabel: "1" } : turn
        )
      ),
    });
    const scroller = traceScroller();

    scroller.scrollTop = 188;
    fireEvent.scroll(scroller);
    advance(FRAME_MS);

    expect(scrubber()).toHaveValue("60");
    expect(activeRows()).toStrictEqual([2]);
  });

  it("reads each anchor's minute by the turn's own row, not its position", () => {
    renderTrace({
      detail: syncDetail(
        turns().map((turn, index) => ({ ...turn, row: index + 1 }))
      ),
    });
    const scroller = traceScroller();

    scroller.scrollTop = 288;
    fireEvent.scroll(scroller);
    advance(FRAME_MS);

    expect(scrubber()).toHaveValue("60");
    expect(activeRows()).toStrictEqual([3]);
  });

  it("measures anchors in content space while the transcript is scrolled", () => {
    const { rerender } = renderTrace();
    traceScroller().scrollTop = 288;

    rerender(traceElement({ traceJumpRequest: { nonce: 1, row: 1 } }));
    advance(FRAME_MS);

    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 88 });
  });

  it("drops a jump request superseded before its frame runs", () => {
    const { rerender } = renderTrace();

    rerender(traceElement({ traceJumpRequest: { nonce: 1, row: 1 } }));
    rerender(traceElement({ traceJumpRequest: { nonce: 2, row: 3 } }));
    advance(FRAME_MS);

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 288 });
  });

  it("clamps a jump to the last scrollable position", () => {
    contentHeightPx = 500;
    renderTrace({ traceJumpRequest: { nonce: 1, row: 3 } });

    advance(FRAME_MS);

    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 200 });
  });

  it("scrolls to the start for a row the trace does not hold", () => {
    renderTrace({ traceJumpRequest: { nonce: 1, row: 99 } });

    advance(FRAME_MS);

    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 0 });
  });

  it("highlights the comment anchor a jump request names", () => {
    const anchor: TraceCommentAnchor = {
      anchorPreview: "Turn 2",
      id: "comment-1",
      traceRow: 2,
    };
    const { rerender } = renderTrace({ commentAnchors: [anchor] });
    const mark = screen.getByText("Turn 2", { selector: "mark" });
    expect(mark).not.toHaveAttribute("data-scroll-highlight");

    rerender(
      traceElement({
        commentAnchors: [anchor],
        traceJumpRequest: { commentId: anchor.id, nonce: 1, row: 2 },
      })
    );

    expect(screen.getByText("Turn 2", { selector: "mark" })).toHaveAttribute(
      "data-scroll-highlight",
      "true"
    );
  });
});

type RenderOptions = {
  commentAnchors?: TraceCommentAnchor[];
  detail?: SessionDetail;
  traceJumpRequest?: { commentId?: string; nonce: number; row: number } | null;
};

function renderTrace(options: RenderOptions = {}) {
  const view = render(traceElement(options));
  advance(FRAME_MS);
  return view;
}

function traceElement({
  commentAnchors = [],
  detail = syncDetail(turns()),
  traceJumpRequest = null,
}: RenderOptions) {
  return (
    <ArtifactSessionsTrace
      artifact={baseArtifact}
      commentAnchors={commentAnchors}
      detailOverride={detail}
      onSubmitTraceComment={() => undefined}
      trace={genericArtifactSessionTrace}
      traceJumpRequest={traceJumpRequest}
    />
  );
}

function turns(): TraceTurn[] {
  return TURN_TIMES.map((timeLabel, row) => ({
    blocks: [{ spans: [`Turn ${row}`], type: "p" }],
    id: `turn-${row}`,
    row,
    side: row % 2 === 0 ? "human" : "agent",
    timeLabel,
  }));
}

function syncDetail(trace: TraceTurn[]): SessionDetail {
  return {
    ...baseDetail,
    costEvents: [],
    durationMinutes: 120,
    timelineMarkers: [],
    trace,
  };
}

function installGeometry() {
  scrollTo = vi.fn();
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    value: scrollTo,
    writable: true,
  });
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    addEventListener: () => undefined,
    addListener: () => undefined,
    dispatchEvent: () => false,
    matches: query === REDUCED_MOTION_QUERY && reducedMotion,
    media: query,
    onchange: null,
    removeEventListener: () => undefined,
    removeListener: () => undefined,
  }));
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches(SCROLLER_SELECTOR) ? viewportHeightPx : 0;
    }
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches(SCROLLER_SELECTOR) ? contentHeightPx : 0;
    }
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.traceRow === undefined ? 0 : ROW_HEIGHT_PX;
    }
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      if (this instanceof HTMLElement && this.dataset.traceRow !== undefined) {
        const scroller = this.closest(SCROLLER_SELECTOR);
        const top =
          SCROLLER_TOP_PX +
          Number(this.dataset.traceRow) * ROW_HEIGHT_PX -
          (scroller?.scrollTop ?? 0);
        return new DOMRect(0, top, 800, ROW_HEIGHT_PX);
      }
      if (this.matches(SCROLLER_SELECTOR)) {
        return new DOMRect(0, SCROLLER_TOP_PX, 800, viewportHeightPx);
      }
      return new DOMRect(0, 0, 0, 0);
    }
  );
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function traceScroller(): HTMLElement {
  const scroller = document.querySelector<HTMLElement>(SCROLLER_SELECTOR);
  if (!scroller) {
    throw new Error("trace scroller is not mounted");
  }
  return scroller;
}

function traceContent(): HTMLElement {
  const content = traceScroller().firstElementChild;
  if (!(content instanceof HTMLElement)) {
    throw new Error("trace scroller has no content wrapper");
  }
  return content;
}

function scrubber(): HTMLElement {
  return screen.getByRole("slider", { name: "Session time position" });
}

function activeRows(): number[] {
  return [
    ...document.querySelectorAll<HTMLElement>("[data-trace-row]"),
  ].flatMap((row) =>
    row.classList.contains(ACTIVE_ROW_CLASS)
      ? [Number(row.dataset.traceRow)]
      : []
  );
}
