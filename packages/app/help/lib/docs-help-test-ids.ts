/**
 * Every `data-testid` the Help surface emits, in one lightweight module with no
 * React in it.
 *
 * SPLIT OUT OF THE COMPONENTS (ISS-10006): the web route's Playwright spec needs
 * these values, and importing them from the component modules pulls the design
 * system's `react-syntax-highlighter` directory import into the Node ESM loader,
 * which refuses it — `playwright --list` then reports the whole suite as zero
 * tests. The same reason `docs-help-labels.ts` next door is a separate module
 * from the components that render its strings.
 *
 * Each id marks ONE state, so an absence assertion written against it cannot
 * also be satisfied by a blanked gate, a 404 shell or an error boundary.
 */

/**
 * The surface's own root. Asserting INSIDE it is what separates "the shared
 * surface rendered" from "the shell still renders its own copy" — the two emit
 * the same nav rows and the same reader, so a locator that does not require this
 * ancestor passes identically against the superseded body.
 */
export const HELP_SURFACE_V2_TEST_ID = "help-surface-v2";

/** Only the corpus-unavailable branch emits it. */
export const HELP_SURFACE_V2_UNAVAILABLE_TEST_ID =
  "help-surface-v2-unavailable";

/** Only the incomplete-index branch emits it. */
export const HELP_SURFACE_V2_NAV_INCOMPLETE_TEST_ID =
  "help-surface-v2-nav-incomplete";

/** Only the failed-search branch emits it. */
export const HELP_SURFACE_V2_SEARCH_FAILED_TEST_ID =
  "help-surface-v2-search-failed";
