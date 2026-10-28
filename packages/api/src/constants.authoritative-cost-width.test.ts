/**
 * ISS-7229 (marisolashgrove on #6406): the width bound must ROUND before it
 * compares, because every writer stores `toFixed(6)`.
 *
 * The bound this replaced was five separate `<` / `>=` inequalities against
 * `MAX_AUTHORITATIVE_COST_USD`. Each admitted the same sliver: a value under the
 * ceiling by less than half a micro-dollar rounds UP to nine integer digits on
 * the way into a `Decimal(14, 6)` column, and the driver raises 22003 inside the
 * transaction the bound exists to protect.
 */
import { describe, expect, it } from "vitest";
import {
  canStoreAuthoritativeCostUsd,
  MAX_AUTHORITATIVE_COST_USD,
} from "./constants";

/**
 * The largest double strictly below the ceiling, DERIVED rather than written
 * out: the window is about 1.5e-8 wide, narrower than a decimal literal can
 * name — spelling one lands on a neighbouring double that rounds down, and the
 * case then passes against the broken bound too.
 */
const ROUNDS_PAST_THE_CEILING =
  MAX_AUTHORITATIVE_COST_USD -
  (Number.EPSILON * MAX_AUTHORITATIVE_COST_USD) / 2;

describe("canStoreAuthoritativeCostUsd", () => {
  it("refuses a figure that only exceeds the column AFTER rounding", () => {
    // The regression the predicate exists for: strictly below the ceiling, so
    // every inequality this replaced said yes.
    expect(ROUNDS_PAST_THE_CEILING).toBeLessThan(MAX_AUTHORITATIVE_COST_USD);
    expect(canStoreAuthoritativeCostUsd(ROUNDS_PAST_THE_CEILING)).toBe(false);
  });

  it("accepts the largest figure that still rounds inside the column", () => {
    // The other half — without it, `() => false` would satisfy the case above.
    expect(canStoreAuthoritativeCostUsd(99_999_999.999_999)).toBe(true);
    // And it is genuinely below the one above, so the two cases sit on opposite
    // sides of the boundary rather than both landing on the same double.
    expect(99_999_999.999_999).toBeLessThan(ROUNDS_PAST_THE_CEILING);
  });

  it("accepts a reported zero, which is a measurement and not an absence", () => {
    expect(canStoreAuthoritativeCostUsd(0)).toBe(true);
  });

  it("refuses non-finite figures", () => {
    expect(canStoreAuthoritativeCostUsd(Number.NaN)).toBe(false);
    expect(canStoreAuthoritativeCostUsd(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("judges width alone, leaving sign policy to each caller", () => {
    // Deliberate: the wire schema refuses a negative itself, and the read parse
    // tolerates one it may already have stored. Folding sign in here would
    // silently change what the read does with an existing row.
    expect(canStoreAuthoritativeCostUsd(-1)).toBe(true);
  });
});
