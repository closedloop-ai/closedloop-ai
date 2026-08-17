/**
 * @file subscription-billing-mode-parity.test.ts
 * @description FEA-3104 cross-surface parity guard.
 *
 * `packages/api/src/types/billing-mode.ts` hard-codes
 * SUBSCRIPTION_BILLING_MODES,
 * a copy of the desktop's canonical SUBSCRIPTION_MODES
 * (`apps/desktop/src/shared/billing-mode.ts`). The API uses it to attribute
 * DESKTOP_SYNC session cost to the subscription (hypothetical) ledger rather than
 * the metered/API (real-spend) ledger. The two sets must stay byte-identical:
 * if a future desktop subscription tier is added to SUBSCRIPTION_MODES but not to
 * this copy, that tier's cost is silently misreported into the metered/API bucket
 * for DESKTOP_SYNC sessions — a cost-misreporting parity bug.
 *
 * This test mirrors the existing BILLING_MODES parity assertion in
 * `apps/desktop/test/billing-mode.test.ts` (the sibling BILLING_MODES ↔ ledger
 * pair): it imports BOTH sets and asserts they are exactly equal (as sorted
 * arrays), binding the copy to the canonical source so any divergence fails CI.
 *
 * Boot-path safety (FEA-3104 caveat, #1618/#1620): the desktop billing-mode
 * module is a pure leaf (its only import is `node:path`), and the import here
 * lives in a TEST — it never enters the desktop-main runtime graph, so it cannot
 * regress the pglite boot path. Nothing in this change makes desktop-main import
 * a runtime value from `@repo/api`.
 */

import {
  isMeteredBillingMode,
  isSubscriptionBillingMode,
  METERED_BILLING_MODES,
  SUBSCRIPTION_BILLING_MODES,
} from "@repo/api/src/types/billing-mode";
import {
  addLedgerCost,
  BILLING_MODES,
  billingLedger,
  emptyLedgerTotals,
  headlineCost,
  METERED_MODES,
  normalizeBillingMode,
  SUBSCRIPTION_MODES,
} from "../../../desktop/src/shared/billing-mode";

function sorted(set: ReadonlySet<string>): string[] {
  return [...set].sort();
}

describe("SUBSCRIPTION_BILLING_MODES ↔ desktop SUBSCRIPTION_MODES parity (FEA-3104)", () => {
  it("the API copy is exactly equal to the desktop canonical set", () => {
    expect(sorted(SUBSCRIPTION_BILLING_MODES)).toEqual(
      sorted(SUBSCRIPTION_MODES)
    );
  });

  it("both sets pin the same 7 subscription-covered modes", () => {
    // Pins the reviewed membership so a change on EITHER side is caught even if
    // both diverge in the same direction. Kept sorted to match the desktop
    // billing-mode.test.ts convention.
    //
    // ISS-5445: `opencode` is deliberately ABSENT. It names a harness, not a
    // payment method, and OpenCode is bring-your-own-key — so it cannot imply
    // subscription coverage. Classification happens from the MODEL at detection
    // time instead (`detectOpencodeBillingMode`).
    const expected = [
      "codex_subscription",
      "copilot_seat",
      "cursor_pro",
      "max_20x",
      "max_5x",
      "pro",
      "subscription_unknown",
    ];
    expect(sorted(SUBSCRIPTION_BILLING_MODES)).toEqual(expected);
    expect(sorted(SUBSCRIPTION_MODES)).toEqual(expected);
  });
});

describe("METERED_BILLING_MODES ↔ desktop METERED_MODES parity (ISS-4773)", () => {
  it("the API copy is exactly equal to the desktop canonical set", () => {
    expect(sorted(METERED_BILLING_MODES)).toEqual(sorted(METERED_MODES));
  });

  it("both sets pin the same 2 confirmed-metered modes", () => {
    const expected = ["api", "cursor_api"];
    expect(sorted(METERED_BILLING_MODES)).toEqual(expected);
    expect(sorted(METERED_MODES)).toEqual(expected);
  });

  it("the two sets are disjoint, so no mode can be both covered and billed", () => {
    // The three-way split assumes a mode lands in at most ONE named ledger; an
    // overlap would double-count that spend into both the headline and the
    // subscription caption.
    const overlap = [...METERED_BILLING_MODES].filter((mode) =>
      SUBSCRIPTION_BILLING_MODES.has(mode)
    );
    expect(overlap).toEqual([]);
  });
});

/**
 * ISS-5445 — the two surfaces must AGREE about a mode, not merely hold equal
 * sets. The tests above compare the two sets; these execute each surface's own
 * public decision function over the whole union, which is what a session's
 * reported ledger actually goes through on desktop (`billingLedger`) and in the
 * cloud (`isSubscriptionBillingMode` / `isMeteredBillingMode`). A refactor that
 * kept the sets equal but changed one side's predicate would pass the former and
 * fail these.
 */
describe("desktop ↔ cloud classification agreement over the whole union (ISS-5445)", () => {
  it("every mode is classified identically by both surfaces' decision functions", () => {
    for (const mode of BILLING_MODES) {
      const ledger = billingLedger(mode);
      expect({ mode, subscription: isSubscriptionBillingMode(mode) }).toEqual({
        mode,
        subscription: ledger === "subscription",
      });
      expect({ mode, metered: isMeteredBillingMode(mode) }).toEqual({
        mode,
        metered: ledger === "metered",
      });
    }
  });

  it("opencode is NOT subscription-covered on either surface (ISS-5445 ruling)", () => {
    // The operator ruling: "opencode doesn't guarantee a free model — the cost
    // should be associated with the model; not the harness." The bare value
    // names a harness, so on both surfaces it must classify as UNDETERMINED,
    // never as subscription-covered. Asserted through the decision functions,
    // not the set literals, so re-adding `opencode` to either set fails here as
    // well as in the parity assertions above.
    expect(billingLedger("opencode")).toBe("unknown");
    expect(isSubscriptionBillingMode("opencode")).toBe(false);
    expect(isMeteredBillingMode("opencode")).toBe(false);
  });

  it("keeps the honest branch reachable: the literal `unknown` is still unknown", () => {
    // The point of the ruling was to shrink the unclassified bucket by moving a
    // mode whose billing method WAS known — not to make the bucket unreachable.
    // A genuinely undetectable session must still read unknown on both surfaces.
    expect(billingLedger("unknown")).toBe("unknown");
    expect(isSubscriptionBillingMode("unknown")).toBe(false);
    expect(isMeteredBillingMode("unknown")).toBe(false);
  });

  it("an unrecognized peer value degrades to unknown on both surfaces, and never throws", () => {
    // Version skew: a newer peer can send a mode this build has never heard of.
    // It must be reported as unclassified rather than guessed into a bucket, and
    // must not throw — `BillingMode` is a stable additive union on the relay
    // sync contract.
    const fromFutureBuild = "anthropic_flex_2027";
    expect(() =>
      billingLedger(normalizeBillingMode(fromFutureBuild))
    ).not.toThrow();
    expect(billingLedger(normalizeBillingMode(fromFutureBuild))).toBe(
      "unknown"
    );
    expect(isSubscriptionBillingMode(fromFutureBuild)).toBe(false);
    expect(isMeteredBillingMode(fromFutureBuild)).toBe(false);
    for (const junk of [null, undefined, "", 42, {}, []]) {
      expect(isSubscriptionBillingMode(junk)).toBe(false);
      expect(isMeteredBillingMode(junk)).toBe(false);
      expect(billingLedger(normalizeBillingMode(junk))).toBe("unknown");
    }
  });

  it("emits no re-classified wire value, so there is no skew window at all", () => {
    // ISS-5445 changed DETECTION (harness ⇒ model), not the meaning of any
    // stored string. A model-priced OpenCode session is now stamped `'api'`, a
    // value every peer already understands and already buckets as metered, so
    // old and new peers agree on every member of the union — there is nothing
    // for a coordinated deploy to protect.
    const classifyOnPeer = (mode: string): string => {
      if (METERED_BILLING_MODES.has(mode)) {
        return "metered";
      }
      return SUBSCRIPTION_BILLING_MODES.has(mode) ? "subscription" : "unknown";
    };
    for (const mode of BILLING_MODES) {
      expect({ mode, ledger: classifyOnPeer(mode) }).toEqual({
        mode,
        ledger: billingLedger(mode),
      });
    }
    // The value a newly-classified paid OpenCode session carries is the ordinary
    // metered one, not a new token an older peer would have to learn.
    expect(classifyOnPeer("api")).toBe("metered");
    expect(billingLedger("api")).toBe("metered");
  });
});

describe("ledger totals still reconcile to total spend after the move (ISS-5445)", () => {
  it("the three buckets sum to total spend across a mixed corpus", () => {
    // Reconciliation is the invariant the ruling must not break: re-bucketing
    // moves money BETWEEN ledgers, never out of the total.
    const corpus = BILLING_MODES.map((mode, index) => ({
      mode,
      cost: (index + 1) * 1.25,
    }));
    const totals = corpus.reduce(
      (acc, row) => addLedgerCost(acc, row.mode, row.cost),
      emptyLedgerTotals()
    );
    const expectedTotal = corpus.reduce((sum, row) => sum + row.cost, 0);
    expect(totals.metered + totals.subscription + totals.unknown).toBeCloseTo(
      expectedTotal,
      10
    );
  });

  it("paid OpenCode spend REACHES the headline; only covered spend is excluded", () => {
    // RETARGETED (ISS-5445, operator ruling 2026-08-07). This test previously
    // asserted the opposite — that $2,265.56 of opencode cost landed in the
    // subscription bucket and left the headline entirely. That encoded the
    // premise review overturned: OpenCode is bring-your-own-key, so its spend
    // can be real out-of-pocket money, and zeroing it out of headline "real
    // spend" understated the bill just as badly as calling it "billing unknown"
    // overstated its mystery.
    //
    // A model-priced OpenCode session is now stamped `'api'`, so its cost is
    // metered and DOES reach the headline.
    const paid = addLedgerCost(emptyLedgerTotals(), "api", 2265.56);
    expect(paid).toEqual({ metered: 2265.56, subscription: 0, unknown: 0 });
    expect(headlineCost(paid)).toBeCloseTo(2265.56, 10);

    // A legacy row still stamped `'opencode'` is undetermined, so it also still
    // reaches the headline — an unknown row is a real number we must not zero.
    const legacy = addLedgerCost(emptyLedgerTotals(), "opencode", 2265.56);
    expect(legacy).toEqual({ metered: 0, subscription: 0, unknown: 2265.56 });
    expect(headlineCost(legacy)).toBeCloseTo(2265.56, 10);

    // Genuinely subscription-covered spend remains the ONLY thing excluded from
    // the headline, which is the invariant this suite exists to protect.
    const covered = addLedgerCost(emptyLedgerTotals(), "pro", 2265.56);
    expect(headlineCost(covered)).toBe(0);
  });
});
