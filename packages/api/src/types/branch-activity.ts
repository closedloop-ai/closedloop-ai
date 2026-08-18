import { z } from "zod";

/** Version of the additive canonical Branch activity atom wire contract. */
export const BranchActivityAtomVersion = {
  V1: 1,
} as const;
export type BranchActivityAtomVersion =
  (typeof BranchActivityAtomVersion)[keyof typeof BranchActivityAtomVersion];

/** Durable source lane that established one qualifying Branch activity atom. */
export const BranchActivitySource = {
  GitHead: "git_head",
  PullRequestLifecycle: "pull_request_lifecycle",
  PullRequestReview: "pull_request_review",
  GitHubWebhook: "github_webhook",
  MonitoredSession: "monitored_session",
  /** Read-side compatibility classification for a newer producer lane. */
  Unknown: "unknown",
} as const;
export type BranchActivitySource =
  (typeof BranchActivitySource)[keyof typeof BranchActivitySource];

/** Whether an atom is attributed directly to a Branch or through one of its PRs. */
export const BranchActivityAttributionKind = {
  Branch: "branch",
  PullRequest: "pull_request",
} as const;
export type BranchActivityAttributionKind =
  (typeof BranchActivityAttributionKind)[keyof typeof BranchActivityAttributionKind];

/** Honest evidence coverage for an atom or latest-evidence projection. */
export const BranchActivityEvidenceCompleteness = {
  Complete: "complete",
  Partial: "partial",
  Unavailable: "unavailable",
} as const;
export type BranchActivityEvidenceCompleteness =
  (typeof BranchActivityEvidenceCompleteness)[keyof typeof BranchActivityEvidenceCompleteness];

/** Why a latest-evidence projection cannot claim complete historical coverage. */
export const BranchActivityEvidenceReason = {
  HistoricalCoverage: "historical_coverage",
  NoEvidence: "no_evidence",
  MalformedEvidence: "malformed_evidence",
  UnknownSource: "unknown_source",
} as const;
export type BranchActivityEvidenceReason =
  (typeof BranchActivityEvidenceReason)[keyof typeof BranchActivityEvidenceReason];

const branchAttributionValidator = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal(BranchActivityAttributionKind.Branch),
    })
    .strict(),
  z
    .object({
      kind: z.literal(BranchActivityAttributionKind.PullRequest),
      pullRequestId: z.uuid(),
    })
    .strict(),
]);

const atomCompletenessValidator = z.union([
  z.literal(BranchActivityEvidenceCompleteness.Complete),
  z.literal(BranchActivityEvidenceCompleteness.Partial),
]);

const branchActivityAtomSchema = z
  .object({
    version: z.literal(BranchActivityAtomVersion.V1),
    source: z.enum(BranchActivitySource),
    /** Raw newer-peer source retained only when `source` is `unknown`. */
    sourceIdentity: z.string().trim().min(1).max(128).optional(),
    sourceEventId: z.string().trim().min(1).max(512),
    occurredAt: z.iso.datetime(),
    attribution: branchAttributionValidator,
    completeness: atomCompletenessValidator,
  })
  .strict()
  .superRefine((atom, context) => {
    if (
      atom.sourceIdentity !== undefined &&
      atom.source !== BranchActivitySource.Unknown
    ) {
      context.addIssue({
        code: "custom",
        message: "sourceIdentity is reserved for unknown compatibility sources",
        path: ["sourceIdentity"],
      });
    }
    if (
      atom.source === BranchActivitySource.Unknown &&
      atom.sourceIdentity === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "unknown compatibility sources require sourceIdentity",
        path: ["sourceIdentity"],
      });
    }
  });

/** One provenance-bearing canonical Branch activity observation. */
export type BranchActivityAtom = z.infer<typeof branchActivityAtomSchema>;

/**
 * Strict producer boundary. Current producers must use a known source lane;
 * `unknown` exists only so older readers can preserve newer-peer identity.
 */
export const branchActivityAtomProducerValidator =
  branchActivityAtomSchema.superRefine((atom, context) => {
    if (atom.source === BranchActivitySource.Unknown) {
      context.addIssue({
        code: "custom",
        message: "producers must use a known Branch activity source",
        path: ["source"],
      });
    }
  });

/** Additive latest-evidence projection carried by current Branch API rows. */
export type BranchActivityEvidenceProjection =
  | {
      completeness: typeof BranchActivityEvidenceCompleteness.Complete;
      latestAtom: BranchActivityAtom;
      reason?: never;
    }
  | {
      completeness: typeof BranchActivityEvidenceCompleteness.Partial;
      latestAtom: BranchActivityAtom;
      reason:
        | typeof BranchActivityEvidenceReason.HistoricalCoverage
        | typeof BranchActivityEvidenceReason.UnknownSource;
    }
  | {
      completeness: typeof BranchActivityEvidenceCompleteness.Unavailable;
      reason:
        | typeof BranchActivityEvidenceReason.NoEvidence
        | typeof BranchActivityEvidenceReason.MalformedEvidence;
    };

const compatibilityAtomValidator = z.object({
  version: z.literal(BranchActivityAtomVersion.V1),
  source: z.unknown(),
  sourceIdentity: z.unknown().optional(),
  sourceEventId: z.string().trim().min(1).max(512),
  occurredAt: z.iso.datetime(),
  attribution: branchAttributionValidator,
  completeness: z.unknown(),
});

/**
 * Normalize historical or version-skewed atoms without fabricating required
 * identity, time, or attribution. Unknown source lanes retain their raw value
 * and are always downgraded to partial evidence.
 */
export function normalizeBranchActivityAtom(
  value: unknown
): BranchActivityAtom | undefined {
  const known = branchActivityAtomSchema.safeParse(value);
  if (known.success) {
    return known.data.source === BranchActivitySource.Unknown
      ? {
          ...known.data,
          completeness: BranchActivityEvidenceCompleteness.Partial,
        }
      : known.data;
  }

  const compatible = compatibilityAtomValidator.safeParse(value);
  if (!compatible.success) {
    return undefined;
  }
  const rawSource = normalizedRawString(compatible.data.source, 128);
  const knownSource = constValue(rawSource, BranchActivitySource);
  const source = knownSource ?? BranchActivitySource.Unknown;
  const sourceIdentity = compatibilitySourceIdentity(
    source,
    rawSource,
    compatible.data.sourceIdentity
  );
  if (source === BranchActivitySource.Unknown && sourceIdentity === undefined) {
    return undefined;
  }
  const completeness = constValue(
    compatible.data.completeness,
    atomCompletenessValues
  );
  return {
    version: BranchActivityAtomVersion.V1,
    source,
    ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
    sourceEventId: compatible.data.sourceEventId,
    occurredAt: compatible.data.occurredAt,
    attribution: compatible.data.attribution,
    completeness:
      source === BranchActivitySource.Unknown
        ? BranchActivityEvidenceCompleteness.Partial
        : (completeness ?? BranchActivityEvidenceCompleteness.Partial),
  };
}

const atomCompletenessValues = {
  Complete: BranchActivityEvidenceCompleteness.Complete,
  Partial: BranchActivityEvidenceCompleteness.Partial,
} as const;

function compatibilitySourceIdentity(
  source: BranchActivitySource,
  rawSource: string | undefined,
  rawSourceIdentity: unknown
): string | undefined {
  if (source !== BranchActivitySource.Unknown) {
    return undefined;
  }
  const explicitIdentity = normalizedRawString(rawSourceIdentity, 128);
  if (explicitIdentity) {
    return explicitIdentity;
  }
  return rawSource === BranchActivitySource.Unknown ? undefined : rawSource;
}

function normalizedRawString(
  value: unknown,
  maxLength: number
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    return undefined;
  }
  return normalized;
}

function constValue<T extends string>(
  value: unknown,
  values: Record<string, T>
): T | undefined {
  return Object.values(values).find((candidate) => candidate === value);
}
