import {
  type PriorityFilterValue,
  splitPriorityFilter,
} from "@repo/api/src/types/priority-filter";
import type { Prisma } from "@repo/database";

/**
 * ISS-10332: the Sessions priority facet, as a predicate on the parent
 * `artifacts.priority` column. `null` when nothing is selected, so the caller
 * adds no clause rather than an always-true one.
 *
 * The unset arm is its own `priority: null` conjunct ORed with the member list:
 * `IN (...)` never matches NULL, so folding the unset token into the list would
 * silently select nothing for it.
 */
export function buildPriorityFacetWhere(
  priorities: readonly PriorityFilterValue[] | undefined
): Prisma.ArtifactWhereInput | null {
  if (!priorities || priorities.length === 0) {
    return null;
  }
  const { members, includesUnset } = splitPriorityFilter(priorities);
  const arms: Prisma.ArtifactWhereInput[] = [];
  if (members.length > 0) {
    arms.push({ priority: { in: members } });
  }
  if (includesUnset) {
    arms.push({ priority: null });
  }
  return { OR: arms };
}
