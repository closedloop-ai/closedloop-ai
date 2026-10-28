/**
 * The portable Projects row. ISS-10476 promoted the Web Master Projects screens
 * out of `apps/prototypes`, and the fixture-shaped model came with them: the
 * prototype carried `updated` / `dueDate` as DISPLAY STRINGS ("4 days ago",
 * "8/14/26") and re-parsed them against a frozen reference clock to sort and
 * filter. A shared surface cannot hold a clock, so each date arrives as two
 * fields — the host's own label, and the instant the surface orders by.
 */

import type { PriorityValue } from "@repo/design-system/lib/priority-order";

export type ProjectSummaryOwner = {
  /**
   * The owner's stable id, when the host holds one. Present so a host can map a
   * board drop back onto the person it must persist; the prototype's fixture
   * people have no ids and omit it.
   */
  readonly id?: string;
  /** Display name of the person who owns the project. */
  readonly name: string;
  readonly initials: string;
  /**
   * The owner's profile image, when the host holds one. Present so a host whose
   * records carry a photo renders the photo rather than silently downgrading
   * every owner to initials; the prototype's fixture people have none.
   */
  readonly avatarUrl?: string;
};

export type ProjectSummaryRow = {
  readonly id: string;
  /** Short human key ("PRO-53"), or null for a project that has none. */
  readonly code: string | null;
  readonly name: string;
  /**
   * Percentage of child tasks that are done, or `null` when there is no
   * population to take a percentage of. `null` is NOT 0% — the completion ring
   * renders its empty treatment for it rather than an unstarted ring.
   */
  readonly completionPercentage: number | null;
  /** Size of the population above; `null` when the host does not hold it. */
  readonly childTaskCount: number | null;
  /** `null` is "no priority" — the artifact priority contract (ISS-9833). */
  readonly priority: PriorityValue | null;
  readonly owner: ProjectSummaryOwner | null;
  /** Host-formatted due date, or null when unset. */
  readonly dueDateLabel: string | null;
  /** Due date as epoch ms, for sorting. Null sorts after every dated row. */
  readonly dueDateMs: number | null;
  /** Host-formatted "updated" label. */
  readonly updatedLabel: string;
  /** Updated instant as epoch ms, for sorting and date-window filters. */
  readonly updatedAtMs: number | null;
  /**
   * What the completion percentage is a percentage OF, in the words the tooltip
   * uses. Hosts count different populations — the prototype counts child tasks,
   * the product counts a project's documents (ISS-4636) — so the ring's
   * accessible name has to say which rather than assume one.
   */
  readonly completionPopulationLabel?: string;
};

const DEFAULT_COMPLETION_POPULATION_LABEL = "child tasks";

/**
 * What the completion percentage counts, in the words every surface must use.
 * One reader of `completionPopulationLabel`, so the ring and the progress filter
 * beside it cannot name the same population two different things.
 */
export function projectCompletionPopulation(row: ProjectSummaryRow): string {
  return row.completionPopulationLabel ?? DEFAULT_COMPLETION_POPULATION_LABEL;
}

/**
 * The owner's grouping and filtering IDENTITY. The display name is not one:
 * two people who share a name would merge into one band and one filter option.
 * Falls back to the name only for a host whose people have no ids at all (the
 * prototype fixtures), where the name is the only identity there is.
 */
export function projectOwnerKey(owner: ProjectSummaryOwner): string {
  return owner.id ?? owner.name;
}

/** Completion has a denominator only when there are child tasks to count. */
export function projectCompletionValue(row: ProjectSummaryRow): number | null {
  if (row.childTaskCount === 0) {
    return null;
  }
  return row.completionPercentage;
}

export function projectCompletionLabel(row: ProjectSummaryRow): string {
  const population = projectCompletionPopulation(row);
  if (row.childTaskCount === 0) {
    return `No ${population} yet`;
  }
  if (row.completionPercentage === null) {
    return `Progress over ${population} is not available`;
  }
  return `${Math.round(row.completionPercentage)}% of ${population} are Done`;
}
