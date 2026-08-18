import { SUBSCRIPTION_BILLING_MODES } from "@repo/api/src/types/billing-mode";
import { describe, expect, it } from "vitest";
import {
  CostAvailability,
  deriveCostAvailability,
  formatCostLabel,
  getCostTooltip,
} from "../cost-availability";

// ISS-4418: drive the all-modes regression tables from the canonical set so a
// new subscription tier added to `isSubscriptionBillingMode` automatically
// enters both the positive-Subscription case and the zero-usage NoUsage case
// below — it can never land a billing mode that skips this coverage.
const SUBSCRIPTION_MODE_CASES = [...SUBSCRIPTION_BILLING_MODES];

describe("deriveCostAvailability", () => {
  it("returns Subscription when billingMode is a subscription tier and the session did work", () => {
    expect(
      deriveCostAvailability({
        estimatedCost: 0,
        billingMode: "pro",
        inputTokens: 5000,
        outputTokens: 1000,
      })
    ).toBe(CostAvailability.Subscription);
  });

  it("returns Subscription even when estimatedCost is positive", () => {
    expect(
      deriveCostAvailability({
        estimatedCost: 3.5,
        billingMode: "max_5x",
        inputTokens: 5000,
        outputTokens: 1000,
      })
    ).toBe(CostAvailability.Subscription);
  });

  it("returns Available when estimatedCost is positive and not subscription", () => {
    expect(
      deriveCostAvailability({
        estimatedCost: 1.25,
        billingMode: null,
        inputTokens: 10_000,
        outputTokens: 2000,
      })
    ).toBe(CostAvailability.Available);
  });

  it("returns Unavailable when cost is zero but tokens were consumed", () => {
    expect(
      deriveCostAvailability({
        estimatedCost: 0,
        billingMode: null,
        inputTokens: 48_000,
        outputTokens: 12_000,
      })
    ).toBe(CostAvailability.Unavailable);
  });

  it("returns Unavailable when only cache tokens were consumed", () => {
    expect(
      deriveCostAvailability({
        estimatedCost: 0,
        billingMode: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 5000,
      })
    ).toBe(CostAvailability.Unavailable);
  });

  it("returns NoUsage when cost is zero and no tokens were consumed", () => {
    expect(
      deriveCostAvailability({
        estimatedCost: 0,
        billingMode: null,
        inputTokens: 0,
        outputTokens: 0,
      })
    ).toBe(CostAvailability.NoUsage);
  });

  it("returns NoUsage when all token fields are zero", () => {
    expect(
      deriveCostAvailability({
        estimatedCost: 0,
        billingMode: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })
    ).toBe(CostAvailability.NoUsage);
  });

  it("treats undefined billingMode as non-subscription", () => {
    expect(
      deriveCostAvailability({
        estimatedCost: 0,
        billingMode: undefined,
        inputTokens: 100,
        outputTokens: 50,
      })
    ).toBe(CostAvailability.Unavailable);
  });

  it("treats an unrecognized billingMode as non-subscription", () => {
    expect(
      deriveCostAvailability({
        estimatedCost: 0,
        billingMode: "some_future_mode",
        inputTokens: 100,
        outputTokens: 50,
      })
    ).toBe(CostAvailability.Unavailable);
  });

  it.each(
    SUBSCRIPTION_MODE_CASES
  )("recognizes subscription mode when the session did work: %s", (mode) => {
    expect(
      deriveCostAvailability({
        estimatedCost: 0,
        billingMode: mode,
        inputTokens: 5000,
        outputTokens: 1000,
      })
    ).toBe(CostAvailability.Subscription);
  });

  // ISS-4418: a zero-usage session (no tokens, no tool uses, no model, cost
  // <= 0) renders `—` for EVERY billing mode. Subscription mode alone must not
  // manufacture `$0.00` for a session that never ran.
  it.each(
    SUBSCRIPTION_MODE_CASES
  )("returns NoUsage for a zero-usage subscription session (%s), not Subscription", (mode) => {
    expect(
      deriveCostAvailability({
        estimatedCost: 0,
        billingMode: mode,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        toolUseCount: 0,
        model: null,
      })
    ).toBe(CostAvailability.NoUsage);
  });

  it("returns Subscription for a subscription session that consumed only cache tokens", () => {
    expect(
      deriveCostAvailability({
        estimatedCost: 0,
        billingMode: "max_20x",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 5000,
      })
    ).toBe(CostAvailability.Subscription);
  });

  it("returns Subscription for a subscription session with tool uses but no tokens", () => {
    expect(
      deriveCostAvailability({
        estimatedCost: 0,
        billingMode: "pro",
        inputTokens: 0,
        outputTokens: 0,
        toolUseCount: 3,
      })
    ).toBe(CostAvailability.Subscription);
  });

  it("returns Subscription for a subscription session with at least one turn but no tokens", () => {
    expect(
      deriveCostAvailability({
        estimatedCost: 0,
        billingMode: "pro",
        turns: 2,
        inputTokens: 0,
        outputTokens: 0,
        toolUseCount: 0,
      })
    ).toBe(CostAvailability.Subscription);
  });

  // ISS-4418 / wongk + codex: a non-blank `model` is NOT proof of work. The
  // Claude parser persists a `/model`-switch display fallback for a model-
  // switch-only transcript with no assistant turns or token usage, so a
  // zero-turn / zero-token / zero-tool subscription session that carries only a
  // model must still read `—` — the same row `isSubstantiveSession` badges Idle
  // — never a fabricated `$0.00`.
  it("returns NoUsage for a subscription session with only a resolved model (no turns/tokens/tools)", () => {
    expect(
      deriveCostAvailability({
        estimatedCost: 0,
        billingMode: "pro",
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        toolUseCount: 0,
        model: "claude-opus-4",
      })
    ).toBe(CostAvailability.NoUsage);
  });

  it("returns NoUsage for a zero-usage unknown-billing session (unchanged)", () => {
    expect(
      deriveCostAvailability({
        estimatedCost: 0,
        billingMode: null,
        inputTokens: 0,
        outputTokens: 0,
        toolUseCount: 0,
        model: null,
      })
    ).toBe(CostAvailability.NoUsage);
  });

  it("ignores model metadata entirely: a populated model on a zero-usage session is still NoUsage", () => {
    expect(
      deriveCostAvailability({
        estimatedCost: 0,
        billingMode: "pro",
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        toolUseCount: 0,
        model: "claude-opus-4",
      })
    ).toBe(CostAvailability.NoUsage);
  });

  // ISS-4418: turns is threaded through as a work signal so Cost stays in
  // lockstep with the `isSubstantiveSession` Idle badge — a session with turns
  // but no tokens/tools/cost is substantive, so unknown-billing does NOT read
  // NoUsage. ISS-5572 refines which non-NoUsage state it reads: with zero tokens
  // there is nothing to price, so the cause is missing USAGE, not missing model
  // pricing. Still a dash, still substantive — only the explanation changed.
  it("returns NoTokenUsage for an unknown-billing session with turns but no tokens", () => {
    expect(
      deriveCostAvailability({
        estimatedCost: 0,
        billingMode: null,
        turns: 3,
        inputTokens: 0,
        outputTokens: 0,
        toolUseCount: 0,
      })
    ).toBe(CostAvailability.NoTokenUsage);
  });

  // ISS-5572, the reported record: SES-80239 is `state: ERROR`, `errorCount: 1`,
  // `turns: 1`, every token counter 0, `toolUseCount: 0`, `estimatedCost: 0`,
  // and `model: null` (API-verified). It errored on turn one and consumed
  // nothing, so "No pricing data for this model" named the wrong cause AND
  // referred to a model that does not exist on the record.
  it("returns NoTokenUsage for an errored turn-one session with no tokens and a null model", () => {
    expect(
      deriveCostAvailability({
        estimatedCost: 0,
        billingMode: null,
        turns: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        toolUseCount: 0,
        model: null,
      })
    ).toBe(CostAvailability.NoTokenUsage);
  });

  // Code review: the counters are typed `number` but arrive across a JSON
  // boundary, and the DETAIL path hands `deriveCostAvailability` the raw API
  // record rather than a `toSafeNumber`-normalized copy the way the list does.
  // A producer that omits a counter used to make `inputTokens + outputTokens`
  // evaluate to `NaN`; `NaN === 0` is false, so the session fell through to
  // `Unavailable` and was told its MODEL was unpriced — the exact confusion
  // this state was split out to end. The cast is the point of the test: it
  // reproduces the shape the type system claims cannot exist.
  it("still returns NoTokenUsage when a counter is missing from the payload", () => {
    const skewedPayload = {
      estimatedCost: 0,
      billingMode: null,
      turns: 1,
      outputTokens: 0,
      toolUseCount: 0,
      model: null,
    } as unknown as Parameters<typeof deriveCostAvailability>[0];

    expect(deriveCostAvailability(skewedPayload)).toBe(
      CostAvailability.NoTokenUsage
    );
  });

  // ISS-5572: tool uses are work evidence (so not NoUsage) but they are not
  // TOKENS, and only tokens carry a price. A tool-use-only unknown-billing
  // session has nothing to price either.
  it("returns NoTokenUsage for a tool-use-only session with no tokens", () => {
    expect(
      deriveCostAvailability({
        estimatedCost: 0,
        billingMode: null,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        toolUseCount: 4,
      })
    ).toBe(CostAvailability.NoTokenUsage);
  });

  // ISS-5572 boundary, the other side: the unpriced-MODEL case that
  // `Unavailable` was actually defined for must keep reading `Unavailable`. One
  // consumed token is the whole difference — there IS usage here, it just could
  // not be priced, so "No pricing data for this model" is the true cause.
  it("keeps Unavailable when a single token was consumed but nothing could be priced", () => {
    expect(
      deriveCostAvailability({
        estimatedCost: 0,
        billingMode: null,
        turns: 1,
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        toolUseCount: 0,
        model: "some-unpriced-model",
      })
    ).toBe(CostAvailability.Unavailable);
  });

  // ISS-5572 version skew: a producer that omits the optional cache counters
  // must not be read as "consumed cache tokens". Omission is no usage.
  it("treats omitted cache counters as no usage rather than unknown pricing", () => {
    expect(
      deriveCostAvailability({
        estimatedCost: 0,
        billingMode: null,
        turns: 2,
        inputTokens: 0,
        outputTokens: 0,
      })
    ).toBe(CostAvailability.NoTokenUsage);
  });
});

describe("formatCostLabel", () => {
  it("formats a dollar amount for Available", () => {
    expect(formatCostLabel(CostAvailability.Available, 4.25)).toBe("$4.25");
  });

  it("formats a dollar amount for Subscription", () => {
    expect(formatCostLabel(CostAvailability.Subscription, 3.5)).toBe("$3.50");
  });

  it("returns dash for Unavailable", () => {
    expect(formatCostLabel(CostAvailability.Unavailable, 0)).toBe("—");
  });

  it("returns dash for NoUsage", () => {
    expect(formatCostLabel(CostAvailability.NoUsage, 0)).toBe("—");
  });

  // ISS-5572: the dash was never the defect — only its explanation was. The new
  // state must render the SAME `—` the old `Unavailable` did, so this fix cannot
  // change a single rendered Cost value anywhere.
  it("returns dash for NoTokenUsage, unchanged from the Unavailable it split from", () => {
    expect(formatCostLabel(CostAvailability.NoTokenUsage, 0)).toBe(
      formatCostLabel(CostAvailability.Unavailable, 0)
    );
    expect(formatCostLabel(CostAvailability.NoTokenUsage, 0)).toBe("—");
  });
});

describe("getCostTooltip", () => {
  it("returns pricing-miss tooltip for Unavailable", () => {
    expect(getCostTooltip(CostAvailability.Unavailable)).toBe(
      "No pricing data for this model"
    );
  });

  it("returns subscription tooltip for Subscription", () => {
    expect(getCostTooltip(CostAvailability.Subscription)).toBe(
      "Billed through your subscription"
    );
  });

  it("returns null for Available", () => {
    expect(getCostTooltip(CostAvailability.Available)).toBeNull();
  });

  it("returns null for NoUsage", () => {
    expect(getCostTooltip(CostAvailability.NoUsage)).toBeNull();
  });

  // ISS-5572: the whole point of the split. The zero-usage-but-substantive
  // session must NOT be told its model is unpriced.
  it("names missing usage, not missing model pricing, for NoTokenUsage", () => {
    expect(getCostTooltip(CostAvailability.NoTokenUsage)).toBe(
      "No token usage recorded to price"
    );
  });

  it("does not mention a model in the NoTokenUsage tooltip", () => {
    expect(getCostTooltip(CostAvailability.NoTokenUsage)).not.toContain(
      "model"
    );
  });

  // ISS-5572: an availability state added later must not inherit a neighbour's
  // explanation or silently fall through to "no tooltip" — the `Record` makes
  // that a typecheck failure, and this pins that every member resolves.
  it("resolves a defined entry for every availability member", () => {
    for (const availability of Object.values(CostAvailability)) {
      expect(getCostTooltip(availability)).not.toBeUndefined();
    }
  });
});
