import type { Prisma } from "@repo/database";

/**
 * ISS-6892: keyset-chunked candidate scanning for the Sessions list sorts whose
 * order is a DISPLAYED value with no trustworthy DB column (Duration, Owner,
 * Status, Updated) or a reconciled value (cost).
 *
 * Those sorts have to rank rows in memory. The previous shape materialized a
 * bounded prefix of the filtered population in ONE read (10,000 rows) and served
 * the retained length as the list's `total`, which made an in-memory MEMORY
 * bound the public population denominator: past the ceiling the list reported at
 * most 10,000 as a COMPLETE total while the usage summary aggregated the whole
 * matching population over the same filter, and every session past the ceiling
 * was unreachable through pagination.
 *
 * The population is now scanned in `artifactId`-keyset chunks and only the
 * WINDOW the request actually needs is retained, so:
 *
 *  - `total` is the uncapped `count(where)` — the same population the summary
 *    aggregates for the same filter, so the two reconcile by construction;
 *  - every matching session is reachable: a row at any rank is served once the
 *    request pages to it, with no hidden ceiling;
 *  - resident rows are bounded by the requested window plus the chunks in
 *    flight — `offset + limit + 3 * chunkSize`
 *    ({@link selectOrderedSessionWindow}) — not by the population.
 *
 * The cost is explicit and unavoidable at this layer: ranking on a value no
 * index carries cannot terminate before the last row, so this walks the whole
 * filtered population on every such read. That is strictly more work than the
 * bounded scan it replaces, because the bounded scan was ranking only the
 * first 10,000 rows and reporting the result as if it had ranked them all.
 * Buying the correctness back with a smaller ceiling is not an option; the
 * durable fix is a maintained displayed-status projection column so Postgres
 * orders and paginates status itself with no candidate scan at all.
 *
 * ISS-7176: cost used to be one of the display-value sorts resolved through
 * this stream (via a per-chunk reconciled-cost read); it is DB-native now
 * (`estimatedCost` is the value, `SessionSortColumnKind.Db`), so it no longer
 * reaches this file at all. Duration, owner, status, and updated remain.
 */

/**
 * Rows read per keyset chunk.
 *
 * Sized against what the bounded path it replaces already issued: its ONE
 * candidate read materialized up to 10,000 rows and reconciled the same 10,000
 * ids in a single aggregate. Half that keeps every individual round trip
 * strictly lighter than what shipped before while keeping the number of them —
 * the cost sort resolves its reconciled-cost authority per chunk — as low as
 * that bound allows. It is a round-trip/residency knob only: no session's
 * availability depends on it.
 */
export const SESSION_CANDIDATE_CHUNK_SIZE = 5000;

/**
 * The keyset walk order. `artifactId` is the `SessionDetail` primary key, so it
 * is total and never null — every row is visited exactly once across the chunks,
 * which an ordering on any other column cannot promise. The RANK the reader sees
 * is the caller's comparator, applied in memory, so this order is a scan
 * mechanism and never a displayed order.
 */
export const SESSION_CANDIDATE_KEYSET_ORDER_BY: Prisma.SessionDetailOrderByWithRelationInput[] =
  [{ artifactId: "asc" }];

/** The one column the keyset walk needs: the `SessionDetail` primary key. */
type KeyedCandidate = { artifactId: string };

type OrderedSessionWindowInput<
  TRow extends KeyedCandidate,
  TItem extends KeyedCandidate,
> = {
  /** The filtered population's `where` — every chunk is scoped to it. */
  where: Prisma.SessionDetailWhereInput;
  /** Rank of the first row the caller wants. */
  offset: number;
  /** How many rows the caller wants. */
  limit: number;
  /** The uncapped size of the filtered population (`count(where)`). */
  total: number;
  /**
   * The TOTAL order over the population. Every Sessions comparator ends with the
   * unique `artifactId` tiebreaker (FEA-4329), which is what lets a chunked scan
   * produce the identical page a single whole-population sort would.
   */
  compare: (a: TItem, b: TItem) => number;
  /**
   * Read one chunk. MUST order by `artifactId` ascending — the walk resumes from
   * the last row's id — and MUST apply the supplied `chunkWhere` verbatim so the
   * tenant/facet scope can never be widened by the keyset clause.
   */
  fetchChunk: (
    chunkWhere: Prisma.SessionDetailWhereInput,
    take: number
  ) => Promise<readonly TRow[]>;
  /**
   * Resolve a chunk's rows into the comparable items. Population-preserving by
   * contract: it maps, it does not filter, so `total` stays the denominator both
   * this page and the usage summary describe.
   */
  mapChunk: (rows: readonly TRow[]) => Promise<TItem[]>;
  chunkSize?: number;
};

/**
 * The `[offset, offset + limit)` slice of the filtered population under
 * `compare`, resolved without materializing the population.
 *
 * The scan retains only the `offset + limit` best-ranked rows seen so far, so
 * the RANKED WINDOW is bounded by `offset + limit + 2 * chunkSize` — the trim
 * threshold, plus the chunk that pushes past it. ISS-9627 measured that bound
 * rather than assuming it; the earlier claim here of one chunk understated it by
 * one, because a window sitting exactly AT the threshold has not tripped the
 * trim and still takes a full chunk before the next check.
 *
 * TOTAL residency is one chunk more than that. `rows` is read again after the
 * sort (the short-chunk termination check), so the fetched chunk is live across
 * it — and a mapper that ALLOCATES, which the production cost mapper does, makes
 * those rows a second population beside the mapped items rather than the same
 * objects. So the bound callers should hold is `offset + limit + 3 * chunkSize`.
 * `session-candidate-stream.test.ts` asserts both measured values, at two
 * population sizes so neither can be a restatement of the row count.
 *
 * The returned page is positioned against the rows this scan actually visited,
 * never against `total`. `total` is a SEPARATE `count(where)` on a separate
 * snapshot, and sessions are written continuously, so the two can disagree; an
 * earlier revision selected a deep page from the far end using `total - offset`
 * as the rank base, which silently shifted the page by the drift and could make
 * a rank unreachable across the crossover. `total` is therefore used for one
 * thing only: skipping the scan for a page the caller was already told does not
 * exist, so an empty page and the reported denominator agree.
 *
 * Sessions are written while this reads them, but a Sessions list page never
 * OBSERVES that: `withSessionListSnapshot` in `list-page-fetch.ts` runs the
 * count, every chunk, and the hydrate inside ONE `RepeatableRead` transaction —
 * every caller of this helper goes through it — so no concurrent
 * write — above or below the cursor — is visible to the walk at all.
 *
 * The walk does not RELY on that snapshot, which is what keeps the snapshot a
 * second line of defence rather than the only one, and what an unwrapped future
 * caller of this exported helper still gets. Its own guarantee, holding with no
 * snapshot (ISS-9623, proven in the sibling test by writing BETWEEN chunk
 * reads):
 *
 *  - a row present and above the cursor for the rest of the walk is served
 *    EXACTLY once — the resume compares `artifactId`, the primary key, by
 *    VALUE, so chunks are disjoint by construction, no write moves a row across
 *    a chunk boundary, and deleting the cursor row itself neither stalls the
 *    walk nor skips its successor;
 *  - a row is ranked on the value the scan READ, so re-ranking it mid-walk
 *    neither re-visits nor skips it;
 *  - a row inserted BELOW the live cursor is not served by that traversal —
 *    inherent without a snapshot, since the walk has no position to go back to,
 *    so it is disclosed rather than fixed.
 *
 * All of that is WITHIN one traversal, and one request is one whole walk, so it
 * is not a claim about two SUCCESSIVE requests: each re-walks and re-ranks the
 * population independently. That boundary is a different axis, and its own
 * hazard — a comparator key that moves between requests — is the one
 * `durationSortClockMs` in `session-display-sort.ts` quantizes and discloses.
 */
export async function selectOrderedSessionWindow<
  TRow extends KeyedCandidate,
  TItem extends KeyedCandidate,
>(input: OrderedSessionWindowInput<TRow, TItem>): Promise<TItem[]> {
  const { where, offset, limit, total, compare, fetchChunk, mapChunk } = input;
  if (limit <= 0 || total <= 0 || offset >= total) {
    return [];
  }
  const chunkSize = input.chunkSize ?? SESSION_CANDIDATE_CHUNK_SIZE;
  const keep = offset + limit;
  // Trim back to `keep` as soon as a chunk pushes past this, so residency never
  // exceeds `trimAt + chunkSize`.
  const trimAt = keep + chunkSize;

  let window: TItem[] = [];
  let cursorId: string | null = null;
  for (;;) {
    const chunkWhere: Prisma.SessionDetailWhereInput =
      cursorId === null
        ? where
        : { AND: [where, { artifactId: { gt: cursorId } }] };
    const rows = await fetchChunk(chunkWhere, chunkSize);
    if (rows.length === 0) {
      break;
    }
    cursorId = rows.at(-1)?.artifactId ?? null;
    window.push(...(await mapChunk(rows)));
    if (window.length > trimAt) {
      window.sort(compare);
      window = window.slice(0, keep);
    }
    if (rows.length < chunkSize || cursorId === null) {
      break;
    }
  }

  window.sort(compare);
  return window.slice(offset, offset + limit);
}
