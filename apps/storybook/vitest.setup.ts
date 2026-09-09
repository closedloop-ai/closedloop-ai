// jest-dom matchers, so a story's `play` function can use the same
// `expect(...).toBeVisible()` vocabulary it uses in the Storybook UI.
import "@testing-library/jest-dom/vitest";
import "../../packages/typescript-config/vitest-localstorage-setup";
// matchMedia (next-themes reads it via the preview's ThemeProvider),
// scrollIntoView + Radix pointer-capture, and ResizeObserver. Shared with
// packages/app rather than re-declared here.
import "../../packages/typescript-config/vitest-jsdom-setup";
import { setProjectAnnotations } from "@storybook/react";
import { beforeAll } from "vitest";
import preview from "./.storybook/preview";

/**
 * jsdom does not implement IntersectionObserver, and the Catalog page uses it to
 * hold several hundred preview iframes unmounted until they scroll near. Without
 * a stub that page throws on mount, which is what it did the first time the
 * sweep ever got far enough to reach it.
 *
 * Deliberately a stub that never fires rather than one that reports everything
 * visible: the sweep asserts the page mounts, and a stub that claimed every card
 * was on screen would mount every preview iframe at once, which is the exact
 * thing the real observer exists to avoid. Scoped to this app rather than the
 * shared jsdom setup, since only this suite needs it.
 */
if (!globalThis.window.IntersectionObserver) {
  Object.defineProperty(globalThis.window, "IntersectionObserver", {
    configurable: true,
    value: class {
      readonly root = null;
      readonly rootMargin = "";
      readonly thresholds: readonly number[] = [];
      disconnect() {
        return;
      }
      observe() {
        return;
      }
      takeRecords() {
        return [];
      }
      unobserve() {
        return;
      }
    },
    writable: true,
  });
}

/**
 * Portable stories do NOT inherit `.storybook/preview.tsx` on their own. Every
 * story in this repo renders inside that preview's decorator stack —
 * NavigationProvider (the in-memory port), ThemeProvider, TooltipProvider, and
 * Toaster — so without these annotations any component reaching for the
 * navigation port or a tooltip context throws on mount, and the failure reads as
 * a broken component rather than a missing test harness.
 */
const annotations = setProjectAnnotations([preview]);

beforeAll(annotations.beforeAll);
