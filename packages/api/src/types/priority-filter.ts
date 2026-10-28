import type { Priority } from "./common.ts";
import { isPriority } from "./priority-contract.ts";
import { PRIORITY_UNSET_VALUE, PRIORITY_VALUES } from "./search-query.ts";

/**
 * ISS-10332 — what a list's priority FILTER may select: a priority member, or
 * {@link PRIORITY_UNSET_VALUE} for artifacts that hold none. The unset token is
 * the search grammar's own, imported rather than re-spelled, so `:priority=NONE`
 * and a list facet name "no priority" identically.
 */
export type PriorityFilterValue = Priority | typeof PRIORITY_UNSET_VALUE;

/** Low→high, unset last. Derived, so a new `Priority` member arrives for free. */
export const PRIORITY_FILTER_VALUES: readonly PriorityFilterValue[] = [
  ...PRIORITY_VALUES,
  PRIORITY_UNSET_VALUE,
];

export type PriorityFilterSelection = {
  members: Priority[];
  includesUnset: boolean;
};

/**
 * The two arms a selection resolves to. They cannot share one `IN (...)`: the
 * unset arm is `IS NULL`, which no value list matches.
 */
export function splitPriorityFilter(
  values: readonly PriorityFilterValue[] | undefined
): PriorityFilterSelection {
  const selected = values ?? [];
  return {
    members: [...new Set(selected.filter(isPriority))],
    includesUnset: selected.includes(PRIORITY_UNSET_VALUE),
  };
}

/**
 * Does a row's priority satisfy the selection? An empty selection admits all.
 *
 * OMITTED IS NOT UNSET. `undefined` is a producer that does not know the row's
 * priority (an older API or Desktop build, or a stored value outside this
 * build's vocabulary), so
 * it satisfies NO arm of an active selection — answering the unset arm for it
 * would assert "holds no priority" about a value nobody read.
 */
export function matchesPriorityFilter(
  priority: Priority | null | undefined,
  values: readonly PriorityFilterValue[] | undefined
): boolean {
  if (!values || values.length === 0) {
    return true;
  }
  if (priority === undefined) {
    return false;
  }
  return values.includes(priority ?? PRIORITY_UNSET_VALUE);
}
