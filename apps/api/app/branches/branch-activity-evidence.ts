import {
  type BranchActivityAtom,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  type BranchActivityEvidenceProjection,
  BranchActivityEvidenceReason,
  BranchActivitySource,
  branchActivityAtomProducerValidator,
  normalizeBranchActivityAtom,
} from "@repo/api/src/types/branch-activity";
import { type TransactionClient, withDb } from "@repo/database";
import { z } from "zod";
import { isStorableInt4Count } from "@/lib/int4-column-bounds";
import { isWithinTrustedFutureBoundary } from "@/lib/trusted-timestamp";
import { recomputeBranchActivityAggregatesInTransaction } from "./branch-activity-aggregate";
import { canonicalBranchActivitySources } from "./branch-activity-canonical-read";
import { lockPullRequestBranchAttributionsInTransaction } from "./pull-request-branch-relink";

/** Stable outcomes returned by the Branch activity persistence boundary. */
export const BranchActivityPersistStatus = {
  Inserted: "inserted",
  Replayed: "replayed",
  Conflict: "conflict",
  Invalid: "invalid",
  NotFound: "not_found",
  InvalidAttribution: "invalid_attribution",
  FutureTimestamp: "future_timestamp",
} as const;
export type BranchActivityPersistStatus =
  (typeof BranchActivityPersistStatus)[keyof typeof BranchActivityPersistStatus];

export type BranchActivityPersistResult = {
  status: BranchActivityPersistStatus;
};

export type PersistedBranchActivityAtom = {
  version: number;
  source: string;
  sourceEventId: string;
  occurredAt: Date;
  activityKind?: string | null;
  attributionKind: string;
  pullRequestDetailId: string | null;
  completeness: string;
  createdAt?: Date;
};

type BranchActivityPersistenceClient = Pick<
  TransactionClient,
  "$executeRaw" | "$queryRaw" | "branchActivityAtom" | "branchDetail"
>;

/**
 * Persist one immutable activity atom and advance the legacy aggregate in one
 * Branch-owned transaction. When invoked inside an ambient `withDb.tx`, the
 * database wrapper joins that transaction instead of opening a second one.
 */
export function persistBranchActivityAtom(input: {
  organizationId: string;
  branchArtifactId: string;
  atom: unknown;
  pushEvidence?: BranchActivityPushEvidence;
}): Promise<BranchActivityPersistResult> {
  const receivedAt = new Date();
  return withDb.tx((tx) =>
    persistBranchActivityAtomInTransaction(tx, { ...input, receivedAt })
  );
}

/**
 * Transaction implementation used by the public writer and focused tests.
 *
 * The boundary validates unknown input itself, enforces organization and
 * associated-PR ownership, and distinguishes exact replay from conflicting
 * reuse of a stable source identity. Unexpected database failures are allowed
 * to reject so the caller transaction rolls back instead of reporting success.
 */
export async function persistBranchActivityAtomInTransaction(
  tx: BranchActivityPersistenceClient,
  input: {
    organizationId: string;
    branchArtifactId: string;
    atom: unknown;
    pushEvidence?: BranchActivityPushEvidence;
    receivedAt?: Date;
  }
): Promise<BranchActivityPersistResult> {
  const parsed = branchActivityAtomProducerValidator.safeParse(input.atom);
  if (!parsed.success) {
    return { status: BranchActivityPersistStatus.Invalid };
  }
  const branch = await tx.branchDetail.findUnique({
    where: {
      organizationId_artifactId: {
        artifactId: input.branchArtifactId,
        organizationId: input.organizationId,
      },
    },
    select: { artifactId: true },
  });
  if (!branch) {
    return { status: BranchActivityPersistStatus.NotFound };
  }

  const atom = parsed.data;
  const pullRequestDetailId = pullRequestId(atom);
  if (!(await hasValidAttribution(tx, input, atom, pullRequestDetailId))) {
    return { status: BranchActivityPersistStatus.InvalidAttribution };
  }

  const occurredAt = new Date(atom.occurredAt);
  const receivedAt = input.receivedAt ?? new Date();
  if (!isWithinTrustedFutureBoundary(occurredAt, receivedAt)) {
    return { status: BranchActivityPersistStatus.FutureTimestamp };
  }
  const persisted = {
    version: atom.version,
    organizationId: input.organizationId,
    branchArtifactId: input.branchArtifactId,
    source: atom.source,
    sourceEventId: atom.sourceEventId,
    occurredAt,
    activityKind: atom.kind ?? null,
    attributionKind: atom.attribution.kind,
    pullRequestDetailId,
    completeness: atom.completeness,
    createdAt: receivedAt,
  };
  // Bound only for a push atom. Every other lane keeps the bind set it had, so
  // its writes survive the stage window in which the new bundle already names
  // these columns and the migration has not landed yet (packages/database
  // AGENTS.md — an added column cannot be split across merges).
  const inserted = await tx.branchActivityAtom.createMany({
    data: [
      input.pushEvidence
        ? { ...persisted, ...pushEvidenceColumns(input.pushEvidence) }
        : persisted,
    ],
    skipDuplicates: true,
  });
  let status: BranchActivityPersistStatus =
    BranchActivityPersistStatus.Inserted;
  if (inserted.count === 0) {
    const stored = await tx.branchActivityAtom.findUnique({
      where: {
        organizationId_branchArtifactId_source_sourceEventId: {
          organizationId: input.organizationId,
          branchArtifactId: input.branchArtifactId,
          source: atom.source,
          sourceEventId: atom.sourceEventId,
        },
      },
      select: {
        version: true,
        source: true,
        sourceEventId: true,
        occurredAt: true,
        activityKind: true,
        attributionKind: true,
        pullRequestDetailId: true,
        completeness: true,
        createdAt: true,
      },
    });
    if (!(stored && persistedAtomsReplayCompatible(stored, persisted))) {
      return { status: BranchActivityPersistStatus.Conflict };
    }
    status = BranchActivityPersistStatus.Replayed;
  }

  // The recompute derives Last-active from canonical atoms only, so a
  // non-canonical lane cannot change its answer — it would take the branch row's
  // NO KEY UPDATE lock and re-scan for a value it cannot move. Push is the
  // highest-volume delivery and wrote nothing on this path until ISS-10009, so
  // skipping it here keeps the cost exactly where it already was.
  if (canonicalBranchActivitySources.some((source) => source === atom.source)) {
    await recomputeBranchActivityAggregatesInTransaction(tx, {
      organizationId: input.organizationId,
      branchArtifactIds: [input.branchArtifactId],
    });
  }
  return { status };
}

/** Project one bounded persisted row without synthesizing legacy provenance. */
export function projectCanonicalBranchActivityEvidence(
  persisted: PersistedBranchActivityAtom | null | undefined
): BranchActivityEvidenceProjection {
  if (!persisted) {
    return {
      completeness: BranchActivityEvidenceCompleteness.Unavailable,
      reason: BranchActivityEvidenceReason.NoEvidence,
    };
  }
  const atom = normalizeBranchActivityAtom({
    version: persisted.version,
    source: persisted.source,
    sourceEventId: persisted.sourceEventId,
    occurredAt: persisted.occurredAt.toISOString(),
    ...(persisted.activityKind ? { kind: persisted.activityKind } : {}),
    attribution:
      persisted.attributionKind === BranchActivityAttributionKind.PullRequest &&
      persisted.pullRequestDetailId
        ? {
            kind: BranchActivityAttributionKind.PullRequest,
            pullRequestId: persisted.pullRequestDetailId,
          }
        : { kind: persisted.attributionKind },
    completeness: persisted.completeness,
  });
  if (!atom) {
    return {
      completeness: BranchActivityEvidenceCompleteness.Unavailable,
      reason: BranchActivityEvidenceReason.MalformedEvidence,
    };
  }
  const { kind: _internalKind, ...publicAtom } = atom;
  return {
    completeness: BranchActivityEvidenceCompleteness.Partial,
    latestAtom: publicAtom,
    reason:
      atom.source === BranchActivitySource.Unknown
        ? BranchActivityEvidenceReason.UnknownSource
        : BranchActivityEvidenceReason.HistoricalCoverage,
  };
}

async function hasValidAttribution(
  tx: Pick<TransactionClient, "$executeRaw" | "$queryRaw">,
  input: { organizationId: string; branchArtifactId: string },
  atom: BranchActivityAtom,
  pullRequestDetailId: string | null
): Promise<boolean> {
  if (atom.attribution.kind === BranchActivityAttributionKind.Branch) {
    return pullRequestDetailId === null;
  }
  if (!pullRequestDetailId) {
    return false;
  }
  const branchByPullRequest =
    await lockPullRequestBranchAttributionsInTransaction(tx, {
      organizationId: input.organizationId,
      pullRequestDetailIds: [pullRequestDetailId],
    });
  return (
    branchByPullRequest.get(pullRequestDetailId) === input.branchArtifactId
  );
}

function pullRequestId(atom: BranchActivityAtom): string | null {
  return atom.attribution.kind === BranchActivityAttributionKind.PullRequest
    ? atom.attribution.pullRequestId
    : null;
}

/** Build the durable identity key for a persisted Branch activity atom. */
export function persistedAtomIdentity(
  atom: Pick<PersistedBranchActivityAtom, "source" | "sourceEventId"> & {
    branchArtifactId: string;
  }
): string {
  return `${atom.branchArtifactId}\u0000${atom.source}\u0000${atom.sourceEventId}`;
}

/**
 * Treat monitored-Session completeness as conservative coverage metadata.
 * Replays retain the first immutable row when later payload-level capping is
 * the only difference instead of turning safe downgrade replay into conflict.
 */
export function persistedAtomsReplayCompatible(
  left: PersistedBranchActivityAtom,
  right: PersistedBranchActivityAtom
): boolean {
  return (
    left.version === right.version &&
    left.source === right.source &&
    left.sourceEventId === right.sourceEventId &&
    left.occurredAt.getTime() === right.occurredAt.getTime() &&
    (left.activityKind ?? null) === (right.activityKind ?? null) &&
    left.attributionKind === right.attributionKind &&
    left.pullRequestDetailId === right.pullRequestDetailId &&
    (left.completeness === right.completeness ||
      (left.source === BranchActivitySource.MonitoredSession &&
        right.source === BranchActivitySource.MonitoredSession))
  );
}

/**
 * Bind parameters one `BranchActivityAtom` row costs in a `createMany`: every
 * column in `model BranchActivityAtom`, the client-generated `id` and
 * `createdAt` defaults included. Sized against the schema, not the row literal a
 * writer happens to spell out, because Prisma binds the defaults it fills in too.
 */
export const BRANCH_ACTIVITY_ATOM_COLUMN_COUNT = 17;

/**
 * Per-push evidence written beside a push atom (ISS-10009 part 1).
 *
 * `lineDelta` is null whenever the provider compare was capped, truncated, or
 * failed — null means UNKNOWN. A short sum reads as a confident measurement,
 * which is worse than no number, so both counts travel together or neither does.
 */
export type BranchActivityPushEvidence = {
  beforeSha: string;
  afterSha: string;
  lineDelta: { linesAdded: number; linesRemoved: number } | null;
};

/**
 * Lowercase-only and full-length, deliberately stricter than the
 * case-insensitive siblings in `branch-publication-loc-projection.ts` and
 * `branch-selected-pull-request-files.ts` and than the exported 7-40
 * `COMMIT_SHA_PATTERN`: these two shas come straight off a GitHub push payload,
 * which always spells them this way, and part 2 keys a range identity on them —
 * a stored pair guaranteed canonical is worth more than one accepting a
 * spelling no producer emits.
 */
const GIT_OBJECT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** The range a push delta describes. Both shas or no evidence at all. */
const pushShaRangeValidator = z.object({
  beforeSha: z.string().regex(GIT_OBJECT_SHA_PATTERN),
  afterSha: z.string().regex(GIT_OBJECT_SHA_PATTERN),
});

/**
 * A fractional, negative, non-finite, or out-of-range count is not a small line
 * count — it is a corrupt one, and storing it would render as a measurement.
 * The ceiling is the `int4` column's, via the predicate that already owns that
 * bound for every other counter here: past it Postgres raises a numeric
 * overflow rather than storing anything, which loses the whole atom.
 */
const pushLineDeltaValidator = z
  .object({
    linesAdded: z.number().refine(isStorableInt4Count),
    linesRemoved: z.number().refine(isStorableInt4Count),
  })
  .strict();

/**
 * Build push evidence from raw webhook and provider values, or `undefined` when
 * the push range is unusable — a push with no valid `before`/`after` pair is not
 * evidence about any range, and part 2 reconciles push rows BY that range.
 *
 * This is the only validation boundary for these columns: everything past it is
 * typed, so the persistence writer trusts the type rather than re-parsing it.
 */
export function branchActivityPushEvidence(input: {
  beforeSha: unknown;
  afterSha: unknown;
  lineDelta: unknown;
}): BranchActivityPushEvidence | undefined {
  const range = pushShaRangeValidator.safeParse(input);
  if (!range.success) {
    return undefined;
  }
  const lineDelta = pushLineDeltaValidator.safeParse(input.lineDelta);
  return {
    beforeSha: range.data.beforeSha,
    afterSha: range.data.afterSha,
    lineDelta: lineDelta.success ? lineDelta.data : null,
  };
}

function pushEvidenceColumns(evidence: BranchActivityPushEvidence) {
  return {
    beforeSha: evidence.beforeSha,
    afterSha: evidence.afterSha,
    linesAdded: evidence.lineDelta?.linesAdded ?? null,
    linesRemoved: evidence.lineDelta?.linesRemoved ?? null,
  };
}
