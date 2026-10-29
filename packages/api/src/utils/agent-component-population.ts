import type { AgentComponentListResponse } from "../types/agent-component.ts";

/**
 * ISS-6891: read a COMPLETE agent-component population out of the paginated list
 * contract, by following its own `total`/`hasMore` continuation.
 *
 * Three consumers need the whole population rather than a page — the cloud
 * page-data reducer, the desktop page-data reducer, and the web workspace's
 * legacy read — because each computes facet COUNTS and summary AGGREGATES over
 * it. A count taken over a prefix is not a count, so each of them keeping the
 * first page and calling it the inventory was the client-side half of the
 * truncation ISS-6891 removed from the server. They share this one follower so
 * the three cannot drift into three different notions of "complete".
 *
 * Termination is guarded on three independent conditions, because any one alone
 * can be defeated by a producer that is merely OLD rather than broken:
 *
 *  - an empty page — there is nothing left to read;
 *  - the producer's own `hasMore: false` — believed even when its `total`
 *    disagrees, so a stale producer degrades to fewer pages, never to a spin;
 *  - the accumulated count reaching `total` — which is what paginates a producer
 *    that omits `hasMore` entirely (the field is optional on the wire) instead of
 *    treating it as single-page.
 *
 * ONE WIDE RE-READ, NOT A WALK (#6483, davetho + whitlockk review). A producer
 * that reports more remaining is asked ONCE more, at its own reported width,
 * from the caller's base offset — and the short first page is DISCARDED rather
 * than concatenated. Two independent defects made the walk the wrong shape:
 *
 *  - COST. Each page is a whole request, and for the two page-data callers that
 *    request rebuilds the entire org population before slicing, so walking `k`
 *    pages was O(k x population) per window against up to three concurrent
 *    windows. The wide re-read makes it 2 requests for any org, not `k`.
 *  - CORRECTNESS. Every offset read opens its OWN snapshot, and the list is
 *    ordered on `lastSeenAt`, which moves. A component crossing the page
 *    boundary between two reads is returned twice and pushes another out, while
 *    the accumulated length still equals `total` — so a MIXED set was published
 *    as the complete population. Reading the whole of it in one request is one
 *    snapshot, which is the only place that race cannot happen.
 *
 * The walk survives only as the fallback for a producer that CLAMPS the width it
 * was asked for (a version-skewed desktop still enforcing the former 1,000-row
 * page). There the offset advances by the rows the producer actually RETURNED,
 * never by the width requested: incrementing by the request width skips the gap
 * between `page.items.length` and `limit`, permanently omitting those rows.
 *
 * Accumulation is keyed on `id`, so a row seen in two snapshots is admitted
 * once. That is not cosmetic: a duplicate inflates the accumulated length toward
 * `total` and MASKS the row it displaced, which is what let a mixed set pass the
 * completeness check. De-duplicated, a displaced row leaves the count short and
 * the re-derived `hasMore` says so.
 *
 * The emitted `hasMore` is re-derived against the accumulated items rather than
 * copied from the last page: when a producer stopped short of its own `total`,
 * saying so is the honest answer. Both server-side callers REFUSE such a result
 * rather than reducing over a partial population.
 */
export async function collectComponentPopulation(
  readPage: (page: {
    limit: number;
    offset: number;
  }) => Promise<AgentComponentListResponse>,
  bounds: { pageSize: number; offset?: number; maxPageSize?: number }
): Promise<AgentComponentListResponse> {
  // A page of zero (or fewer) is not a page and a negative offset is not an
  // offset; `Math.min` alone would leave both ends open.
  const pageSize = Math.max(1, Math.floor(bounds.pageSize));
  const baseOffset = Math.max(0, Math.floor(bounds.offset ?? 0));
  // The widest single page this producer will ACCEPT. Unbounded for an
  // in-process caller; the HTTP list validator rejects (does not clamp) a
  // `limit` over `AGENT_COMPONENT_INVENTORY_CAP`, so a wire caller states that
  // bound here rather than having the wide re-read answered with a 400.
  const maxPageSize = Math.max(pageSize, bounds.maxPageSize ?? pageSize);
  const items: AgentComponentListResponse["items"] = [];
  const seen = new Set<string>();
  let limit = pageSize;
  let offset = baseOffset;
  let total = 0;
  let widened = false;

  for (;;) {
    const page = await readPage({ limit, offset });
    total = page.total;
    for (const item of page.items) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        items.push(item);
      }
    }
    if (
      page.items.length === 0 ||
      page.hasMore === false ||
      items.length >= total
    ) {
      break;
    }
    if (!widened) {
      widened = true;
      const width = remainderWidth(total, baseOffset, pageSize, maxPageSize);
      if (width > limit) {
        // Re-ask for the whole remainder in ONE request, and drop the prefix so
        // the population comes from that single snapshot rather than being
        // stitched across two.
        limit = width;
        offset = baseOffset;
        items.length = 0;
        seen.clear();
        continue;
      }
      // Already at the widest page this producer accepts — walk, rather than
      // spend a request re-reading the page just read.
    }
    // Advance by what the producer RETURNED — the gap between that and `limit`
    // is rows, not padding.
    offset += page.items.length;
  }

  return { items, total, hasMore: items.length < total };
}

/**
 * The width one request needs to reach the end of the population from
 * `baseOffset` — the producer's own `total`, minus what the caller skipped, and
 * never wider than the page that producer accepts.
 *
 * Never narrower than the page the caller already asked for either, so a `total`
 * that is stale-low cannot shrink the read below the first page. A non-finite
 * `total` is not a width: fall back to the caller's page size and let the walk
 * do the paging.
 */
function remainderWidth(
  total: number,
  baseOffset: number,
  pageSize: number,
  maxPageSize: number
): number {
  if (!Number.isFinite(total)) {
    return pageSize;
  }
  return Math.min(
    maxPageSize,
    Math.max(pageSize, Math.floor(total) - baseOffset)
  );
}
