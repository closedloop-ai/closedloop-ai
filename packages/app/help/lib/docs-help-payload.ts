/**
 * ISS-10005 — what a docs bundle hands `HelpSurfaceV2` to render.
 *
 * Declared here rather than imported from a shell: `packages/app` must not
 * import `apps/*`, and the desktop wire contract
 * (`apps/desktop/src/shared/docs-help-contract.ts`) compiles into the main
 * process too. `docs-help-payload-parity.test.ts` holds the two to one shape.
 * This is the SHAPE the bundle arrives in, never a second copy of its content.
 */

/** One heading of a doc page: depth, text, and the anchor slug the reader stamps. */
export type DocsHelpHeading = {
  level: number;
  text: string;
  slug: string;
};

/**
 * One doc page. `renderBody` is optional because a bundle produced by an older
 * generator shipped only the search-flattened `body`; absence means "this
 * producer cannot give you markdown", which is not the empty string.
 */
export type DocsHelpPage = {
  path: string;
  title: string;
  description?: string;
  group?: string;
  headings: readonly DocsHelpHeading[];
  body: string;
  renderBody?: string;
};

/** Which field a search hit matched on — drives the hit's facet label. */
export const DocsHelpMatchField = {
  Title: "title",
  Heading: "heading",
  Body: "body",
  Group: "group",
} as const;

export type DocsHelpMatchField =
  (typeof DocsHelpMatchField)[keyof typeof DocsHelpMatchField];

/** A single search result over the host's local docs index. */
export type DocsHelpSearchHit = {
  path: string;
  title: string;
  group?: string;
  matchField: DocsHelpMatchField;
  score: number;
  excerpt: string;
  headingSlug?: string;
};

/** One clickable page row in the nav tree. */
export type DocsHelpNavPage = {
  path: string;
  title: string;
  group?: string;
};

/** One nav group heading and its ordered pages. */
export type DocsHelpNavGroup = {
  group: string;
  pages: readonly DocsHelpNavPage[];
};

/**
 * The one label for "open the live docs site", shared by every Help state so the
 * same action never reads three different ways as the state changes. Pinned
 * against the desktop wire contract's copy by the payload parity test.
 */
export const DOCS_HELP_VIEW_ONLINE_LABEL = "View online";
