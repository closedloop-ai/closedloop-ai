import type { DocsHelpMatchField } from "./docs-help-payload";

/**
 * The canonical human label for a search hit's `matchField` facet, in one
 * lightweight module (no React) so every surface showing a docs hit reads the
 * same label instead of re-declaring the map and drifting.
 */
export const DOCS_MATCH_FIELD_LABEL: Record<DocsHelpMatchField, string> = {
  title: "Title",
  heading: "Section",
  body: "Body",
  group: "Group",
};

/**
 * ISS-10044 — what a docs search that never ran says, in the one place both the
 * Help pane and the command palette read it from.
 *
 * Names the read as a FAILURE TO ANSWER, never as an answer: this and the
 * `No results for "…"` sentence beside it must stay different sentences, because
 * the reader's next move differs — wait, versus broaden the query.
 *
 * Split in two because the chrome is: a pane has room for the reassurance and a
 * palette row does not, which is the same division `SearchSurfaceV2` makes
 * between its `UNAVAILABLE_TITLE` and `UNAVAILABLE_DESCRIPTION`.
 */
export const DOCS_HELP_SEARCH_FAILED_TITLE = "Couldn't search the docs.";
/**
 * No transience claim. This state also covers a reply the payload guard refused,
 * and re-reading a corrupt snapshot reproduces that forever — "usually
 * temporary" would tell the reader to wait for something that never resolves.
 * What holds for BOTH causes is that the query is not what went wrong.
 */
export const DOCS_HELP_SEARCH_FAILED_DETAIL =
  "This is on our end, not a problem with your query.";
export const DOCS_HELP_SEARCH_FAILED_MESSAGE = `${DOCS_HELP_SEARCH_FAILED_TITLE} ${DOCS_HELP_SEARCH_FAILED_DETAIL}`;

/**
 * ISS-10006 — the three sentences that name WHERE this host's docs come from.
 *
 * Host-supplied for the same reason the Diagnostics route notice is: the corpus
 * is a fact about the shell, and the two shells hold it differently. Desktop
 * reads a snapshot packed into the app, so "isn't available offline" and "newer
 * than your app" are true and useful there. Web reads the corpus the deployment
 * ships and serves it over HTTP: there is no bundle, no snapshot and no offline,
 * and telling a browser reader their build has no docs stops them reloading over
 * a read that would have succeeded.
 *
 * The surface keeps the STATE — unavailable, missing, unbrowsable — and the
 * titles, which are true on any host. Only the causal sentence moves.
 */
export type DocsHelpCorpusCopy = {
  /**
   * The heading when this host cannot offer docs at all. Host-supplied with the
   * sentence under it, because the two make ONE claim: "offline" is the reason
   * on a host whose docs are a packed snapshot, and a browser has no such state.
   */
  readonly corpusUnavailableTitle: string;
  /** Under that heading: why this host cannot offer them. */
  readonly corpusUnavailableDetail: string;
  /** Under "Page not found": why this host does not hold that page. */
  readonly pageMissingDetail: string;
  /** Under "Nothing to browse": why this host lists no sections. */
  readonly navEmptyDetail: string;
};
