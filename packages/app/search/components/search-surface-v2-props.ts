import type {
  SearchSurfaceReadState,
  SearchSurfaceResult,
} from "../lib/search-surface-model";

/**
 * ISS-9414 — what a shell hands `SearchSurfaceV2`, and nothing else.
 *
 * Every entry here is a {@link HostBoundarySeam}: the bytes (`read`,
 * `results`), the recovery the host's transport can perform (`onRetry`), and
 * the shape of the shell the surface is mounted in (`mode`). Ordering, labels,
 * destinations, the state ladder and the row body are the surface's, so a host
 * has nothing left to compose beside it.
 */

/** Which shell shape the surface is rendering into. */
export const SearchSurfaceModeKind = {
  /** A full route body with room for an on-ramp and multi-line rows. */
  Page: "page",
  /** A command-palette list inside the shell's own dialog. */
  Overlay: "overlay",
} as const;
export type SearchSurfaceModeKind =
  (typeof SearchSurfaceModeKind)[keyof typeof SearchSurfaceModeKind];

/**
 * The mode, WITH the shell-shaped values that mode alone implies.
 *
 * A discriminated union rather than a `mode` string beside two optional props,
 * because the Desktop overlay's group heading and the Web page's example runner
 * are each meaningless in the other shell and mandatory in their own. As
 * optional props, either could be dropped in silence and the surface would
 * render a headingless palette or a dead on-ramp — the omitted-optional-prop
 * defect ISS-9216 names. Here `tsc` refuses both.
 */
export type SearchSurfaceMode =
  | {
      readonly kind: typeof SearchSurfaceModeKind.Page;
      /**
       * Runs one of the on-ramp's example queries. The on-ramp is the page's
       * {@link SearchSurfaceState.NotRun} body, so the host that owns the query
       * string owns committing the example into it.
       */
      readonly onRunExample: (query: string) => void;
    }
  | {
      readonly kind: typeof SearchSurfaceModeKind.Overlay;
      /**
       * Names the result group in the palette, e.g. "Docs". The shell's corpus
       * decides the word, so the shell supplies it; the surface decides that a
       * palette has a named group at all.
       */
      readonly groupHeading: string;
      /**
       * The palette's own empty-query prompt, e.g. "Type to search the
       * documentation." A page lands a designed on-ramp here and an overlay has
       * one line, so the two are not the same string with a different width.
       */
      readonly notRunPrompt: string;
    };

export type SearchSurfaceV2Props = {
  readonly mode: SearchSurfaceMode;
  /**
   * The query behind this render, echoed in the no-results copy so a reader
   * sees WHICH question came back empty.
   */
  readonly query: string;
  /** Whether the query ran, is running, failed, and how much it returned. */
  readonly read: SearchSurfaceReadState;
  /** Ranked rows, rendered in exactly this order on every host. */
  readonly results: readonly SearchSurfaceResult[];
  /**
   * Re-issues the failed read. Required, not optional: `UnifiedSearchResults`
   * made the retry affordance appear only when a host wired one, so an
   * unavailable state rendered with a way out on `/search` and without one in
   * the mobile sheet — the same state telling two stories. Every host has a
   * query it can run again.
   */
  readonly onRetry: () => void;
  /**
   * Called when a row is activated, on top of the row's own navigation. An
   * overlay host dismisses itself here so activating a hit whose destination is
   * already current still closes the palette; a page host has no container to
   * dismiss and passes nothing.
   */
  readonly onActivateResult?: (result: SearchSurfaceResult) => void;
};
