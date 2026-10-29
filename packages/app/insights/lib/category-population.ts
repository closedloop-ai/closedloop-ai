import type {
  CategoryBucket,
  CategoryPopulation,
} from "@closedloop-ai/loops-api/insights";

/**
 * The population a capped category breakdown is a prefix of (ISS-9842), or
 * `undefined` when the buckets carry none or carry one that cannot be true.
 *
 * Every bucket must carry the same `population`, every count — both population
 * fields and each bucket's value — must be a non-negative safe integer, and the
 * pair must be consistent with the prefix it rides on: at least as many
 * categories as buckets; when every category is
 * present the total IS the slice sum; when some are omitted the total exceeds
 * the slice sum by at least one unit per omitted category. Anything else is
 * treated as unknown rather than rendered — a wrong denominator is the defect
 * this helper exists to remove, and a fabricated one is no better. Browser
 * code, so the bad value is dropped, not logged.
 */
export function categoryPopulation(
  buckets: readonly CategoryBucket[]
): CategoryPopulation | undefined {
  const first = buckets[0]?.population;
  if (first === undefined) {
    return undefined;
  }
  if (!(isCount(first.total) && isCount(first.categories))) {
    return undefined;
  }
  let sliceSum = 0;
  for (const bucket of buckets) {
    const population = bucket.population;
    if (
      population === undefined ||
      population.total !== first.total ||
      population.categories !== first.categories ||
      !isCount(bucket.value)
    ) {
      return undefined;
    }
    sliceSum += bucket.value;
  }
  const omitted = first.categories - buckets.length;
  if (omitted < 0) {
    return undefined;
  }
  const consistent =
    omitted === 0
      ? first.total === sliceSum
      : first.total >= sliceSum + omitted;
  if (!consistent) {
    return undefined;
  }
  return { total: first.total, categories: first.categories };
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
