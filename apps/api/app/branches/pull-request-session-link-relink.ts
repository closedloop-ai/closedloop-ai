import { LinkType } from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import {
  isProseDerivedSessionPrRef,
  SessionArtifactLinkKind,
} from "@repo/api/src/types/session-artifact-link";
import {
  classifySessionPrMetadata,
  type PersistedSessionPrRef,
  SessionPrMetadataClassificationKind,
  sessionPrIdentityKey,
  sessionPrRefsFromMetadata,
} from "@repo/api/src/types/session-pr-link-metadata";
import type { Prisma, TransactionClient } from "@repo/database";
import { acquireSessionArtifactLinksAdvisoryLock } from "@/app/agent-sessions/service/advisory-locks";
import {
  prLinkKind,
  topLevelLinkKind,
} from "@/app/agent-sessions/service/artifact-links/session-branch-link-writer";
import {
  mergeBranchLifecycleEvents,
  readBranchLifecycleEventsFromMetadata,
} from "@/app/agent-sessions/service/artifact-links/shared";
import { parseJsonObject } from "@/lib/json-schema";
import { acquirePullRequestProviderIdentityLockInTransaction } from "./pull-request-provider-lock";

type SessionLinkRelinkClient = Pick<
  TransactionClient,
  "$executeRaw" | "artifactLink"
>;

type RelinkableArtifactLink = {
  id: string;
  sourceId: string;
  targetId: string;
  metadata: unknown;
};

/** Move only one PR's contribution between shared Session-to-Branch edges. */
export async function relinkPullRequestSessionLinksInTransaction(
  tx: SessionLinkRelinkClient,
  input: {
    organizationId: string;
    pullRequestNumber: number;
    repositoryFullName: string | null;
    sourceBranchArtifactIds: readonly string[];
    targetBranchArtifactId: string;
  }
): Promise<boolean> {
  if (!input.repositoryFullName) {
    return false;
  }
  const repositoryFullName = input.repositoryFullName;
  await acquirePullRequestProviderIdentityLockInTransaction(tx, {
    organizationId: input.organizationId,
    repositoryFullName,
    number: input.pullRequestNumber,
  });
  const branchArtifactIds = [
    ...new Set([
      ...input.sourceBranchArtifactIds,
      input.targetBranchArtifactId,
    ]),
  ];
  const discoveredLinks = await tx.artifactLink.findMany({
    where: {
      organizationId: input.organizationId,
      linkType: LinkType.RelatesTo,
      targetId: { in: branchArtifactIds },
    },
    select: {
      id: true,
      sourceId: true,
      targetId: true,
      metadata: true,
    },
  });
  const discoveredSourceLinks = discoveredLinks.filter(
    (link) =>
      link.targetId !== input.targetBranchArtifactId &&
      isMatchingSessionPrMetadata(
        link.metadata,
        repositoryFullName,
        input.pullRequestNumber
      )
  );
  if (discoveredSourceLinks.length === 0) {
    return false;
  }
  const sessionArtifactIds = [
    ...new Set(discoveredSourceLinks.map((link) => link.sourceId)),
  ].sort();
  for (const sessionArtifactId of sessionArtifactIds) {
    await acquireSessionArtifactLinksAdvisoryLock(tx, {
      organizationId: input.organizationId,
      sessionArtifactId,
    });
  }
  const links = await tx.artifactLink.findMany({
    where: {
      organizationId: input.organizationId,
      linkType: LinkType.RelatesTo,
      targetId: { in: branchArtifactIds },
      sourceId: { in: sessionArtifactIds },
    },
    select: {
      id: true,
      sourceId: true,
      targetId: true,
      metadata: true,
    },
  });
  const sourceLinks = links.filter(
    (link) =>
      link.targetId !== input.targetBranchArtifactId &&
      isMatchingSessionPrMetadata(
        link.metadata,
        repositoryFullName,
        input.pullRequestNumber
      )
  );
  if (sourceLinks.length === 0) {
    return false;
  }
  const targetBySessionId = new Map(
    links
      .filter((link) => link.targetId === input.targetBranchArtifactId)
      .map((link) => [link.sourceId, link])
  );
  const sourcesBySessionId = new Map<string, RelinkableArtifactLink[]>();
  for (const link of sourceLinks) {
    const sessionLinks = sourcesBySessionId.get(link.sourceId) ?? [];
    sessionLinks.push(link);
    sourcesBySessionId.set(link.sourceId, sessionLinks);
  }
  for (const [sessionArtifactId, sessionSourceLinks] of sourcesBySessionId) {
    const targetLink = targetBySessionId.get(sessionArtifactId);
    const targetMetadata = parseJsonObject(targetLink?.metadata) ?? {};
    assertValidPrContributionMetadata(targetMetadata);
    const mergedMetadata = mergePrContribution(
      targetMetadata,
      sessionSourceLinks.map((link) => link.metadata),
      repositoryFullName,
      input.pullRequestNumber
    );
    await tx.artifactLink.upsert({
      where: {
        sourceId_targetId_linkType: {
          sourceId: sessionArtifactId,
          targetId: input.targetBranchArtifactId,
          linkType: LinkType.RelatesTo,
        },
      },
      create: {
        organizationId: input.organizationId,
        sourceId: sessionArtifactId,
        targetId: input.targetBranchArtifactId,
        linkType: LinkType.RelatesTo,
        metadata: mergedMetadata as Prisma.InputJsonValue,
      },
      update: { metadata: mergedMetadata as Prisma.InputJsonValue },
      select: { id: true },
    });
    for (const sourceLink of sessionSourceLinks) {
      await removePrContribution(
        tx,
        sourceLink,
        repositoryFullName,
        input.pullRequestNumber
      );
    }
  }
  return true;
}

async function removePrContribution(
  tx: SessionLinkRelinkClient,
  link: RelinkableArtifactLink,
  repositoryFullName: string,
  pullRequestNumber: number
): Promise<void> {
  const metadata = parseJsonObject(link.metadata) ?? {};
  const remainingRefs = sessionPrRefsFromMetadata(metadata).filter(
    (ref) => !matchesPullRequest(ref, repositoryFullName, pullRequestNumber)
  );
  if (remainingRefs.length > 0) {
    await tx.artifactLink.update({
      where: { id: link.id },
      data: {
        metadata: buildSessionPrMetadata(
          metadata,
          remainingRefs
        ) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return;
  }
  const kinds = collectLinkKinds(metadata);
  kinds.delete(SessionArtifactLinkKind.SessionPr);
  kinds.delete(SessionArtifactLinkKind.SessionPrSet);
  if (metadata.branchLinked === true) {
    kinds.add(SessionArtifactLinkKind.SessionBranch);
  }
  if (kinds.size === 0) {
    await tx.artifactLink.delete({ where: { id: link.id } });
    return;
  }
  const nextMetadata = { ...metadata };
  Reflect.deleteProperty(nextMetadata, "relationTypes");
  Reflect.deleteProperty(nextMetadata, "source");
  Reflect.deleteProperty(nextMetadata, "confidence");
  Reflect.deleteProperty(nextMetadata, "extractorVersion");
  Reflect.deleteProperty(nextMetadata, "repositoryFullName");
  Reflect.deleteProperty(nextMetadata, "prNumber");
  Reflect.deleteProperty(nextMetadata, "prRefs");
  nextMetadata.linkKinds = [...kinds].sort();
  nextMetadata.linkKind = kinds.has(SessionArtifactLinkKind.SessionBranch)
    ? SessionArtifactLinkKind.SessionBranch
    : [...kinds].sort()[0];
  await tx.artifactLink.update({
    where: { id: link.id },
    data: { metadata: nextMetadata as Prisma.InputJsonValue },
    select: { id: true },
  });
}

function mergePrContribution(
  targetMetadata: Record<string, unknown>,
  sourceMetadataValues: readonly unknown[],
  repositoryFullName: string,
  pullRequestNumber: number
): Record<string, unknown> {
  const sourceMetadata = sourceMetadataValues.map(
    (value) => parseJsonObject(value) ?? {}
  );
  const refsByIdentity = new Map(
    sessionPrRefsFromMetadata(targetMetadata).map((ref) => [
      sessionPrIdentityKey(ref.repositoryFullName, ref.prNumber),
      normalizePrRef(ref),
    ])
  );
  const matchingSourceRefs = sourceMetadata.flatMap((metadata) =>
    sessionPrRefsFromMetadata(metadata).filter((ref) =>
      matchesPullRequest(ref, repositoryFullName, pullRequestNumber)
    )
  );
  if (matchingSourceRefs.length === 0) {
    throw new Error("pull request branch relink source metadata changed");
  }
  const identity = sessionPrIdentityKey(repositoryFullName, pullRequestNumber);
  const relationTypes = new Set(
    refsByIdentity.get(identity)?.relationTypes ?? []
  );
  for (const ref of matchingSourceRefs) {
    for (const relationType of ref.relationTypes) {
      relationTypes.add(relationType);
    }
  }
  // ISS-5823 (review cid 3839477585 / codex P1): the merged identity carries a
  // `method` too, and it is the STRONGEST of the refs that fed it. Rebuilding it
  // without one made every relink look pre-ISS-5823 — i.e. command-derived — so
  // a prose-only mention was promoted the moment provider reconciliation moved
  // its PR. Strongest-wins rather than "keep the target's": if any contributing
  // ref really was command-derived, a command genuinely did reference this PR,
  // and demoting that to prose would suppress evidence just as wrongly as
  // promoting prose invents it. Only when EVERY contributor is prose does the
  // merged ref stay prose.
  const contributingRefs = [
    ...(refsByIdentity.has(identity) ? [refsByIdentity.get(identity)] : []),
    ...matchingSourceRefs,
  ].filter((ref) => ref !== undefined);
  const mergedMethod = contributingRefs.every(isProseDerivedSessionPrRef)
    ? contributingRefs.find(isProseDerivedSessionPrRef)?.method
    : undefined;
  refsByIdentity.set(identity, {
    repositoryFullName: normalizeRepoFullName(repositoryFullName),
    prNumber: pullRequestNumber,
    relationTypes: [...relationTypes].sort(),
    ...(mergedMethod === undefined ? {} : { method: mergedMethod }),
  });
  const branchLifecycleEvents = mergeBranchLifecycleEvents(
    readBranchLifecycleEventsFromMetadata(targetMetadata),
    ...sourceMetadata.map(readBranchLifecycleEventsFromMetadata)
  );
  const source = sourceMetadata[0] ?? {};
  return buildSessionPrMetadata(
    {
      ...targetMetadata,
      ...(source.source === undefined ? {} : { source: source.source }),
      ...(source.confidence === undefined
        ? {}
        : { confidence: source.confidence }),
      ...(source.extractorVersion === undefined
        ? {}
        : { extractorVersion: source.extractorVersion }),
      ...(branchLifecycleEvents.length > 0 ? { branchLifecycleEvents } : {}),
    },
    [...refsByIdentity.values()]
  );
}

function assertValidPrContributionMetadata(
  metadata: Record<string, unknown>
): void {
  const kinds = collectLinkKinds(metadata);
  const classification = classifySessionPrMetadata(metadata);
  if (
    (kinds.has(SessionArtifactLinkKind.SessionPr) ||
      kinds.has(SessionArtifactLinkKind.SessionPrSet)) &&
    classification.kind === SessionPrMetadataClassificationKind.Invalid
  ) {
    throw new Error("pull request branch relink Session link conflict");
  }
}

function isMatchingSessionPrMetadata(
  value: unknown,
  repositoryFullName: string,
  pullRequestNumber: number
): boolean {
  const metadata = parseJsonObject(value);
  if (!metadata) {
    return false;
  }
  return sessionPrRefsFromMetadata(metadata).some((ref) =>
    matchesPullRequest(ref, repositoryFullName, pullRequestNumber)
  );
}

function buildSessionPrMetadata(
  metadata: Record<string, unknown>,
  refs: readonly PersistedSessionPrRef[]
): Record<string, unknown> {
  const normalizedRefs = [...refs]
    .map(normalizePrRef)
    .sort((left, right) =>
      sessionPrIdentityKey(
        left.repositoryFullName,
        left.prNumber
      ).localeCompare(
        sessionPrIdentityKey(right.repositoryFullName, right.prNumber)
      )
    );
  // ISS-5823 (review cid 3839477585 / codex P1): the tier is DERIVED from the
  // refs, through the same two helpers the ingest writer uses
  // (`artifact-links/pr-links.ts`), rather than re-spelled here. This block
  // previously stamped `SessionPr`/`SessionPrSet` unconditionally, so a
  // prose-only link was promoted to metric-bearing by a duplicate collapse or a
  // branch relink — defeating the gate this ticket exists to install. Importing
  // the derivation rather than copying it is the point: two copies of a tier
  // rule drift, and the drift is invisible until a prose mention shows up in a
  // cost number.
  const isProseOnly =
    normalizedRefs.length > 0 &&
    normalizedRefs.every(isProseDerivedSessionPrRef);
  const isMultiPr = normalizedRefs.length > 1;
  const linkKinds = collectLinkKinds(metadata);
  linkKinds.delete(SessionArtifactLinkKind.SessionPr);
  linkKinds.delete(SessionArtifactLinkKind.SessionPrSet);
  linkKinds.delete(SessionArtifactLinkKind.SessionPrProse);
  linkKinds.delete(SessionArtifactLinkKind.SessionBranch);
  // Branch evidence is kept only when the link independently carries it
  // (`branchLinked`), or when a genuine multi-PR set earns it. A prose-only set
  // earns neither, so it can no longer re-enter the Branches corpus through a
  // `SessionBranch` kind it never established.
  if (metadata.branchLinked === true || (isMultiPr && !isProseOnly)) {
    linkKinds.add(SessionArtifactLinkKind.SessionBranch);
  }
  linkKinds.add(prLinkKind(isProseOnly, isMultiPr));
  const relationTypes = [
    ...new Set(normalizedRefs.flatMap((ref) => ref.relationTypes)),
  ].sort();
  const nextMetadata = { ...metadata };
  Reflect.deleteProperty(nextMetadata, "repositoryFullName");
  Reflect.deleteProperty(nextMetadata, "prNumber");
  return {
    ...nextMetadata,
    linkKind: topLevelLinkKind(isProseOnly, isMultiPr, linkKinds),
    linkKinds: [...linkKinds].sort(),
    relationTypes,
    prRefs: normalizedRefs,
    ...(normalizedRefs.length === 1
      ? {
          repositoryFullName: normalizedRefs[0]?.repositoryFullName,
          prNumber: normalizedRefs[0]?.prNumber,
        }
      : {}),
  };
}

/**
 * ISS-5823 (review cid 3839477585 / codex P1): `method` is PROVENANCE and must
 * survive a relink. Dropping it here silently promoted a prose-only mention to
 * command-derived evidence every time provider reconciliation moved a PR between
 * branch artifacts — the ref came back method-less, which the discriminators
 * read as "pre-ISS-5823 row, therefore command-derived", and the mention bought
 * its way into the metric readers and the GitHub-write authorization probe. A
 * relink moves a link between branches; it is not new evidence about how the
 * reference was found.
 *
 * Spread conditionally so a genuinely method-less legacy ref stays method-less
 * rather than gaining an explicit `undefined` key on the persisted JSON.
 */
function normalizePrRef(ref: PersistedSessionPrRef): PersistedSessionPrRef {
  return {
    repositoryFullName: normalizeRepoFullName(ref.repositoryFullName),
    prNumber: ref.prNumber,
    relationTypes: [...new Set(ref.relationTypes)].sort(),
    ...(ref.method === undefined ? {} : { method: ref.method }),
  };
}

function matchesPullRequest(
  ref: PersistedSessionPrRef,
  repositoryFullName: string,
  pullRequestNumber: number
): boolean {
  return (
    sessionPrIdentityKey(ref.repositoryFullName, ref.prNumber) ===
    sessionPrIdentityKey(repositoryFullName, pullRequestNumber)
  );
}

function collectLinkKinds(metadata: Record<string, unknown>): Set<string> {
  const kinds = new Set<string>();
  if (typeof metadata.linkKind === "string") {
    kinds.add(metadata.linkKind);
  }
  for (const kind of stringArray(metadata.linkKinds)) {
    kinds.add(kind);
  }
  return kinds;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
