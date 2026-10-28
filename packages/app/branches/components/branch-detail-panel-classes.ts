/**
 * The Branch details reading measure, declared once because two render paths
 * need it: the tab panel of a ready branch, and the inherited Related Sessions
 * section beside the no-sessions zero-state.
 */
export const BRANCH_DETAIL_MEASURE_CLASS = "mx-auto w-full max-w-[1000px]";
/**
 * Exported for the shell adapter: the shell's own `TabsContent` supplies only
 * `flex min-h-0 flex-1 flex-col`, so the panel's scroll, padding and measure
 * width have to come from here or the Artifact tab renders with none of them.
 *
 * ISS-12308: split across two elements, not one. A single element carrying
 * both the scroll (`overflow-auto`) and the reading measure (`max-w-[1000px]
 * mx-auto`) puts the native scrollbar at the measure's edge instead of the
 * panel's — the scroller must stay full-width. Mirrors the `.sd3-scroll` /
 * `.sd3-doc` split the Sessions tab and Session Detail already use.
 */
export const BRANCH_DETAILS_PANEL_SCROLL_CLASS =
  "bq-page-scroll min-h-0 flex-1 overflow-auto";
export const BRANCH_DETAILS_PANEL_CONTENT_CLASS = `${BRANCH_DETAIL_MEASURE_CLASS} px-5 pt-4 pb-6`;
