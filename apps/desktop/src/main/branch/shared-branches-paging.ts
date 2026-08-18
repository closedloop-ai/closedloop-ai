import type { BranchRow } from "@repo/api/src/types/branch";

/**
 * Output-shaping for the desktop Branches list projection: narrowing the
 * projected rows to a requested id set, then paging them. Extracted from
 * `shared-branches-api.ts` (ISS-4689) — both are pure functions over an
 * already-projected `BranchRow[]` with no reads, no source, and no wire concerns,
 * so they belong beside each other rather than inside the serving-op module.
 */

/**
 * Narrow the projected list to a requested id set (the contract advertises
 * narrow id reads). Sanitizes to non-empty strings and dedupes; an absent or
 * all-garbage `ids` returns the full list unchanged.
 */
export function selectRequestedBranches(
  items: BranchRow[],
  ids: readonly string[] | undefined
): BranchRow[] {
  if (!ids || ids.length === 0) {
    return items;
  }
  const wanted = new Set<string>();
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0) {
      wanted.add(id);
    }
  }
  if (wanted.size === 0) {
    return items;
  }
  return items.filter((item) => wanted.has(item.id));
}

/**
 * Page the projected output. `offset`/`limit` are clamped to non-negative
 * integers (a missing limit returns the rest from `offset`). The reads are
 * already bounded grouped queries; paging the output caps the IPC payload so a
 * large local corpus can't ship the whole list at once.
 */
export function pageBranches(
  items: BranchRow[],
  limit: number | undefined,
  offset: number | undefined
): BranchRow[] {
  const start = Math.max(0, Math.trunc(offset ?? 0));
  if (limit == null) {
    return items.slice(start);
  }
  return items.slice(start, start + Math.max(0, Math.trunc(limit)));
}
