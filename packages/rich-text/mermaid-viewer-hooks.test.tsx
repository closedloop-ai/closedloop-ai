// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreOwnProperty } from "./__tests__/dom-property";
import {
  useContainerSize,
  useFullscreen,
  useLatestRef,
  useSvgMeasurements,
  useVisibleRegion,
} from "./mermaid-viewer-hooks";

const mocks = vi.hoisted(() => ({
  fitNodeLabels: vi.fn(),
}));

vi.mock("./mermaid-viewer-utils", () => ({
  fitNodeLabels: mocks.fitNodeLabels,
}));

const mutationCallbacks: MutationCallback[] = [];
const resizeCallbacks: ResizeObserverCallback[] = [];
const resizeObservers: TestResizeObserver[] = [];

class TestMutationObserver {
  callback: MutationCallback;
  disconnect = vi.fn();
  observe = vi.fn();

  constructor(callback: MutationCallback) {
    this.callback = callback;
    mutationCallbacks.push(callback);
  }
}

class TestResizeObserver {
  callback: ResizeObserverCallback;
  disconnect = vi.fn();
  observe = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeCallbacks.push(callback);
    resizeObservers.push(this);
  }
}

beforeEach(() => {
  mocks.fitNodeLabels.mockReset();
  mutationCallbacks.length = 0;
  resizeCallbacks.length = 0;
  resizeObservers.length = 0;
  vi.stubGlobal("MutationObserver", TestMutationObserver);
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreOwnProperty(
    document,
    "exitFullscreen",
    originalExitFullscreenDescriptor
  );
  restoreOwnProperty(
    document,
    "fullscreenElement",
    originalFullscreenElementDescriptor
  );
});

describe("useContainerSize", () => {
  it("keeps zero size without a target", () => {
    const ref = asRef<HTMLElement | null>(null);
    const { result } = renderHook(() => useContainerSize(ref));

    expect(result.current).toEqual({ height: 0, width: 0 });
    expect(resizeCallbacks).toHaveLength(0);
  });

  it("tracks resize changes and disconnects its observer", () => {
    let width = 320;
    let height = 180;
    const target = document.createElement("div");
    vi.spyOn(target, "clientWidth", "get").mockImplementation(() => width);
    vi.spyOn(target, "clientHeight", "get").mockImplementation(() => height);
    const ref = asRef<HTMLElement | null>(target);

    const { result, unmount } = renderHook(() => useContainerSize(ref));
    expect(result.current).toEqual({ height: 180, width: 320 });
    expect(resizeObservers[0]?.observe).toHaveBeenCalledWith(target);

    width = 640;
    height = 360;
    act(() => resizeCallbacks[0]?.([], {} as ResizeObserver));
    expect(result.current).toEqual({ height: 360, width: 640 });

    unmount();
    expect(resizeObservers[0]?.disconnect).toHaveBeenCalledOnce();
  });
});

describe("useFullscreen", () => {
  it("requests and exits only its own fullscreen element", () => {
    const wrapper = document.createElement("div");
    const requestFullscreen = vi.fn();
    const exitFullscreen = vi.fn();
    Object.defineProperty(wrapper, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: exitFullscreen,
    });
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement,
    });

    const wrapperRef = asRef<HTMLElement | null>(wrapper);
    const { result } = renderHook(() => useFullscreen(wrapperRef));
    act(() => result.current.toggle());
    expect(requestFullscreen).toHaveBeenCalledOnce();

    fullscreenElement = wrapper;
    act(() => document.dispatchEvent(new Event("fullscreenchange")));
    expect(result.current.isFullscreen).toBe(true);
    act(() => result.current.toggle());
    expect(exitFullscreen).toHaveBeenCalledOnce();

    fullscreenElement = document.createElement("div");
    act(() => document.dispatchEvent(new Event("fullscreenchange")));
    expect(result.current.isFullscreen).toBe(false);
  });

  it("does nothing when requesting fullscreen without a wrapper", () => {
    const wrapperRef = asRef<HTMLElement | null>(null);
    const { result } = renderHook(() => useFullscreen(wrapperRef));
    expect(() => result.current.toggle()).not.toThrow();
  });
});

describe("useSvgMeasurements", () => {
  it("ignores missing targets and targets without an SVG", () => {
    const scaleRef = asRef(1);
    const missingRef = asRef<HTMLDivElement | null>(null);
    const { result, unmount } = renderHook(() =>
      useSvgMeasurements(missingRef, scaleRef)
    );
    expect(result.current).toEqual({ contentBBox: null, naturalSize: null });
    unmount();

    const emptyRef = asRef<HTMLDivElement | null>(
      document.createElement("div")
    );
    const empty = renderHook(() => useSvgMeasurements(emptyRef, scaleRef));
    expect(empty.result.current).toEqual({
      contentBBox: null,
      naturalSize: null,
    });
  });

  it("measures scaled SVG size and content bounds without noisy updates", () => {
    const target = document.createElement("div");
    target.innerHTML = '<svg viewBox="0 0 100 50"></svg>';
    const svg = target.querySelector("svg");
    if (!(svg instanceof SVGSVGElement)) {
      throw new Error("test SVG was not created");
    }
    let rect = { height: 100, width: 200 };
    let bbox = { height: 40, width: 90, x: 5, y: 6 };
    vi.spyOn(svg, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          ...rect,
          bottom: rect.height,
          left: 0,
          right: rect.width,
          toJSON: () => ({}),
          top: 0,
          x: 0,
          y: 0,
        }) as DOMRect
    );
    Object.defineProperty(svg, "getBBox", {
      configurable: true,
      value: () => bbox,
    });

    const contentRef = asRef<HTMLDivElement | null>(target);
    const scaleRef = asRef(2);
    const { result } = renderHook(() =>
      useSvgMeasurements(contentRef, scaleRef)
    );
    expect(result.current.naturalSize).toEqual({ height: 50, width: 100 });
    expect(result.current.contentBBox).toEqual(bbox);
    expect(mocks.fitNodeLabels).toHaveBeenCalledWith(target);

    act(() => mutationCallbacks[0]?.([], {} as MutationObserver));
    expect(result.current.naturalSize).toEqual({ height: 50, width: 100 });

    rect = { height: 120, width: 240 };
    bbox = { height: 45, width: 95, x: 8, y: 9 };
    act(() => mutationCallbacks[0]?.([], {} as MutationObserver));
    expect(result.current.naturalSize).toEqual({ height: 60, width: 120 });
    expect(result.current.contentBBox).toEqual(bbox);
  });

  it("uses an unscaled fallback and tolerates empty or throwing geometry", () => {
    const target = document.createElement("div");
    target.innerHTML = "<svg></svg>";
    const svg = target.querySelector("svg");
    if (!(svg instanceof SVGSVGElement)) {
      throw new Error("test SVG was not created");
    }
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      toJSON: () => ({}),
      top: 0,
      width: 0,
      x: 0,
      y: 0,
    });
    Object.defineProperty(svg, "getBBox", {
      configurable: true,
      value: vi.fn(() => ({ height: 0, width: 0, x: 0, y: 0 })),
    });

    const contentRef = asRef<HTMLDivElement | null>(target);
    const scaleRef = asRef(0);
    const { result } = renderHook(() =>
      useSvgMeasurements(contentRef, scaleRef)
    );
    expect(result.current).toEqual({ contentBBox: null, naturalSize: null });

    Object.defineProperty(svg, "getBBox", {
      configurable: true,
      value: () => {
        throw new Error("detached");
      },
    });
    act(() => mutationCallbacks[0]?.([], {} as MutationObserver));
    expect(result.current).toEqual({ contentBBox: null, naturalSize: null });
  });
});

describe("useVisibleRegion", () => {
  it("returns null for each unavailable DOM boundary", () => {
    const container = document.createElement("div");
    const content = document.createElement("div");
    const containerRef = asRef<HTMLElement | null>(null);
    const contentRef = asRef<HTMLElement | null>(null);
    const { result, rerender } = renderHook(
      ({ trigger }) =>
        useVisibleRegion({
          containerRef,
          contentRef,
          trigger,
        }),
      {
        initialProps: { trigger: 0 },
      }
    );
    expect(result.current).toBeNull();

    containerRef.current = container;
    contentRef.current = content;
    rerender({ trigger: 1 });
    expect(result.current).toBeNull();

    content.innerHTML = "<svg></svg>";
    const svg = content.querySelector("svg");
    if (!(svg instanceof SVGSVGElement)) {
      throw new Error("test SVG was not created");
    }
    Object.defineProperty(svg, "getScreenCTM", {
      configurable: true,
      value: () => null,
    });
    rerender({ trigger: 2 });
    expect(result.current).toBeNull();
  });

  it("maps the container corners through the SVG inverse matrix", () => {
    const container = document.createElement("div");
    const content = document.createElement("div");
    content.innerHTML = "<svg></svg>";
    const svg = content.querySelector("svg");
    if (!(svg instanceof SVGSVGElement)) {
      throw new Error("test SVG was not created");
    }
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      bottom: 220,
      height: 200,
      left: 10,
      right: 310,
      toJSON: () => ({}),
      top: 20,
      width: 300,
      x: 10,
      y: 20,
    });
    const inverse = { name: "inverse" };
    const transformedMatrices: unknown[] = [];
    Object.defineProperty(svg, "getScreenCTM", {
      configurable: true,
      value: () => ({ inverse: () => inverse }),
    });
    vi.stubGlobal(
      "DOMPoint",
      class {
        x: number;
        y: number;

        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }

        matrixTransform(matrix: unknown) {
          transformedMatrices.push(matrix);
          return { x: this.x / 2, y: this.y / 2 };
        }
      }
    );
    const containerRef = asRef<HTMLElement | null>(container);
    const contentRef = asRef<HTMLElement | null>(content);

    const { result } = renderHook(() =>
      useVisibleRegion({
        containerRef,
        contentRef,
        trigger: "ready",
      })
    );

    expect(result.current).toEqual({
      height: 100,
      width: 150,
      x: 5,
      y: 10,
    });
    expect(transformedMatrices).toEqual([inverse, inverse]);
  });
});

describe("useLatestRef", () => {
  it("keeps identity while exposing the latest value", () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useLatestRef(value),
      { initialProps: { value: "first" } }
    );
    const firstRef = result.current;

    rerender({ value: "second" });

    expect(result.current).toBe(firstRef);
    expect(result.current.current).toBe("second");
  });
});

function asRef<T>(value: T): RefObject<T> {
  return { current: value };
}

const originalExitFullscreenDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "exitFullscreen"
);
const originalFullscreenElementDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "fullscreenElement"
);
