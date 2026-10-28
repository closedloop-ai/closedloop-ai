import type { Page } from "@playwright/test";

/** One state the startup bar showed. */
export type StartupBarFrame = {
  counter: string | null;
  exiting: boolean;
  label: string | null;
};

/** The renderer global the recorder appends frames to. */
const FRAMES_KEY = "__clStartupBarFrames";

/**
 * Record every distinct state the startup bar shows from now on: its label, its
 * counter, and whether it is sliding out.
 *
 * A MutationObserver rather than polling, so a frame shorter than a poll (the
 * banner's 300 ms exit, or a first frame replaced a moment later) is still
 * recorded. The bar is found as the progress element's nearest
 * `position: fixed` ancestor, the banner's own surface.
 */
export async function recordStartupBarFrames(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const frames: {
      counter: string | null;
      exiting: boolean;
      label: string | null;
    }[] = [];
    let previous = "";
    const record = () => {
      let surface = document.querySelector('[role="progressbar"]');
      while (surface && getComputedStyle(surface).position !== "fixed") {
        surface = surface.parentElement;
      }
      if (!surface) {
        previous = "";
        return;
      }
      const frame = {
        counter:
          surface.querySelector(".tabular-nums")?.textContent?.trim() ?? null,
        exiting: surface.hasAttribute("data-exiting"),
        label:
          surface.querySelector('[role="status"]')?.textContent?.trim() ?? null,
      };
      const serialized = JSON.stringify(frame);
      if (serialized !== previous) {
        previous = serialized;
        frames.push(frame);
      }
    };
    Reflect.set(window, key, frames);
    new MutationObserver(record).observe(document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    record();
  }, FRAMES_KEY);
}

/** The frames recorded so far, oldest first. */
export function readStartupBarFrames(page: Page): Promise<StartupBarFrame[]> {
  return page.evaluate(
    (key): StartupBarFrame[] => Reflect.get(window, key) ?? [],
    FRAMES_KEY
  );
}
