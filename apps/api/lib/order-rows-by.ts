/**
 * Restore an explicit id order onto rows a set-membership query returned.
 *
 * Postgres returns `id IN (...)` rows in whatever order it likes, so any caller
 * that stored an order alongside the ids has to reimpose it. Promoted out of
 * `documents/custom-field-ordered-read.ts` (ISS-7215) once a second caller
 * appeared: the custom-field display path derives BOTH the cached sort key and
 * the rendered string from `people_value_ids`, and two independent orderings
 * would make a row sort under one name and render another.
 *
 * An id with no row is DROPPED rather than held as a gap — a target that no
 * longer exists is absent, not a placeholder.
 */
export function orderRowsBy<T extends { id: string }>(
  rows: T[],
  orderedIds: string[]
): T[] {
  return orderRowsByIdFrom(
    new Map(rows.map((row) => [row.id, row])),
    orderedIds
  );
}

/**
 * The same ordering against an index the caller already holds.
 *
 * The variant to reach for inside a per-row loop: a batch read resolves ONE map
 * across the whole page, and spreading it back into an array per row would make
 * the read O(rows x page-wide rows) to answer a question that is O(ids on the
 * row). Both entry points share this body, so the drop-missing semantics cannot
 * drift between them.
 */
export function orderRowsByIdFrom<T>(
  rowsById: ReadonlyMap<string, T>,
  orderedIds: string[]
): T[] {
  const ordered: T[] = [];
  for (const id of orderedIds) {
    const row = rowsById.get(id);
    if (row) {
      ordered.push(row);
    }
  }
  return ordered;
}
