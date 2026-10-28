import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTrace } from "../session-trace";
import {
  buildTestSessionDetail,
  buildTurn,
} from "./support/session-detail-builders";

type ObserverRecord = {
  callback: IntersectionObserverCallback;
  disconnected: boolean;
  instance: IntersectionObserver;
  observed: Element[];
  options: IntersectionObserverInit | undefined;
};

const observers: ObserverRecord[] = [];

class FakeIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly scrollMargin = "";
  readonly thresholds: readonly number[] = [];
  private readonly record: ObserverRecord;

  constructor(
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit
  ) {
    this.record = {
      callback,
      disconnected: false,
      instance: this,
      observed: [],
      options,
    };
    observers.push(this.record);
  }

  disconnect() {
    this.record.disconnected = true;
  }

  observe(target: Element) {
    this.record.observed.push(target);
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  unobserve() {
    // Not exercised by SessionTrace.
  }
}

const detail = buildTestSessionDetail({
  trace: [
    buildTurn({ id: "a" }),
    buildTurn({ id: "idle", kind: "idle" }),
    buildTurn({ id: "c", row: 7 }),
  ],
});

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ScrollRoot({ children }: { children: ReactNode }) {
  return <div data-session-detail-scroll>{children}</div>;
}

function rowElement(row: number): Element {
  const element = document.querySelector(`[data-trace-row="${row}"]`);
  if (!element) {
    throw new Error(`row ${row} missing`);
  }
  return element;
}

function entry(
  target: Element,
  isIntersecting: boolean,
  top: number
): IntersectionObserverEntry {
  const rect = DOMRect.fromRect({ height: 10, width: 10, x: 0, y: top });
  return {
    boundingClientRect: rect,
    intersectionRatio: isIntersecting ? 1 : 0,
    intersectionRect: rect,
    isIntersecting,
    rootBounds: null,
    target,
    time: 0,
  };
}

function renderObserved(observeActiveTraceRow?: boolean) {
  const onActiveTraceRowChange = vi.fn();
  const view = render(
    <SessionTrace
      activeTraceRow={0}
      detail={detail}
      observeActiveTraceRow={observeActiveTraceRow}
      onActiveTraceRowChange={onActiveTraceRowChange}
    />,
    { wrapper: ScrollRoot }
  );
  return { ...view, onActiveTraceRowChange };
}

describe("SessionTrace active-row observation", () => {
  it("observes every row against the detail scroll container", () => {
    const { container } = renderObserved();

    expect(observers).toHaveLength(1);
    const [observer] = observers;
    expect(observer?.options).toEqual({
      root: container.querySelector("[data-session-detail-scroll]"),
      rootMargin: "-180px 0px -55% 0px",
      threshold: 0.1,
    });
    expect(
      observer?.observed.map((node) => node.getAttribute("data-trace-row"))
    ).toEqual(["0", "1", "7"]);
  });

  it("reports the topmost intersecting row and drops rows that leave", () => {
    const { onActiveTraceRowChange } = renderObserved();
    const [observer] = observers;
    if (!observer) {
      throw new Error("observer missing");
    }
    const notify = (entries: IntersectionObserverEntry[]) =>
      observer.callback(entries, observer.instance);

    notify([
      entry(rowElement(1), true, 50),
      entry(rowElement(7), true, 20),
      entry(rowElement(0), false, 5),
    ]);
    notify([entry(rowElement(7), false, 20)]);
    notify([entry(rowElement(1), false, 50)]);

    expect(onActiveTraceRowChange.mock.calls).toEqual([[7], [1]]);
  });

  it("disconnects on unmount", () => {
    const { unmount } = renderObserved();

    unmount();

    expect(observers[0]?.disconnected).toBe(true);
  });

  it("does not observe when observation is turned off", () => {
    renderObserved(false);

    expect(observers).toHaveLength(0);
  });

  it("does not observe outside a detail scroll container", () => {
    render(
      <SessionTrace
        activeTraceRow={0}
        detail={detail}
        onActiveTraceRowChange={vi.fn()}
      />
    );

    expect(observers).toHaveLength(0);
  });
});
