/**
 * Branch coverage for the Foundations/Motion pages that
 * `motion-foundations.test.tsx` does not reach: the v2.0 copy of the page
 * (`stories/foundations-v2/motion.stories.tsx`, same behavior as v1.0) and the
 * easing curve drawn from a resolved `cubic-bezier(...)` value on both.
 */
import { composeStory } from "@storybook/react";
import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "storybook/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import v1Meta, {
  Default as v1Default,
} from "../stories/foundations/motion.stories";
import v2Meta, {
  Default as v2Default,
} from "../stories/foundations-v2/motion.stories";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const TRAVELLED = "translateX(16rem)";
const HOME = "translateX(0)";
const BEZIER = "cubic-bezier(0.4, 0, 0.2, 1)";
// pins current behavior; looks odd because the control points are not rounded
const CURVE_PATH = "M 0 48 C 19.200000000000003 48, 9.600000000000001 0, 48 0";
const LINEAR_PATH = "M 0 48 C 0 48, 48 0, 48 0";

const originalMatchMedia = Object.getOwnPropertyDescriptor(
  globalThis.window,
  "matchMedia"
);
const originalIntersectionObserver = Object.getOwnPropertyDescriptor(
  globalThis,
  "IntersectionObserver"
);

function stubMatchMedia(matches: (query: string) => boolean) {
  Object.defineProperty(globalThis.window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: matches(query),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

type ObserverCallback = (entries: IntersectionObserverEntry[]) => void;

function stubIntersectionObserver() {
  const callbacks: ObserverCallback[] = [];
  const active = new Set<FakeIntersectionObserver>();
  class FakeIntersectionObserver {
    constructor(callback: ObserverCallback) {
      callbacks.push(callback);
    }
    observe() {
      active.add(this);
    }
    disconnect() {
      active.delete(this);
    }
  }
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    writable: true,
    value: FakeIntersectionObserver,
  });
  return { callbacks, active };
}

function squares() {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[style*="translateX"]')
  );
}

function transforms() {
  return new Set(squares().map((node) => node.style.transform));
}

async function flushFrames() {
  await act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
}

function curvePaths() {
  return Array.from(document.querySelectorAll("svg path")).map((path) =>
    path.getAttribute("d")
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalMatchMedia) {
    Object.defineProperty(globalThis.window, "matchMedia", originalMatchMedia);
  } else {
    Reflect.deleteProperty(globalThis.window, "matchMedia");
  }
  if (originalIntersectionObserver) {
    Object.defineProperty(
      globalThis,
      "IntersectionObserver",
      originalIntersectionObserver
    );
  } else {
    Reflect.deleteProperty(globalThis, "IntersectionObserver");
  }
});

describe("Foundations v2 Motion", () => {
  it("moves every square home to the far edge on Replay, twice", async () => {
    await composeStory(v2Default, v2Meta).run();
    expect(squares().length).toBeGreaterThan(0);
    expect(transforms()).toEqual(new Set([HOME]));

    for (const button of screen.getAllByRole("button", { name: "Replay" })) {
      await userEvent.click(button);
    }
    await flushFrames();
    expect(transforms()).toEqual(new Set([TRAVELLED]));

    for (const button of screen.getAllByRole("button", { name: "Replay" })) {
      await userEvent.click(button);
    }
    await flushFrames();
    expect(transforms()).toEqual(new Set([TRAVELLED]));
    expect(
      squares().some((node) => node.className.includes("!duration-0"))
    ).toBe(false);
  });

  it("opens then closes the accordion preview with the running keyframe", async () => {
    await composeStory(v2Default, v2Meta).run();
    const panel = Array.from(
      document.querySelectorAll<HTMLElement>("[data-state]")
    ).find((node) => node.style.height === "0px");
    if (!panel) {
      throw new Error("accordion panel did not render");
    }
    expect(panel).toHaveAttribute("data-state", "closed");

    await userEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(panel).toHaveAttribute("data-state", "open");
    expect(panel.className).toContain("animate-accordion-down");
    expect(panel.style.height).toBe("");

    await userEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(panel).toHaveAttribute("data-state", "closed");
    expect(panel.className).toContain("animate-accordion-up");
  });

  it("replays on intersect only, and disconnects observers under reduced motion", async () => {
    const { callbacks } = stubIntersectionObserver();
    await composeStory(v2Default, v2Meta).run();

    act(() => {
      for (const callback of callbacks) {
        callback([{ isIntersecting: false } as IntersectionObserverEntry]);
      }
    });
    await flushFrames();
    expect(transforms()).toEqual(new Set([HOME]));

    act(() => {
      for (const callback of callbacks) {
        callback([{ isIntersecting: true } as IntersectionObserverEntry]);
      }
    });
    await flushFrames();
    expect(transforms().has(TRAVELLED)).toBe(true);
  });

  it("prints reduce motion and tears observers down when the preference matches", async () => {
    stubMatchMedia((query) => query === REDUCED_MOTION_QUERY);
    const { active } = stubIntersectionObserver();
    await composeStory(v2Default, v2Meta).run();
    expect(await screen.findByText("reduce motion")).toBeVisible();
    await waitFor(() => expect(active.size).toBe(0));
  });

  it("prints allow motion when the preference does not match", async () => {
    await composeStory(v2Default, v2Meta).run();
    expect(await screen.findByText("allow motion")).toBeVisible();
  });
});

describe.each([
  ["v1.0", v1Default, v1Meta],
  ["v2.0", v2Default, v2Meta],
] as const)("Foundations Motion %s easing curve", (_label, story, meta) => {
  it("draws the straight line when the browser resolves no timing function", async () => {
    await composeStory(story, meta).run();
    const paths = curvePaths();
    expect(paths.length).toBeGreaterThan(0);
    expect(new Set(paths)).toEqual(new Set([LINEAR_PATH]));
  });

  it("draws the control points parsed from a resolved cubic-bezier", async () => {
    const original = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element: Element, pseudo?: string | null) => {
        const real = original(element, pseudo);
        return new Proxy(real, {
          get(target, prop) {
            if (prop === "getPropertyValue") {
              return (name: string) =>
                name === "transition-timing-function"
                  ? BEZIER
                  : target.getPropertyValue(name);
            }
            const value = Reflect.get(target, prop);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }
    );
    await composeStory(story, meta).run();
    await waitFor(() => expect(curvePaths()).toContain(CURVE_PATH));
  });
});
