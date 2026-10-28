// jest-dom matchers, so a story's `play` function can use the same
// `expect(...).toBeVisible()` vocabulary it uses in the Storybook UI.
import "@testing-library/jest-dom/vitest";
import "../../packages/typescript-config/vitest-localstorage-setup";
// matchMedia (next-themes reads it via the preview's ThemeProvider),
// scrollIntoView + Radix pointer-capture, and ResizeObserver. Shared with
// packages/app rather than re-declared here.
import "../../packages/typescript-config/vitest-jsdom-setup";
// ISS-9661: drain the work a file's final unmount defers, so it runs here
// rather than against a torn-down jsdom.
import "../../packages/typescript-config/vitest-teardown-drain";
import { setProjectAnnotations } from "@storybook/react";
import { render } from "@testing-library/react";
import { beforeAll } from "vitest";
import preview from "./.storybook/preview";

/**
 * Portable stories do NOT inherit `.storybook/preview.tsx` on their own. Every
 * story in this repo renders inside that preview's decorator stack —
 * NavigationProvider (the in-memory port), ThemeProvider, TooltipProvider, and
 * Toaster — so without these annotations any component reaching for the
 * navigation port or a tooltip context throws on mount, and the failure reads as
 * a broken component rather than a missing test harness.
 *
 * `testingLibraryRender` (ISS-9661) is what makes a portable story's React root
 * get UNMOUNTED. Without it Storybook renders through its own `react-dom-shim`,
 * which creates a root per `run()` and unmounts none of them — `runStory`'s
 * cleanup only detaches the container. Every suite in `__tests__/` therefore
 * ended with one live root still holding queued scheduler work, which fires from
 * `Immediate.performWorkUntilDeadline` after Vitest tears the jsdom down and is
 * booked as an unhandled error: the job exits 1 with every test green. Handing
 * Storybook `@testing-library/react`'s `render` routes the mount through RTL,
 * whose auto-cleanup unmounts through React.
 *
 * That is also why NO suite here hand-rolls a `cleanup()` that strips
 * `document.body`. Removing nodes React still owns is what produced the
 * "NotFoundError: node to be removed is not a child" cascades those helpers were
 * written to dodge, and with a real unmount in place they are the bug, not the
 * guard. Let RTL do it.
 */
const annotations = setProjectAnnotations([
  preview,
  { testingLibraryRender: render },
]);

beforeAll(annotations.beforeAll);
