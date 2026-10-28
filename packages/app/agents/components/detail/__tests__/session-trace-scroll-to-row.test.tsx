import { render } from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionTrace } from "../session-trace";
import type { SessionTraceHandle } from "../session-trace-contract";
import type { SessionTraceItem } from "../session-trace-groups";
import { sayItem } from "./session-trace-test-helpers";

/**
 * The non-windowed `scrollToRow` path: every row is mounted, so the handle
 * scrolls the bounded container itself to centre the nearest rendered row at or
 * before the target, never calling `scrollIntoView` on an ancestor.
 */

const CONTAINER_TOP = 100;
const CONTAINER_CLIENT_HEIGHT = 200;
const ROW_HEIGHT = 20;
const START_SCROLL_TOP = 50;

/** Row N sits N*100px below the viewport's top edge. */
function rowTop(row: number): number {
  return CONTAINER_TOP + row * 100;
}

function stubGeometry(container: HTMLElement) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this === container) {
        return new DOMRect(0, CONTAINER_TOP, 400, CONTAINER_CLIENT_HEIGHT);
      }
      const row = Number(this.getAttribute("data-row"));
      return new DOMRect(0, rowTop(row), 400, ROW_HEIGHT);
    }
  );
  Object.defineProperty(container, "clientHeight", {
    configurable: true,
    value: CONTAINER_CLIENT_HEIGHT,
  });
  container.scrollTop = START_SCROLL_TOP;
}

/** The scrollTop that centres a row whose top is `top`. */
function centredScrollTop(top: number): number {
  const centre = (CONTAINER_CLIENT_HEIGHT - ROW_HEIGHT) / 2;
  return START_SCROLL_TOP + (top - CONTAINER_TOP - centre);
}

function mount(items: readonly SessionTraceItem[]) {
  const handle = createRef<SessionTraceHandle>();
  const scroller: RefObject<HTMLDivElement | null> = createRef();
  render(
    <div ref={scroller}>
      <SessionTrace items={items} ref={handle} scrollElementRef={scroller} />
    </div>
  );
  const container = scroller.current;
  if (container === null || handle.current === null) {
    throw new Error("trace did not mount");
  }
  return { container, handle: handle.current };
}

const ITEMS = [
  sayItem(2, "second turn"),
  sayItem(6, "sixth turn", { isThinking: true }),
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SessionTrace scrollToRow without windowing", () => {
  it("smooth-scrolls the container to centre the nearest row at or before the target", () => {
    const { container, handle } = mount(ITEMS);
    stubGeometry(container);
    const scrollTo = vi.fn();
    container.scrollTo = scrollTo;

    handle.scrollToRow(9);

    expect(scrollTo).toHaveBeenCalledWith({
      top: centredScrollTop(rowTop(6)),
      behavior: "smooth",
    });
  });

  it("falls back to the first row when the target precedes every rendered row", () => {
    const { container, handle } = mount(ITEMS);
    stubGeometry(container);
    const scrollTo = vi.fn();
    container.scrollTo = scrollTo;

    handle.scrollToRow(0);

    expect(scrollTo).toHaveBeenCalledWith({
      top: centredScrollTop(rowTop(2)),
      behavior: "smooth",
    });
  });

  it("ignores a non-numeric data-row and sets scrollTop when scrollTo is unavailable", () => {
    const { container, handle } = mount(ITEMS);
    const junk = document.createElement("div");
    junk.setAttribute("data-row", "not-a-row");
    container.prepend(junk);
    stubGeometry(container);
    Object.defineProperty(container, "scrollTo", {
      configurable: true,
      value: undefined,
    });

    handle.scrollToRow(3);

    expect(container.scrollTop).toBe(centredScrollTop(rowTop(2)));
  });

  it("leaves the container where it was when no row is rendered", () => {
    const { container, handle } = mount([]);
    stubGeometry(container);
    const scrollTo = vi.fn();
    container.scrollTo = scrollTo;

    handle.scrollToRow(4);

    expect(scrollTo).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(START_SCROLL_TOP);
  });
});
