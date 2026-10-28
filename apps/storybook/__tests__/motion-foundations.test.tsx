/**
 * Behavior tests for the Foundations/Motion page
 * (`stories/foundations/motion.stories.tsx`): the replay control, the
 * accordion pair, the scroll-into-view replay and the reduced-motion readout.
 * The story sweep mounts the page once and touches nothing, so each of these
 * was reachable only from here. jsdom has no `IntersectionObserver` and a
 * non-matching `matchMedia` stub; both are installed per case and restored.
 */
import { composeStory } from "@storybook/react";
import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "storybook/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import motionMeta, {
  Default as defaultStory,
} from "../stories/foundations/motion.stories";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const TRAVELLED = "translateX(16rem)";
const HOME = "translateX(0)";

type ObserverCallback = (entries: IntersectionObserverEntry[]) => void;

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

/** Installs a fake observer that records every callback it is given. */
function stubIntersectionObserver() {
  const callbacks: ObserverCallback[] = [];
  const observed: Element[] = [];
  const active = new Set<FakeIntersectionObserver>();
  class FakeIntersectionObserver {
    constructor(callback: ObserverCallback) {
      callbacks.push(callback);
    }
    observe(node: Element) {
      observed.push(node);
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
  return { callbacks, observed, active };
}

/**
 * The travelling squares — every demo square is positioned by an inline
 * `translateX` transform, which is the value under test, so that is what
 * selects them rather than a styling class.
 */
function squares() {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[style*="translateX"]')
  );
}

/** Lets the replay's two nested animation frames run inside React's act. */
async function flushFrames() {
  await act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
}

function transforms() {
  return squares().map((node) => node.style.transform);
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

describe("Foundations/Motion", () => {
  it("starts every demo square at home and moves it to the far edge on Replay", async () => {
    await composeStory(defaultStory, motionMeta).run();
    expect(squares().length).toBeGreaterThan(0);
    expect(new Set(transforms())).toEqual(new Set([HOME]));

    for (const button of screen.getAllByRole("button", { name: "Replay" })) {
      await userEvent.click(button);
    }
    await flushFrames();

    expect(new Set(transforms())).toEqual(new Set([TRAVELLED]));
    // A second replay snaps home first (transition suppressed), then travels.
    for (const button of screen.getAllByRole("button", { name: "Replay" })) {
      await userEvent.click(button);
    }
    await flushFrames();
    expect(new Set(transforms())).toEqual(new Set([TRAVELLED]));
    expect(
      squares().some((node) => node.className.includes("!duration-0"))
    ).toBe(false);
  });

  it("the accordion pair opens on the first press, then closes, keeping the running keyframe", async () => {
    await composeStory(defaultStory, motionMeta).run();
    const expand = screen.getByRole("button", { name: "Expand" });
    // The one `data-state` carrier pinned shut by an inline height before
    // its first press is the accordion panel.
    const panel = Array.from(
      document.querySelectorAll<HTMLElement>("[data-state]")
    ).find((node) => node.style.height === "0px");
    if (!panel) {
      throw new Error("accordion panel did not render");
    }
    expect(panel).toHaveAttribute("data-state", "closed");

    await userEvent.click(expand);

    expect(screen.getByRole("button", { name: "Collapse" })).toBeVisible();
    expect(panel).toHaveAttribute("data-state", "open");
    expect(panel.className).toContain("animate-accordion-down");
    expect(panel.style.height).toBe("");

    await userEvent.click(screen.getByRole("button", { name: "Collapse" }));

    expect(screen.getByRole("button", { name: "Expand" })).toBeVisible();
    expect(panel).toHaveAttribute("data-state", "closed");
    expect(panel.className).toContain("animate-accordion-up");
  });

  it("replays a demo when it scrolls into view", async () => {
    const { callbacks, observed, active } = stubIntersectionObserver();
    await composeStory(defaultStory, motionMeta).run();
    expect(observed.length).toBeGreaterThan(0);
    expect(active.size).toBe(observed.length);
    expect(new Set(transforms())).toEqual(new Set([HOME]));

    act(() => {
      for (const callback of callbacks) {
        callback([{ isIntersecting: false } as IntersectionObserverEntry]);
      }
    });
    await flushFrames();
    expect(new Set(transforms())).toEqual(new Set([HOME]));

    act(() => {
      for (const callback of callbacks) {
        callback([{ isIntersecting: true } as IntersectionObserverEntry]);
      }
    });
    await flushFrames();
    expect(
      transforms().filter((value) => value === TRAVELLED).length
    ).toBeGreaterThan(0);
  });

  it("reports the reduced-motion preference and disconnects the view observers for it", async () => {
    stubMatchMedia((query) => query === REDUCED_MOTION_QUERY);
    const { active } = stubIntersectionObserver();
    await composeStory(defaultStory, motionMeta).run();

    expect(await screen.findByText("reduce motion")).toBeVisible();
    // The preference is read in an effect, so the first pass observes and the
    // reduced pass tears every observer down again.
    await waitFor(() => expect(active.size).toBe(0));
  });

  it("reports allowed motion under the default non-matching media query", async () => {
    await composeStory(defaultStory, motionMeta).run();
    expect(await screen.findByText("allow motion")).toBeVisible();
  });
});
