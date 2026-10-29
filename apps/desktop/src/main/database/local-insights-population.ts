import type { CategoryPopulation } from "@closedloop-ai/loops-api/insights";
import { nullableNumber } from "./db-helpers.js";

type WindowValue = number | bigint | string | null | undefined;

type WindowPopulationRow = {
  total: WindowValue;
  categories: WindowValue;
};

/**
 * ISS-9842: the `population` a capped category breakdown carries on every
 * bucket, from the `SUM(COUNT(*)) OVER () AS total` / `COUNT(*) OVER () AS
 * categories` pair the query computes before its LIMIT.
 *
 * Degrades by OMISSION. A window value that carries no number means the
 * population is unknown, and an unknown denominator must not be serialized as
 * 0 (the ring would divide by it and read every slice as infinite) or as
 * `null` (an installed client that predates the field may not accept it). The
 * KPI beside the chart keeps its own `numberOrZero` read: there, absent
 * genuinely means none.
 */
export function windowPopulationField(row: WindowPopulationRow): {
  population?: CategoryPopulation;
} {
  const total = nullableNumber(row.total);
  const categories = nullableNumber(row.categories);
  if (total === null || categories === null) {
    return {};
  }
  return { population: { total, categories } };
}
