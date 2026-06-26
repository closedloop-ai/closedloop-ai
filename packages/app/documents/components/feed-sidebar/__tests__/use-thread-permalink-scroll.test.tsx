// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadPermalinkScroll } from "../use-thread-permalink-scroll";

const RETRY_DELAY_MS = 250;

type HarnessProps = {
  targetThreadId: string | null;
  threadsReady: boolean;
  hasThread: (id: string) => boolean;
  onResolved: (resolution: "resolved" | "not-found") => void;
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
    expect(onResolved).toHaveBeenCalledWith("resolved");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    const targetEl = container.querySelector<HTMLElement>(
      '[data-thread-id="th_1"]'
    );
    expect(targetEl?.dataset.permalinkHighlight).toBe("true");

    act(() => {
      vi.advanceTimersByTime(1600);
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
    expect(onResolved).toHaveBeenCalledWith("not-found");
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
});
