/**
 * ISS-8554 / PLN-1853 Phase 3 (revision 12) — the list-sort shadow differ.
 *
 * Unlike the usage-summary differ (`usage-summary-differ.ts`), which scores
 * many independent FIELDS with their own allowlisted movements, this compares
 * ONE sequence against another: the ordered `artifact_id`s a single page is
 * supposed to contain, in order. §11 (revision 12) is explicit that this must
 * be IDENTICAL, never convergent — a reordering of a page a user is actively
 * reading has no tolerance the way an aggregate figure does.
 */

export type ListSortDiffVerdict =
  | { clean: true }
  | {
      clean: false;
      /**
       * The first index where the two sequences disagree, or `null` when
       * they agree everywhere but differ in length.
       */
      firstMismatchIndex: number | null;
      liveLength: number;
      candidateLength: number;
    };

/** Compares two ordered `artifact_id` pages for the SAME request. */
export function diffSessionListSortPage(
  live: readonly string[],
  candidate: readonly string[]
): ListSortDiffVerdict {
  const shorter = Math.min(live.length, candidate.length);
  for (let index = 0; index < shorter; index += 1) {
    if (live[index] !== candidate[index]) {
      return {
        clean: false,
        firstMismatchIndex: index,
        liveLength: live.length,
        candidateLength: candidate.length,
      };
    }
  }
  if (live.length !== candidate.length) {
    return {
      clean: false,
      firstMismatchIndex: null,
      liveLength: live.length,
      candidateLength: candidate.length,
    };
  }
  return { clean: true };
}

/**
 * One row of an ordered page as the comparison reads it: the artifact id, plus
 * the record's `updated` key read inside the snapshot the ordering came from, in
 * epoch milliseconds (`null` when neither `@updatedAt` column resolved). On an
 * `updated` page that IS the key the ordering was computed from; on any other
 * column it is only a witness that the row mutated between the two reads.
 */
export type ListSortPageRow = {
  id: string;
  recordUpdatedAtMs: number | null;
};

/** One position where the two orderings disagree, with each side's sort key. */
export type ListSortDivergence = {
  index: number;
  liveId: string | null;
  liveUpdatedAtMs: number | null;
  candidateId: string | null;
  candidateUpdatedAtMs: number | null;
};

/**
 * Every position where the two orderings disagree, each side carrying the key
 * it was ordered by.
 *
 * `updated` is the column every desktop sync upsert bumps, so on `updated desc`
 * page 1 IS the rows syncing right now and a key can move between the live read
 * and the candidate read with no ordering defect present. Each side's ordering
 * and keys come from one MVCC snapshot of its own — the live page from the list
 * read's `RepeatableRead` transaction (`list-page-fetch.ts`), the candidate from
 * `readSessionListPageByUpdated`'s — so a key that differs ACROSS the two sides
 * moved between them, and one that agrees leaves a real ordering divergence as
 * the only explanation. An index and two lengths could not tell those apart
 * (tamsinb on #8670).
 *
 * A `null` id is that side's page being shorter at this index.
 */
export function describeSessionListSortDivergence(
  live: readonly ListSortPageRow[],
  candidate: readonly ListSortPageRow[]
): ListSortDivergence[] {
  const divergences: ListSortDivergence[] = [];
  const longer = Math.max(live.length, candidate.length);
  for (let index = 0; index < longer; index += 1) {
    const liveRow = live[index];
    const candidateRow = candidate[index];
    if (liveRow?.id === candidateRow?.id) {
      continue;
    }
    divergences.push({
      index,
      liveId: liveRow?.id ?? null,
      liveUpdatedAtMs: liveRow?.recordUpdatedAtMs ?? null,
      candidateId: candidateRow?.id ?? null,
      candidateUpdatedAtMs: candidateRow?.recordUpdatedAtMs ?? null,
    });
  }
  return divergences;
}
