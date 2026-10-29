import {
  BranchParticipationKind,
  normalizeBranchParticipationKind,
} from "@repo/api/src/types/branch";
import type { Priority } from "@repo/api/src/types/common";
import type {
  PersistedSessionPrRef,
  SyncedBranchArtifactRef,
  SyncedBranchLifecycleEvent,
  SyncedPullRequestArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  BRANCH_PUSH_METHODS,
  PROSE_MENTION_REF_METHODS,
  sessionPrIdentityKey,
} from "@repo/api/src/types/session-artifact-link";
import { mergeBranchLifecycleEvents } from "./shared";

/**
 * Folded per-session evidence for one repository/branch identity.
 * This is the durable retry payload; replaying it must produce the same
 * Product-visible link metadata as immediate ingest.
 */
export type BranchRefAggregate = {
  repositoryFullName: string;
  branchName: string;
  method: string;
  relation: ArtifactRefRelation;
  observedAt?: string;
  /**
   * Earliest PUSH-method observation TIMESTAMP, when the ref carried one. Drives
   * `firstPushedAt` only. ISS-8148: never read this to decide WHETHER a push
   * happened — `observedAt` is optional on the wire, so an older Desktop build
   * emits a real `git_push` with no timestamp and this stays undefined.
   */
  pushedAt?: string;
  /**
   * ISS-8148: a PUSH-method ref was observed, timestamp or not. This is the
   * push-EVIDENCE bit; `pushedAt` is the push-TIME. Splitting them keeps a
   * version-skewed producer's timestamp-less `git_push` from being read as
   * "never pushed" (Cross-Repo Compatibility: a missing optional field degrades,
   * it does not gate).
   */
  pushObserved?: boolean;
  /**
   * ISS-8186 (tamsinb, #6080): a PULL-REQUEST ref in the same payload named
   * this branch as its head, which vouches for a push without one having been
   * observed on a branch ref.
   *
   * Kept as its own bit rather than folded into `pushObserved`, which would be a
   * distinction collapse with a consequence: `pushObserved` also drives the
   * timestamp-less `stampBranchFirstPush` upper bound, so a PR-vouched branch
   * would acquire a fabricated `firstPushedAt` from a lane that observed no
   * push. It lives on the AGGREGATE, not in a caller-side set, because the
   * aggregate is what the durable retry store persists — a deferred identity
   * whose only evidence is a same-batch PR ref would otherwise reach the drain
   * stripped of the reason it was eligible.
   */
  pullRequestObserved?: boolean;
  /**
   * False means the aggregate was produced only from PR head evidence; missing
   * preserves legacy branch-ref retry rows as independent Branch evidence.
   */
  branchRefObserved?: boolean;
  /**
   * Exact PR identities that justified PR-derived Branch evidence. Optional so
   * older retry rows stay readable and Branch-only evidence stays unchanged.
   */
  prRefs?: PersistedSessionPrRef[];
  branchLifecycleEvents: SyncedBranchLifecycleEvent[];
  directParticipation?: BranchParticipationKind;
  directParticipationMethod?: string;
  directParticipationObservedAt?: string;
  /**
   * ISS-10332: the desktop-set priority a deferred identity's ref carried, so
   * the retry drain can seed it once the branch materializes. Optional so rows
   * enqueued before this field existed still parse.
   */
  priority?: Priority;
};

/** Stable identity key for one session's folded Branch evidence. */
export function branchRefAggregateKey(input: {
  repositoryFullName: string;
  branchName: string;
}): string {
  return `${input.repositoryFullName}#${input.branchName}`;
}

/** Fold a branch ref into the per-target aggregate: strongest relation + latest observedAt win. */
export function foldBranchRef(
  byTarget: Map<string, BranchRefAggregate>,
  targetKey: string,
  ref: SyncedBranchArtifactRef
): void {
  const existing = byTarget.get(targetKey);
  const incoming = branchRefAggregateFromRef(ref);
  if (!existing) {
    byTarget.set(targetKey, incoming);
    return;
  }
  byTarget.set(targetKey, mergeBranchRefAggregates(existing, incoming));
}

/** Merge two persisted aggregates without downgrading stronger evidence. */
export function mergeBranchRefAggregates(
  existing: BranchRefAggregate,
  incoming: BranchRefAggregate
): BranchRefAggregate {
  const merged: BranchRefAggregate = {
    ...existing,
    branchLifecycleEvents: mergeBranchLifecycleEvents(
      existing.branchLifecycleEvents,
      incoming.branchLifecycleEvents
    ),
  };
  if (branchRefEvidenceRank(incoming) < branchRefEvidenceRank(existing)) {
    merged.relation = incoming.relation;
    merged.method = incoming.method;
  }
  if (
    incoming.observedAt &&
    (!merged.observedAt ||
      Date.parse(incoming.observedAt) > Date.parse(merged.observedAt))
  ) {
    merged.observedAt = incoming.observedAt;
  }
  if (
    incoming.pushedAt &&
    (!merged.pushedAt ||
      Date.parse(incoming.pushedAt) < Date.parse(merged.pushedAt))
  ) {
    merged.pushedAt = incoming.pushedAt;
  }
  if (incoming.pushObserved) {
    merged.pushObserved = true;
  }
  if (incoming.pullRequestObserved) {
    merged.pullRequestObserved = true;
  }
  // The later sync carries the desktop's current claim.
  if (incoming.priority) {
    merged.priority = incoming.priority;
  }
  const branchRefObserved = mergeBranchRefObserved(
    existing.branchRefObserved,
    incoming.branchRefObserved
  );
  if (branchRefObserved === undefined) {
    Reflect.deleteProperty(merged, "branchRefObserved");
  } else {
    merged.branchRefObserved = branchRefObserved;
  }
  const prRefs = mergePersistedSessionPrRefs(existing.prRefs, incoming.prRefs);
  if (prRefs.length > 0) {
    merged.prRefs = prRefs;
  } else {
    Reflect.deleteProperty(merged, "prRefs");
  }
  mergeDirectBranchParticipationEvidence(
    merged,
    directBranchParticipationEvidenceFromAggregate(incoming)
  );
  return merged;
}

/** Merge a current PR-head snapshot, dropping persisted PR refs it no longer names. */
export function mergeBranchRefAggregatesReplacingPullRequestRefs(
  existing: BranchRefAggregate,
  incoming: BranchRefAggregate
): BranchRefAggregate {
  if (!replacesPullRequestRefs(incoming)) {
    return mergeBranchRefAggregates(existing, incoming);
  }
  const incomingPrRefs = mergePersistedSessionPrRefs(incoming.prRefs);
  const incomingIdentities = new Set(
    incomingPrRefs.map((ref) =>
      sessionPrIdentityKey(ref.repositoryFullName, ref.prNumber)
    )
  );
  const retainedExistingPrRefs = mergePersistedSessionPrRefs(
    (existing.prRefs ?? []).filter((ref) =>
      incomingIdentities.has(
        sessionPrIdentityKey(ref.repositoryFullName, ref.prNumber)
      )
    )
  );
  const prunedExisting = aggregateWithPrRefs(existing, retainedExistingPrRefs);
  return mergeBranchRefAggregates(prunedExisting, {
    ...incoming,
    prRefs: incomingPrRefs,
  });
}

function branchRefAggregateFromRef(
  ref: SyncedBranchArtifactRef
): BranchRefAggregate {
  const aggregate: BranchRefAggregate = {
    repositoryFullName: ref.repositoryFullName,
    branchName: ref.branchName,
    method: ref.method,
    relation: ref.relation,
    branchLifecycleEvents: ref.branchLifecycleEvents ?? [],
    branchRefObserved: true,
    ...(ref.observedAt ? { observedAt: ref.observedAt } : {}),
    ...(BRANCH_PUSH_METHODS.has(ref.method) ? { pushObserved: true } : {}),
    ...(BRANCH_PUSH_METHODS.has(ref.method) && ref.observedAt
      ? { pushedAt: ref.observedAt }
      : {}),
  };
  mergeDirectBranchParticipationEvidence(
    aggregate,
    directBranchParticipationEvidenceFromRef(ref)
  );
  return aggregate;
}

/** Fold a PR ref with explicit head Branch identity into retryable Branch evidence. */
export function branchRefAggregateFromPullRequestRef(
  ref: SyncedPullRequestArtifactRef & { branchName: string },
  prRef: PersistedSessionPrRef
): BranchRefAggregate {
  const aggregate: BranchRefAggregate = {
    repositoryFullName: ref.repositoryFullName,
    branchName: ref.branchName,
    method: ref.method,
    relation: ref.relation,
    branchLifecycleEvents: ref.branchLifecycleEvents ?? [],
    pullRequestObserved: true,
    branchRefObserved: false,
    prRefs: [prRef],
    ...(ref.observedAt ? { observedAt: ref.observedAt } : {}),
  };
  mergeDirectBranchParticipationEvidence(
    aggregate,
    directBranchParticipationEvidenceFromRef(ref)
  );
  return aggregate;
}

export function mergePersistedSessionPrRefs(
  ...groups: readonly (readonly PersistedSessionPrRef[] | undefined)[]
): PersistedSessionPrRef[] {
  const byIdentity = new Map<
    string,
    {
      repositoryFullName: string;
      prNumber: number;
      relationTypes: Set<PersistedSessionPrRef["relationTypes"][number]>;
      method?: string;
    }
  >();
  for (const group of groups) {
    for (const ref of group ?? []) {
      const identity = sessionPrIdentityKey(
        ref.repositoryFullName,
        ref.prNumber
      );
      const existing = byIdentity.get(identity);
      if (!existing) {
        byIdentity.set(identity, {
          repositoryFullName: ref.repositoryFullName,
          prNumber: ref.prNumber,
          relationTypes: new Set(ref.relationTypes),
          ...(ref.method ? { method: ref.method } : {}),
        });
        continue;
      }
      for (const relationType of ref.relationTypes) {
        existing.relationTypes.add(relationType);
      }
      if (!ref.method) {
        Reflect.deleteProperty(existing, "method");
      } else if (existing.method) {
        // Intentional: command-derived evidence has no method and is never weakened by prose.
        existing.method = ref.method;
      }
    }
  }
  return [...byIdentity.values()]
    .map((ref) => ({
      repositoryFullName: ref.repositoryFullName,
      prNumber: ref.prNumber,
      relationTypes: [...ref.relationTypes].sort(),
      ...(ref.method ? { method: ref.method } : {}),
    }))
    .sort((left, right) => {
      const repositoryOrder = sessionPrIdentityKey(
        left.repositoryFullName,
        0
      ).localeCompare(sessionPrIdentityKey(right.repositoryFullName, 0));
      return repositoryOrder || left.prNumber - right.prNumber;
    });
}

export function hasPullRequestHeadPrIdentity(
  aggregate: BranchRefAggregate
): boolean {
  return aggregate.pullRequestObserved === true && hasPrRefs(aggregate);
}

export function hasPullRequestHeadPushEvidence(
  aggregate: BranchRefAggregate
): boolean {
  return (
    aggregate.pullRequestObserved === true &&
    (hasPrRefs(aggregate) || aggregate.branchRefObserved === undefined)
  );
}

export function isPullRequestHeadAggregateMissingPrIdentity(
  aggregate: BranchRefAggregate
): boolean {
  return (
    aggregate.pullRequestObserved === true &&
    aggregate.branchRefObserved === false &&
    !hasPrRefs(aggregate)
  );
}

export function normalizeBranchRefAggregatePrRefs(
  aggregate: BranchRefAggregate
): BranchRefAggregate {
  const normalized = { ...aggregate };
  const prRefs = mergePersistedSessionPrRefs(aggregate.prRefs);
  if (prRefs.length > 0) {
    normalized.prRefs = prRefs;
  } else {
    Reflect.deleteProperty(normalized, "prRefs");
  }
  return normalized;
}

function hasPrRefs(aggregate: BranchRefAggregate): boolean {
  return aggregate.prRefs !== undefined && aggregate.prRefs.length > 0;
}

function aggregateWithPrRefs(
  aggregate: BranchRefAggregate,
  prRefs: PersistedSessionPrRef[]
): BranchRefAggregate {
  const next = { ...aggregate };
  if (prRefs.length > 0) {
    next.prRefs = prRefs;
  } else {
    Reflect.deleteProperty(next, "prRefs");
  }
  return next;
}

function replacesPullRequestRefs(aggregate: BranchRefAggregate): boolean {
  return (
    aggregate.pullRequestObserved === true &&
    aggregate.branchRefObserved === false
  );
}

function branchRefEvidenceRank(ref: {
  relation: ArtifactRefRelation;
  method: string;
}): number {
  if (PROSE_MENTION_REF_METHODS.has(ref.method)) {
    return 98;
  }
  return BRANCH_RELATION_PRECEDENCE[ref.relation] ?? 99;
}

const BRANCH_RELATION_PRECEDENCE: Record<ArtifactRefRelation, number> = {
  [ArtifactRefRelation.Created]: 0,
  [ArtifactRefRelation.Output]: 1,
  [ArtifactRefRelation.Input]: 2,
  [ArtifactRefRelation.Referenced]: 3,
  [ArtifactRefRelation.Reviewed]: 4,
  [ArtifactRefRelation.Workspace]: 4,
};

function directBranchParticipationEvidenceFromRef(
  ref: DirectBranchParticipationRef
): DirectBranchParticipationEvidence | null {
  const branchParticipation =
    normalizeBranchParticipationKind(ref.branchParticipation) ??
    deriveDirectBranchParticipation(ref);
  if (!branchParticipation) {
    return null;
  }
  return {
    branchParticipation,
    method: ref.method,
    ...(ref.observedAt ? { observedAt: ref.observedAt } : {}),
  };
}

function directBranchParticipationEvidenceFromAggregate(
  aggregate: BranchRefAggregate
): DirectBranchParticipationEvidence | null {
  if (!aggregate.directParticipation) {
    return null;
  }
  return {
    branchParticipation: aggregate.directParticipation,
    method: aggregate.directParticipationMethod ?? aggregate.method,
    ...(aggregate.directParticipationObservedAt
      ? { observedAt: aggregate.directParticipationObservedAt }
      : {}),
  };
}

function deriveDirectBranchParticipation(input: {
  relation: ArtifactRefRelation;
  method: string;
}): BranchParticipationKind | undefined {
  if (
    input.relation === ArtifactRefRelation.Created ||
    input.relation === ArtifactRefRelation.Output ||
    BRANCH_PUSH_METHODS.has(input.method)
  ) {
    return BranchParticipationKind.Wrote;
  }
  if (
    input.method === ArtifactRefMethod.PrReviewFeedbackCommand ||
    input.relation === ArtifactRefRelation.Reviewed
  ) {
    return BranchParticipationKind.Reviewed;
  }
  return undefined;
}

function mergeDirectBranchParticipationEvidence(
  aggregate: BranchRefAggregate,
  incoming: DirectBranchParticipationEvidence | null
): void {
  if (!incoming) {
    return;
  }
  const currentRank = directBranchParticipationRank(
    aggregate.directParticipation
  );
  const incomingRank = directBranchParticipationRank(
    incoming.branchParticipation
  );
  if (incomingRank > currentRank) {
    return;
  }
  if (incomingRank === currentRank && aggregate.directParticipation) {
    const currentPriority = directBranchParticipationEvidencePriority({
      branchParticipation: aggregate.directParticipation,
      method: aggregate.directParticipationMethod ?? "",
    });
    const incomingPriority =
      directBranchParticipationEvidencePriority(incoming);
    if (incomingPriority > currentPriority) {
      return;
    }
    if (incomingPriority === currentPriority) {
      if (!incoming.observedAt) {
        return;
      }
      if (
        aggregate.directParticipationObservedAt &&
        Date.parse(incoming.observedAt) <=
          Date.parse(aggregate.directParticipationObservedAt)
      ) {
        return;
      }
    }
  }
  aggregate.directParticipation = incoming.branchParticipation;
  aggregate.directParticipationMethod = incoming.method;
  if (incoming.observedAt) {
    aggregate.directParticipationObservedAt = incoming.observedAt;
    return;
  }
  Reflect.deleteProperty(aggregate, "directParticipationObservedAt");
}

function directBranchParticipationRank(
  branchParticipation: BranchParticipationKind | undefined
): number {
  if (branchParticipation === BranchParticipationKind.Wrote) {
    return 0;
  }
  if (branchParticipation === BranchParticipationKind.Reviewed) {
    return 1;
  }
  return 99;
}

function directBranchParticipationEvidencePriority(
  input: DirectBranchParticipationEvidence
): number {
  if (
    input.branchParticipation === BranchParticipationKind.Reviewed &&
    input.method === ArtifactRefMethod.PrReviewFeedbackCommand
  ) {
    return 0;
  }
  return 1;
}

type DirectBranchParticipationEvidence = {
  branchParticipation: BranchParticipationKind;
  method: string;
  observedAt?: string;
};

type DirectBranchParticipationRef = {
  branchParticipation?: unknown;
  relation: ArtifactRefRelation;
  method: string;
  observedAt?: string;
};

function mergeBranchRefObserved(
  existing: boolean | undefined,
  incoming: boolean | undefined
): boolean | undefined {
  if (existing === false && incoming === false) {
    return false;
  }
  if (existing === true || incoming === true) {
    return true;
  }
  return undefined;
}

/**
 * ISS-8186: split a session's folded branch identities into the ones this slice
 * materializes INLINE and the ones it defers.
 *
 * The branch lane awaits one `ensureBranchArtifactRow` per distinct identity
 * inside the session's own write transaction, and the identity count comes from
 * that session's whole `artifactRefs` array — a different, earlier lane than the
 * monitored-activity persist, whose own work is uncapped since ISS-9860, so
 * nothing in that later lane ever bounded this one (whitlockk, #5990).
 *
 * Insertion order is the payload's own ref order, so the split is deterministic
 * across retries of the same payload: a given identity lands on the same side
 * every time, and the deferred set does not churn.
 *
 * NOTHING IS DROPPED — the caller enqueues `deferred` into the durable branch
 * materialization retry store. A truncating version of this helper would be a
 * silent data loss, not a bound.
 */
export function partitionBranchMaterializationBudget(
  byIdentity: ReadonlyMap<string, BranchRefAggregate>,
  budget: number
): {
  inline: [string, BranchRefAggregate][];
  deferred: [string, BranchRefAggregate][];
} {
  const entries = [...byIdentity];
  const boundedBudget = Math.max(1, budget);
  return {
    inline: entries.slice(0, boundedBudget),
    deferred: entries.slice(boundedBudget),
  };
}
