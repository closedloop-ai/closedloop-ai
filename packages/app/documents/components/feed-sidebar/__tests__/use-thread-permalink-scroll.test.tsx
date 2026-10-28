// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { StrictMode, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HIGHLIGHT_DURATION_MS,
  PermalinkResolution,
  RETRY_DELAY_MS,
  useThreadPermalinkScroll,
} from "../use-thread-permalink-scroll";

type HarnessProps = {
  targetThreadId: string | null;
  threadsReady: boolean;
  hasThread: (id: string) => boolean;
  onResolved: (resolution: PermalinkResolution) => void;
  mountedThreadIds: readonly string[];
};

function Harness({
  targetThreadId,
  threadsReady,
  hasThread,
  onResolved,
  mountedThreadIds,
}: Readonly<HarnessProps>) {
  const containerRef = useRef<HTMLOListElement | null>(null);
  useThreadPermalinkScroll({
    containerRef,
    hasThread,
    onResolved,
    targetThreadId,
    threadsReady,
  });
  return (
    <ol ref={containerRef}>
      {mountedThreadIds.map((id) => (
        <li data-thread-id={id} key={id}>
          {id}
        </li>
      ))}
    </ol>
  );
}

describe("useThreadPermalinkScroll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom does not implement scrollIntoView.
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a no-op when targetThreadId is null", () => {
    const onResolved = vi.fn();
    const hasThread = vi.fn();
    render(
      <Harness
        hasThread={hasThread}
        mountedThreadIds={["th_1"]}
        onResolved={onResolved}
        targetThreadId={null}
        threadsReady={true}
      />
    );
    act(() => {
      vi.advanceTimersByTime(RETRY_DELAY_MS + 10);
    });
    expect(onResolved).not.toHaveBeenCalled();
    expect(hasThread).not.toHaveBeenCalled();
  });

  it("is a no-op while threadsReady is false", () => {
    const onResolved = vi.fn();
    const hasThread = vi.fn();
    render(
      <Harness
        hasThread={hasThread}
        mountedThreadIds={[]}
        onResolved={onResolved}
        targetThreadId="th_1"
        threadsReady={false}
      />
    );
    act(() => {
      vi.advanceTimersByTime(RETRY_DELAY_MS + 10);
    });
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("scrolls + applies highlight + resolves when the target card is present", () => {
    const onResolved = vi.fn();
    const hasThread = (id: string) => id === "th_1";
    const { container } = render(
      <Harness
        hasThread={hasThread}
        mountedThreadIds={["th_other", "th_1"]}
        onResolved={onResolved}
        targetThreadId="th_1"
        threadsReady={true}
      />
    );
    expect(onResolved).toHaveBeenCalledWith(PermalinkResolution.Resolved);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    const targetEl = container.querySelector<HTMLElement>(
      '[data-thread-id="th_1"]'
    );
    expect(targetEl?.dataset.permalinkHighlight).toBe("true");

    act(() => {
      vi.advanceTimersByTime(HIGHLIGHT_DURATION_MS);
    });
    expect(targetEl?.dataset.permalinkHighlight).toBeUndefined();
  });

  it("retries once after a short tick before declaring not-found", () => {
    const onResolved = vi.fn();
    const hasThread = () => false;
    render(
      <Harness
        hasThread={hasThread}
        mountedThreadIds={[]}
        onResolved={onResolved}
        targetThreadId="th_missing"
        threadsReady={true}
      />
    );
    expect(onResolved).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(RETRY_DELAY_MS + 10);
    });
    expect(onResolved).toHaveBeenCalledWith(PermalinkResolution.NotFound);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("does not re-fire on re-renders for the same targetThreadId", () => {
    const onResolved = vi.fn();
    const hasThread = (id: string) => id === "th_1";
    const { rerender } = render(
      <Harness
        hasThread={hasThread}
        mountedThreadIds={["th_1"]}
        onResolved={onResolved}
        targetThreadId="th_1"
        threadsReady={true}
      />
    );
    expect(onResolved).toHaveBeenCalledTimes(1);

    rerender(
      <Harness
        hasThread={hasThread}
        mountedThreadIds={["th_1"]}
        onResolved={onResolved}
        targetThreadId="th_1"
        threadsReady={true}
      />
    );
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("moves the highlight to the second thread when the permalink target changes", () => {
    const onResolved = vi.fn();
    const hasThread = (id: string) => id === "th_1" || id === "th_2";
    const mountedThreadIds = ["th_1", "th_2"];
    const { container, rerender } = render(
      <Harness
        hasThread={hasThread}
        mountedThreadIds={mountedThreadIds}
        onResolved={onResolved}
        targetThreadId="th_1"
        threadsReady={true}
      />
    );
    const firstEl = container.querySelector<HTMLElement>(
      '[data-thread-id="th_1"]'
    );
    expect(firstEl?.dataset.permalinkHighlight).toBe("true");

    rerender(
      <Harness
        hasThread={hasThread}
        mountedThreadIds={mountedThreadIds}
        onResolved={onResolved}
        targetThreadId="th_2"
        threadsReady={true}
      />
    );

    const secondEl = container.querySelector<HTMLElement>(
      '[data-thread-id="th_2"]'
    );
    expect(secondEl?.dataset.permalinkHighlight).toBe("true");
    expect(firstEl?.dataset.permalinkHighlight).toBeUndefined();
    expect(onResolved).toHaveBeenNthCalledWith(2, PermalinkResolution.Resolved);

    // The superseded th_1 timer must not strip th_2's highlight early.
    act(() => {
      vi.advanceTimersByTime(HIGHLIGHT_DURATION_MS - 1);
    });
    expect(secondEl?.dataset.permalinkHighlight).toBe("true");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(secondEl?.dataset.permalinkHighlight).toBeUndefined();
  });

  it("drops the first thread's highlight when the next target never resolves", () => {
    const onResolved = vi.fn();
    const hasThread = (id: string) => id === "th_1";
    const mountedThreadIds = ["th_1"];
    const { container, rerender } = render(
      <Harness
        hasThread={hasThread}
        mountedThreadIds={mountedThreadIds}
        onResolved={onResolved}
        targetThreadId="th_1"
        threadsReady={true}
      />
    );
    const firstEl = container.querySelector<HTMLElement>(
      '[data-thread-id="th_1"]'
    );
    expect(firstEl?.dataset.permalinkHighlight).toBe("true");

    rerender(
      <Harness
        hasThread={hasThread}
        mountedThreadIds={mountedThreadIds}
        onResolved={onResolved}
        targetThreadId="th_missing"
        threadsReady={true}
      />
    );
    expect(firstEl?.dataset.permalinkHighlight).toBeUndefined();

    act(() => {
      vi.advanceTimersByTime(RETRY_DELAY_MS + 10);
    });
    expect(onResolved).toHaveBeenNthCalledWith(2, PermalinkResolution.NotFound);
    expect(firstEl?.dataset.permalinkHighlight).toBeUndefined();
  });

  it("re-resolves the same thread after the permalink target is cleared", () => {
    const onResolved = vi.fn();
    const hasThread = (id: string) => id === "th_1";
    const mountedThreadIds = ["th_1"];
    const { container, rerender } = render(
      <Harness
        hasThread={hasThread}
        mountedThreadIds={mountedThreadIds}
        onResolved={onResolved}
        targetThreadId="th_1"
        threadsReady={true}
      />
    );
    const targetEl = container.querySelector<HTMLElement>(
      '[data-thread-id="th_1"]'
    );
    expect(targetEl?.dataset.permalinkHighlight).toBe("true");

    // Clearing `?thread` drops the live highlight and resolves nothing.
    rerender(
      <Harness
        hasThread={hasThread}
        mountedThreadIds={mountedThreadIds}
        onResolved={onResolved}
        targetThreadId={null}
        threadsReady={true}
      />
    );
    expect(targetEl?.dataset.permalinkHighlight).toBeUndefined();
    expect(onResolved).toHaveBeenCalledTimes(1);

    // Re-opening the same permalink must resolve again, not no-op on the
    // resolved-target guard.
    rerender(
      <Harness
        hasThread={hasThread}
        mountedThreadIds={mountedThreadIds}
        onResolved={onResolved}
        targetThreadId="th_1"
        threadsReady={true}
      />
    );
    expect(targetEl?.dataset.permalinkHighlight).toBe("true");
    expect(onResolved).toHaveBeenNthCalledWith(2, PermalinkResolution.Resolved);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(HIGHLIGHT_DURATION_MS);
    });
    expect(targetEl?.dataset.permalinkHighlight).toBeUndefined();
  });

  it("clears the pending highlight timer on unmount", () => {
    const onResolved = vi.fn();
    const hasThread = (id: string) => id === "th_1";
    const { unmount } = render(
      <Harness
        hasThread={hasThread}
        mountedThreadIds={["th_1"]}
        onResolved={onResolved}
        targetThreadId="th_1"
        threadsReady={true}
      />
    );
    expect(onResolved).toHaveBeenCalledWith(PermalinkResolution.Resolved);
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("still highlights and still fades under StrictMode's double-invoked effects", () => {
    const onResolved = vi.fn();
    const hasThread = (id: string) => id === "th_1";
    const { container } = render(
      <StrictMode>
        <Harness
          hasThread={hasThread}
          mountedThreadIds={["th_1"]}
          onResolved={onResolved}
          targetThreadId="th_1"
          threadsReady={true}
        />
      </StrictMode>
    );
    const targetEl = container.querySelector<HTMLElement>(
      '[data-thread-id="th_1"]'
    );
    expect(targetEl?.dataset.permalinkHighlight).toBe("true");
    // The double-invoke must not replay the side effects: re-arming the fade
    // is not a second resolution.
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(HIGHLIGHT_DURATION_MS);
    });
    expect(targetEl?.dataset.permalinkHighlight).toBeUndefined();
  });
});
