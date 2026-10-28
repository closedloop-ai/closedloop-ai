import type { DocsHelpCorpusCopy } from "@repo/app/help/lib/docs-help-labels";

/**
 * ISS-10006 — where DESKTOP's docs come from.
 *
 * Verbatim the sentences the shared surface carried before this copy became
 * host-supplied, because on desktop they are true: the corpus is a snapshot
 * packed into the app, that is exactly what makes Help work offline, and it ages
 * with the build. Web reads the corpus off its deployment over HTTP and has none
 * of those facts, so the sentence moved to the host rather than the state.
 *
 * Its own module so the complete surface and the superseded body read ONE copy.
 * Two constants is how the two branches start telling different stories, which
 * is the same reason `HelpBundleUnavailable` was exported in the first place.
 */
export const DESKTOP_DOCS_CORPUS_COPY: DocsHelpCorpusCopy = {
  corpusUnavailableDetail:
    "The bundled documentation snapshot isn't available in this build.",
  corpusUnavailableTitle: "Docs aren't available offline",
  navEmptyDetail: "No documentation sections are listed in this build.",
  pageMissingDetail:
    "This page isn't in the bundled docs snapshot. It may be newer than your app.",
};
