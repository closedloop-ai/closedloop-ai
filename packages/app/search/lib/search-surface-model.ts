import type { LucideIcon } from "lucide-react";
import { formatDate } from "../../shared/lib/date-utils";
import {
  type OfferedSearchHit,
  SEARCH_ENTITY_TYPE_ICONS,
  SEARCH_ENTITY_TYPE_LABELS,
  searchHitOrgRelativeRoute,
} from "./search-display";

/**
 * ISS-9414 — the one behavior model behind `SearchSurfaceV2`, so a Web page and
 * a Desktop overlay can render the same search WITHOUT sharing a transport, a
 * corpus, or a layout.
 *
 * Web reaches the unified FTS corpus over `apps/api`; Desktop reaches a local
 * docs index over IPC. Neither fact belongs in a result row, so a host maps its
 * own hits into {@link SearchSurfaceResult} at its boundary and the surface
 * orders, labels and links every row from there. That is what makes "the same
 * query and fixture produce the same ordering, labels and destinations on both
 * hosts" a checkable claim rather than an aspiration: the fixture IS this type.
 */

/** A single result, in the only shape the surface renders. */
export type SearchSurfaceResult = {
  /**
   * Identity within one result set, and the row's React key. A host mints it
   * from whatever makes its own hit unique — an entity id, or a docs path plus
   * anchor, since one page can match twice under different headings.
   */
  readonly key: string;
  /**
   * What KIND of thing this is, in the reader's words: "Document", "Session",
   * or on Desktop the field the docs index matched. Rendered verbatim, so the
   * host that owns the corpus owns the vocabulary for it.
   */
  readonly kindLabel: string;
  readonly title: string;
  /**
   * Match context, carrying Postgres' `<b>…</b>` markers where the producer
   * emits them. Parsed into typed segments before render — never injected as
   * HTML. Empty when the host has no snippet for this hit.
   */
  readonly snippet: string;
  /**
   * Org-relative destination, or null when the host cannot build a safe one.
   * Null renders a non-link row, so a click never lands on a 404 — the same
   * policy `searchHitOrgRelativeRoute` already applies on Web.
   */
  readonly destination: string | null;
  /**
   * Trailing meta, e.g. "Updated 4 Sep 2026". Absent where the corpus has no
   * such fact — a local docs page has no updated-at the reader could act on,
   * and inventing one would be the "plausible-but-wrong value" the package
   * guidelines bar.
   */
  readonly meta?: string;
  readonly icon: LucideIcon;
};

/**
 * The states the surface renders, and why there are five rather than the three
 * a results list usually gets.
 *
 * `NoResults`, `Unavailable` and `NotRun` are three DIFFERENT claims and a
 * reader acts on each differently: broaden the query, retry later, or type
 * something. Before ISS-9414 each host re-derived "has the query run yet" for
 * itself, which is a gate each host can get wrong.
 *
 * Deliberately NOT `CompleteSurfaceState`: that ladder has no member for "the
 * user has not asked anything yet", because every other surface loads its
 * population unprompted. Search is the one whose population is undefined until
 * a query exists.
 */
export const SearchSurfaceState = {
  /**
   * No query has been issued. The surface knows NOTHING about the corpus — it
   * has not been asked. Never an empty list, never a zero.
   */
  NotRun: "not-run",
  /** A query is in flight. */
  Loading: "loading",
  /** The query ran and the corpus answered with nothing. Remedy: broaden. */
  NoResults: "no-results",
  /**
   * The query could not be answered — the transport failed, or this host has
   * no search to run. Remedy: retry. Never "no results", which would blame the
   * corpus for a question nobody managed to ask.
   */
  Unavailable: "unavailable",
  /** The query ran and returned rows. */
  Ready: "ready",
} as const;
export type SearchSurfaceState =
  (typeof SearchSurfaceState)[keyof typeof SearchSurfaceState];

/** What the surface knows about the query behind the current render. */
export type SearchSurfaceReadState = {
  /**
   * Whether a query has actually been ISSUED. Not "the box is non-empty": a
   * host that gates its request on a minimum length has not run anything below
   * that floor, and saying otherwise is what produces a false "No results".
   */
  readonly hasRun: boolean;
  readonly isLoading: boolean;
  /** The read failed, or this host cannot answer it at all. */
  readonly isUnavailable: boolean;
  /**
   * A safe-to-show reason the query could not be answered — the search route's
   * 400 body for a malformed inline filter, e.g. "Unknown priority value:
   * huge". Null when the failure has no reason a user could act on.
   *
   * Required rather than optional, because its presence is not decoration: a
   * reason means the QUERY is what failed, so the surface offers no retry, and
   * its absence means the transport failed, so the surface does. A host that
   * could drop this silently would turn a fixable query into a dead retry
   * button — which is the shape of the `pageSizeOptions` divergence ISS-9218
   * closed.
   */
  readonly unavailableReason: string | null;
  readonly resultCount: number;
};

/**
 * The single derivation both hosts share, so neither can classify the same read
 * differently.
 *
 * Order is load-bearing. `NotRun` outranks everything, because a query that was
 * never issued cannot have failed or come back empty. `Loading` then outranks
 * `Unavailable` so a retry in flight shows progress instead of freezing on the
 * failure it is already fixing. `Unavailable` outranks the count last, because
 * a failed read's `resultCount` of 0 is the absence of an answer, not an answer
 * of none.
 */
export function searchSurfaceState({
  hasRun,
  isLoading,
  isUnavailable,
  resultCount,
}: SearchSurfaceReadState): SearchSurfaceState {
  if (!hasRun) {
    return SearchSurfaceState.NotRun;
  }
  if (isLoading) {
    return SearchSurfaceState.Loading;
  }
  if (isUnavailable) {
    return SearchSurfaceState.Unavailable;
  }
  if (resultCount === 0) {
    return SearchSurfaceState.NoResults;
  }
  return SearchSurfaceState.Ready;
}

/**
 * The Web host's boundary: unified FTS hits into the shared model, preserving
 * the server's ranking. Labels and icons come from the existing
 * `search-display` maps, so the surface and the pre-ISS-9414 list cannot drift
 * on what a `document` is called.
 */
export function searchHitsToSurfaceResults(
  hits: readonly OfferedSearchHit[]
): SearchSurfaceResult[] {
  return hits.map((hit) => ({
    key: `${hit.entityType}:${hit.entityId}`,
    kindLabel: SEARCH_ENTITY_TYPE_LABELS[hit.entityType],
    title: hit.title,
    snippet: hit.snippet,
    destination: searchHitOrgRelativeRoute(hit),
    meta: `Updated ${formatDate(hit.updatedAt)}`,
    icon: SEARCH_ENTITY_TYPE_ICONS[hit.entityType],
  }));
}
