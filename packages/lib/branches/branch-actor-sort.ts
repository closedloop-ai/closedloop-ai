import {
  compareListQueryText,
  ListQueryTextOrdering,
} from "@repo/api/src/types/list-query-ordering-semantics";

/**
 * Orders actor buckets by owner, with the unattributed bucket last.
 *
 * `null` is not a name that sorts somewhere in the alphabet — it is the "we
 * could not attribute this" bucket, and it belongs at the end of the list rather
 * than ahead of every owner whose name starts with a letter. That placement is
 * the one `ListQuerySortDisposition.Last`
 * (`@repo/api/src/types/list-query-value-semantics`) declares for an unrankable
 * row, reached here without a field registry because an actor bucket is not a
 * list-query sort field; the two agree rather than compete (ISS-9585).
 *
 * Lives in `@repo/lib/branches` rather than `@repo/app` because the desktop MAIN
 * process is one of the two callers and `@repo/app` is renderer-only, and
 * because the unattributed-owner bucket is branch semantics rather than a
 * general-purpose ordering rule.
 */
export function compareOwner(a: string | null, b: string | null): number {
  if (a === b) {
    return 0;
  }
  if (a == null) {
    return 1;
  }
  if (b == null) {
    return -1;
  }
  return compareStrings(a, b);
}

/**
 * Code-unit string ordering for grouped projection keys (model names, hour
 * buckets) that both the desktop main process and the renderer sort.
 *
 * These keys are machine identifiers rather than prose, which is exactly
 * `ListQueryTextOrdering.CodeUnit`. Delegating rather than re-deriving is what
 * keeps a retune of the ruling from moving the list mirrors and leaving these
 * buckets behind (ISS-9585).
 */
export function compareStrings(a: string, b: string): number {
  return compareListQueryText(a, b, ListQueryTextOrdering.CodeUnit);
}
