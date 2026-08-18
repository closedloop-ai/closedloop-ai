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
 * Portable stories do NOT inherit `.storybook/preview.tsx` on their own. Every
 * story in this repo renders inside that preview's decorator stack —
 * NavigationProvider (the in-memory port), ThemeProvider, TooltipProvider, and
 * Toaster — so without these annotations any component reaching for the
 * navigation port or a tooltip context throws on mount, and the failure reads as
 * a broken component rather than a missing test harness.
 */
const annotations = setProjectAnnotations([preview]);

beforeAll(annotations.beforeAll);
