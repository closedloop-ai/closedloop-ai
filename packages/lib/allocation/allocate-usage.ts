/**
 * ISS-12552: the one allocation kernel. It conserves a
 * session's usage across recipients, proven first, and knows nothing about
 * what a recipient is (PRD-801 and PRD-802 consume it; AC-016).
 *
 * Weights are session-level (PRD-800): `a_i` is recipient i's proven tokens
 * over every bucket and `A` their sum. Each (priceKey, category) bucket keeps
 * its proven tokens and splits its remainder by `a_i / A`; equally when
 * `A = 0`; and keeps it as session-level unattributed usage when there is no
 * recipient. A zero-proven recipient gets nothing while another is proven.
 * Proven and estimated tokens stay separate fields (AC-017, AC-018).
 */
import { Result } from "@repo/api/src/types/result";
import { apportion, compareKeys } from "./apportion";

export type AllocationUnit = {
  /** One measured usage source; a key may appear once. */
  sourceKey: string;
  agentId: string | null;
  priceKey: string;
  category: string;
  tokens: number;
};

export type ProvenUsage = {
  sourceKey: string;
  recipientKey: string;
  tokens: number;
};

export type AllocateUsageInput = {
  units: readonly AllocationUnit[];
  recipients: readonly string[];
  provenBy: readonly ProvenUsage[];
};

export type RecipientShare = {
  recipientKey: string;
  provenTokens: number;
  estimatedTokens: number;
};

export type BucketAllocation = {
  priceKey: string;
  category: string;
  totalTokens: number;
  unattributedTokens: number;
  shares: RecipientShare[];
};

export type Allocation = {
  totalTokens: number;
  unattributedTokens: number;
  /** Ordered by priceKey, then category. */
  buckets: BucketAllocation[];
  /** Session totals per recipient, ordered by recipientKey. */
  recipients: RecipientShare[];
};

export const ReconciliationFailureKind = {
  DuplicateSource: "duplicate_source",
  /**
   * Two of the owner's sessions that started at the same instant both hold a
   * usage, so nothing says which is the fork. Not a duplicate row in
   * one session, which is `duplicate_source`.
   */
  AmbiguousSource: "ambiguous_source",
  DuplicateRecipient: "duplicate_recipient",
  InvalidTokens: "invalid_tokens",
  UnknownSource: "unknown_source",
  UnknownRecipient: "unknown_recipient",
  ProvenExceedsMeasured: "proven_exceeds_measured",
  InvalidPrice: "invalid_price",
} as const;
export type ReconciliationFailureKind =
  (typeof ReconciliationFailureKind)[keyof typeof ReconciliationFailureKind];

export type ReconciliationFailure = {
  kind: ReconciliationFailureKind;
  sourceKey?: string;
  recipientKey?: string;
  priceKey?: string;
  category?: string;
};

export function allocateUsage(
  input: AllocateUsageInput
): Result<Allocation, ReconciliationFailure> {
  const checked = validate(input);
  if (!checked.ok) {
    return checked;
  }
  const { unitsBySource, recipients } = checked.value;
  const buckets = new Map<string, BucketTally>();
  for (const unit of unitsBySource.values()) {
    const bucket = bucketFor(buckets, unit);
    bucket.total += BigInt(unit.tokens);
  }
  const weights = new Map<string, bigint>(recipients.map((key) => [key, 0n]));
  for (const proof of input.provenBy) {
    const unit = unitsBySource.get(proof.sourceKey);
    if (!unit) {
      continue;
    }
    const tokens = BigInt(proof.tokens);
    const proven = bucketFor(buckets, unit).proven;
    proven.set(
      proof.recipientKey,
      (proven.get(proof.recipientKey) ?? 0n) + tokens
    );
    weights.set(
      proof.recipientKey,
      (weights.get(proof.recipientKey) ?? 0n) + tokens
    );
  }
  const ordered = [...buckets.values()].sort(compareBuckets);
  const allocated = ordered.map((bucket) =>
    allocateBucket(bucket, recipients, weights)
  );
  return Result.ok(summarize(allocated, recipients));
}

type BucketTally = {
  priceKey: string;
  category: string;
  total: bigint;
  proven: Map<string, bigint>;
};

type CheckedInput = {
  unitsBySource: Map<string, AllocationUnit>;
  recipients: string[];
};

function validate(
  input: AllocateUsageInput
): Result<CheckedInput, ReconciliationFailure> {
  const unitsBySource = new Map<string, AllocationUnit>();
  for (const unit of input.units) {
    if (unitsBySource.has(unit.sourceKey)) {
      return failure(ReconciliationFailureKind.DuplicateSource, unit);
    }
    if (!isTokenCount(unit.tokens)) {
      return failure(ReconciliationFailureKind.InvalidTokens, unit);
    }
    unitsBySource.set(unit.sourceKey, unit);
  }
  const recipients = [...input.recipients].sort(compareKeys);
  for (let index = 1; index < recipients.length; index += 1) {
    if (recipients[index] === recipients[index - 1]) {
      return Result.err({
        kind: ReconciliationFailureKind.DuplicateRecipient,
        recipientKey: recipients[index],
      });
    }
  }
  const known = new Set(recipients);
  const provenBySource = new Map<string, number>();
  for (const proof of input.provenBy) {
    const unit = unitsBySource.get(proof.sourceKey);
    if (!unit) {
      return Result.err({
        kind: ReconciliationFailureKind.UnknownSource,
        sourceKey: proof.sourceKey,
      });
    }
    if (!known.has(proof.recipientKey)) {
      return Result.err({
        kind: ReconciliationFailureKind.UnknownRecipient,
        sourceKey: proof.sourceKey,
        recipientKey: proof.recipientKey,
      });
    }
    if (!isTokenCount(proof.tokens)) {
      return failure(ReconciliationFailureKind.InvalidTokens, unit);
    }
    const proven = (provenBySource.get(proof.sourceKey) ?? 0) + proof.tokens;
    if (proven > unit.tokens) {
      return failure(ReconciliationFailureKind.ProvenExceedsMeasured, unit);
    }
    provenBySource.set(proof.sourceKey, proven);
  }
  return Result.ok({ unitsBySource, recipients });
}

function allocateBucket(
  bucket: BucketTally,
  recipients: readonly string[],
  weights: ReadonlyMap<string, bigint>
): AllocatedBucket {
  const provenTotal = [...bucket.proven.values()].reduce(
    (sum, tokens) => sum + tokens,
    0n
  );
  const remainder = bucket.total - provenTotal;
  const estimated = estimateRemainder(remainder, recipients, weights);
  return {
    priceKey: bucket.priceKey,
    category: bucket.category,
    total: bucket.total,
    unattributed: recipients.length === 0 ? remainder : 0n,
    shares: recipients.map((recipientKey) => ({
      recipientKey,
      proven: bucket.proven.get(recipientKey) ?? 0n,
      estimated: estimated.get(recipientKey) ?? 0n,
    })),
  };
}

/** The remainder split: by session-level weight, else equally. */
function estimateRemainder(
  remainder: bigint,
  recipients: readonly string[],
  weights: ReadonlyMap<string, bigint>
): Map<string, bigint> {
  if (recipients.length === 0 || remainder === 0n) {
    return new Map();
  }
  const weighted = recipients.map((key) => ({
    key,
    weight: weights.get(key) ?? 0n,
  }));
  const anyProven = weighted.some((entry) => entry.weight > 0n);
  return apportion(
    remainder,
    anyProven
      ? weighted.filter((entry) => entry.weight > 0n)
      : recipients.map((key) => ({ key, weight: 1n }))
  );
}

type AllocatedBucket = {
  priceKey: string;
  category: string;
  total: bigint;
  unattributed: bigint;
  shares: { recipientKey: string; proven: bigint; estimated: bigint }[];
};

function summarize(
  buckets: readonly AllocatedBucket[],
  recipients: readonly string[]
): Allocation {
  const totals = new Map(
    recipients.map((key) => [key, { proven: 0n, estimated: 0n }])
  );
  for (const bucket of buckets) {
    for (const share of bucket.shares) {
      const total = totals.get(share.recipientKey);
      if (total) {
        total.proven += share.proven;
        total.estimated += share.estimated;
      }
    }
  }
  return {
    totalTokens: Number(sum(buckets.map((bucket) => bucket.total))),
    unattributedTokens: Number(
      sum(buckets.map((bucket) => bucket.unattributed))
    ),
    buckets: buckets.map((bucket) => ({
      priceKey: bucket.priceKey,
      category: bucket.category,
      totalTokens: Number(bucket.total),
      unattributedTokens: Number(bucket.unattributed),
      shares: bucket.shares.map(toShare),
    })),
    recipients: recipients.map((recipientKey) => {
      const total = totals.get(recipientKey) ?? { proven: 0n, estimated: 0n };
      return toShare({ recipientKey, ...total });
    }),
  };
}

function toShare(share: {
  recipientKey: string;
  proven: bigint;
  estimated: bigint;
}): RecipientShare {
  return {
    recipientKey: share.recipientKey,
    provenTokens: Number(share.proven),
    estimatedTokens: Number(share.estimated),
  };
}

function bucketFor(
  buckets: Map<string, BucketTally>,
  unit: AllocationUnit
): BucketTally {
  const key = bucketKey(unit.priceKey, unit.category);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      priceKey: unit.priceKey,
      category: unit.category,
      total: 0n,
      proven: new Map(),
    };
    buckets.set(key, bucket);
  }
  return bucket;
}

export function bucketKey(priceKey: string, category: string): string {
  return `${priceKey}\u0000${category}`;
}

function compareBuckets(left: BucketTally, right: BucketTally): number {
  return (
    compareKeys(left.priceKey, right.priceKey) ||
    compareKeys(left.category, right.category)
  );
}

function isTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

function failure(
  kind: ReconciliationFailureKind,
  unit: AllocationUnit
): Result<never, ReconciliationFailure> {
  return Result.err({
    kind,
    sourceKey: unit.sourceKey,
    priceKey: unit.priceKey,
    category: unit.category,
  });
}
