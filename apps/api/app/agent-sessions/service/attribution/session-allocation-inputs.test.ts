import { UsageTokenCategory } from "@repo/api/src/types/attribution-evidence";
import { TokenSourceIdentityAvailability } from "@repo/api/src/types/token-cost-provenance";
import { computeTokenCost } from "@repo/cost/genai-cost";
import { Prisma } from "@repo/database";
import { ALLOCATION_CATEGORY_COUNTS } from "@repo/lib/attribution/allocation-inputs";
import { describe, expect, it } from "vitest";
import {
  type AllocationTokenEvent,
  categoryPricer,
  sessionTotalMicros,
  uniformRateUsage,
} from "./session-allocation-inputs";

const PRICED_MODEL = "claude-sonnet-4-20250514";
const UNPRICEABLE_MODEL = "not-a-real-model";
const AT = new Date("2026-10-16T12:00:00.000Z");

function event(
  extra: Partial<AllocationTokenEvent> = {}
): AllocationTokenEvent {
  return {
    externalEventId: "evt-1",
    agentExternalId: null,
    model: PRICED_MODEL,
    inputTokens: 100n,
    outputTokens: 50n,
    cacheReadTokens: 0n,
    cacheWriteTokens: 0n,
    estimatedCost: new Prisma.Decimal("0.001050"),
    sourceIdentity: {
      availability: TokenSourceIdentityAvailability.Available,
      scheme: "claude-message",
      sourceRecordIds: ["msg_01"],
    },
    eventCreatedAt: AT,
    ...extra,
  };
}

describe("categoryPricer", () => {
  it("prices a category at the pricing engine's rate for the model", () => {
    const pricer = categoryPricer([event()]);
    const engine = computeTokenCost({
      model: PRICED_MODEL,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    expect(engine.priced).toBe(true);
    expect(
      pricer({
        priceKey: PRICED_MODEL,
        category: UsageTokenCategory.Output,
        tokens: 50,
      })
    ).toBeCloseTo((engine.outputCostUsd ?? 0) * 1_000_000, 6);
    expect(
      pricer({
        priceKey: PRICED_MODEL,
        category: UsageTokenCategory.Output,
        tokens: 1,
      })
    ).not.toBeCloseTo(
      pricer({
        priceKey: PRICED_MODEL,
        category: UsageTokenCategory.Input,
        tokens: 1,
      }),
      9
    );
  });

  it("prices each request at its own tier, not at the tier of the session's sum", () => {
    const tiered = "claude-sonnet-4-5";
    const oneRequest = computeTokenCost({
      model: tiered,
      inputTokens: 150_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      timestamp: AT,
    });
    const requests = [1, 2, 3].map((n) =>
      event({
        externalEventId: `evt-${n}`,
        model: tiered,
        inputTokens: 150_000n,
        outputTokens: 0n,
        estimatedCost: new Prisma.Decimal(oneRequest.inputCostUsd ?? 0),
      })
    );
    const sessionSum = computeTokenCost({
      model: tiered,
      inputTokens: 450_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      timestamp: AT,
    });
    const perRequestMicros = (oneRequest.inputCostUsd ?? 0) * 3 * 1_000_000;

    expect(sessionSum.inputCostUsd).not.toBeCloseTo(
      (oneRequest.inputCostUsd ?? 0) * 3,
      6
    );
    expect(
      categoryPricer(requests)({
        priceKey: tiered,
        category: UsageTokenCategory.Input,
        tokens: 450_000,
      })
    ).toBeCloseTo(perRequestMicros, 3);
  });

  it("prices a model the engine cannot price at one rate across its categories", () => {
    const pricer = categoryPricer([
      event({
        externalEventId: "evt-a",
        model: UNPRICEABLE_MODEL,
        inputTokens: 300n,
        outputTokens: 10n,
        cacheReadTokens: 900n,
        estimatedCost: new Prisma.Decimal("0.004000"),
      }),
      event({
        externalEventId: "evt-b",
        model: UNPRICEABLE_MODEL,
        inputTokens: 5n,
        outputTokens: 400n,
        cacheWriteTokens: 20n,
        estimatedCost: new Prisma.Decimal("0.009000"),
      }),
    ]);
    const perToken = (category: UsageTokenCategory) =>
      pricer({ priceKey: UNPRICEABLE_MODEL, category, tokens: 1 });

    expect(perToken(UsageTokenCategory.Input)).toBeCloseTo(13_000 / 1635, 9);
    for (const category of [
      UsageTokenCategory.Output,
      UsageTokenCategory.CacheRead,
      UsageTokenCategory.CacheWrite,
    ]) {
      expect(perToken(category)).toBeCloseTo(
        perToken(UsageTokenCategory.Input),
        9
      );
    }
  });

  it("apportions each model its own stored cost in a session that mixes a priced and an unpriceable model", () => {
    const priced = event({
      externalEventId: "evt-priced",
      inputTokens: 1000n,
      outputTokens: 200n,
      estimatedCost: new Prisma.Decimal("0.006000"),
    });
    const unpriceable = event({
      externalEventId: "evt-unpriceable",
      model: UNPRICEABLE_MODEL,
      inputTokens: 700n,
      outputTokens: 80n,
      cacheReadTokens: 4000n,
      estimatedCost: new Prisma.Decimal("0.002500"),
    });
    const pricer = categoryPricer([priced, unpriceable]);
    const apportioned = (e: AllocationTokenEvent) =>
      ALLOCATION_CATEGORY_COUNTS.reduce(
        (sum, [category, field]) =>
          sum +
          pricer({ priceKey: e.model, category, tokens: Number(e[field]) }),
        0
      );

    expect(apportioned(priced)).toBeCloseTo(6000, 6);
    expect(apportioned(unpriceable)).toBeCloseTo(2500, 6);
    expect(uniformRateUsage([priced, unpriceable])).toEqual({
      tokens: 4780,
      micros: 2500,
    });
  });

  it("returns no price for a model no event in the session carries", () => {
    expect(
      categoryPricer([event()])({
        priceKey: "not-a-real-model",
        category: UsageTokenCategory.Input,
        tokens: 10,
      })
    ).toBeNaN();
  });
});

describe("sessionTotalMicros", () => {
  it("sums stored costs exactly, skipping an event that lacks one, and has no total when none has one", () => {
    expect(
      sessionTotalMicros([
        event(),
        event({ estimatedCost: new Prisma.Decimal("0.000001") }),
      ])
    ).toBe(1051);
    expect(sessionTotalMicros([event(), event({ estimatedCost: null })])).toBe(
      1050
    );
    expect(sessionTotalMicros([event({ estimatedCost: null })])).toBe(null);
  });
});
