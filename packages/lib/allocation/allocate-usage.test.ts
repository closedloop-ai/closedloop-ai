import { describe, expect, it } from "vitest";
import {
  type AllocationUnit,
  allocateUsage,
  ReconciliationFailureKind,
} from "./allocate-usage";
import { priceAllocation } from "./price-allocation";

const PLAN = "artifact:plan";
const BRANCH = "artifact:branch";

function unit(
  sourceKey: string,
  tokens: number,
  extra: Partial<AllocationUnit> = {}
): AllocationUnit {
  return {
    sourceKey,
    agentId: null,
    priceKey: "claude-opus-4",
    category: "input",
    tokens,
    ...extra,
  };
}

describe("allocateUsage", () => {
  it("gives 125k and 375k of a 500k session proven 100k and 300k (AC-017)", () => {
    const result = allocateUsage({
      units: [
        unit("plan", 100_000),
        unit("impl", 300_000),
        unit("rest", 100_000),
      ],
      recipients: [PLAN, BRANCH],
      provenBy: [
        { sourceKey: "plan", recipientKey: PLAN, tokens: 100_000 },
        { sourceKey: "impl", recipientKey: BRANCH, tokens: 300_000 },
      ],
    });

    expect(result.ok && result.value.recipients).toEqual([
      { recipientKey: BRANCH, provenTokens: 300_000, estimatedTokens: 75_000 },
      { recipientKey: PLAN, provenTokens: 100_000, estimatedTokens: 25_000 },
    ]);
  });

  it("splits a model with no proven tokens by the session-level weights", () => {
    const result = allocateUsage({
      units: [
        unit("opus-plan", 100_000),
        unit("opus-impl", 300_000),
        unit("haiku", 40_000, { priceKey: "claude-haiku-4" }),
      ],
      recipients: [PLAN, BRANCH],
      provenBy: [
        { sourceKey: "opus-plan", recipientKey: PLAN, tokens: 100_000 },
        { sourceKey: "opus-impl", recipientKey: BRANCH, tokens: 300_000 },
      ],
    });

    const haiku = result.ok
      ? result.value.buckets.find((b) => b.priceKey === "claude-haiku-4")
      : undefined;
    expect(haiku?.shares).toEqual([
      { recipientKey: BRANCH, provenTokens: 0, estimatedTokens: 30_000 },
      { recipientKey: PLAN, provenTokens: 0, estimatedTokens: 10_000 },
    ]);
  });

  it("splits the remainder equally when nothing is proven", () => {
    const result = allocateUsage({
      units: [unit("a", 7)],
      recipients: [PLAN, BRANCH],
      provenBy: [],
    });

    expect(result.ok && result.value.recipients).toEqual([
      { recipientKey: BRANCH, provenTokens: 0, estimatedTokens: 4 },
      { recipientKey: PLAN, provenTokens: 0, estimatedTokens: 3 },
    ]);
  });

  it("keeps usage as session-level unattributed when there is no recipient", () => {
    const result = allocateUsage({
      units: [unit("a", 9), unit("b", 3, { category: "output" })],
      recipients: [],
      provenBy: [],
    });

    expect(result.ok && result.value).toMatchObject({
      totalTokens: 12,
      unattributedTokens: 12,
      recipients: [],
    });
  });

  it("gives a zero-proven recipient nothing while another is proven", () => {
    const result = allocateUsage({
      units: [unit("proven", 10), unit("rest", 1001)],
      recipients: [PLAN, BRANCH],
      provenBy: [{ sourceKey: "proven", recipientKey: PLAN, tokens: 10 }],
    });

    expect(result.ok && result.value.recipients).toEqual([
      { recipientKey: BRANCH, provenTokens: 0, estimatedTokens: 0 },
      { recipientKey: PLAN, provenTokens: 10, estimatedTokens: 1001 },
    ]);
  });

  it("gives a residual tie to the smaller recipient key", () => {
    const result = allocateUsage({
      units: [unit("proven-a", 1), unit("proven-b", 1), unit("rest", 1)],
      recipients: ["b", "a"],
      provenBy: [
        { sourceKey: "proven-a", recipientKey: "a", tokens: 1 },
        { sourceKey: "proven-b", recipientKey: "b", tokens: 1 },
      ],
    });

    expect(
      result.ok && result.value.recipients.map((r) => r.estimatedTokens)
    ).toEqual([1, 0]);
  });

  it("fails on a duplicate source event instead of counting it twice (ISS-12487)", () => {
    // Two legacy Desktop rows carrying one token event's source identity.
    const result = allocateUsage({
      units: [unit("msg_01:usage", 500), unit("msg_01:usage", 500)],
      recipients: [PLAN],
      provenBy: [],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: ReconciliationFailureKind.DuplicateSource,
        sourceKey: "msg_01:usage",
        priceKey: "claude-opus-4",
        category: "input",
      },
    });
  });

  it("fails when proven usage exceeds the measured usage, instead of clamping", () => {
    const result = allocateUsage({
      units: [unit("a", 10)],
      recipients: [PLAN, BRANCH],
      provenBy: [
        { sourceKey: "a", recipientKey: PLAN, tokens: 6 },
        { sourceKey: "a", recipientKey: BRANCH, tokens: 5 },
      ],
    });

    expect(!result.ok && result.error.kind).toBe(
      ReconciliationFailureKind.ProvenExceedsMeasured
    );
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["non-finite", Number.POSITIVE_INFINITY],
    ["past the safe-integer range", 2 ** 53],
  ])("fails on a %s token count", (_label, tokens) => {
    const result = allocateUsage({
      units: [unit("a", tokens)],
      recipients: [PLAN],
      provenBy: [],
    });

    expect(!result.ok && result.error.kind).toBe(
      ReconciliationFailureKind.InvalidTokens
    );
  });

  it("fails on a proof naming an unknown source or recipient, or a repeated recipient", () => {
    const base = { units: [unit("a", 10)], recipients: [PLAN] };
    const unknownSource = allocateUsage({
      ...base,
      provenBy: [{ sourceKey: "z", recipientKey: PLAN, tokens: 1 }],
    });
    const unknownRecipient = allocateUsage({
      ...base,
      provenBy: [{ sourceKey: "a", recipientKey: BRANCH, tokens: 1 }],
    });
    const repeated = allocateUsage({
      units: base.units,
      recipients: [PLAN, PLAN],
      provenBy: [],
    });

    expect(
      [unknownSource, unknownRecipient, repeated].map(
        (result) => !result.ok && result.error.kind
      )
    ).toEqual([
      ReconciliationFailureKind.UnknownSource,
      ReconciliationFailureKind.UnknownRecipient,
      ReconciliationFailureKind.DuplicateRecipient,
    ]);
  });
});

describe("priceAllocation", () => {
  const RATES: Record<string, number> = {
    "claude-opus-4\u0000input": 15,
    "claude-opus-4\u0000output": 75,
  };
  const pricer = (bucket: {
    priceKey: string;
    category: string;
    tokens: number;
  }) =>
    bucket.tokens * (RATES[`${bucket.priceKey}\u0000${bucket.category}`] ?? 0);

  it("prices each bucket at its own rate, never a blended one", () => {
    const allocation = allocateUsage({
      units: [unit("in", 100), unit("out", 100, { category: "output" })],
      recipients: [PLAN, BRANCH],
      provenBy: [
        { sourceKey: "in", recipientKey: PLAN, tokens: 100 },
        { sourceKey: "out", recipientKey: BRANCH, tokens: 100 },
      ],
    });
    if (!allocation.ok) {
      throw new Error("allocation failed");
    }

    const priced = priceAllocation(allocation.value, pricer, 9000);

    expect(priced.ok && priced.value.recipients).toEqual([
      { recipientKey: BRANCH, provenMicros: 7500, estimatedMicros: 0 },
      { recipientKey: PLAN, provenMicros: 1500, estimatedMicros: 0 },
    ]);
  });

  it("reconciles to the stored session total by the residual rule", () => {
    const allocation = allocateUsage({
      units: [unit("a", 1), unit("b", 1), unit("c", 1)],
      recipients: ["x", "y", "z"],
      provenBy: [
        { sourceKey: "a", recipientKey: "x", tokens: 1 },
        { sourceKey: "b", recipientKey: "y", tokens: 1 },
        { sourceKey: "c", recipientKey: "z", tokens: 1 },
      ],
    });
    if (!allocation.ok) {
      throw new Error("allocation failed");
    }

    const priced = priceAllocation(allocation.value, pricer, 100);

    expect(
      priced.ok && priced.value.recipients.map((r) => r.provenMicros)
    ).toEqual([34, 33, 33]);
  });

  it("fails on a session total no priced usage can carry, or an invalid price or total", () => {
    const allocation = allocateUsage({
      units: [unit("a", 10, { priceKey: "unpriced-model" })],
      recipients: [PLAN],
      provenBy: [],
    });
    if (!allocation.ok) {
      throw new Error("allocation failed");
    }

    expect(
      [
        priceAllocation(allocation.value, pricer, 5),
        priceAllocation(allocation.value, () => -1, 5),
        priceAllocation(allocation.value, pricer, -5),
        priceAllocation(allocation.value, pricer, 0.5),
      ].map((result) => !result.ok && result.error.kind)
    ).toEqual([
      ReconciliationFailureKind.InvalidPrice,
      ReconciliationFailureKind.InvalidPrice,
      ReconciliationFailureKind.InvalidPrice,
      ReconciliationFailureKind.InvalidPrice,
    ]);
  });
});
