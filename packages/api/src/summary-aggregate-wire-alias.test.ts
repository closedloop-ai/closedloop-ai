/**
 * @file summary-aggregate-wire-alias.test.ts
 * @description ISS-6409 (#6417 review): the `avgLocPerDollar` wire key is the
 * only cross-repo contract change in this work, and it shipped with no test in
 * either direction — both the emit and the (since-removed) read arm could be
 * deleted with every suite green.
 *
 * The asymmetry is the contract, and it is deliberate: the rename changed the
 * ESTIMAND, not just the spelling. A producer predating it put the unweighted
 * MEAN of the rows' ratios under this key — the number ISS-6409 was filed to
 * remove, which read ~1,070 where the real rate was ~30. So the key is emitted
 * (an installed Desktop build keeps a number, and now a correct one) and never
 * read back (a new client must not resurrect the retired estimand).
 */
import { describe, expect, it } from "vitest";
import {
  deserializeSummaryAggregate,
  type SerializedSummaryAggregate,
  serializeSummaryAggregate,
} from "./utils/agent-component-page-data.ts";
import type { SummaryAggregate } from "./utils/agent-component-summary-aggregate.ts";

function aggregate(locPerDollar: number | null): SummaryAggregate {
  return {
    collaborators: 1,
    components: 2,
    hasVerifiableLocPerDollar: true,
    invocations: 10,
    invocationsExact: true,
    invocationsPluginCoverage: new Map(),
    locPerDollar,
    locPerDollarSampleSize: locPerDollar === null ? 0 : 2,
  };
}

describe("avgLocPerDollar wire alias (ISS-6409)", () => {
  it("emits the legacy key alongside the canonical one", () => {
    const wire = serializeSummaryAggregate(aggregate(30.26));

    expect(wire.locPerDollar).toBeCloseTo(30.26, 2);
    expect(wire.avgLocPerDollar).toBe(wire.locPerDollar);
  });

  it("emits a legacy null rather than a fabricated zero", () => {
    // The old contract declared the field `number | null`, so an old reader
    // expects null and renders the unavailable dash. A 0 would be a measured
    // claim the producer never made.
    const wire = serializeSummaryAggregate(aggregate(null));

    expect(wire.avgLocPerDollar).toBeNull();
    expect(wire.avgLocPerDollar).not.toBe(0);
  });

  it("does NOT read the legacy key back — it carries the retired estimand", () => {
    // A pre-rename producer's `avgLocPerDollar` is the unweighted mean of the
    // rows' ratios, not an old name for this value. Recovering it would put
    // ISS-6409's own defect back on screen under copy that promises a ratio of
    // totals, so an absent canonical value stays absent and the card reads `—`.
    // A pre-rename producer: the canonical key is absent entirely, which the
    // current type cannot express (it declares `locPerDollar` required), so
    // the omission is built by deleting it from a valid shape rather than by
    // casting a hand-written literal.
    const { locPerDollar: _absent, ...legacyOnly } = {
      ...serializeSummaryAggregate(aggregate(30.26)),
      avgLocPerDollar: 1070,
    };

    const hydrated = deserializeSummaryAggregate(
      legacyOnly as SerializedSummaryAggregate
    );

    expect(hydrated.locPerDollar).toBeUndefined();
    expect(hydrated.locPerDollar).not.toBe(1070);
    // The alias must not survive onto the in-process shape either.
    expect(Object.hasOwn(hydrated, "avgLocPerDollar")).toBe(false);
  });

  it("round-trips the canonical value unchanged", () => {
    const hydrated = deserializeSummaryAggregate(
      serializeSummaryAggregate(aggregate(5.2))
    );

    expect(hydrated.locPerDollar).toBe(5.2);
    expect(serializeSummaryAggregate(hydrated).avgLocPerDollar).toBe(5.2);
  });
});
