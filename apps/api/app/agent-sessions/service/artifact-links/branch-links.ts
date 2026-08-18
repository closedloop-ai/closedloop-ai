import {
  ArtifactType,
  BranchPushSource,
  LinkType,
} from "@repo/api/src/types/artifact";
import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
  normalizeBranchParticipationKind,
  normalizeRepoFullName,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import type {
  SyncedArtifactRef,
  SyncedBranchArtifactRef,
  SyncedBranchLifecycleEvent,
} from "@repo/api/src/types/session-artifact-link";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  BRANCH_PUSH_METHODS,
  deriveBranchParticipationFromEvidence,
  deriveBranchParticipationFromMetadata,
  PROSE_MENTION_REF_METHODS,
  parseSessionPrLinkMetadata,
  SessionArtifactLinkKind,
  SessionArtifactLinkMetadataSource,
} from "@repo/api/src/types/session-artifact-link";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { stampBranchFirstPush } from "@/app/branches/branch-push-state";
import {
  CloudBranchNonMaterializationKind,
  type CloudBranchNonMaterializationKind as CloudBranchNonMaterializationKindType,
} from "@/app/branches/branch-write-eligibility";
import { isCloudBranchEligible } from "@/app/branches/cloud-branch-eligibility";
import { parseJsonObject } from "@/lib/json-schema";
import type { AgentSessionUpsertTx } from "../records";
import type {
  SessionBranchRepositoryAuthority,
  SessionBranchRepositoryAuthorityMap,
} from "./shared";
import {
  collectBranchRefs,
  mergeBranchLifecycleEvents,
  readBranchLifecycleEventsFromMetadata,
  storeUnresolvedRefs,
} from "./shared";

/**
 * Extractor version stamped on session_branch link metadata so a future
 * re-derivation can be recognized and re-merged in place.
 */
const SESSION_BRANCH_LINK_EXTRACTOR_VERSION = 1;

/**
 * Precedence when a session touched one branch via several methods/relations —
 * write evidence (`created`/`output`) outranks read/workspace evidence, so the
 * cloud can distinguish a branch a session wrote to from one it merely started
 * on (FEA-2729 AC).
 */
const BRANCH_RELATION_PRECEDENCE: Record<ArtifactRefRelation, number> = {
  [ArtifactRefRelation.Created]: 0,
  [ArtifactRefRelation.Output]: 1,
  [ArtifactRefRelation.Input]: 2,
  [ArtifactRefRelation.Referenced]: 3,
  // FEA-3585: `reviewed` is a PR-only relation and never applies to a BRANCH
  // ref — listed only to keep this Record exhaustive over ArtifactRefRelation
  // (ranked lowest, alongside workspace, as read-only non-write evidence).
  [ArtifactRefRelation.Reviewed]: 4,
  [ArtifactRefRelation.Workspace]: 4,
};

/**
 * ISS-5764: rank a branch ref for the aggregate's relation/method election.
 *
 * Relation alone is not enough. `referenced` (3) deliberately outranks
 * `workspace` (4), which is right when both are COMMAND evidence — a branch the
 * session referenced is a stronger statement than one it merely started on. But
 * the desktop now also mints `referenced` branch refs from PROSE, and those are
 * the weakest evidence in the system: without this, a session that ran
 * `git checkout feat/x` AND wrote "I checked out branch feat/x" had its
 * aggregate re-labelled from `workspace`/`git_checkout` to
 * `referenced`/`branch_mention_in_prose` — a mention overwriting the record of a
 * command the session actually ran. Prose is ranked below every relation so it
 * can only ever establish an aggregate that has no other evidence at all.
 */
function branchRefEvidenceRank(ref: {
  relation: ArtifactRefRelation;
  method: string;
}): number {
  if (PROSE_MENTION_REF_METHODS.has(ref.method)) {
    return 98;
  }
  return BRANCH_RELATION_PRECEDENCE[ref.relation] ?? 99;
}

type BranchRefAggregate = {
  repositoryFullName: string;
  branchName: string;
  method: string;
  relation: ArtifactRefRelation;
  observedAt?: string;
  /**
   * Earliest observed time across this branch's PUSH-method refs (`git_push` /
   * `gh_pr_create`), if any — the C1-verified in-session push evidence that
   * stamps `firstPushedAt`/`pushSource='session'` (PRD-510 FR2, PLN-1099 Phase
   * 2). Distinct from `observedAt` (which keeps the LATEST across all methods
   * for link recency); push state is earliest-wins.
   */
  pushedAt?: string;
  branchLifecycleEvents: SyncedBranchLifecycleEvent[];
  directParticipation?: BranchParticipationKind;
  directParticipationMethod?: string;
  directParticipationObservedAt?: string;
};

/**
 * Resolve or create a BRANCH only after the server-owned repository authority
 * proves it is a non-default branch. An unavailable, mismatched, or default
 * authority is a tolerated non-materialized result, not a transaction failure.
 *
 * - Repository identity and authority come from an active organization-scoped
 *   GitHub installation row or org-scoped PublicRepository row. A
 *   desktop-provided full name is never authority.
 * - Creation is artifact-first (FR13): create the `Artifact(BRANCH)` (org from
 *   the API key, never the payload) with the `BranchDetail` nested, so the org
 *   copy matches the parent by construction. No head/base/PR is written — a
 *   desktop branch ref carries none, so a later webhook still lands cleanly
 *   through `applyHeadTransition` (FR8 head-provenance discipline).
 * - A session with no resolved project yields an UNPARENTED branch artifact
 *   (FEA-1749). Branch identity is `(organizationId, repositoryFullName,
 *   branchName)` per PRD-510 D2 — a project has never been part of it. This
 *   used to return null instead, which deferred the ref forever: the desktop
 *   lane is exactly the producer that has no project, so the branch it waited
 *   for could never arrive. That made FR8/FR12's non-App producer unreachable.
 */
export async function ensureBranchArtifactRow(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    projectId: string | null;
    repositoryAuthority: SessionBranchRepositoryAuthority | undefined;
    repositoryFullName: string;
    branchName: string;
  }
): Promise<BranchMaterializationResult> {
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
  // A concurrent producer (another request or a racing tick) can insert the
  // same D2 row between the findFirst above and this create; the unique index
  // then rejects it with P2002. We deliberately do NOT catch-and-re-read on
  // `tx` here: this create runs inside the long-lived multi-session sync
  // transaction, which Postgres marks aborted after any failed statement, so a
  // recovery query on the same `tx` would itself fail (AGENTS.md: no recovery
  // inside an aborted interactive transaction). Letting P2002 propagate rolls
  // the batch back cleanly; the desktop re-sends the full ref set on its next
  // sync, where the findFirst above resolves the winning row.
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
          repositoryId: authority.repositoryId,
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

/** Fold a branch ref into the per-artifact aggregate: strongest relation + latest observedAt win. */
function foldBranchRef(
  byArtifact: Map<string, BranchRefAggregate>,
  branchArtifactId: string,
  ref: SyncedBranchArtifactRef
): void {
  const existing = byArtifact.get(branchArtifactId);
  const directParticipationEvidence =
    directBranchParticipationEvidenceFromRef(ref);
  if (!existing) {
    byArtifact.set(
      branchArtifactId,
      branchRefAggregateFromRef(ref, directParticipationEvidence)
    );
    return;
  }
  const incomingRank = branchRefEvidenceRank(ref);
  const existingRank = branchRefEvidenceRank(existing);
  if (incomingRank < existingRank) {
    existing.relation = ref.relation;
    existing.method = ref.method;
  }
  if (
    ref.observedAt &&
    (!existing.observedAt ||
      Date.parse(ref.observedAt) > Date.parse(existing.observedAt))
  ) {
    existing.observedAt = ref.observedAt;
  }
  // Push state is earliest-wins (unlike `observedAt`'s latest-wins recency).
  if (
    ref.observedAt &&
    BRANCH_PUSH_METHODS.has(ref.method) &&
    (!existing.pushedAt ||
      Date.parse(ref.observedAt) < Date.parse(existing.pushedAt))
  ) {
    existing.pushedAt = ref.observedAt;
  }
  existing.branchLifecycleEvents = mergeBranchLifecycleEvents(
    existing.branchLifecycleEvents,
    ref.branchLifecycleEvents
  );
  mergeDirectBranchParticipationEvidence(existing, directParticipationEvidence);
}

function branchRefAggregateFromRef(
  ref: SyncedBranchArtifactRef,
  directParticipationEvidence: ReturnType<
    typeof directBranchParticipationEvidenceFromRef
  >
): BranchRefAggregate {
  const aggregate: BranchRefAggregate = {
    repositoryFullName: ref.repositoryFullName,
    branchName: ref.branchName,
    method: ref.method,
    relation: ref.relation,
    branchLifecycleEvents: ref.branchLifecycleEvents ?? [],
    ...(ref.observedAt ? { observedAt: ref.observedAt } : {}),
    ...(BRANCH_PUSH_METHODS.has(ref.method) && ref.observedAt
      ? { pushedAt: ref.observedAt }
      : {}),
  };
  mergeDirectBranchParticipationEvidence(
    aggregate,
    directParticipationEvidence
  );
  return aggregate;
}

/**
 * Merge-upsert one SESSION→BRANCH link. The row is shared with the session_pr
 * lane (same `(sourceId,targetId,linkType)` unique key), so this preserves any
 * existing metadata and overlays branch evidence — `linkKinds` accumulates
 * every kind present, and `linkKind` keeps `session_pr` precedence so that
 * lane's scalar reader/replacement keeps working (FEA-2729, decision:
 * merge-into-one-edge).
 */
async function upsertSessionBranchLink(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  sessionArtifactId: string,
  branchArtifactId: string,
  aggregate: BranchRefAggregate
): Promise<void> {
  const existing = await tx.artifactLink.findFirst({
    where: {
      organizationId,
      sourceId: sessionArtifactId,
      targetId: branchArtifactId,
      linkType: LinkType.RelatesTo,
    },
    select: {
      metadata: true,
      branchParticipation: true,
      branchParticipationMethod: true,
      branchParticipationObservedAt: true,
    },
  });
  const base = parseJsonObject(existing?.metadata) ?? {};
  const parsedBase = parseSessionPrLinkMetadata(base);
  const branchLifecycleEvents = mergeBranchLifecycleEvents(
    readBranchLifecycleEventsFromMetadata(existing?.metadata),
    aggregate.branchLifecycleEvents
  );
  const incomingBranchParticipationEvidence =
    branchParticipationEvidenceFromAggregate(aggregate);
  const incomingBranchParticipation =
    incomingBranchParticipationEvidence.branchParticipation;
  const existingBranchParticipation = normalizeBranchParticipationKind(
    existing?.branchParticipation
  );
  const metadataBranchParticipation =
    deriveBranchParticipationFromMetadata(parsedBase);
  const metadataBranchParticipationEvidence =
    branchParticipationEvidenceFromMetadata(parsedBase);
  const branchParticipation = chooseBranchParticipation(
    incomingBranchParticipation,
    existingBranchParticipation ?? metadataBranchParticipation
  );
  const kinds = collectLinkKinds(base);
  kinds.add(SessionArtifactLinkKind.SessionBranch);
  const linkKind = kinds.has(SessionArtifactLinkKind.SessionPr)
    ? SessionArtifactLinkKind.SessionPr
    : SessionArtifactLinkKind.SessionBranch;

  const metadata = {
    ...base,
    linkKind,
    linkKinds: [...kinds].sort(),
    branchLinked: true,
    method: aggregate.method,
    relation: aggregate.relation,
    ...(aggregate.observedAt ? { observedAt: aggregate.observedAt } : {}),
    branchName: aggregate.branchName,
    branchRepositoryFullName: aggregate.repositoryFullName,
    branchSource: SessionArtifactLinkMetadataSource.DesktopSync,
    branchExtractorVersion: SESSION_BRANCH_LINK_EXTRACTOR_VERSION,
    ...(branchParticipation ? { branchParticipation } : {}),
    ...(branchLifecycleEvents.length > 0 ? { branchLifecycleEvents } : {}),
  };
  const branchParticipationData = branchParticipationWriteData({
    branchParticipation,
    method: branchParticipationMethod({
      branchParticipation,
      incomingBranchParticipation,
      incomingMethod: incomingBranchParticipationEvidence.method,
      existingBranchParticipation,
      existingMethod: existing?.branchParticipationMethod ?? null,
      metadataMethodBranchParticipation:
        metadataBranchParticipationEvidence.methodBranchParticipation,
      metadataMethod: metadataBranchParticipationEvidence.method,
    }),
    observedAt: branchParticipationObservedAt({
      branchParticipation,
      incomingBranchParticipation,
      incomingObservedAt: incomingBranchParticipationEvidence.observedAt,
      existingBranchParticipation,
      existingObservedAt: existing?.branchParticipationObservedAt ?? null,
      metadataBranchParticipation,
      metadataObservedAt: metadataBranchParticipationEvidence.observedAt,
    }),
  });

  await tx.artifactLink.upsert({
    where: {
      sourceId_targetId_linkType: {
        sourceId: sessionArtifactId,
        targetId: branchArtifactId,
        linkType: LinkType.RelatesTo,
      },
    },
    create: {
      organizationId,
      sourceId: sessionArtifactId,
      targetId: branchArtifactId,
      linkType: LinkType.RelatesTo,
      metadata,
      ...branchParticipationData,
    },
    update: { metadata, ...branchParticipationData },
  });
}

function branchParticipationWriteData(input: {
  branchParticipation: BranchParticipationKind | undefined;
  method: string | null;
  observedAt: Date | null;
}) {
  return {
    branchParticipation: input.branchParticipation ?? null,
    branchParticipationMethod: input.branchParticipation ? input.method : null,
    branchParticipationObservedAt: input.observedAt,
  };
}

function collectLinkKinds(metadata: Record<string, unknown>): Set<string> {
  const kinds = new Set<string>();
  if (typeof metadata.linkKind === "string") {
    kinds.add(metadata.linkKind);
  }
  if (Array.isArray(metadata.linkKinds)) {
    for (const kind of metadata.linkKinds) {
      if (typeof kind === "string") {
        kinds.add(kind);
      }
    }
  }
  return kinds;
}

function chooseBranchParticipation(
  incoming: BranchParticipationKind | undefined,
  existing: BranchParticipationKind | undefined
): BranchParticipationKind | undefined {
  if (
    incoming === BranchParticipationKind.Wrote ||
    existing === BranchParticipationKind.Wrote
  ) {
    return BranchParticipationKind.Wrote;
  }
  if (
    incoming === BranchParticipationKind.Reviewed ||
    existing === BranchParticipationKind.Reviewed
  ) {
    return BranchParticipationKind.Reviewed;
  }
  return undefined;
}

function branchParticipationMethod(input: {
  branchParticipation: BranchParticipationKind | undefined;
  incomingBranchParticipation: BranchParticipationKind | undefined;
  incomingMethod: string | null;
  existingBranchParticipation: BranchParticipationKind | undefined;
  existingMethod: string | null;
  metadataMethodBranchParticipation: BranchParticipationKind | undefined;
  metadataMethod: string | null;
}): string | null {
  if (!input.branchParticipation) {
    return null;
  }
  if (
    input.branchParticipation === input.incomingBranchParticipation &&
    input.incomingMethod
  ) {
    return input.incomingMethod;
  }
  if (
    input.branchParticipation === input.existingBranchParticipation &&
    input.existingMethod
  ) {
    return input.existingMethod;
  }
  if (
    input.branchParticipation === input.metadataMethodBranchParticipation &&
    input.metadataMethod
  ) {
    return input.metadataMethod;
  }
  return null;
}

function branchParticipationObservedAt(input: {
  branchParticipation: BranchParticipationKind | undefined;
  incomingBranchParticipation: BranchParticipationKind | undefined;
  incomingObservedAt: Date | null;
  existingBranchParticipation: BranchParticipationKind | undefined;
  existingObservedAt: Date | null;
  metadataBranchParticipation: BranchParticipationKind | undefined;
  metadataObservedAt: string | null;
}): Date | null {
  if (!input.branchParticipation) {
    return null;
  }
  if (
    input.branchParticipation === input.incomingBranchParticipation &&
    input.incomingObservedAt
  ) {
    return input.incomingObservedAt;
  }
  if (
    input.branchParticipation === input.existingBranchParticipation &&
    input.existingObservedAt
  ) {
    return input.existingObservedAt;
  }
  if (
    input.branchParticipation === input.metadataBranchParticipation &&
    input.metadataObservedAt &&
    Number.isFinite(Date.parse(input.metadataObservedAt))
  ) {
    return new Date(input.metadataObservedAt);
  }
  return null;
}

function branchParticipationEvidenceFromAggregate(
  aggregate: BranchRefAggregate
): {
  branchParticipation: BranchParticipationKind | undefined;
  method: string | null;
  observedAt: Date | null;
} {
  if (aggregate.directParticipation) {
    return {
      branchParticipation: aggregate.directParticipation,
      method: aggregate.directParticipationMethod ?? null,
      observedAt: parseOptionalDate(aggregate.directParticipationObservedAt),
    };
  }

  const directBranchParticipation = deriveBranchParticipationFromEvidence({
    relation: aggregate.relation,
    method: aggregate.method,
    branchLifecycleEvents: [],
  });
  if (directBranchParticipation) {
    return {
      branchParticipation: directBranchParticipation,
      method: aggregate.method,
      observedAt: parseOptionalDate(aggregate.observedAt),
    };
  }

  const lifecycleBranchParticipation = deriveBranchParticipationFromEvidence({
    branchLifecycleEvents: aggregate.branchLifecycleEvents,
  });
  if (!lifecycleBranchParticipation) {
    return {
      branchParticipation: undefined,
      method: null,
      observedAt: null,
    };
  }
  return {
    branchParticipation: lifecycleBranchParticipation,
    method: null,
    observedAt:
      latestLifecycleEventObservedAt(
        aggregate.branchLifecycleEvents,
        BranchLifecycleBoundaryKind.ReviewFeedback
      ) ?? parseOptionalDate(aggregate.observedAt),
  };
}

function latestLifecycleEventObservedAt(
  events: SyncedBranchLifecycleEvent[],
  kind: BranchLifecycleBoundaryKind
): Date | null {
  let latest: Date | null = null;
  for (const event of events) {
    if (event.kind !== kind) {
      continue;
    }
    const observedAt = parseOptionalDate(event.observedAt);
    if (!observedAt) {
      continue;
    }
    if (!latest || observedAt.getTime() > latest.getTime()) {
      latest = observedAt;
    }
  }
  return latest;
}

function parseOptionalDate(value: string | undefined): Date | null {
  if (!(value && Number.isFinite(Date.parse(value)))) {
    return null;
  }
  return new Date(value);
}

function branchParticipationEvidenceFromMetadata(
  metadata: ReturnType<typeof parseSessionPrLinkMetadata>
): {
  methodBranchParticipation: BranchParticipationKind | undefined;
  method: string | null;
  observedAt: string | null;
} {
  const methodBranchParticipation = deriveBranchParticipationFromEvidence({
    relation: metadata?.relation,
    method: metadata?.method,
    branchLifecycleEvents: [],
  });
  if (methodBranchParticipation) {
    return {
      methodBranchParticipation,
      method: typeof metadata?.method === "string" ? metadata.method : null,
      observedAt:
        typeof metadata?.observedAt === "string" ? metadata.observedAt : null,
    };
  }
  const lifecycleBranchParticipation = deriveBranchParticipationFromEvidence({
    branchLifecycleEvents: metadata?.branchLifecycleEvents,
  });
  if (!lifecycleBranchParticipation) {
    return {
      methodBranchParticipation: undefined,
      method: null,
      observedAt: null,
    };
  }
  const reviewFeedbackObservedAt = latestLifecycleEventObservedAt(
    metadata?.branchLifecycleEvents ?? [],
    BranchLifecycleBoundaryKind.ReviewFeedback
  );
  return {
    methodBranchParticipation: undefined,
    method: null,
    observedAt: reviewFeedbackObservedAt?.toISOString() ?? null,
  };
}

function directBranchParticipationEvidenceFromRef(
  ref: SyncedBranchArtifactRef
): {
  branchParticipation: BranchParticipationKind;
  method: string;
  observedAt?: string;
} | null {
  const branchParticipation =
    normalizeBranchParticipationKind(ref.branchParticipation) ??
    deriveBranchParticipationFromEvidence({
      relation: ref.relation,
      method: ref.method,
      branchLifecycleEvents: [],
    });
  if (!branchParticipation) {
    return null;
  }
  return {
    branchParticipation,
    method: ref.method,
    ...(ref.observedAt ? { observedAt: ref.observedAt } : {}),
  };
}

function mergeDirectBranchParticipationEvidence(
  aggregate: BranchRefAggregate,
  incoming: ReturnType<typeof directBranchParticipationEvidenceFromRef>
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
    if (incomingPriority < currentPriority) {
      replaceDirectBranchParticipationEvidence(aggregate, incoming);
      return;
    }
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
  replaceDirectBranchParticipationEvidence(aggregate, incoming);
}

function replaceDirectBranchParticipationEvidence(
  aggregate: BranchRefAggregate,
  incoming: NonNullable<
    ReturnType<typeof directBranchParticipationEvidenceFromRef>
  >
): void {
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

function directBranchParticipationEvidencePriority(input: {
  branchParticipation: BranchParticipationKind;
  method: string;
}): number {
  if (
    input.branchParticipation === BranchParticipationKind.Reviewed &&
    input.method === ArtifactRefMethod.PrReviewFeedbackCommand
  ) {
    return 0;
  }
  return 1;
}

/**
 * Create SESSION→BRANCH `ArtifactLink`s from a session's `branch`-kind refs,
 * carrying `method`/`relation`/`observedAt` in metadata (FEA-2729). Resolves —
 * or artifact-first CREATES — the BRANCH artifact by `(organizationId,
 * repositoryFullName, branchName)` (org from the API key — PRD-510 FR11).
 *
 * FEA-1749: this lane no longer defers anything. It previously wrote refs it
 * could not place into `SessionDetail.metadata._unresolvedBranchRefs` "to be
 * retried on a later tick", but the only thing it ever waited on was a project
 * the desktop lane never has — so those refs were retried forever and the
 * branch never appeared. Branch identity (D2) has never included a project.
 *
 * Additive by design (no replacement deleteMany): a session's touched branches
 * are effectively monotonic, and skipping deletes keeps this lane from
 * clobbering the session_pr link it may share a row with. Idempotent — re-sync
 * and extractor re-derivation update metadata in place on the unique key.
 *
 * `repositoryAuthorityByFullName` is resolved and locked once for this
 * session inside its write transaction, so this lane issues no authority
 * lookup per ref while still preventing a preflight-to-write race.
 */
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

  const byArtifact = new Map<string, BranchRefAggregate>();
  const unresolved: UnresolvedBranchRef[] = [];
  for (const ref of branchRefs) {
    // Resolve or create only when the batched server authority proves this is a
    // non-default branch. Public repositories retain a null installation repo
    // id; the normalized full name remains part of the D2 identity.
    const normalizedFullName = normalizeRepoFullName(ref.repositoryFullName);
    // An unavailable/default result is intentionally skipped without aborting
    // the multi-session transaction; a later sync re-evaluates fresh authority.
    const materialization = await ensureBranchArtifactRow(tx, {
      organizationId,
      projectId,
      repositoryAuthority:
        repositoryAuthorityByFullName.get(normalizedFullName),
      repositoryFullName: normalizedFullName,
      branchName: ref.branchName,
    });
    if (
      materialization.status === BranchMaterializationStatus.NotMaterialized
    ) {
      unresolved.push({
        repositoryFullName: normalizedFullName,
        branchName: ref.branchName,
        cause: materialization.cause,
      });
      continue;
    }
    const branchArtifactId = materialization.artifactId;
    if (branchArtifactId === sessionArtifactId) {
      continue;
    }
    foldBranchRef(byArtifact, branchArtifactId, ref);
  }

  for (const [branchArtifactId, aggregate] of byArtifact) {
    // PRD-510 FR2 / PLN-1099 Phase 2b: a C1-verified in-session push (a synced
    // `git_push`/`gh_pr_create` ref — the desktop extractor already dropped
    // failed pushes) stamps `firstPushedAt`/`pushSource='session'` set-once,
    // earliest-wins. This is the non-App producer: it flips a branch to pushed
    // (and thus org-visible under FR12) with no GitHub App/webhook required.
    //
    // Stamp before the link upsert so the push evidence and link preserve their
    // existing write order. Any failed write propagates and rolls back the
    // transaction; this lane never continues on an aborted transaction.
    if (aggregate.pushedAt) {
      await stampBranchFirstPush(
        tx,
        branchArtifactId,
        new Date(aggregate.pushedAt),
        BranchPushSource.Session
      );
    }
    await upsertSessionBranchLink(
      tx,
      organizationId,
      sessionArtifactId,
      branchArtifactId,
      aggregate
    );
  }
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
