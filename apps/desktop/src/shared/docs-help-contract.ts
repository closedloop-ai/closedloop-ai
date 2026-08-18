/**
 * Wire contract for the desktop in-app Docs & Help bridge (FEA-3843 / PRD-555
 * M1 — bundle + local search index + IPC).
 *
 * The product docs live in `apps/web/content/docs` (the Fumadocs `.mdx` +
 * per-folder `meta.json` tree that serves closedloop.ai/docs). PRD-555 M1
 * snapshots them into the desktop bundle at build time (see
 * `scripts/generate-docs-bundle-manifest.mjs`), builds a local title/heading/body
 * search index in the main process, and exposes three read-only IPC operations —
 * `search`, `getPage`, `status` — behind `assertTrustedIpcSender`. There is no
 * server round-trip and no doc *content* is authored here: the bundle is a
 * snapshot of the single source of truth in `apps/web/content/docs`.
 *
 * Per AGENTS.md, values that cross the main/renderer boundary live in a shared
 * module so the two sides can't drift — the main handler
 * (`main/ipc/docs-help-ipc.ts`), `preload-common.ts`, and any renderer transport
 * (M2/FEA-3844) all import the channels and types from here. No UI ships in M1;
 * this is backend/data plumbing only.
 */

/**
 * Single label for the "open the live docs site" action, shared by every Help
 * state (reader header, page-not-found, and bundle-unavailable) so the same
 * action never reads three different ways as the state changes.
 */
export const DOCS_HELP_VIEW_ONLINE_LABEL = "View online";

/** IPC channels for the docs-help bridge. */
export const DocsHelpIpcChannel = {
  /** Full-text search over the local title/heading/body index. */
  Search: "desktop:docs-help:search",
  /** Fetch a single rendered doc page by its bundle path (e.g. `essentials/settings`). */
  GetPage: "desktop:docs-help:get-page",
  /** Bundle status: whether it is available, the version stamp, and page count. */
  Status: "desktop:docs-help:status",
  /**
   * The `meta.json` navigation tree (groups → pages) for the M2 Help view's left
   * pane. Read-only projection of the already-nav-ordered bundle; carries only
   * `path`/`title`/`group` per page (no bodies), so listing every page for the
   * tree does not pull the full bundle across IPC.
   */
  Nav: "desktop:docs-help:nav",
} as const;

export type DocsHelpIpcChannel =
  (typeof DocsHelpIpcChannel)[keyof typeof DocsHelpIpcChannel];

/**
 * A single heading extracted from a doc page (level + text + slug anchor). The
 * slug lets the M2 reader deep-link to a section (`path#slug`); M1 only carries
 * the data.
 */
export type DocsHelpHeading = {
  /** Markdown heading depth (2 = `##`, 3 = `###`, …). H1/frontmatter title is the page `title`. */
  level: number;
  /** Heading text, stripped of markdown/JSX. */
  text: string;
  /** GitHub-style slug of the heading text, usable as a `#anchor`. */
  slug: string;
};

/**
 * One doc page in the bundle. `path` is the `meta.json`-style page id (the
 * `.mdx` path minus extension, e.g. `getting-started/api-keys`); `group` is the
 * `meta.json` navigation group it belongs to (facet for search), or `undefined`
 * when the page is not referenced by the nav.
 */
export type DocsHelpPage = {
  path: string;
  title: string;
  description?: string;
  group?: string;
  headings: readonly DocsHelpHeading[];
  /**
   * Plain-text body (frontmatter + all markup stripped) used for body-match
   * search and for search-hit excerpts. Not for display as a document — it drops
   * code fences, links, and tables (see {@link DocsHelpPage.renderBody}).
   */
  body: string;
  /**
   * Markdown-renderable body for the M2 reader: the source `.mdx` with
   * frontmatter, HTML comments, and MDX/JSX component tags stripped, but the
   * markdown structure that the reader's markdown pipeline understands — code
   * fences, links, tables, lists, emphasis, headings — preserved. Distinct from
   * {@link DocsHelpPage.body}, which is fully flattened for search. Optional so a
   * bundle produced by an older generator (which only shipped `body`) degrades
   * gracefully to the plain-text body.
   */
  renderBody?: string;
};

/** Which field a search hit matched on — drives result ranking/labels in M2. */
export const DocsHelpMatchField = {
  Title: "title",
  Heading: "heading",
  Body: "body",
  /**
   * The query matched only the page's meta.json group/facet — not its title,
   * heading, or body. Ranked below a body match; the hit shows the page
   * description rather than a (nonexistent) body excerpt.
   */
  Group: "group",
} as const;

export type DocsHelpMatchField =
  (typeof DocsHelpMatchField)[keyof typeof DocsHelpMatchField];

/** A single search result. */
export type DocsHelpSearchHit = {
  path: string;
  title: string;
  group?: string;
  /** Strongest field the query matched on (title > heading > body > group). */
  matchField: DocsHelpMatchField;
  /** Relevance score (higher is better); opaque ordering key for the renderer. */
  score: number;
  /**
   * A short excerpt around the first body match, or the page description when
   * the match was on the title/heading/group. Plain text, already truncated.
   */
  excerpt: string;
  /**
   * Heading slug to deep-link to when the match was on a heading; omitted for
   * title/body matches.
   */
  headingSlug?: string;
};

/** Request half of `search`. */
export type DocsHelpSearchRequest = {
  query: string;
  /** Max hits to return (defaults + clamped in the main handler). */
  limit?: number;
};

/** Result half of `search`. */
export type DocsHelpSearchResult = {
  query: string;
  hits: readonly DocsHelpSearchHit[];
};

/** Request half of `getPage`. */
export type DocsHelpGetPageRequest = {
  path: string;
};

/**
 * Result half of `getPage`. `found` carries the {@link DocsHelpPage}; `missing`
 * reports an unknown/out-of-bundle path (the renderer shows a "not found /
 * view online" state) without leaking whether the path was merely absent vs
 * rejected.
 */
export type DocsHelpGetPageResult =
  | { kind: "found"; page: DocsHelpPage }
  | { kind: "missing" };

/**
 * A single leaf in the Help view's left nav tree — the minimum needed to render
 * a clickable page row and route to it (`getPage(path)`): the bundle `path`, the
 * page `title`, and its `meta.json` `group` (omitted for un-navigated pages,
 * which the tree collects under a fallback bucket).
 */
export type DocsHelpNavPage = {
  path: string;
  title: string;
  group?: string;
};

/**
 * One rendered section of the left nav tree: a `meta.json` group heading and its
 * ordered pages. Groups are returned in `meta.json` nav order; pages preserve the
 * bundle's (nav) order within each group.
 */
export type DocsHelpNavGroup = {
  group: string;
  pages: readonly DocsHelpNavPage[];
};

/**
 * Result half of `nav`: the full navigation tree for the Help view's left pane.
 * Empty when the bundle is unavailable/empty (the view falls back to its
 * unavailable state, mirroring `status.available === false`).
 */
export type DocsHelpNavResult = {
  groups: readonly DocsHelpNavGroup[];
};

/**
 * Result half of `status`. When `available` is false the bundle failed to load
 * (or is empty) and the Help surfaces stay dark. `sourceCommit` is the
 * `apps/web/content/docs` snapshot commit stamp; `pageCount` powers a simple freshness/health
 * readout. `docsSiteUrl` is the "view latest online" escape hatch base URL.
 */
export type DocsHelpStatus = {
  available: boolean;
  sourceCommit: string;
  generatedAt: string;
  pageCount: number;
  docsSiteUrl: string;
};
