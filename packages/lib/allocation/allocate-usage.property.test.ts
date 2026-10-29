/**
 * ISS-12552: the kernel's requirements as properties. Each
 * property restates AC-017, AC-018 or AC-019, not the implementation:
 * conservation per bucket in tokens and micro-dollars, independence from input
 * order, determinism, and no share for a zero-proven recipient while another
 * is proven. Usage on a model with no price carries no cost, so a session
 * mixing priced and unpriced usage conserves its cost on the priced buckets.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AllocateUsageInput,
  type Allocation,
  allocateUsage,
  ReconciliationFailureKind,
} from "./allocate-usage";
import {
  type AllocationPricer,
  type PricedBucket,
  priceAllocation,
} from "./price-allocation";

const PRICE_KEYS = ["opus", "sonnet", "haiku"];
const CATEGORIES = ["input", "output", "cache_read", "cache_write"];
/** Integer micro-dollars per token, so a bucket's exact price is known. */
const RATE: Record<string, number> = {
  opus: 15,
  sonnet: 3,
  haiku: 1,
};

const integerPricer: AllocationPricer = (bucket) =>
  bucket.tokens * (RATE[bucket.priceKey] ?? 0);

const UNPRICED_KEY = "unpriced-model";

const unitOf = (priceKeys: readonly string[]) =>
  fc.record({
    sourceKey: fc.string({ minLength: 1, maxLength: 8 }),
    priceKey: fc.constantFrom(...priceKeys),
    category: fc.constantFrom(...CATEGORIES),
    tokens: fc.integer({ min: 0, max: 50_000_000 }),
  });

const recipientsArbitrary = fc.uniqueArray(
  fc.string({ minLength: 1, maxLength: 6 }),
  { maxLength: 5 }
);

const proofSeedsArbitrary = fc.array(
  fc.tuple(fc.nat(), fc.nat(), fc.double({ min: 0, max: 1, noNaN: true }))
);

const session = fc
  .record({
    units: fc.uniqueArray(unitOf(PRICE_KEYS), {
      selector: (unit) => unit.sourceKey,
      maxLength: 30,
    }),
    recipients: recipientsArbitrary,
    proofSeeds: proofSeedsArbitrary,
  })
  .map(({ units, recipients, proofSeeds }) =>
    withProofs(units, recipients, proofSeeds)
  );

/**
 * A session that always holds priced and unpriced units side by side: the
 * unpriced ones are a model the pricer has no rate for, as a token event with
 * no price row is.
 */
const mixedSession = fc
  .record({
    priced: fc.uniqueArray(unitOf(PRICE_KEYS), {
      selector: (unit) => unit.sourceKey,
      minLength: 1,
      maxLength: 15,
    }),
    unpriced: fc.uniqueArray(unitOf([UNPRICED_KEY]), {
      selector: (unit) => unit.sourceKey,
      minLength: 1,
      maxLength: 15,
    }),
    recipients: recipientsArbitrary,
    proofSeeds: proofSeedsArbitrary,
  })
  .map(({ priced, unpriced, recipients, proofSeeds }) =>
    withProofs(
      [
        ...priced.map((unit) => ({
          ...unit,
          sourceKey: `p:${unit.sourceKey}`,
        })),
        ...unpriced.map((unit) => ({
          ...unit,
          sourceKey: `u:${unit.sourceKey}`,
        })),
      ],
      recipients,
      proofSeeds
    )
  );

/** Proofs drawn from the seeds, never more than a unit measured. */
function withProofs(
  units: readonly {
    sourceKey: string;
    priceKey: string;
    category: string;
    tokens: number;
  }[],
  recipients: readonly string[],
  proofSeeds: readonly [number, number, number][]
): AllocateUsageInput {
  const proven = new Map<string, number>();
  const provenBy =
    units.length === 0 || recipients.length === 0
      ? []
      : proofSeeds.flatMap(([unitSeed, recipientSeed, share]) => {
          const target = units[unitSeed % units.length];
          if (!target) {
            return [];
          }
          const room = target.tokens - (proven.get(target.sourceKey) ?? 0);
          const tokens = Math.floor(room * share);
          proven.set(
            target.sourceKey,
            (proven.get(target.sourceKey) ?? 0) + tokens
          );
          return [
            {
              sourceKey: target.sourceKey,
              recipientKey: recipients[recipientSeed % recipients.length] ?? "",
              tokens,
            },
          ];
        });
  return {
    units: units.map((unit) => ({ ...unit, agentId: null })),
    recipients: [...recipients],
    provenBy,
  };
}

function allocated(input: AllocateUsageInput): Allocation {
  const result = allocateUsage(input);
  if (!result.ok) {
    throw new Error(`allocation failed: ${result.error.kind}`);
  }
  return result.value;
}

function reversed(input: AllocateUsageInput): AllocateUsageInput {
  return {
    units: [...input.units].reverse(),
    recipients: [...input.recipients].reverse(),
    provenBy: [...input.provenBy].reverse(),
  };
}

describe("allocateUsage properties", () => {
  it("conserves every bucket's tokens across proven, estimated and unattributed", () => {
    fc.assert(
      fc.property(session, (input) => {
        const allocation = allocated(input);
        for (const bucket of allocation.buckets) {
          const measured = input.units
            .filter(
              (unit) =>
                unit.priceKey === bucket.priceKey &&
                unit.category === bucket.category
            )
            .reduce((sum, unit) => sum + unit.tokens, 0);
          const shared = bucket.shares.reduce(
            (sum, share) => sum + share.provenTokens + share.estimatedTokens,
            0
          );
          expect(bucket.totalTokens).toBe(measured);
          expect(shared + bucket.unattributedTokens).toBe(measured);
        }
      })
    );
  });

  it("keeps every proven token as proven, never estimated", () => {
    fc.assert(
      fc.property(session, (input) => {
        const allocation = allocated(input);
        for (const recipient of allocation.recipients) {
          const proven = input.provenBy
            .filter((proof) => proof.recipientKey === recipient.recipientKey)
            .reduce((sum, proof) => sum + proof.tokens, 0);
          expect(recipient.provenTokens).toBe(proven);
        }
      })
    );
  });

  it("gives a zero-proven recipient nothing while another recipient is proven", () => {
    fc.assert(
      fc.property(session, (input) => {
        const allocation = allocated(input);
        const anyProven = allocation.recipients.some((r) => r.provenTokens > 0);
        for (const recipient of allocation.recipients) {
          if (anyProven && recipient.provenTokens === 0) {
            expect(recipient.estimatedTokens).toBe(0);
          }
        }
      })
    );
  });

  it("does not depend on input order, and repeats exactly", () => {
    fc.assert(
      fc.property(session, (input) => {
        const allocation = allocated(input);
        expect(allocated(reversed(input))).toEqual(allocation);
        expect(allocated(input)).toEqual(allocation);
      })
    );
  });
});

describe("priceAllocation properties", () => {
  it("prices each bucket at exactly its own price when the stored total agrees", () => {
    fc.assert(
      fc.property(session, (input) => {
        const allocation = allocated(input);
        const sessionTotal = allocation.buckets.reduce(
          (sum, bucket) =>
            sum + integerPricer({ ...bucket, tokens: bucket.totalTokens }),
          0
        );
        const priced = priceAllocation(allocation, integerPricer, sessionTotal);
        if (!priced.ok) {
          throw new Error(`pricing failed: ${priced.error.kind}`);
        }
        for (const [index, bucket] of priced.value.buckets.entries()) {
          const tokens = allocation.buckets[index]?.totalTokens ?? 0;
          const micros = bucket.shares.reduce(
            (sum, share) => sum + share.provenMicros + share.estimatedMicros,
            bucket.unattributedMicros
          );
          expect(micros).toBe(integerPricer({ ...bucket, tokens }));
        }
      })
    );
  });

  it("sums to the stored session total, whatever it is", () => {
    fc.assert(
      fc.property(
        session,
        fc.integer({ min: 0, max: 10_000_000_000 }),
        (input, sessionTotal) => {
          const allocation = allocated(input);
          const priced = priceAllocation(
            allocation,
            integerPricer,
            sessionTotal
          );
          if (!priced.ok) {
            // Only a session with no priced usage cannot carry a total.
            expect(priced.error.kind).toBe(
              ReconciliationFailureKind.InvalidPrice
            );
            expect(allocation.totalTokens).toBe(0);
            return;
          }
          const micros = priced.value.buckets.reduce(
            (sum, bucket) =>
              bucket.shares.reduce(
                (inner, share) =>
                  inner + share.provenMicros + share.estimatedMicros,
                sum + bucket.unattributedMicros
              ),
            0
          );
          expect(micros).toBe(sessionTotal);
          expect(
            priced.value.recipients.reduce(
              (sum, r) => sum + r.provenMicros + r.estimatedMicros,
              priced.value.unattributedMicros
            )
          ).toBe(sessionTotal);
        }
      )
    );
  });
});

describe("priceAllocation over priced and unpriced usage (ISS-12552)", () => {
  it("prices each priced bucket exactly and gives an unpriced bucket nothing, when the stored total agrees", () => {
    fc.assert(
      fc.property(mixedSession, (input) => {
        const allocation = allocated(input);
        const sessionTotal = allocation.buckets.reduce(
          (sum, bucket) =>
            sum + integerPricer({ ...bucket, tokens: bucket.totalTokens }),
          0
        );
        const priced = priceAllocation(allocation, integerPricer, sessionTotal);
        if (!priced.ok) {
          throw new Error(`pricing failed: ${priced.error.kind}`);
        }
        for (const [index, bucket] of priced.value.buckets.entries()) {
          const tokens = allocation.buckets[index]?.totalTokens ?? 0;
          expect(bucketMicros(bucket)).toBe(
            integerPricer({ ...bucket, tokens })
          );
        }
      })
    );
  });

  it("conserves any stored total across the priced buckets alone", () => {
    fc.assert(
      fc.property(
        mixedSession,
        fc.integer({ min: 0, max: 10_000_000_000 }),
        (input, sessionTotal) => {
          const allocation = allocated(input);
          const priced = priceAllocation(
            allocation,
            integerPricer,
            sessionTotal
          );
          if (!priced.ok) {
            expect(priced.error.kind).toBe(
              ReconciliationFailureKind.InvalidPrice
            );
            expect(sessionTotal).toBeGreaterThan(0);
            expect(pricedTokens(allocation)).toBe(0);
            return;
          }
          const unpricedMicros = priced.value.buckets
            .filter((bucket) => bucket.priceKey === UNPRICED_KEY)
            .reduce((sum, bucket) => sum + bucketMicros(bucket), 0);
          const allMicros = priced.value.buckets.reduce(
            (sum, bucket) => sum + bucketMicros(bucket),
            0
          );
          expect(unpricedMicros).toBe(0);
          expect(allMicros).toBe(sessionTotal);
          expect(
            priced.value.recipients.reduce(
              (sum, r) => sum + r.provenMicros + r.estimatedMicros,
              priced.value.unattributedMicros
            )
          ).toBe(sessionTotal);
        }
      )
    );
  });
});

function bucketMicros(bucket: PricedBucket): number {
  return bucket.shares.reduce(
    (sum, share) => sum + share.provenMicros + share.estimatedMicros,
    bucket.unattributedMicros
  );
}

/** Tokens measured on a model the pricer has a rate for. */
function pricedTokens(allocation: Allocation): number {
  return allocation.buckets
    .filter((bucket) => bucket.priceKey !== UNPRICED_KEY)
    .reduce((sum, bucket) => sum + bucket.totalTokens, 0);
}
