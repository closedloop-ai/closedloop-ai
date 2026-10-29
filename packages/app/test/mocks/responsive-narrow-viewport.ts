import { vi } from "vitest";

/** Test control for the PRD-727 viewport-width narrow-grid media query. */
export type ResponsiveNarrowViewportStub = {
  restore: () => void;
  setNarrow: (narrow: boolean) => void;
};

/** Installs controllable viewport and media-query results for narrow-grid tests. */
export function stubResponsiveNarrowViewport(
  initialNarrow: boolean
): ResponsiveNarrowViewportStub {
  const originalMatchMediaDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "matchMedia"
  );
  const originalInnerWidthDescriptor = Object.getOwnPropertyDescriptor(
    globalThis.window,
    "innerWidth"
  );
  const originalVisualViewportDescriptor = Object.getOwnPropertyDescriptor(
    globalThis.window,
    "visualViewport"
  );
  const listeners = new Set<EventListenerOrEventListenerObject>();
  let matches = initialNarrow;
  const visualViewport = Object.assign(new EventTarget(), {
    width: viewportWidth(initialNarrow),
  });
  const media: MediaQueryList = {
    addEventListener: (
      _type: string,
      listener: EventListenerOrEventListenerObject
    ) => {
      listeners.add(listener);
    },
    addListener: () => undefined,
    dispatchEvent: (event) => {
      for (const listener of listeners) {
        if (typeof listener === "function") {
          listener(event);
        } else {
          listener.handleEvent(event);
        }
      }
      return !event.defaultPrevented;
    },
    get matches() {
      return matches;
    },
    media: "(max-width: 767px)",
    onchange: null,
    removeEventListener: (
      _type: string,
      listener: EventListenerOrEventListenerObject
    ) => {
      listeners.delete(listener);
    },
    removeListener: () => undefined,
  };
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    value: vi.fn(() => media),
  });
  Object.defineProperty(globalThis.window, "innerWidth", {
    configurable: true,
    value: viewportWidth(initialNarrow),
  });
  Object.defineProperty(globalThis.window, "visualViewport", {
    configurable: true,
    value: visualViewport,
  });
  return {
    restore: () => {
      if (originalMatchMediaDescriptor) {
        Object.defineProperty(
          globalThis,
          "matchMedia",
          originalMatchMediaDescriptor
        );
      } else {
        Reflect.deleteProperty(globalThis, "matchMedia");
      }
      restoreProperty(
        globalThis.window,
        "innerWidth",
        originalInnerWidthDescriptor
      );
      restoreProperty(
        globalThis.window,
        "visualViewport",
        originalVisualViewportDescriptor
      );
    },
    setNarrow: (narrow) => {
      matches = narrow;
      const width = viewportWidth(narrow);
      visualViewport.width = width;
      Object.defineProperty(globalThis.window, "innerWidth", {
        configurable: true,
        value: width,
      });
      visualViewport.dispatchEvent(new Event("resize"));
      media.dispatchEvent(new Event("change"));
    },
  };
}

function viewportWidth(narrow: boolean): number {
  return narrow ? 390 : 1280;
}

function restoreProperty(
  target: Window,
  key: "innerWidth" | "visualViewport",
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }
  Reflect.deleteProperty(target, key);
}
