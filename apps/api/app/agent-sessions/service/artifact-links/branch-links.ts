import { ArtifactType, BranchPushSource } from "@repo/api/src/types/artifact";
import {
  BranchLifecycleBoundaryKind,
  normalizeRepoFullName,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import type {
  SyncedArtifactRef,
  SyncedBranchLifecycleEvent,
} from "@repo/api/src/types/session-artifact-link";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { v7 as uuidv7 } from "uuid";
import { seedBranchOwners } from "@/app/branches/branch-owner-seed/branch-owner-seed";
import { stampBranchFirstPush } from "@/app/branches/branch-push-state";
import {
  CloudBranchNonMaterializationKind,
  type CloudBranchNonMaterializationKind as CloudBranchNonMaterializationKindType,
} from "@/app/branches/branch-write-eligibility";
import { isCloudBranchEligible } from "@/app/branches/cloud-branch-eligibility";
import { SessionIngestWorkBudget } from "../ingest-work-budget";
import type { AgentSessionUpsertTx } from "../records";
import {
  enqueueBranchMaterializationRetriesTx,
  isRetryableBranchMaterializationCause,
} from "./branch-materialization-retry";
import { deleteBranchMaterializationRetriesForAggregatesTx } from "./branch-materialization-retry-delete";
import {
  type BranchPrioritySeed,
  branchRefPrioritiesByIdentity,
  seedBranchPrioritiesIfUnset,
  withBranchPriorityClaim,
} from "./branch-priority-seed";
import {
  type BranchRefAggregate,
  branchRefAggregateKey,
  foldBranchRef,
  hasPullRequestHeadPushEvidence,
  isPullRequestHeadAggregateMissingPrIdentity,
  partitionBranchMaterializationBudget,
} from "./branch-ref-aggregate";
import { readExistingBranchRows } from "./existing-branch-rows";
import { persistSessionBranchLinkBatch } from "./session-branch-link-batch";
import {
  SessionBranchLinkEvidenceSource,
  upsertSessionBranchLink,
} from "./session-branch-link-writer";
import type {
  SessionBranchRepositoryAuthority,
  SessionBranchRepositoryAuthorityMap,
} from "./shared";
import { collectBranchRefs, storeUnresolvedRefs } from "./shared";

export async function ensureBranchArtifactRow(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    projectId: string | null;
    repositoryAuthority: SessionBranchRepositoryAuthority | undefined;
    repositoryFullName: string;
    branchName: string;
    createWhenAbsent: boolean;
  }
): Promise<BranchMaterializationResult> {
  const rejection = branchMaterializationRejection(input);
  if (rejection) {
    return rejection;
  }
  const authority = input.repositoryAuthority;
  // D2 key is unique, so at most one row exists — resolve it regardless of
  // deletedAt (a tombstoned row still owns the key; creating a second would
  // violate the unique index).
  const identity = {
    organizationId: input.organizationId,
    repositoryFullName: input.repositoryFullName,
    branchName: input.branchName,
  };
  const existing = await tx.branchDetail.findFirst({
    where: identity,
    select: { artifactId: true },
  });
  if (existing) {
    return {
      status: BranchMaterializationStatus.Materialized,
      artifactId: existing.artifactId,
    };
  }
  // ISS-8148: no row yet and no evidence this branch ever reached the remote.
  // Defer without creating — a local-only branch must not materialize at all.
  if (!input.createWhenAbsent) {
    return {
      status: BranchMaterializationStatus.NotMaterialized,
      cause: CloudBranchNonMaterializationKind.NotPushed,
    };
  }
  // A uniqueness race aborts the whole transaction; retry only after rollback.
  const created = await tx.artifact.create({
    data: {
      type: ArtifactType.Branch,
      organization: { connect: { id: input.organizationId } },
      // Unparented when the session has no project — mirrors the SESSION
      // artifact precedent in this same lane (FEA-1749).
      ...(input.projectId
        ? { project: { connect: { id: input.projectId } } }
        : {}),
      name: input.branchName,
      status: GitHubPRState.Open,
      externalUrl: `https://github.com/${input.repositoryFullName}/tree/${encodeURIComponent(input.branchName)}`,
      branch: {
        create: {
          organizationId: input.organizationId,
          repositoryId: authority?.repositoryId ?? null,
          repositoryFullName: input.repositoryFullName,
          branchName: input.branchName,
        },
      },
    },
    select: { id: true },
  });
  return {
    status: BranchMaterializationStatus.Materialized,
    artifactId: created.id,
  };
}

/**
 * Resolve/create a Branch from persisted full-fidelity evidence and write the
 * same SESSION→BRANCH link the immediate ingest path writes.
 */
export async function materializeSessionBranchAggregate(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    projectId: string | null;
    sessionArtifactId: string;
    aggregate: BranchRefAggregate;
    repositoryAuthority: SessionBranchRepositoryAuthority | undefined;
  }
): Promise<BranchMaterializationResult> {
  if (isPullRequestHeadAggregateMissingPrIdentity(input.aggregate)) {
    return {
      status: BranchMaterializationStatus.NotMaterialized,
      cause: CloudBranchNonMaterializationKind.IdentityMismatch,
    };
  }
  const materialization = await ensureBranchArtifactRow(tx, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    repositoryAuthority: input.repositoryAuthority,
    repositoryFullName: input.aggregate.repositoryFullName,
    branchName: input.aggregate.branchName,
    // Persisted push evidence can heal a previously deferred identity.
    createWhenAbsent: hasBranchPushEvidence({
      pushObserved: input.aggregate.pushObserved === true,
      branchLifecycleEvents: input.aggregate.branchLifecycleEvents,
      pullRequestObserved: hasPullRequestHeadPushEvidence(input.aggregate),
    }),
  });
  if (materialization.status === BranchMaterializationStatus.NotMaterialized) {
    return materialization;
  }
  if (materialization.artifactId !== input.sessionArtifactId) {
    await persistMaterializedSessionBranchAggregate(tx, {
      organizationId: input.organizationId,
      sessionArtifactId: input.sessionArtifactId,
      branchArtifactId: materialization.artifactId,
      aggregate: input.aggregate,
    });
    if (input.aggregate.priority) {
      await seedBranchPrioritiesIfUnset(tx, input.organizationId, [
        {
          artifactId: materialization.artifactId,
          priority: input.aggregate.priority,
        },
      ]);
    }
  }
  return materialization;
}

async function persistMaterializedSessionBranchAggregate(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    sessionArtifactId: string;
    branchArtifactId: string;
    aggregate: BranchRefAggregate;
  }
): Promise<void> {
  if (input.aggregate.pushedAt) {
    await stampBranchFirstPush(
      tx,
      input.branchArtifactId,
      new Date(input.aggregate.pushedAt),
      BranchPushSource.Session
    );
  } else if (
    hasPullRequestHeadPushEvidence(input.aggregate) &&
    input.aggregate.observedAt
  ) {
    await stampBranchFirstPush(
      tx,
      input.branchArtifactId,
      new Date(input.aggregate.observedAt),
      BranchPushSource.Session
    );
  } else if (input.aggregate.pushObserved) {
    // ISS-8148 (review): a version-skewed producer can send a recognized
    // push-method ref with no `observedAt`. The push is real — it just has no
    // time — so stamp the ingest instant as an UPPER BOUND rather than leave
    // the row unstamped and silently outside every publication-gated
    // population (metric denominators included). `stampBranchFirstPush`
    // overwrites any LATER stored value, so the first timestamped push
    // evidence corrects this stamp downward.
    await stampBranchFirstPush(
      tx,
      input.branchArtifactId,
      new Date(),
      BranchPushSource.Session
    );
  }
  await upsertSessionBranchLink(tx, {
    organizationId: input.organizationId,
    sessionArtifactId: input.sessionArtifactId,
    branchArtifactId: input.branchArtifactId,
    aggregate: input.aggregate,
    evidenceSource:
      input.aggregate.branchRefObserved === false
        ? SessionBranchLinkEvidenceSource.PullRequestHead
        : SessionBranchLinkEvidenceSource.IndependentBranch,
  });
  await seedBranchOwners(tx, input.organizationId, [input.branchArtifactId]);
}

export async function persistSessionBranchArtifactLinks(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  projectId: string | null,
  sessionArtifactId: string,
  artifactRefs: SyncedArtifactRef[] | undefined,
  repositoryAuthorityByFullName: SessionBranchRepositoryAuthorityMap
): Promise<void> {
  // `undefined` means the client didn't send refs — leave links untouched
  // (mirrors persistArtifactLinks).
  if (artifactRefs === undefined) {
    return;
  }
  const branchRefs = collectBranchRefs(artifactRefs);
  if (branchRefs.length === 0) {
    return;
  }

  // ISS-8148: fold on branch IDENTITY first, so the push-evidence decision sees
  // every ref for a branch before any row can be created. The previous
  // ensure-then-fold order materialized a row per ref and could only ever judge
  // one ref at a time.
  const byIdentity = new Map<string, BranchRefAggregate>();
  for (const ref of branchRefs) {
    // The normalized full name is part of the D2 identity, so it is applied
    // before the fold rather than after materialization.
    const normalizedRef = {
      ...ref,
      repositoryFullName: normalizeRepoFullName(ref.repositoryFullName),
    };
    foldBranchRef(
      byIdentity,
      branchRefAggregateKey(normalizedRef),
      normalizedRef
    );
  }
  // Overflow remains in the durable retry store.
  const { inline, deferred } = partitionBranchMaterializationBudget(
    byIdentity,
    SessionIngestWorkBudget.BranchMaterializationsPerSession
  );

  const byArtifact = new Map<string, BranchRefAggregate>();
  const prioritiesByIdentity = branchRefPrioritiesByIdentity(branchRefs);
  const prioritySeeds: BranchPrioritySeed[] = [];
  const unresolved: UnresolvedBranchRef[] = [];
  const retryableByBranch = new Map<string, BranchRefAggregate>(deferred);
  const { materializations, assignedBranchIds } =
    await ensureBranchArtifactRows(tx, {
      organizationId,
      projectId,
      aggregates: inline.map(([, aggregate]) => aggregate),
      authorities: repositoryAuthorityByFullName,
    });
  for (const [identityKey, aggregate] of inline) {
    // Resolve or create only when the batched server authority proves this is a
    // non-default branch. Public repositories retain a null installation repo
    // id.
    const normalizedFullName = aggregate.repositoryFullName;
    // An unavailable/default result is intentionally skipped without aborting
    // the multi-session transaction; a later sync re-evaluates fresh authority.
    const materialization = materializations.get(identityKey);
    if (!materialization) {
      throw new Error("branch identity absent from batch materialization");
    }
    if (
      materialization.status === BranchMaterializationStatus.NotMaterialized
    ) {
      // `NotPushed` IS retryable (see `isRetryableBranchMaterializationCause`).
      // Two heal paths: a re-synced push ref re-runs this lane directly (the
      // producer budget shed-protects push-method refs — see the desktop's
      // artifact-ref-budget.ts — so that ref survives to re-arrive), and the
      // durable row drains once ANOTHER producer (push webhook, PR lane,
      // reconciler) has created the D2 row. Push evidence that reaches neither
      // path is invisible to the cloud until one does.
      if (isRetryableBranchMaterializationCause(materialization.cause)) {
        retryableByBranch.set(identityKey, aggregate);
      } else {
        unresolved.push({
          repositoryFullName: normalizedFullName,
          branchName: aggregate.branchName,
          cause: materialization.cause,
        });
      }
      continue;
    }
    const branchArtifactId = materialization.artifactId;
    if (branchArtifactId === sessionArtifactId) {
      continue;
    }
    byArtifact.set(branchArtifactId, aggregate);
    const priority = prioritiesByIdentity.get(identityKey);
    if (priority) {
      prioritySeeds.push({ artifactId: branchArtifactId, priority });
    }
  }
  await seedBranchPrioritiesIfUnset(tx, organizationId, prioritySeeds);

  // Inline rejections and overflow share the existing durable retry path, and
  // each keeps its priority claim for the drain to seed.
  if (retryableByBranch.size > 0) {
    await enqueueBranchMaterializationRetriesTx(tx, {
      organizationId,
      sourceArtifactId: sessionArtifactId,
      aggregates: [...retryableByBranch].map(([identityKey, aggregate]) =>
        withBranchPriorityClaim(
          aggregate,
          prioritiesByIdentity.get(identityKey)
        )
      ),
    });
  }

  await persistSessionBranchLinkBatch(tx, {
    organizationId,
    sessionArtifactId,
    byArtifact,
  });
  // ISS-12463: the seed only stamps a NULL assignee, so a branch the lookup
  // above already read as assigned cannot be stamped; skipping it drops a no-op
  // statement, and a batch of only assigned branches (the replay) runs none.
  await seedBranchOwners(
    tx,
    organizationId,
    [...byArtifact.keys()].filter((id) => !assignedBranchIds.has(id))
  );
  await deleteBranchMaterializationRetriesForAggregatesTx(tx, {
    organizationId,
    sourceArtifactId: sessionArtifactId,
    aggregates: [...byArtifact.values()],
  });
  if (unresolved.length > 0) {
    await storeUnresolvedRefs<UnresolvedBranchRef>(
      tx,
      sessionArtifactId,
      "_unresolvedBranchRefs",
      isUnresolvedBranchRef,
      (ref) => `${ref.repositoryFullName}#${ref.branchName}#${ref.cause}`,
      unresolved
    );
  }
}

export const BranchMaterializationStatus = {
  Materialized: "materialized",
  NotMaterialized: "not_materialized",
} as const;

export type BranchMaterializationResult =
  | {
      status: typeof BranchMaterializationStatus.Materialized;
      artifactId: string;
    }
  | {
      status: typeof BranchMaterializationStatus.NotMaterialized;
      cause: CloudBranchNonMaterializationKindType;
    };

type UnresolvedBranchRef = {
  repositoryFullName: string;
  branchName: string;
  cause?: CloudBranchNonMaterializationKindType;
};

function isUnresolvedBranchRef(value: unknown): value is UnresolvedBranchRef {
  if (!(value && typeof value === "object")) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.repositoryFullName === "string" &&
    typeof candidate.branchName === "string" &&
    (candidate.cause === undefined ||
      Object.values(CloudBranchNonMaterializationKind).includes(
        candidate.cause as CloudBranchNonMaterializationKindType
      ))
  );
}

function resolveCanonicalRejectionCause(
  branchName: string,
  authority: SessionBranchRepositoryAuthority
): CloudBranchNonMaterializationKindType {
  if (authority.identityConflict) {
    return CloudBranchNonMaterializationKind.ConflictingAuthority;
  }
  const defaultBranches = authority.authorities.flatMap((candidate) =>
    "defaultBranch" in candidate.evidence
      ? [candidate.evidence.defaultBranch]
      : []
  );
  if (defaultBranches.includes(branchName)) {
    return CloudBranchNonMaterializationKind.DefaultBranch;
  }
  return CloudBranchNonMaterializationKind.AuthorityUnavailable;
}

const BRANCH_LIFECYCLE_IMPLIES_REMOTE: Record<
  BranchLifecycleBoundaryKind,
  boolean
> = {
  [BranchLifecycleBoundaryKind.PrRaised]: true,
  [BranchLifecycleBoundaryKind.ReviewFeedback]: true,
  [BranchLifecycleBoundaryKind.SessionStart]: false,
  [BranchLifecycleBoundaryKind.BranchWrite]: false,
  [BranchLifecycleBoundaryKind.ReadOnlyReference]: false,
  [BranchLifecycleBoundaryKind.UnknownEvidence]: false,
  [BranchLifecycleBoundaryKind.SessionEnd]: false,
};

export function hasBranchPushEvidence(input: {
  pushObserved: boolean;
  branchLifecycleEvents: readonly SyncedBranchLifecycleEvent[];
  /** A PR ref in the same batch names this branch as its head. */
  pullRequestObserved: boolean;
}): boolean {
  if (input.pushObserved || input.pullRequestObserved) {
    return true;
  }
  return input.branchLifecycleEvents.some(
    (event) => BRANCH_LIFECYCLE_IMPLIES_REMOTE[event.kind] === true
  );
}

function branchMaterializationRejection(input: {
  repositoryAuthority: SessionBranchRepositoryAuthority | undefined;
  repositoryFullName: string;
  branchName: string;
}): BranchMaterializationResult | undefined {
  const authority = input.repositoryAuthority;
  if (!authority) {
    return {
      status: BranchMaterializationStatus.NotMaterialized,
      cause: CloudBranchNonMaterializationKind.AuthorityUnavailable,
    };
  }
  if (
    !isCloudBranchEligible({
      branchName: input.branchName,
      repository: {
        provider: VcsProviderKind.GitHub,
        fullName: input.repositoryFullName,
        ...(authority.providerRepositoryId
          ? { providerRepositoryId: authority.providerRepositoryId }
          : {}),
      },
      authorities: authority.authorities,
    })
  ) {
    return {
      status: BranchMaterializationStatus.NotMaterialized,
      cause: resolveCanonicalRejectionCause(input.branchName, authority),
    };
  }
  return undefined;
}

/** Set-shaped counterpart of ensureBranchArtifactRow; keeps artifact-first atomicity. */
async function ensureBranchArtifactRows(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    projectId: string | null;
    aggregates: BranchRefAggregate[];
    authorities: SessionBranchRepositoryAuthorityMap;
  }
): Promise<{
  materializations: Map<string, BranchMaterializationResult>;
  /** Existing branch rows read with a non-NULL assignee. */
  assignedBranchIds: Set<string>;
}> {
  const results = new Map<string, BranchMaterializationResult>();
  const assignedBranchIds = new Set<string>();
  const eligible = input.aggregates.filter((aggregate) => {
    const rejection = branchMaterializationRejection({
      ...aggregate,
      repositoryAuthority: input.authorities.get(aggregate.repositoryFullName),
    });
    if (rejection) {
      results.set(branchRefAggregateKey(aggregate), rejection);
    }
    return rejection === undefined;
  });
  if (eligible.length === 0) {
    return { materializations: results, assignedBranchIds };
  }
  // Bounded by the existing per-session materialization budget, like the
  // identity-set lookup in internal-branch-target.ts.
  const existing = await readExistingBranchRows(
    tx,
    input.organizationId,
    eligible
  );
  for (const row of existing) {
    if (row.assigned) {
      assignedBranchIds.add(row.artifactId);
    }
    results.set(branchRefAggregateKey(row), {
      status: BranchMaterializationStatus.Materialized,
      artifactId: row.artifactId,
    });
  }
  const missing = eligible
    .filter((aggregate) => {
      const key = branchRefAggregateKey(aggregate);
      if (results.has(key)) {
        return false;
      }
      if (
        !hasBranchPushEvidence({
          pushObserved: aggregate.pushObserved === true,
          branchLifecycleEvents: aggregate.branchLifecycleEvents,
          pullRequestObserved: aggregate.pullRequestObserved === true,
        })
      ) {
        results.set(key, {
          status: BranchMaterializationStatus.NotMaterialized,
          cause: CloudBranchNonMaterializationKind.NotPushed,
        });
        return false;
      }
      return true;
    })
    .map((aggregate) => ({ aggregate, artifactId: uuidv7() }));
  if (missing.length > 0) {
    await tx.artifact.createMany({
      data: missing.map(({ aggregate, artifactId }) => ({
        id: artifactId,
        type: ArtifactType.Branch,
        organizationId: input.organizationId,
        projectId: input.projectId,
        name: aggregate.branchName,
        status: GitHubPRState.Open,
        externalUrl: `https://github.com/${aggregate.repositoryFullName}/tree/${encodeURIComponent(aggregate.branchName)}`,
      })),
    });
    // A racing D2 insert still aborts this transaction, as the single-row writer does.
    await tx.branchDetail.createMany({
      data: missing.map(({ aggregate, artifactId }) => ({
        artifactId,
        organizationId: input.organizationId,
        repositoryId:
          input.authorities.get(aggregate.repositoryFullName)?.repositoryId ??
          null,
        repositoryFullName: aggregate.repositoryFullName,
        branchName: aggregate.branchName,
      })),
    });
    for (const { aggregate, artifactId } of missing) {
      results.set(branchRefAggregateKey(aggregate), {
        status: BranchMaterializationStatus.Materialized,
        artifactId,
      });
    }
  }
  return { materializations: results, assignedBranchIds };
}
