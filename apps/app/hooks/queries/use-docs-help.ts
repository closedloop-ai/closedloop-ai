"use client";

import type {
  DocsHelpNavGroup,
  DocsHelpPage,
  DocsHelpSearchHit,
} from "@repo/app/help/lib/docs-help-payload";
import {
  DOCS_HELP_NAV_PATH,
  DOCS_HELP_PAGE_PATH,
  DOCS_HELP_SEARCH_PATH,
  DocsCorpusFailureReason,
} from "@repo/app/help/lib/web-help-contract";
import { useQuery } from "@tanstack/react-query";

/**
 * ISS-10006 — the three reads behind Web Help, as queries.
 *
 * The corpus is immutable for the life of a deployment: it ships with the
 * build. So the nav index and every page are cached for the session rather than
 * re-read on each mount — leaving Help and coming back re-paid the whole
 * 155-page index before this moved off hand-rolled `fetch`.
 *
 * `retry: false` on all three, deliberately. Each read's failure is a STATE the
 * surface renders and the reader can act on — the online escape hatch, or simply
 * searching again — and three silent background retries put that state seconds
 * behind the thing that caused it, which is the delay a reader reads as a hang.
 */
export const docsHelpKeys = {
  all: ["docs-help"] as const,
  nav: () => [...docsHelpKeys.all, "nav"] as const,
  page: (path: string) => [...docsHelpKeys.all, "page", path] as const,
  search: (query: string) => [...docsHelpKeys.all, "search", query] as const,
};

/**
 * The corpus genuinely holds no such page, as opposed to the read failing.
 *
 * A distinct error type rather than a status number on a generic one: the two
 * send a reader opposite ways — online for a page that does not exist here, back
 * again for a read that did not come back — and the caller has to be able to
 * tell them apart without reparsing a message.
 */
export class DocsHelpPageMissingError extends Error {
  constructor(path: string) {
    super(`docs page not in this corpus: ${path}`);
    this.name = "DocsHelpPageMissingError";
  }
}

/**
 * A docs read that did not come back, WITH the server's reason (marisolashgrove
 * review). The reason decides which sentence the surface shows, because a
 * deployment that never shipped the corpus and a transient fs failure send the
 * reader opposite ways — online, or back again in a moment.
 */
export class DocsCorpusUnavailableError extends Error {
  readonly reason: DocsCorpusFailureReason;

  constructor(status: number, reason: DocsCorpusFailureReason) {
    super(`docs nav read failed: ${status} (${reason})`);
    this.name = "DocsCorpusUnavailableError";
    this.reason = reason;
  }
}

const HTTP_NOT_FOUND = 404;

/**
 * The server's reason, or the weaker of the two claims. An unknown value from a
 * newer server, a body that is not JSON, and an older server that sent no body
 * at all all degrade to `ReadFailed` rather than asserting the permanent one.
 */
async function readFailureReason(
  response: Response
): Promise<DocsCorpusFailureReason> {
  try {
    const body = (await response.json()) as { reason?: unknown };
    return body.reason === DocsCorpusFailureReason.NotDeployed
      ? DocsCorpusFailureReason.NotDeployed
      : DocsCorpusFailureReason.ReadFailed;
  } catch {
    return DocsCorpusFailureReason.ReadFailed;
  }
}

export function useDocsHelpNav() {
  return useQuery({
    queryFn: async (): Promise<readonly DocsHelpNavGroup[]> => {
      const response = await fetch(DOCS_HELP_NAV_PATH);
      if (!response.ok) {
        throw new DocsCorpusUnavailableError(
          response.status,
          await readFailureReason(response)
        );
      }
      const body = (await response.json()) as {
        navGroups?: readonly DocsHelpNavGroup[];
      };
      // Returned UNGUARDED, the same call `useDocsHelpSearch` makes below
      // (whitlockk review). A 200 whose payload carries no `navGroups` at all is a
      // reply nothing could read, and coalescing it to `[]` here would hand the
      // surface a real empty tree — "Nothing to browse", a claim about the
      // corpus — instead of the shared `treeUnreadable` state `readNavGroups`
      // derives from a non-array. `?? null` and not the bare value because
      // react-query refuses `undefined` as data; `null` is the non-array the
      // guard is looking for. A FAILED read never lands here: it threw above,
      // and becomes `Unavailable`.
      return (body.navGroups ?? null) as readonly DocsHelpNavGroup[];
    },
    queryKey: docsHelpKeys.nav(),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useDocsHelpPage(path: string | null) {
  return useQuery({
    enabled: path !== null,
    queryFn: async (): Promise<DocsHelpPage> => {
      const requested = path ?? "";
      const response = await fetch(
        `${DOCS_HELP_PAGE_PATH}?path=${encodeURIComponent(requested)}`
      );
      if (response.status === HTTP_NOT_FOUND) {
        throw new DocsHelpPageMissingError(requested);
      }
      if (!response.ok) {
        throw new Error(`docs page read failed: ${response.status}`);
      }
      const body = (await response.json()) as { page: DocsHelpPage };
      return body.page;
    },
    queryKey: docsHelpKeys.page(path ?? ""),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useDocsHelpSearch(query: string) {
  return useQuery({
    enabled: query !== "",
    queryFn: async (): Promise<readonly DocsHelpSearchHit[]> => {
      const response = await fetch(
        `${DOCS_HELP_SEARCH_PATH}?q=${encodeURIComponent(query)}`
      );
      if (!response.ok) {
        throw new Error(`docs search failed: ${response.status}`);
      }
      // Returned UNGUARDED on purpose: the caller runs it through
      // `readSearchHits`/`isSearchHitsUnreadable`, which need the raw value to
      // tell "matched nothing" apart from "could not be read".
      const body = (await response.json()) as { hits?: unknown };
      return body.hits as readonly DocsHelpSearchHit[];
    },
    queryKey: docsHelpKeys.search(query),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
