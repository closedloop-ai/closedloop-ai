import type {
  DocsHelpNavGroup,
  DocsHelpPage,
  DocsHelpSearchHit,
} from "./docs-help-payload";

/**
 * ISS-10005 — what a host's docs TRANSPORT can say, and what the surface may ask
 * it for. The bridge never crosses this seam.
 */

/** Collapsing these renders a failed bundle read as a docs set with no pages. */
export const DocsHelpBundleStatus = {
  Loading: "loading",
  Unavailable: "unavailable",
  Ready: "ready",
} as const;
export type DocsHelpBundleStatus =
  (typeof DocsHelpBundleStatus)[keyof typeof DocsHelpBundleStatus];

/**
 * Per-page reader lifecycle. `Idle` is distinct from `Missing`: nothing has been
 * asked for yet, which is not the same claim as "asked, and the bundle has no
 * such page".
 *
 * ISS-10044 — `Error` is distinct from BOTH. `Missing` is a claim about what the
 * snapshot CONTAINS, and a request that never returned supports no such claim:
 * collapsing the two sends a reader looking online for a page that is sitting in
 * the bundle they already have.
 */
export type DocsHelpPageState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "found"; readonly page: DocsHelpPage }
  | { readonly kind: "missing" }
  | { readonly kind: "error" };

export type DocsHelpSource = {
  readonly bundleStatus: DocsHelpBundleStatus;
  /** The `meta.json` nav tree as the host read it, believed by nobody. */
  readonly navGroups: readonly DocsHelpNavGroup[];
  readonly selectedPath: string | null;
  readonly page: DocsHelpPageState;
  /** Open a page, optionally scrolled to a heading anchor once it renders. */
  readonly selectPage: (path: string, headingSlug?: string) => void;
  /** The anchor owed to the CURRENT page, or null. Consumed once. */
  readonly pendingHeadingSlug: string | null;
  readonly onHeadingHandled: () => void;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly searchHits: readonly DocsHelpSearchHit[];
  readonly isSearching: boolean;
  /**
   * ISS-10044 — the search itself did not come back. The reader's counterpart to
   * `page: { kind: "error" }`, and required for the same reason: without it a
   * rejected search arrives as `searchHits: []`, which the pane can only read as
   * "this query matched nothing" — a claim about a corpus nothing searched.
   */
  readonly searchFailed: boolean;
  /**
   * Base URL of the live docs site — the "view latest online" escape hatch every
   * degraded state offers. Host-supplied because it is stamped into the bundle
   * the host loaded, not a constant the surface may assume.
   */
  readonly docsSiteUrl: string;
};
