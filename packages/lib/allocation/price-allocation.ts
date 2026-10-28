/**
 * ISS-12552: prices an allocation. Each bucket share is
 * priced at its own (priceKey, category) price by the injected pricer, so no
 * blended rate exists (AC-019), and the priced shares are reconciled to the
 * session's priced total in micro-dollars by the kernel's residual rule. A
 * negative or non-integer total, or a total no share can carry, is an
 * impossible price, not an unpriced session (PRD-800).
 */
import { Result } from "@repo/api/src/types/result";
import {
  type Allocation,
  bucketKey,
  type ReconciliationFailure,
  ReconciliationFailureKind,
} from "./allocate-usage";
import { apportion } from "./apportion";

/** Micro-dollars for `tokens` at the bucket's price; may be fractional. */
export type AllocationPricer = (bucket: {
  priceKey: string;
  category: string;
  tokens: number;
}) => number;

export type PricedShare = {
  recipientKey: string;
  provenMicros: number;
  estimatedMicros: number;
};

export type PricedBucket = {
  priceKey: string;
  category: string;
  unattributedMicros: number;
  shares: PricedShare[];
};

export type PricedAllocation = {
  totalMicros: number;
  unattributedMicros: number;
  buckets: PricedBucket[];
  /** Session totals per recipient, ordered by recipientKey. */
  recipients: PricedShare[];
};

/** Pricer output is kept to this many fractional micro-dollar digits. */
const PRICE_SCALE = 1_000_000;

const ShareKind = {
  Proven: "proven",
  Estimated: "estimated",
  Unattributed: "unattributed",
} as const;
type ShareKind = (typeof ShareKind)[keyof typeof ShareKind];

export function priceAllocation(
  allocation: Allocation,
  pricer: AllocationPricer,
  sessionTotalMicros: number
): Result<PricedAllocation, ReconciliationFailure> {
  if (!(Number.isSafeInteger(sessionTotalMicros) && sessionTotalMicros >= 0)) {
    return Result.err({ kind: ReconciliationFailureKind.InvalidPrice });
  }
  const entries: { key: string; weight: bigint }[] = [];
  for (const bucket of allocation.buckets) {
    const parts: [ShareKind, string, number][] = [
      [ShareKind.Unattributed, "", bucket.unattributedTokens],
      ...bucket.shares.flatMap((share): [ShareKind, string, number][] => [
        [ShareKind.Proven, share.recipientKey, share.provenTokens],
        [ShareKind.Estimated, share.recipientKey, share.estimatedTokens],
      ]),
    ];
    for (const [kind, recipientKey, tokens] of parts) {
      const micros = pricer({
        priceKey: bucket.priceKey,
        category: bucket.category,
        tokens,
      });
      if (!(Number.isFinite(micros) && micros >= 0)) {
        return Result.err({
          kind: ReconciliationFailureKind.InvalidPrice,
          priceKey: bucket.priceKey,
          category: bucket.category,
        });
      }
      entries.push({
        key: shareKey(bucket.priceKey, bucket.category, kind, recipientKey),
        weight: BigInt(Math.round(micros * PRICE_SCALE)),
      });
    }
  }
  const total = BigInt(sessionTotalMicros);
  const priced = entries.some((entry) => entry.weight > 0n);
  if (total > 0n && !priced) {
    return Result.err({ kind: ReconciliationFailureKind.InvalidPrice });
  }
  const micros = priced ? apportion(total, entries) : new Map<string, bigint>();
  return Result.ok(assemble(allocation, micros, sessionTotalMicros));
}

function assemble(
  allocation: Allocation,
  micros: ReadonlyMap<string, bigint>,
  sessionTotalMicros: number
): PricedAllocation {
  const read = (
    priceKey: string,
    category: string,
    kind: ShareKind,
    recipientKey: string
  ) =>
    Number(micros.get(shareKey(priceKey, category, kind, recipientKey)) ?? 0n);
  const buckets = allocation.buckets.map((bucket) => ({
    priceKey: bucket.priceKey,
    category: bucket.category,
    unattributedMicros: read(
      bucket.priceKey,
      bucket.category,
      ShareKind.Unattributed,
      ""
    ),
    shares: bucket.shares.map((share) => ({
      recipientKey: share.recipientKey,
      provenMicros: read(
        bucket.priceKey,
        bucket.category,
        ShareKind.Proven,
        share.recipientKey
      ),
      estimatedMicros: read(
        bucket.priceKey,
        bucket.category,
        ShareKind.Estimated,
        share.recipientKey
      ),
    })),
  }));
  return {
    totalMicros: sessionTotalMicros,
    unattributedMicros: buckets.reduce(
      (total, bucket) => total + bucket.unattributedMicros,
      0
    ),
    buckets,
    recipients: allocation.recipients.map(({ recipientKey }) => {
      const shares = buckets.flatMap((bucket) =>
        bucket.shares.filter((share) => share.recipientKey === recipientKey)
      );
      return {
        recipientKey,
        provenMicros: shares.reduce((t, s) => t + s.provenMicros, 0),
        estimatedMicros: shares.reduce((t, s) => t + s.estimatedMicros, 0),
      };
    }),
  };
}

function shareKey(
  priceKey: string,
  category: string,
  kind: ShareKind,
  recipientKey: string
): string {
  return `${bucketKey(priceKey, category)}\u0000${kind}\u0000${recipientKey}`;
}
