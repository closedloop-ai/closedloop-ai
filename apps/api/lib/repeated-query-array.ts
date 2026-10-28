import { z } from "zod";

/**
 * A repeated query param, as `parseQueryParams` hands it over: a string for one
 * value, `string[]` for several. Both normalize to an array.
 *
 * Deduped on the RAW value, before element parsing, and only then bounded: the
 * width to bound is what arrives, not what survives parsing (ISS-7271). A
 * caller repeating one valid value thousands of times collapses to one entry
 * and parses; a caller sending more than `max` DISTINCT values is rejected
 * whole, never truncated, with the issue path naming the param (ISS-9073).
 *
 * Two spellings, differing only in what an ABSENT param parses to. `undefined`
 * keeps an optional facet distinguishable from an empty one; `[]` is for
 * surfaces whose every facet is "unnarrowed" when absent.
 */
export function repeatedQueryArray<T extends z.ZodTypeAny>(
  element: T,
  max: number
) {
  return normalizedArray(element, max).optional();
}

export function repeatedQueryArrayOrEmpty<T extends z.ZodTypeAny>(
  element: T,
  max: number
) {
  return normalizedArray(element, max).default([]);
}

// `.optional()` and `.default()` both answer an absent param themselves, so
// this preprocess only ever sees a present value.
function normalizedArray<T extends z.ZodTypeAny>(element: T, max: number) {
  return z.preprocess(
    (value) => (Array.isArray(value) ? [...new Set(value)] : [value]),
    z.array(element).max(max)
  );
}
