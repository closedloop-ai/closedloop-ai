import { Priority } from "@repo/api/src/types/common";

/**
 * ISS-9665, flag-OFF path: restore the pre-fix rendering of an artifact whose
 * priority is genuinely unset.
 *
 * The API now reports `null` honestly at every endpoint, so a surface that has
 * not yet opted into the unset affordances would start showing blanks where it
 * showed `Medium`. That is a user-perceivable change, and the closed-by-default
 * UI policy (ISS-4779) says it waits behind
 * `ARTIFACT_PRIORITY_UNSET_FLAG_KEY`.
 *
 * Applied to the ROW MODEL, never at the cell. Grouping, the constant-column
 * collapse rule, and the sort comparator all read `row.priority` independently,
 * so substituting only where the value is painted would let the cell say
 * `Medium` while the section header above it said "No priority" — a screen
 * disagreeing with itself, which is worse than either answer alone.
 *
 * `Priority.Medium` and not some other member because that is exactly what
 * `toDocument` folded to, and the whole contract of the flag-off path is "what
 * shipped before".
 */
export function withPriorityDisplayFallback<
  T extends { priority: Priority | null },
>(rows: readonly T[]): T[] {
  return rows.map((row) =>
    row.priority === null ? { ...row, priority: Priority.Medium } : row
  );
}

/**
 * Single-value form of {@link withPriorityDisplayFallback}. Constrained on the
 * field alone so a project, which shares the artifact priority contract
 * (ISS-9441), folds through the same substitution as a document.
 */
export function priorityDisplayFallback<
  T extends { priority: Priority | null },
>(row: T): T {
  return row.priority === null ? { ...row, priority: Priority.Medium } : row;
}
