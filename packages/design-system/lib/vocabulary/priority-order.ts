/**
 * The one semantic model for the generic artifact `priority` field.
 *
 * Domain-free on purpose — this package may not import `@repo/api` or
 * `@closedloop-ai/loops-api` — so the vocabulary is spelled literally here and bound to
 * the persisted `Priority` enum in `@repo/app/shared/lib/priority-constants`.
 */

/**
 * Semantic order, most urgent first. This array — never a value set's
 * declaration order, which is an authoring accident — is what sorting,
 * grouping, filter options and editor options read.
 */
export const PRIORITY_VALUES_HIGHEST_FIRST = [
  "URGENT",
  "HIGH",
  "MEDIUM",
  "LOW",
] as const;
export type PriorityValue = (typeof PRIORITY_VALUES_HIGHEST_FIRST)[number];

export const PRIORITY_VALUES_LOWEST_FIRST = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "URGENT",
] as const satisfies readonly PriorityValue[];

/** Ranks after every known value, so unset sorts last in an urgent-first list. */
export const PRIORITY_RANK_NONE = PRIORITY_VALUES_HIGHEST_FIRST.length;

export const PRIORITY_LABEL_NONE = "No priority";
export const PRIORITY_LABEL_UNKNOWN = "Unknown priority";

/** Lookup only: read an explicit order array to decide presentation order. */
export const PRIORITY_LABELS = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  URGENT: "Urgent",
} as const satisfies Readonly<Record<PriorityValue, string>>;

// Spelled out rather than derived from array indices so it is exhaustive by
// construction: a new value fails typecheck instead of ranking as unset.
export const PRIORITY_ORDINAL = {
  URGENT: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
} as const satisfies Readonly<Record<PriorityValue, number>>;

/** `Object.hasOwn`, not `in`, so prototype keys are not members. */
export function isPriorityValue(value: string): value is PriorityValue {
  return Object.hasOwn(PRIORITY_ORDINAL, value);
}

/**
 * Takes any string because group keys and persisted filter values arrive
 * unnarrowed; anything outside the vocabulary ranks as unset.
 */
export function priorityRank(priority: string | null | undefined): number {
  if (!priority) {
    return PRIORITY_RANK_NONE;
  }
  return isPriorityValue(priority)
    ? PRIORITY_ORDINAL[priority]
    : PRIORITY_RANK_NONE;
}

/**
 * The one priority comparator: most urgent first, unset last. Compares rank,
 * never the spelling — lexicographically, URGENT sorts last.
 */
export function comparePriorityByRank(
  left: string | null | undefined,
  right: string | null | undefined
): number {
  return priorityRank(left) - priorityRank(right);
}

/**
 * The label a menu option or group-section header shows. A grid *cell* renders
 * `GridEmptyValue` for an unset priority rather than these words.
 */
export function priorityLabel(priority: string | null | undefined): string {
  if (priority == null) {
    return PRIORITY_LABEL_NONE;
  }
  if (!isPriorityValue(priority)) {
    return PRIORITY_LABEL_UNKNOWN;
  }
  return PRIORITY_LABELS[priority];
}
