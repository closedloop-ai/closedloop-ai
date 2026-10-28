import type { DocsHelpCorpusCopy } from "./docs-help-labels";

/**
 * ISS-10006 — the WEB Help host's transport constants.
 *
 * Shared by the client host and by the specs that intercept these reads, so an
 * E2E stubbing a path that the host no longer calls fails loudly instead of
 * passing on an interception nothing ever hit.
 *
 * IN `packages/app` RATHER THAN BESIDE THE ROUTE, and that placement is what
 * makes the sentence above true. `apps/app` declares no `"type": "module"`, so
 * Node loads its modules as CommonJS, and a VALUE import of one from the
 * repo-root Playwright tree fails to resolve its named exports — `playwright
 * --list` then reports the whole suite as zero tests, which reddens the `e2e`
 * lane and every deploy guard that lists specs. Every other e2e value import in
 * this repo comes from a lightweight `packages/*` lib for the same reason (see
 * `packages/app/shared/feature-flags/dev-mode/dev-mode-contract`). React
 * component modules are unusable there too — they pull the design system's
 * `react-syntax-highlighter` directory import, which Node's ESM loader refuses.
 */

/** Nav tree + page index. A failure here is `bundleStatus: Unavailable`. */
export const DOCS_HELP_NAV_PATH = "/api/docs-help";

/** One page with its markdown body. 404 is `missing`; any other failure is `error`. */
export const DOCS_HELP_PAGE_PATH = "/api/docs-help/page";

/** Title/heading/body search. A failure here is `searchFailed`, never zero hits. */
export const DOCS_HELP_SEARCH_PATH = "/api/docs-help/search";

/**
 * Typing debounce. Low enough that a reader who stops typing sees results
 * without noticing a wait, high enough that a word does not issue one read per
 * keystroke against a server-side index over 155 pages.
 */
export const DOCS_SEARCH_DEBOUNCE_MS = 200;

/**
 * ISS-10006 — where WEB's docs come from, said in web's terms.
 *
 * The surface's default sentences were written for the desktop bundle: "isn't
 * available offline", "the bundled docs snapshot", "in this build". On web there
 * is no bundle, no snapshot and no offline — the corpus is read off the
 * deployment over HTTP, and a failure here is usually transient. Telling a
 * browser reader their build has no docs stops them reloading over a read that
 * would have worked.
 */
export const WEB_DOCS_CORPUS_COPY: DocsHelpCorpusCopy = {
  corpusUnavailableDetail: "We couldn't load the documentation just now.",
  corpusUnavailableTitle: "Docs aren't available right now",
  navEmptyDetail: "No documentation sections came back with this response.",
  pageMissingDetail: "This page isn't in the documentation we're serving.",
};

/**
 * ISS-10006 (marisolashgrove review) — WHY the docs read failed, on the wire.
 *
 * `NotDeployed` is permanent for the life of the deployment: the corpus is not
 * in the bundle, so every reload reproduces it. `ReadFailed` is everything else
 * — a parse failure, an fs blip — and is worth another look. Collapsing them
 * gives the reader one "couldn't load just now" sentence that invites a reload
 * over a read that cannot succeed, which is the same distinction Diagnostics
 * makes with `unservableReason` one surface over.
 *
 * An unknown value from a newer server degrades to `ReadFailed`, the weaker of
 * the two claims.
 */
export const DocsCorpusFailureReason = {
  NotDeployed: "not-deployed",
  ReadFailed: "read-failed",
} as const;
export type DocsCorpusFailureReason =
  (typeof DocsCorpusFailureReason)[keyof typeof DocsCorpusFailureReason];

/**
 * What a reader sees when this deployment never shipped the corpus.
 *
 * Deliberately NOT the `WEB_DOCS_CORPUS_COPY` sentence: "just now" tells them to
 * wait for something that will not change, and the online escape hatch the
 * surface already offers is the only move that works.
 */
export const WEB_DOCS_CORPUS_COPY_NOT_DEPLOYED: DocsHelpCorpusCopy = {
  ...WEB_DOCS_CORPUS_COPY,
  corpusUnavailableDetail:
    "This deployment doesn't carry the documentation. It's all on the docs site.",
  corpusUnavailableTitle: "Docs aren't part of this build",
};
