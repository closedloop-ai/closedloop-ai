import { GitHubFetchMechanism } from "@repo/api/src/types/github-read-model";
import {
  type RepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  type RepositoryDefaultProvenance,
  RepositoryDefaultReason,
  type RepositoryDefaultUnavailableObservation,
  repositoryDefaultProvenanceValidator,
} from "@repo/api/src/types/repository-default-identity";
import type { Prisma, TransactionClient } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  claimRepositoryDefaultObservationReceipt,
  RepositoryDefaultObservationTargetKind,
} from "@/lib/github/repository-default-observation-receipt";

/** Additive head-repository observation carried by PR provider projections. */
export type PullRequestHeadRepositoryObservation = {
  authority?: RepositoryDefaultAuthority;
  unavailable?: RepositoryDefaultUnavailableObservation;
  /** Exact provider PR head captured by the same bounded acquisition. */
  headRef?: { name: string; oid?: string | null };
};

/** Preserve the provider's optional available or typed-unavailable PR head. */
export function pullRequestHeadRepositoryObservation(input: {
  headRepository?: RepositoryDefaultAuthority;
  headRepositoryUnavailable?: RepositoryDefaultUnavailableObservation;
  headBranch?: string;
  headSha?: string | null;
}): PullRequestHeadRepositoryObservation | undefined {
  const headRef =
    input.headBranch === undefined && input.headSha === undefined
      ? {}
      : { headRef: { name: input.headBranch ?? "", oid: input.headSha } };
  if (input.headRepository) {
    return { authority: input.headRepository, ...headRef };
  }
  if (input.headRepositoryUnavailable) {
    return { unavailable: input.headRepositoryUnavailable, ...headRef };
  }
  return undefined;
}

type PullRequestAuthorityClient = {
  pullRequestDetail: Pick<
    TransactionClient["pullRequestDetail"],
    "findFirst" | "updateMany"
  >;
  repositoryDefaultObservationReceipt: Pick<
    TransactionClient["repositoryDefaultObservationReceipt"],
    "createMany"
  >;
};

type StoredHeadAuthority = {
  headRefName: string | null;
  headRefOid: string | null;
  headRepositoryGithubId: string | null;
  headRepositoryFullName: string | null;
  headRepositoryDefaultBranchName: string | null;
  headRepositoryDefaultBranchAvailability: string | null;
  headRepositoryDefaultBranchCompleteness: string | null;
  headRepositoryDefaultBranchReason: string | null;
  headRepositoryDefaultBranchSource: string | null;
  headRepositoryDefaultBranchMechanism: string | null;
  headRepositoryDefaultBranchTrigger: string | null;
  headRepositoryDefaultBranchCredentialType: string | null;
  headRepositoryDefaultBranchCredentialOwnerId: string | null;
  headRepositoryDefaultBranchObservationKey: string | null;
  headRepositoryDefaultBranchObservedAt: Date | null;
  headRepositoryDefaultBranchEventAt: Date | null;
};

type ResolvedHeadAuthority = {
  repositoryGithubId: string | null;
  repositoryFullName: string | null;
  branchName: string | null;
  availability: string;
  completeness: string;
  reason: string | null;
  provenance: RepositoryDefaultProvenance;
};

const AUTHORITY_SELECT = {
  headRefName: true,
  headRefOid: true,
  headRepositoryGithubId: true,
  headRepositoryFullName: true,
  headRepositoryDefaultBranchName: true,
  headRepositoryDefaultBranchAvailability: true,
  headRepositoryDefaultBranchCompleteness: true,
  headRepositoryDefaultBranchReason: true,
  headRepositoryDefaultBranchSource: true,
  headRepositoryDefaultBranchMechanism: true,
  headRepositoryDefaultBranchTrigger: true,
  headRepositoryDefaultBranchCredentialType: true,
  headRepositoryDefaultBranchCredentialOwnerId: true,
  headRepositoryDefaultBranchObservationKey: true,
  headRepositoryDefaultBranchObservedAt: true,
  headRepositoryDefaultBranchEventAt: true,
} as const;

const AUTHORITY_CAS_MAX_ATTEMPTS = 3;

/**
 * Atomically applies an optional PR-head authority observation. Exact replays
 * are no-ops, and optimistic compare-and-swap prevents concurrent stale writes.
 */
export async function persistPullRequestHeadRepositoryAuthority(
  db: PullRequestAuthorityClient,
  scope: {
    organizationId: string;
    pullRequestDetailId: string;
  },
  observation: PullRequestHeadRepositoryObservation | undefined,
  headRef?: { name: string; oid?: string | null }
): Promise<boolean> {
  const incoming = resolveIncomingObservation(observation);
  if (!incoming) {
    return false;
  }
  const incomingHeadRef = normalizeHeadRef(headRef ?? observation?.headRef);
  let webhookReceiptClaimed = false;

  for (let attempt = 0; attempt < AUTHORITY_CAS_MAX_ATTEMPTS; attempt += 1) {
    const stored = await db.pullRequestDetail.findFirst({
      where: {
        id: scope.pullRequestDetailId,
        organizationId: scope.organizationId,
      },
      select: AUTHORITY_SELECT,
    });
    if (!stored) {
      return false;
    }
    if (
      isAvailableCompleteAuthority(incoming) &&
      !incomingHeadRef &&
      hasStoredHeadRefEvidence(stored)
    ) {
      return false;
    }

    if (
      !(await claimWebhookReceipt(db, scope, incoming, webhookReceiptClaimed))
    ) {
      return false;
    }
    webhookReceiptClaimed = true;

    const outcome = await applyAuthorityDecision(
      db,
      scope,
      stored,
      incoming,
      incomingHeadRef
    );
    if (outcome !== "retry") {
      return outcome;
    }
  }

  log.error("github_repository_default_authority_stale_rejected", {
    organizationId: scope.organizationId,
    pullRequestDetailId: scope.pullRequestDetailId,
    observationKey: incoming.provenance.observationKey,
    reason: PullRequestHeadAuthorityDiagnosticReason.CompareAndSwapExhausted,
  });
  if (webhookReceiptClaimed) {
    throw new Error(
      "Webhook repository-default authority compare-and-swap exhausted"
    );
  }
  return false;
}

function claimWebhookReceipt(
  db: PullRequestAuthorityClient,
  scope: { organizationId: string; pullRequestDetailId: string },
  incoming: ResolvedHeadAuthority,
  alreadyClaimed: boolean
): Promise<boolean> {
  if (
    incoming.provenance.mechanism !== GitHubFetchMechanism.Webhook ||
    alreadyClaimed
  ) {
    return Promise.resolve(true);
  }
  return claimRepositoryDefaultObservationReceipt(db, {
    organizationId: scope.organizationId,
    targetKind: RepositoryDefaultObservationTargetKind.PullRequestDetail,
    targetId: scope.pullRequestDetailId,
    source: incoming.provenance.source,
    observationKey: incoming.provenance.observationKey,
    observedAt: new Date(incoming.provenance.observedAt),
  });
}

async function applyAuthorityDecision(
  db: PullRequestAuthorityClient,
  scope: { organizationId: string; pullRequestDetailId: string },
  stored: StoredHeadAuthority,
  incoming: ResolvedHeadAuthority,
  headRef: { name: string; oid: string } | null
): Promise<boolean | "retry"> {
  const decision = decideHeadAuthority(stored, incoming);
  if (decision.kind === "noop") {
    if (!canRepairLegacyHeadRef(stored, incoming, headRef)) {
      return false;
    }
    const outcome = await persistLegacyHeadRef(db, scope, stored, headRef);
    return outcome === "updated" ? true : "retry";
  }
  if (decision.kind === "stale") {
    log.error("github_repository_default_authority_stale_rejected", {
      organizationId: scope.organizationId,
      pullRequestDetailId: scope.pullRequestDetailId,
      observationKey: incoming.provenance.observationKey,
      reason: PullRequestHeadAuthorityDiagnosticReason.StaleObservation,
    });
    return false;
  }
  if (decision.kind === "conflict") {
    log.error("github_repository_default_authority_conflict", {
      organizationId: scope.organizationId,
      pullRequestDetailId: scope.pullRequestDetailId,
      observationKey: incoming.provenance.observationKey,
      reason: RepositoryDefaultReason.Conflicting,
    });
  }
  if (incoming.reason === RepositoryDefaultReason.Malformed) {
    log.error("github_repository_default_authority_malformed", {
      organizationId: scope.organizationId,
      pullRequestDetailId: scope.pullRequestDetailId,
      providerRepositoryId: incoming.repositoryGithubId,
      repositoryFullName: incoming.repositoryFullName,
      source: incoming.provenance.source,
      observationKey: incoming.provenance.observationKey,
      reason: RepositoryDefaultReason.Malformed,
    });
  }
  const result = await db.pullRequestDetail.updateMany({
    where: {
      id: scope.pullRequestDetailId,
      organizationId: scope.organizationId,
      headRepositoryDefaultBranchObservationKey:
        stored.headRepositoryDefaultBranchObservationKey,
      headRepositoryDefaultBranchObservedAt:
        stored.headRepositoryDefaultBranchObservedAt,
      headRefName: stored.headRefName,
      headRefOid: stored.headRefOid,
    },
    data: {
      ...toPrismaData(decision.value),
      ...(decision.kind === "accept" &&
      isAvailableCompleteAuthority(decision.value) &&
      headRef
        ? headRefData(headRef)
        : {}),
    },
  });
  return result.count === 1 ? true : "retry";
}

async function persistLegacyHeadRef(
  db: PullRequestAuthorityClient,
  scope: { organizationId: string; pullRequestDetailId: string },
  stored: StoredHeadAuthority,
  headRef: { name: string; oid: string }
): Promise<"retry" | "updated"> {
  const result = await db.pullRequestDetail.updateMany({
    where: {
      id: scope.pullRequestDetailId,
      organizationId: scope.organizationId,
      headRepositoryDefaultBranchObservationKey:
        stored.headRepositoryDefaultBranchObservationKey,
      headRepositoryDefaultBranchObservedAt:
        stored.headRepositoryDefaultBranchObservedAt,
      headRefName: stored.headRefName,
      headRefOid: stored.headRefOid,
    },
    data: headRefData(headRef),
  });
  return result.count === 1 ? "updated" : "retry";
}

function normalizeHeadRef(
  headRef: { name: string; oid?: string | null } | undefined
): { name: string; oid: string } | null {
  const name = headRef?.name.trim();
  const oid = headRef?.oid?.trim();
  return name && oid ? { name, oid } : null;
}

function hasStoredHeadRefEvidence(stored: StoredHeadAuthority): boolean {
  return Boolean(stored.headRefName || stored.headRefOid);
}

function headRefData(headRef: {
  name: string;
  oid: string;
}): Prisma.PullRequestDetailUncheckedUpdateInput {
  return {
    headRefName: headRef.name,
    headRefOid: headRef.oid,
  };
}

function canRepairLegacyHeadRef(
  stored: StoredHeadAuthority,
  incoming: ResolvedHeadAuthority,
  headRef: { name: string; oid: string } | null
): headRef is { name: string; oid: string } {
  return Boolean(
    headRef &&
      incoming.provenance.mechanism !== GitHubFetchMechanism.Webhook &&
      isAvailableCompleteAuthority(incoming) &&
      stored.headRepositoryDefaultBranchAvailability ===
        RepositoryDefaultAvailability.Available &&
      stored.headRepositoryDefaultBranchCompleteness ===
        RepositoryDefaultCompleteness.Complete &&
      hasSameSemanticAuthority(stored, incoming) &&
      hasSameObservationProvenance(stored, incoming) &&
      (stored.headRefName === null || stored.headRefName === headRef.name) &&
      (stored.headRefOid === null || stored.headRefOid === headRef.oid) &&
      (stored.headRefName === null) !== (stored.headRefOid === null)
  );
}

function hasSameObservationProvenance(
  stored: StoredHeadAuthority,
  incoming: ResolvedHeadAuthority
): boolean {
  const storedObservedAt = stored.headRepositoryDefaultBranchObservedAt;
  const storedEventAt = stored.headRepositoryDefaultBranchEventAt;
  const incomingObservedAt = new Date(incoming.provenance.observedAt);
  const incomingEventAt = incoming.provenance.eventAt
    ? new Date(incoming.provenance.eventAt)
    : null;
  return (
    stored.headRepositoryDefaultBranchSource === incoming.provenance.source &&
    stored.headRepositoryDefaultBranchMechanism ===
      incoming.provenance.mechanism &&
    stored.headRepositoryDefaultBranchTrigger === incoming.provenance.trigger &&
    stored.headRepositoryDefaultBranchCredentialType ===
      incoming.provenance.credentialType &&
    stored.headRepositoryDefaultBranchCredentialOwnerId ===
      (incoming.provenance.credentialOwnerId ?? null) &&
    stored.headRepositoryDefaultBranchObservationKey ===
      incoming.provenance.observationKey &&
    storedObservedAt?.getTime() === incomingObservedAt.getTime() &&
    storedEventAt?.getTime() === incomingEventAt?.getTime()
  );
}

function isAvailableCompleteAuthority(
  authority: ResolvedHeadAuthority
): boolean {
  return (
    authority.availability === RepositoryDefaultAvailability.Available &&
    authority.completeness === RepositoryDefaultCompleteness.Complete
  );
}

function resolveIncomingObservation(
  observation: PullRequestHeadRepositoryObservation | undefined
): ResolvedHeadAuthority | null {
  if (observation?.authority) {
    const { repository, evidence, provenance } = observation.authority;
    return {
      repositoryGithubId: repository.providerRepositoryId,
      repositoryFullName: repository.fullName,
      branchName: "defaultBranch" in evidence ? evidence.defaultBranch : null,
      availability: evidence.availability,
      completeness: evidence.completeness,
      reason: "reason" in evidence ? evidence.reason : null,
      provenance,
    };
  }
  if (observation?.unavailable) {
    return {
      repositoryGithubId: null,
      repositoryFullName: null,
      branchName: null,
      availability: RepositoryDefaultAvailability.Unavailable,
      completeness: RepositoryDefaultCompleteness.Unavailable,
      reason: observation.unavailable.reason,
      provenance: observation.unavailable.provenance,
    };
  }
  return null;
}

function decideHeadAuthority(
  stored: StoredHeadAuthority,
  incoming: ResolvedHeadAuthority
):
  | { kind: "noop" }
  | { kind: "stale" }
  | { kind: "accept" | "conflict"; value: ResolvedHeadAuthority } {
  if (
    stored.headRepositoryDefaultBranchObservationKey ===
      incoming.provenance.observationKey &&
    stored.headRepositoryDefaultBranchSource === incoming.provenance.source
  ) {
    return { kind: "noop" };
  }

  const observationOrder = compareObservationTime(stored, incoming);
  if (observationOrder === null) {
    return {
      kind: "accept",
      value: retainKnownAuthorityWhenPoorer(stored, incoming),
    };
  }
  if (observationOrder < 0) {
    return { kind: "stale" };
  }
  if (observationOrder > 0) {
    return {
      kind: "accept",
      value: retainKnownAuthorityWhenPoorer(stored, incoming),
    };
  }
  return decideEqualTimeAuthority(stored, incoming);
}

/**
 * Provider event time wins for webhooks; a live read's acquisition time is its
 * snapshot cutoff. Comparing those cutoffs stops a delayed webhook from
 * rewinding a newer REST or GraphQL pair merely because its receipt was later.
 */
function compareObservationTime(
  stored: StoredHeadAuthority,
  incoming: ResolvedHeadAuthority
): number | null {
  const storedAt =
    stored.headRepositoryDefaultBranchEventAt ??
    stored.headRepositoryDefaultBranchObservedAt;
  if (!storedAt) {
    return null;
  }
  const incomingAt = new Date(
    incoming.provenance.eventAt ?? incoming.provenance.observedAt
  );
  return incomingAt.getTime() - storedAt.getTime();
}

function decideEqualTimeAuthority(
  stored: StoredHeadAuthority,
  incoming: ResolvedHeadAuthority
):
  | { kind: "noop" }
  | { kind: "accept" | "conflict"; value: ResolvedHeadAuthority } {
  const storedAvailable =
    stored.headRepositoryDefaultBranchAvailability ===
    RepositoryDefaultAvailability.Available;
  const incomingAvailable =
    incoming.availability === RepositoryDefaultAvailability.Available;

  if (
    stored.headRepositoryDefaultBranchReason ===
    RepositoryDefaultReason.Conflicting
  ) {
    return { kind: "noop" };
  }

  if (hasSameSemanticAuthority(stored, incoming)) {
    return deterministicEqualTimeDecision(stored, incoming);
  }

  if (storedAvailable && incomingAvailable) {
    const sameRepository =
      stored.headRepositoryFullName === incoming.repositoryFullName &&
      stored.headRepositoryGithubId === incoming.repositoryGithubId;
    const provenance = deterministicProvenance(stored, incoming);
    return {
      kind: "conflict",
      value: {
        ...incoming,
        repositoryGithubId: sameRepository ? incoming.repositoryGithubId : null,
        repositoryFullName: sameRepository ? incoming.repositoryFullName : null,
        branchName: null,
        availability: RepositoryDefaultAvailability.Unavailable,
        completeness: RepositoryDefaultCompleteness.Unavailable,
        reason: RepositoryDefaultReason.Conflicting,
        provenance,
      },
    };
  }
  if (storedAvailable) {
    return { kind: "noop" };
  }
  if (incomingAvailable) {
    return { kind: "accept", value: incoming };
  }

  const storedKey = stored.headRepositoryDefaultBranchObservationKey ?? "";
  if (storedKey.localeCompare(incoming.provenance.observationKey) <= 0) {
    return { kind: "noop" };
  }
  return { kind: "accept", value: incoming };
}

function hasSameSemanticAuthority(
  stored: StoredHeadAuthority,
  incoming: ResolvedHeadAuthority
): boolean {
  return (
    stored.headRepositoryGithubId === incoming.repositoryGithubId &&
    stored.headRepositoryFullName === incoming.repositoryFullName &&
    stored.headRepositoryDefaultBranchName === incoming.branchName &&
    stored.headRepositoryDefaultBranchAvailability === incoming.availability &&
    stored.headRepositoryDefaultBranchCompleteness === incoming.completeness &&
    stored.headRepositoryDefaultBranchReason === incoming.reason
  );
}

function deterministicEqualTimeDecision(
  stored: StoredHeadAuthority,
  incoming: ResolvedHeadAuthority
): { kind: "noop" } | { kind: "accept"; value: ResolvedHeadAuthority } {
  const storedIdentity = storedObservationIdentity(stored);
  const incomingIdentity = `${incoming.provenance.source}:${incoming.provenance.observationKey}`;
  if (storedIdentity.localeCompare(incomingIdentity) <= 0) {
    return { kind: "noop" };
  }
  return { kind: "accept", value: incoming };
}

function deterministicProvenance(
  stored: StoredHeadAuthority,
  incoming: ResolvedHeadAuthority
): RepositoryDefaultProvenance {
  const storedProvenance = storedRepositoryDefaultProvenance(stored);
  if (!storedProvenance) {
    return incoming.provenance;
  }
  return storedObservationIdentity(stored).localeCompare(
    `${incoming.provenance.source}:${incoming.provenance.observationKey}`
  ) <= 0
    ? storedProvenance
    : incoming.provenance;
}

function storedObservationIdentity(stored: StoredHeadAuthority): string {
  return `${stored.headRepositoryDefaultBranchSource ?? ""}:${
    stored.headRepositoryDefaultBranchObservationKey ?? ""
  }`;
}

function storedRepositoryDefaultProvenance(
  stored: StoredHeadAuthority
): RepositoryDefaultProvenance | null {
  const source = stored.headRepositoryDefaultBranchSource;
  const mechanism = stored.headRepositoryDefaultBranchMechanism;
  const trigger = stored.headRepositoryDefaultBranchTrigger;
  const credentialType = stored.headRepositoryDefaultBranchCredentialType;
  const observationKey = stored.headRepositoryDefaultBranchObservationKey;
  const observedAt = stored.headRepositoryDefaultBranchObservedAt;
  if (
    !(
      source &&
      mechanism &&
      trigger &&
      credentialType &&
      observationKey &&
      observedAt
    )
  ) {
    return null;
  }
  const parsed = repositoryDefaultProvenanceValidator.safeParse({
    source,
    mechanism,
    trigger,
    credentialType,
    ...(stored.headRepositoryDefaultBranchCredentialOwnerId
      ? {
          credentialOwnerId:
            stored.headRepositoryDefaultBranchCredentialOwnerId,
        }
      : {}),
    observationKey,
    observedAt: observedAt.toISOString(),
    ...(stored.headRepositoryDefaultBranchEventAt
      ? { eventAt: stored.headRepositoryDefaultBranchEventAt.toISOString() }
      : {}),
  });
  return parsed.success ? parsed.data : null;
}

function retainKnownAuthorityWhenPoorer(
  stored: StoredHeadAuthority,
  incoming: ResolvedHeadAuthority
): ResolvedHeadAuthority {
  const storedHasKnownBranch =
    (stored.headRepositoryDefaultBranchAvailability ===
      RepositoryDefaultAvailability.Available ||
      stored.headRepositoryDefaultBranchAvailability ===
        RepositoryDefaultAvailability.Stale) &&
    Boolean(stored.headRepositoryDefaultBranchName);
  if (
    !storedHasKnownBranch ||
    incoming.availability === RepositoryDefaultAvailability.Available ||
    !stored.headRepositoryDefaultBranchName
  ) {
    return incoming;
  }
  return {
    ...incoming,
    repositoryGithubId: stored.headRepositoryGithubId,
    repositoryFullName: stored.headRepositoryFullName,
    branchName: stored.headRepositoryDefaultBranchName,
    availability: RepositoryDefaultAvailability.Stale,
    completeness: RepositoryDefaultCompleteness.Partial,
  };
}

function toPrismaData(
  authority: ResolvedHeadAuthority
): Prisma.PullRequestDetailUncheckedUpdateInput {
  return {
    headRepositoryGithubId: authority.repositoryGithubId,
    headRepositoryFullName: authority.repositoryFullName,
    headRepositoryDefaultBranchName: authority.branchName,
    headRepositoryDefaultBranchAvailability: authority.availability,
    headRepositoryDefaultBranchCompleteness: authority.completeness,
    headRepositoryDefaultBranchReason: authority.reason,
    headRepositoryDefaultBranchSource: authority.provenance.source,
    headRepositoryDefaultBranchMechanism: authority.provenance.mechanism,
    headRepositoryDefaultBranchTrigger: authority.provenance.trigger,
    headRepositoryDefaultBranchCredentialType:
      authority.provenance.credentialType,
    headRepositoryDefaultBranchCredentialOwnerId:
      authority.provenance.credentialOwnerId ?? null,
    headRepositoryDefaultBranchObservationKey:
      authority.provenance.observationKey,
    headRepositoryDefaultBranchObservedAt: new Date(
      authority.provenance.observedAt
    ),
    headRepositoryDefaultBranchEventAt: authority.provenance.eventAt
      ? new Date(authority.provenance.eventAt)
      : null,
  };
}

const PullRequestHeadAuthorityDiagnosticReason = {
  CompareAndSwapExhausted: "compare_and_swap_exhausted",
  StaleObservation: "stale_observation",
} as const;
