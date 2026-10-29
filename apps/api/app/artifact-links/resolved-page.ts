/**
 * Snapshot-aware tree pages pin link membership and BFS order for 24 hours.
 * Legacy numeric cursors reuse the latest matching traversal; concurrent fresh
 * reads may change that membership, as with their existing offset semantics.
 * Link data and
 * endpoint hydration remain live: deleted links disappear without shifting
 * later pages; additions appear on a fresh traversal. Missing/expired snapshots
 * rebuild at the numeric offset, retaining legacy offset mutation semantics.
 * Direct pages keep their existing live offset semantics.
 */

/**
 * Links per page.
 *
 * Measured against the numbers ISS-10041 recorded: the pre-fix shape held
 * 194 MB of JS heap for 10,025 links and 487 MB for 42,060 against a 2,048 MB
 * ceiling — roughly 11 KB of heap and 10.6 KB of serialized JSON per hydrated
 * link. 1,000 links is therefore ~11 MB per response, two orders of magnitude
 * under the ceiling.
 *
 * It also sits above every healthy tree: the surfaces that read tree mode render
 * one document's own lineage, and `OVERSIZE_LINK_TREE_LINK_COUNT` puts "an
 * order of magnitude above any healthy tree" at 5,000. So a caller that never
 * opts into paging — an already-installed Desktop build, an external REST
 * client — gets the identical array it got before on every real graph, and only
 * the pathological hub that used to KILL this route now comes back as a usable
 * first page instead of a 500.
 */
export const ARTIFACT_LINK_PAGE_SIZE = 1000;

/**
 * The slice a finder reads for one page. `take` is deliberately one MORE than
 * the page size — see {@link splitPeekedPage}.
 */
export type ResolvedLinkWindow = {
  skip: number;
  take: number;
  snapshotId?: string;
};

/**
 * One page of links plus the cursor that reaches the next one.
 *
 * `nextCursor` is OMITTED, never `null`, when there is no next page — the repo's
 * rule for an optional field crossing a deploy boundary, and what lets a pager
 * loop on one fact instead of two.
 */
export type PeekedLinkPage<T> = {
  pageLinks: T[];
  nextCursor?: string;
};

/** The read window for `cursor`, or for the first page when it is absent. */
export function windowForCursor(
  cursor?: number,
  snapshotId?: string
): ResolvedLinkWindow {
  return {
    skip: cursor ?? 0,
    ...(snapshotId ? { snapshotId } : {}),
    // The peek row. Reading one past the page is how "is there a next page"
    // becomes a fact rather than an inference: a full page is NOT evidence of
    // more rows, and `skip + length < total` would need a `count()` this route
    // has no other reason to pay for.
    take: ARTIFACT_LINK_PAGE_SIZE + 1,
  };
}

/**
 * Split a peeked read — `take` rows starting at `skip` — into the page served
 * and the cursor for the next one.
 *
 * Takes the RAW links, before hydration, deliberately. `hydrateLinksWithEndpoints`
 * DROPS a link whose endpoint artifact it could not resolve, so deciding
 * "is there more" from the hydrated count would withhold `nextCursor` whenever a
 * page's peek row happened to be the dropped one — a response that silently ends
 * a traversal early while claiming to be complete.
 */
export function splitPeekedPage<T>(
  peeked: readonly T[],
  window: ResolvedLinkWindow
): PeekedLinkPage<T> {
  const pageLinks = peeked.slice(0, ARTIFACT_LINK_PAGE_SIZE);
  if (peeked.length <= ARTIFACT_LINK_PAGE_SIZE) {
    return { pageLinks };
  }
  // Advance by the page SIZE, not by how many rows survived hydration, for the
  // same reason: a short page advanced by its own length would re-serve rows the
  // caller already has, and a fully-dropped page would leave the cursor where it
  // started — a non-terminating loop for a consumer told to page until the
  // cursor is absent.
  return {
    pageLinks,
    nextCursor: String(window.skip + ARTIFACT_LINK_PAGE_SIZE),
  };
}
