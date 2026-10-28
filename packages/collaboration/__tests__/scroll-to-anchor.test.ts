// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrollToAnchor } from "../client/scroll-to-anchor";

const HIGHLIGHT_ATTR = "data-scroll-highlight";

function addMark(threadId: string): HTMLElement {
  const mark = document.createElement("span");
  mark.className = "lb-tiptap-thread-mark";
  mark.dataset.lbThreadId = threadId;
  mark.scrollIntoView = vi.fn();
  document.body.append(mark);
  return mark;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("scrollToAnchor", () => {
  it("scrolls the matching thread mark into view and highlights it briefly", () => {
    const other = addMark("th_other");
    const mark = addMark("th_1");

    scrollToAnchor("th_1");

    expect(mark.scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      behavior: "smooth",
    });
    expect(other.scrollIntoView).not.toHaveBeenCalled();
    expect(mark.getAttribute(HIGHLIGHT_ATTR)).toBe("true");
    expect(other.hasAttribute(HIGHLIGHT_ATTR)).toBe(false);

    vi.advanceTimersByTime(1599);
    expect(mark.getAttribute(HIGHLIGHT_ATTR)).toBe("true");
    vi.advanceTimersByTime(1);
    expect(mark.hasAttribute(HIGHLIGHT_ATTR)).toBe(false);
  });

  it("escapes the thread id so selector metacharacters match literally", () => {
    const threadId = 'th"] , .x[a="';
    const mark = addMark(threadId);

    scrollToAnchor(threadId);

    expect(mark.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("ignores an element carrying the thread id without the thread-mark class", () => {
    const stray = document.createElement("span");
    stray.dataset.lbThreadId = "th_1";
    stray.scrollIntoView = vi.fn();
    document.body.append(stray);

    scrollToAnchor("th_1");

    expect(stray.scrollIntoView).not.toHaveBeenCalled();
    expect(stray.hasAttribute(HIGHLIGHT_ATTR)).toBe(false);
  });

  it("does nothing and schedules no timer when the mark is absent", () => {
    addMark("th_other");

    expect(() => scrollToAnchor("th_missing")).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  // Pins current behavior; looks odd because the first call's removal timer is
  // never cancelled, so it clears the repeat call's highlight after 600ms
  // instead of the full 1600ms.
  it("lets the first call's timer clear a repeat highlight on the same mark early", () => {
    const mark = addMark("th_1");

    scrollToAnchor("th_1");
    vi.advanceTimersByTime(1000);
    scrollToAnchor("th_1");

    expect(mark.scrollIntoView).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(2);
    expect(mark.getAttribute(HIGHLIGHT_ATTR)).toBe("true");

    vi.advanceTimersByTime(599);
    expect(mark.getAttribute(HIGHLIGHT_ATTR)).toBe("true");
    vi.advanceTimersByTime(1);
    expect(mark.hasAttribute(HIGHLIGHT_ATTR)).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });
});
