import {
  Priority,
  type Priority as PriorityType,
} from "@repo/api/src/types/common";

const PRIORITY_SORT_ORDER: Record<PriorityType, number> = {
  [Priority.Urgent]: 0,
  [Priority.High]: 1,
  [Priority.Medium]: 2,
  [Priority.Low]: 3,
};

export function comparePriorityValues(
  aPriority: PriorityType | null | undefined,
  bPriority: PriorityType | null | undefined
): number {
  if (!(aPriority || bPriority)) {
    return 0;
  }
  if (!aPriority) {
    return 1;
  }
  if (!bPriority) {
    return -1;
  }
  return PRIORITY_SORT_ORDER[aPriority] - PRIORITY_SORT_ORDER[bPriority];
}
