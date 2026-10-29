import { afterEach, describe, expect, it, vi } from "vitest";
import { stubResizableContainerWidthPx } from "../../typescript-config/vitest-container-width-stub";

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

function observedTargets(
  callback: ReturnType<typeof vi.fn<ResizeObserverCallback>>
): Element[] {
  return callback.mock.calls.map(([entries]) => entries[0]?.target as Element);
}

describe("vitest-container-width-stub (ISS-12047)", () => {
  it("reports only the newly observed target on observe", () => {
    const stub = stubResizableContainerWidthPx(640);
    restore = stub.restore;
    const callback = vi.fn<ResizeObserverCallback>();
    const observer = new ResizeObserver(callback);
    const targets = [
      document.createElement("div"),
      document.createElement("div"),
      document.createElement("div"),
    ];

    for (const target of targets) {
      observer.observe(target);
    }

    expect(observedTargets(callback)).toEqual(targets);
  });

  it("still re-reports every observed target when the width changes", () => {
    const stub = stubResizableContainerWidthPx(640);
    restore = stub.restore;
    const callback = vi.fn<ResizeObserverCallback>();
    const observer = new ResizeObserver(callback);
    const targets = [
      document.createElement("div"),
      document.createElement("div"),
    ];
    for (const target of targets) {
      observer.observe(target);
    }
    callback.mockClear();

    stub.setWidth(320);

    expect(observedTargets(callback)).toEqual(targets);
    expect(
      callback.mock.calls.map(([entries]) => entries[0]?.contentRect.width)
    ).toEqual([320, 320]);
  });
});
