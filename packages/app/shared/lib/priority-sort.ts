import type { Priority as PriorityType } from "@repo/api/src/types/common";
import { comparePriorityByRank } from "@repo/design-system/lib/priority-order";

/**
 * Orders artifacts most urgent first with an unset priority last. Delegates so
 * this and the cells showing the same values cannot disagree on rank; callers
 * consume the sign, not the magnitude.
 */
export function comparePriorityValues(
  aPriority: PriorityType | null | undefined,
  bPriority: PriorityType | null | undefined
): number {
  return comparePriorityByRank(aPriority, bPriority);
}

export function comparePriorityValuesForSort(
  aPriority: PriorityType | null | undefined,
  bPriority: PriorityType | null | undefined,
  direction: "asc" | "desc"
): number {
  const aMissing = aPriority == null;
  const bMissing = bPriority == null;
  if (aMissing && bMissing) {
    return 0;
  }
  if (aMissing) {
    return 1;
  }
  if (bMissing) {
    return -1;
  }

  const result = comparePriorityValues(aPriority, bPriority);
  return direction === "asc" ? result : -result;
}
