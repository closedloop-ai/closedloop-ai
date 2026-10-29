"use client";

import {
  DEFAULT_SESSION_FACET_FILTERS,
  SESSION_FACET_FILTER_PARAMS,
  type SessionFacetFilters,
} from "../../lib/session-filter-adapter";

/**
 * Every facet key, read off the canonical URL-param registry rather than listed
 * again. A facet added to `SessionFacetFilters` lands in that map to get a URL
 * param, so deriving from it stops this module silently ignoring a facet the
 * rest of the app already filters by.
 */
export const SESSION_FACET_KEYS = Object.keys(
  SESSION_FACET_FILTER_PARAMS
) as readonly (keyof SessionFacetFilters)[];

/** Every facet emptied, for a "Clear all" that must reach all of them. */
export const CLEARED_SESSION_FACETS: SessionFacetFilters =
  DEFAULT_SESSION_FACET_FILTERS;

/**
 * One facet toggle, applied to the selection a running commit has reached so
 * far (`current`) but with its DIRECTION decided by the selection the user
 * actually saw (`rendered`).
 *
 * Splitting those two is what makes a multi-toggle click correct.
 * `ActiveFiltersBar` clears a facet — from its "Clear all" and from a chip's
 * remove alike — by replaying one `onToggle` per selected value, synchronously
 * and with no render between, so a single click reaches this once per value:
 *
 *  - Reading membership from `current` alone flips direction mid-sequence.
 *    Clearing `active,error` removed `active`, then found `error` in the pair it
 *    had already shortened and removed that, leaving `active` selected — the
 *    defect whitlockk reported (#5566). With a one-value facet there is no second
 *    toggle, which is why it went unnoticed.
 *  - Reading membership from `rendered` alone re-adds. "Clear all" empties both
 *    facets first, so every replayed toggle then found its value absent and put
 *    it back.
 *
 * Taking the direction from `rendered` makes each replayed toggle mean what the
 * user's click meant — "this value was on screen, take it off" — and applying it
 * to `current` makes it idempotent, so it composes with the clear that preceded
 * it instead of undoing it.
 */
export function applyFacetToggle(
  current: readonly string[],
  rendered: readonly string[],
  value: string
): string[] {
  if (rendered.includes(value)) {
    return current.filter((candidate) => candidate !== value);
  }
  // Idempotent on the add side too: a value already selected upstream in this
  // same commit must not be listed twice.
  return current.includes(value) ? [...current] : [...current, value];
}

/**
 * Recover a toggle's INTENT from the whole-object result the canonical builder
 * reports, and re-express it as a patch.
 *
 * That builder derives `next` from the `filters` it was handed at RENDER time,
 * so stored verbatim all nine facets would carry the #5566 defect
 * {@link applyFacetToggle} exists to prevent. Diffing `next` against that
 * snapshot recovers which facet and which values flipped, which is enough to
 * re-apply them functionally. Falls back to `next` when the change is not a
 * single-facet toggle — a shape this builder does not emit.
 */
export function reconcileFacetChange(
  rendered: SessionFacetFilters,
  next: SessionFacetFilters
): (current: SessionFacetFilters) => SessionFacetFilters {
  const changed = SESSION_FACET_KEYS.filter(
    (key) => !isSameSelection(rendered[key], next[key])
  );
  const key = changed[0];
  if (changed.length !== 1 || key === undefined) {
    return () => next;
  }
  const flipped = symmetricDifference(rendered[key], next[key]);
  return (current) => {
    let values = current[key];
    for (const value of flipped) {
      values = applyFacetToggle(values, rendered[key], value);
    }
    return { ...current, [key]: values };
  };
}

function isSameSelection(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function symmetricDifference(
  left: readonly string[],
  right: readonly string[]
): string[] {
  const inLeft = new Set(left);
  const inRight = new Set(right);
  return [
    ...left.filter((value) => !inRight.has(value)),
    ...right.filter((value) => !inLeft.has(value)),
  ];
}
