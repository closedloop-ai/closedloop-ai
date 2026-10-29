import { LinkType } from "@repo/api/src/types/artifact";
import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
  normalizeBranchParticipationKind,
} from "@repo/api/src/types/branch";
import type { JsonObject } from "@repo/api/src/types/common";
import type { SyncedBranchLifecycleEvent } from "@repo/api/src/types/session-artifact-link";
import {
  deriveBranchParticipationFromEvidence,
  deriveBranchParticipationFromMetadata,
  isProseDerivedSessionPrRef,
  parseSessionPrLinkMetadata,
  SessionArtifactLinkKind,
  SessionArtifactLinkMetadataSource,
  sessionPrRefsFromMetadata,
} from "@repo/api/src/types/session-artifact-link";
import { parseJsonObject } from "@/lib/json-schema";
import { acquireSessionArtifactLinksAdvisoryLock } from "../advisory-locks";
import type { AgentSessionUpsertTx } from "../records";
import {
  type BranchRefAggregate,
  hasPullRequestHeadPrIdentity,
  mergePersistedSessionPrRefs,
} from "./branch-ref-aggregate";
import { relationTypesFromPrRefs } from "./session-pr-link-merge";
import { SESSION_PR_LINK_SOURCE } from "./session-pr-link-source";
import {
  mergeBranchLifecycleEvents,
  readBranchLifecycleEventsFromMetadata,
} from "./shared";

const SESSION_BRANCH_LINK_EXTRACTOR_VERSION = 1;

export const SessionBranchLinkEvidenceSource = {
  IndependentBranch: "independent_branch",
  PullRequestHead: "pull_request_head",
} as const;

export type SessionBranchLinkEvidenceSource =
  (typeof SessionBranchLinkEvidenceSource)[keyof typeof SessionBranchLinkEvidenceSource];

export type ExistingSessionBranchLinkState = {
  metadata: unknown;
  branchParticipation: unknown;
  branchParticipationMethod: string | null;
  branchParticipationObservedAt: Date | null;
};

type SessionBranchLinkWriteData = {
  metadata: JsonObject;
  branchParticipation: BranchParticipationKind | null;
  branchParticipationMethod: string | null;
  branchParticipationObservedAt: Date | null;
};

/**
 * Merge-upsert one SESSION->BRANCH edge shared by direct Branch evidence and
 * PR-derived head-Branch evidence.
 */
export async function upsertSessionBranchLink(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    sessionArtifactId: string;
    branchArtifactId: string;
    aggregate: BranchRefAggregate;
    evidenceSource?: SessionBranchLinkEvidenceSource;
  }
): Promise<void> {
  await acquireSessionArtifactLinksAdvisoryLock(tx, {
    organizationId: input.organizationId,
    sessionArtifactId: input.sessionArtifactId,
  });
  const existing = await tx.artifactLink.findFirst({
    where: {
      organizationId: input.organizationId,
      sourceId: input.sessionArtifactId,
      targetId: input.branchArtifactId,
      linkType: LinkType.RelatesTo,
    },
    select: {
      metadata: true,
      branchParticipation: true,
      branchParticipationMethod: true,
      branchParticipationObservedAt: true,
    },
  });
  const writeData = buildSessionBranchLinkWriteData({
    aggregate: input.aggregate,
    evidenceSource:
      input.evidenceSource ?? SessionBranchLinkEvidenceSource.IndependentBranch,
    existing,
  });

  await tx.artifactLink.upsert({
    where: {
      sourceId_targetId_linkType: {
        sourceId: input.sessionArtifactId,
        targetId: input.branchArtifactId,
        linkType: LinkType.RelatesTo,
      },
    },
    create: {
      organizationId: input.organizationId,
      sourceId: input.sessionArtifactId,
      targetId: input.branchArtifactId,
      linkType: LinkType.RelatesTo,
      ...writeData,
    },
    update: writeData,
    select: { id: true },
  });
}

export function buildSessionBranchLinkWriteData(input: {
  aggregate: BranchRefAggregate;
  evidenceSource?: SessionBranchLinkEvidenceSource;
  existing?: ExistingSessionBranchLinkState | null;
  initialMetadata?: JsonObject;
}): SessionBranchLinkWriteData {
  const base =
    parseJsonObject(input.initialMetadata ?? input.existing?.metadata) ?? {};
  const parsedBase = parseSessionPrLinkMetadata(base);
  const writesIndependentBranchEvidence =
    input.evidenceSource !== SessionBranchLinkEvidenceSource.PullRequestHead;
  const preservesIndependentBranchEvidence = base.branchLinked === true;
  const projectIncomingBranchEvidence = projectsIncomingBranchEvidence(
    input,
    preservesIndependentBranchEvidence
  );
  const branchLifecycleEvents = mergeBranchLifecycleEvents(
    readBranchLifecycleEventsFromMetadata(base),
    projectIncomingBranchEvidence ? input.aggregate.branchLifecycleEvents : []
  );
  const incomingBranchParticipationEvidence = projectIncomingBranchEvidence
    ? branchParticipationEvidenceFromAggregate(input.aggregate)
    : emptyAggregateBranchParticipationEvidence();
  const incomingBranchParticipation =
    incomingBranchParticipationEvidence.branchParticipation;
  const preservesPriorBranchProjection =
    writesIndependentBranchEvidence || preservesIndependentBranchEvidence;
  const existingBranchParticipation = preservesPriorBranchProjection
    ? normalizeBranchParticipationKind(input.existing?.branchParticipation)
    : undefined;
  const metadataBranchParticipation = preservesPriorBranchProjection
    ? deriveBranchParticipationFromMetadata(parsedBase)
    : undefined;
  const metadataBranchParticipationEvidence = preservesPriorBranchProjection
    ? branchParticipationEvidenceFromMetadata(parsedBase)
    : emptyBranchParticipationEvidence();
  const branchParticipation = chooseBranchParticipation(
    incomingBranchParticipation,
    existingBranchParticipation ?? metadataBranchParticipation
  );
  const shouldDeclareBranch =
    writesIndependentBranchEvidence ||
    preservesIndependentBranchEvidence ||
    (projectIncomingBranchEvidence && branchParticipation !== undefined);
  const linkKinds = collectSessionArtifactLinkKinds(base);
  if (shouldDeclareBranch) {
    linkKinds.add(SessionArtifactLinkKind.SessionBranch);
  } else {
    linkKinds.delete(SessionArtifactLinkKind.SessionBranch);
  }
  const metadataBase = shouldDeclareBranch
    ? base
    : withoutSessionBranchProjectionFields(base);

  const metadata = mergePrIdentityMetadata(
    {
      ...metadataBase,
      linkKind: sessionBranchTopLevelLinkKind(linkKinds, base.linkKind),
      linkKinds: [...linkKinds].sort(),
      ...branchLinkedMetadata(
        preservesIndependentBranchEvidence || writesIndependentBranchEvidence
      ),
      ...sessionBranchProjectionMetadata({
        aggregate: input.aggregate,
        branchLifecycleEvents,
        branchParticipation,
        shouldDeclareBranch:
          shouldDeclareBranch && projectIncomingBranchEvidence,
      }),
    },
    acceptsPullRequestHeadEvidence(input) ? input.aggregate.prRefs : undefined
  );
  const branchParticipationData = branchParticipationWriteData({
    branchParticipation,
    method: branchParticipationMethod({
      branchParticipation,
      incomingBranchParticipation,
      incomingMethod: incomingBranchParticipationEvidence.method,
      existingBranchParticipation,
      existingMethod: input.existing?.branchParticipationMethod ?? null,
      metadataMethodBranchParticipation:
        metadataBranchParticipationEvidence.methodBranchParticipation,
      metadataMethod: metadataBranchParticipationEvidence.method,
    }),
    observedAt: branchParticipationObservedAt({
      branchParticipation,
      incomingBranchParticipation,
      incomingObservedAt: incomingBranchParticipationEvidence.observedAt,
      existingBranchParticipation,
      existingObservedAt: input.existing?.branchParticipationObservedAt ?? null,
      metadataBranchParticipation,
      metadataObservedAt: metadataBranchParticipationEvidence.observedAt,
    }),
  });

  return { metadata, ...branchParticipationData };
}

function acceptsPullRequestHeadEvidence(input: {
  aggregate: BranchRefAggregate;
  evidenceSource?: SessionBranchLinkEvidenceSource;
}): boolean {
  return (
    input.evidenceSource !== SessionBranchLinkEvidenceSource.PullRequestHead ||
    hasPullRequestHeadPrIdentity(input.aggregate)
  );
}

function projectsIncomingBranchEvidence(
  input: {
    aggregate: BranchRefAggregate;
    evidenceSource?: SessionBranchLinkEvidenceSource;
  },
  preservesIndependentBranchEvidence: boolean
): boolean {
  return (
    input.evidenceSource !== SessionBranchLinkEvidenceSource.PullRequestHead ||
    (hasPullRequestHeadPrIdentity(input.aggregate) &&
      !preservesIndependentBranchEvidence)
  );
}

function branchLinkedMetadata(shouldPersistBranchLinked: boolean): JsonObject {
  return shouldPersistBranchLinked ? { branchLinked: true } : {};
}

function sessionBranchProjectionMetadata(input: {
  aggregate: BranchRefAggregate;
  branchLifecycleEvents: SyncedBranchLifecycleEvent[];
  branchParticipation: BranchParticipationKind | undefined;
  shouldDeclareBranch: boolean;
}): JsonObject {
  if (!input.shouldDeclareBranch) {
    return {};
  }
  return {
    method: input.aggregate.method,
    relation: input.aggregate.relation,
    ...(input.aggregate.observedAt
      ? { observedAt: input.aggregate.observedAt }
      : {}),
    branchName: input.aggregate.branchName,
    branchRepositoryFullName: input.aggregate.repositoryFullName,
    branchSource: SessionArtifactLinkMetadataSource.DesktopSync,
    branchExtractorVersion: SESSION_BRANCH_LINK_EXTRACTOR_VERSION,
    ...(input.branchParticipation
      ? { branchParticipation: input.branchParticipation }
      : {}),
    ...(input.branchLifecycleEvents.length > 0
      ? { branchLifecycleEvents: input.branchLifecycleEvents }
      : {}),
  };
}

function mergePrIdentityMetadata(
  metadata: JsonObject,
  incomingRefs: BranchRefAggregate["prRefs"]
): JsonObject {
  if (!(incomingRefs && incomingRefs.length > 0)) {
    return metadata;
  }
  const prRefs = mergePersistedSessionPrRefs(
    sessionPrRefsFromMetadata(metadata),
    incomingRefs
  );
  if (prRefs.length === 0) {
    return metadata;
  }
  const relationTypes = relationTypesFromPrRefs(prRefs);
  const next = withoutSessionPrIdentityFields(metadata);
  const isMultiPr = prRefs.length > 1;
  const isProseOnly = prRefs.every(isProseDerivedSessionPrRef);
  const linkKinds = collectSessionArtifactLinkKinds(next);
  linkKinds.delete(SessionArtifactLinkKind.SessionPr);
  linkKinds.delete(SessionArtifactLinkKind.SessionPrSet);
  linkKinds.delete(SessionArtifactLinkKind.SessionPrProse);
  linkKinds.add(prLinkKind(isProseOnly, isMultiPr));
  return {
    ...next,
    linkKind: topLevelLinkKind(isProseOnly, isMultiPr, linkKinds),
    linkKinds: [...linkKinds].sort(),
    relationTypes,
    prRefs,
    source:
      typeof next.source === "string" ? next.source : SESSION_PR_LINK_SOURCE,
    confidence: typeof next.confidence === "number" ? next.confidence : 1.0,
    extractorVersion:
      typeof next.extractorVersion === "number" ? next.extractorVersion : 1,
    ...(prRefs.length === 1
      ? {
          repositoryFullName: prRefs[0]?.repositoryFullName,
          prNumber: prRefs[0]?.prNumber,
        }
      : {}),
  };
}

function sessionBranchTopLevelLinkKind(
  linkKinds: ReadonlySet<string>,
  current: unknown
): string {
  if (linkKinds.has(SessionArtifactLinkKind.SessionPr)) {
    return SessionArtifactLinkKind.SessionPr;
  }
  if (linkKinds.has(SessionArtifactLinkKind.SessionBranch)) {
    return SessionArtifactLinkKind.SessionBranch;
  }
  if (linkKinds.has(SessionArtifactLinkKind.SessionPrSet)) {
    return SessionArtifactLinkKind.SessionBranch;
  }
  if (linkKinds.has(SessionArtifactLinkKind.SessionPrProse)) {
    return SessionArtifactLinkKind.SessionPrProse;
  }
  return typeof current === "string"
    ? current
    : SessionArtifactLinkKind.SessionBranch;
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

export function collectSessionArtifactLinkKinds(
  metadata: Record<string, unknown>
): Set<string> {
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

function emptyAggregateBranchParticipationEvidence(): {
  branchParticipation: BranchParticipationKind | undefined;
  method: string | null;
  observedAt: Date | null;
} {
  return {
    branchParticipation: undefined,
    method: null,
    observedAt: null,
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

function emptyBranchParticipationEvidence(): {
  methodBranchParticipation: BranchParticipationKind | undefined;
  method: string | null;
  observedAt: string | null;
} {
  return {
    methodBranchParticipation: undefined,
    method: null,
    observedAt: null,
  };
}

export function withoutSessionPrIdentityFields(
  metadata: JsonObject
): JsonObject {
  const preserved = { ...metadata };
  Reflect.deleteProperty(preserved, "repositoryFullName");
  Reflect.deleteProperty(preserved, "prNumber");
  Reflect.deleteProperty(preserved, "prRefs");
  return preserved;
}

export function withoutSessionBranchProjectionFields(
  metadata: JsonObject
): JsonObject {
  const preserved = { ...metadata };
  const stripsSharedEvidenceFields = hasSessionBranchProjectionFields(metadata);
  Reflect.deleteProperty(preserved, "branchLinked");
  Reflect.deleteProperty(preserved, "branchParticipation");
  Reflect.deleteProperty(preserved, "branchName");
  Reflect.deleteProperty(preserved, "branchRepositoryFullName");
  Reflect.deleteProperty(preserved, "branchSource");
  Reflect.deleteProperty(preserved, "branchExtractorVersion");
  Reflect.deleteProperty(preserved, "branchLifecycleEvents");
  if (stripsSharedEvidenceFields) {
    Reflect.deleteProperty(preserved, "method");
    Reflect.deleteProperty(preserved, "relation");
    Reflect.deleteProperty(preserved, "observedAt");
  }
  return preserved;
}

function hasSessionBranchProjectionFields(metadata: JsonObject): boolean {
  return (
    metadata.branchLinked === true ||
    metadata.branchParticipation !== undefined ||
    metadata.branchName !== undefined ||
    metadata.branchRepositoryFullName !== undefined ||
    metadata.branchSource !== undefined ||
    metadata.branchExtractorVersion !== undefined ||
    metadata.branchLifecycleEvents !== undefined
  );
}

/** The PR-lane kind this link's `linkKinds` set should carry. */
export function prLinkKind(isProseOnly: boolean, isMultiPr: boolean): string {
  if (isProseOnly) {
    return SessionArtifactLinkKind.SessionPrProse;
  }
  return isMultiPr
    ? SessionArtifactLinkKind.SessionPrSet
    : SessionArtifactLinkKind.SessionPr;
}

/**
 * The scalar `linkKind`. Branch evidence keeps precedence over the PR tier.
 */
export function topLevelLinkKind(
  isProseOnly: boolean,
  isMultiPr: boolean,
  linkKinds: ReadonlySet<string>
): string {
  if (isProseOnly) {
    return linkKinds.has(SessionArtifactLinkKind.SessionBranch)
      ? SessionArtifactLinkKind.SessionBranch
      : SessionArtifactLinkKind.SessionPrProse;
  }
  return isMultiPr
    ? SessionArtifactLinkKind.SessionBranch
    : SessionArtifactLinkKind.SessionPr;
}
