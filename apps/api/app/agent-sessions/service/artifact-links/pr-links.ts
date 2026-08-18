import { LinkType } from "@repo/api/src/types/artifact";
import type {
  SyncedBranchLifecycleEvent,
  SyncedSessionPrRef,
} from "@repo/api/src/types/session-artifact-link";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { parseJsonObject } from "@/lib/json-schema";
import type { AgentSessionUpsertTx } from "../records";
import {
  mergeBranchLifecycleEvents,
  readBranchLifecycleEventsFromMetadata,
  resolveRepoIdsByFullName,
  storeUnresolvedRefs,
} from "./shared";

const SESSION_PR_LINK_SOURCE = "DETERMINISTIC";

type PrResolution = { branchArtifactId: string };

async function resolvePrDetailsByRepoAndNumber(
  tx: AgentSessionUpsertTx,
  repoIdByFullName: Map<string, string>,
  prRefs: SyncedSessionPrRef[]
): Promise<Map<string, PrResolution>> {
  const resolved = new Map<string, PrResolution>();
  const resolvedPairs = prRefs
    .map((ref) => {
      const repositoryId = repoIdByFullName.get(ref.repositoryFullName);
      return repositoryId === undefined
        ? null
        : { repositoryId, number: ref.prNumber };
    })
    .filter((pair): pair is { repositoryId: string; number: number } =>
      Boolean(pair)
    );
  if (resolvedPairs.length === 0) {
    return resolved;
  }
  const prDetails = await tx.pullRequestDetail.findMany({
    where: {
      isCurrent: true,
      lastVerifiedAt: { not: null },
      OR: resolvedPairs.map((pair) => ({
        repositoryId: pair.repositoryId,
        number: pair.number,
      })),
    },
    select: { repositoryId: true, number: true, branchArtifactId: true },
  });
  for (const prDetail of prDetails) {
    resolved.set(`${prDetail.repositoryId}:${prDetail.number}`, {
      branchArtifactId: prDetail.branchArtifactId,
    });
  }
  return resolved;
}

type PrRefByBranch = {
  relationTypes: Set<string>;
  repositoryFullName: string;
  prNumber: number;
  branchLifecycleEvents: SyncedBranchLifecycleEvent[];
};

export type UnresolvedPrRef = {
  repositoryFullName: string;
  prNumber: number;
  cause?: string;
};

function aggregatePrRefsByBranch(
  prRefs: SyncedSessionPrRef[],
  repoIdByFullName: Map<string, string>,
  prDetailsByRepoAndNumber: Map<string, PrResolution>
): { byBranch: Map<string, PrRefByBranch>; unresolved: UnresolvedPrRef[] } {
  const byBranch = new Map<string, PrRefByBranch>();
  const unresolved: UnresolvedPrRef[] = [];

  for (const prRef of prRefs) {
    const repositoryId = repoIdByFullName.get(prRef.repositoryFullName);
    const resolution =
      repositoryId === undefined
        ? undefined
        : prDetailsByRepoAndNumber.get(`${repositoryId}:${prRef.prNumber}`);

    if (!resolution) {
      unresolved.push({
        repositoryFullName: prRef.repositoryFullName,
        prNumber: prRef.prNumber,
      });
      continue;
    }

    const existing = byBranch.get(resolution.branchArtifactId);
    if (existing) {
      existing.relationTypes.add(prRef.relationType);
      existing.branchLifecycleEvents = mergeBranchLifecycleEvents(
        existing.branchLifecycleEvents,
        prRef.branchLifecycleEvents
      );
    } else {
      byBranch.set(resolution.branchArtifactId, {
        relationTypes: new Set([prRef.relationType]),
        repositoryFullName: prRef.repositoryFullName,
        prNumber: prRef.prNumber,
        branchLifecycleEvents: prRef.branchLifecycleEvents ?? [],
      });
    }
  }

  return { byBranch, unresolved };
}

function storeUnresolvedPrRefs(
  tx: AgentSessionUpsertTx,
  sessionArtifactId: string,
  unresolvedPrRefs: UnresolvedPrRef[]
): Promise<void> {
  return storeUnresolvedRefs<UnresolvedPrRef>(
    tx,
    sessionArtifactId,
    "_unresolvedPrRefs",
    (value): value is UnresolvedPrRef =>
      value != null &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>).repositoryFullName ===
        "string" &&
      typeof (value as Record<string, unknown>).prNumber === "number" &&
      ((value as Record<string, unknown>).cause === undefined ||
        typeof (value as Record<string, unknown>).cause === "string"),
    (ref) => `${ref.repositoryFullName}#${ref.prNumber}`,
    unresolvedPrRefs
  );
}

async function resolvePreserveTargetIds(
  tx: AgentSessionUpsertTx,
  sessionArtifactId: string,
  byBranch: Map<string, PrRefByBranch>,
  unresolved: UnresolvedPrRef[]
): Promise<Set<string>> {
  const ids = new Set(byBranch.keys());
  if (unresolved.length === 0) {
    return ids;
  }
  const existingPrLinks = await tx.artifactLink.findMany({
    where: {
      sourceId: sessionArtifactId,
      linkType: LinkType.RelatesTo,
      metadata: {
        path: ["linkKind"],
        equals: SessionArtifactLinkKind.SessionPr,
      },
    },
    select: { targetId: true, metadata: true },
  });
  for (const link of existingPrLinks) {
    const meta = link.metadata as Record<string, unknown> | null;
    if (!meta) {
      continue;
    }
    const matchesUnresolved = unresolved.some(
      (u) =>
        meta.repositoryFullName === u.repositoryFullName &&
        meta.prNumber === u.prNumber
    );
    if (matchesUnresolved) {
      ids.add(link.targetId);
    }
  }
  return ids;
}

export async function persistSessionPrArtifactLinks(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  sessionArtifactId: string,
  prRefs: SyncedSessionPrRef[] | undefined
): Promise<void> {
  if (prRefs === undefined) {
    return;
  }

  const repoIdByFullName = await resolveRepoIdsByFullName(
    tx,
    organizationId,
    prRefs
  );
  const prDetailsByRepoAndNumber = await resolvePrDetailsByRepoAndNumber(
    tx,
    repoIdByFullName,
    prRefs
  );

  const { byBranch, unresolved } = aggregatePrRefsByBranch(
    prRefs,
    repoIdByFullName,
    prDetailsByRepoAndNumber
  );

  const preserveTargetIds = await resolvePreserveTargetIds(
    tx,
    sessionArtifactId,
    byBranch,
    unresolved
  );

  await tx.artifactLink.deleteMany({
    where: {
      organizationId,
      sourceId: sessionArtifactId,
      linkType: LinkType.RelatesTo,
      metadata: {
        path: ["linkKind"],
        equals: SessionArtifactLinkKind.SessionPr,
      },
      // FEA-2729: never delete a row that also carries session_branch evidence
      // (a merged edge keeps linkKind=session_pr for precedence). The branch
      // lane owns those rows; dropping a PR ref must not take branch data with
      // it.
      NOT: {
        metadata: {
          path: ["branchLinked"],
          equals: true,
        },
      },
      ...(preserveTargetIds.size > 0
        ? { targetId: { notIn: [...preserveTargetIds] } }
        : {}),
    },
  });

  // ISS-4445 (wongk): batch the pre-upsert reads. Previously this loop issued one
  // serial `findFirst` per branch (then one upsert), so a large session doubled
  // the statement count inside the batch-wide 30s transaction and risked a
  // timeout that rolls back the whole sync batch. Fetch every existing link's
  // merge base in ONE `findMany` keyed by targetId, then the loop only upserts.
  const existingMetadataByTargetId = await loadExistingLinkMetadataByTargetId(
    tx,
    organizationId,
    sessionArtifactId,
    [...byBranch.keys()].filter((id) => id !== sessionArtifactId)
  );

  for (const [branchArtifactId, ref] of byBranch) {
    if (branchArtifactId === sessionArtifactId) {
      continue;
    }

    const existingMetadata = existingMetadataByTargetId.get(branchArtifactId);
    const base = parseJsonObject(existingMetadata) ?? {};
    const linkKinds = collectLinkKinds(base);
    linkKinds.add(SessionArtifactLinkKind.SessionPr);
    const branchLifecycleEvents = mergeBranchLifecycleEvents(
      readBranchLifecycleEventsFromMetadata(existingMetadata),
      ref.branchLifecycleEvents
    );
    const metadata = {
      ...base,
      linkKind: SessionArtifactLinkKind.SessionPr,
      linkKinds: [...linkKinds].sort(),
      relationTypes: [...ref.relationTypes].sort(),
      source: SESSION_PR_LINK_SOURCE,
      confidence: 1.0,
      extractorVersion: 1,
      repositoryFullName: ref.repositoryFullName,
      prNumber: ref.prNumber,
      ...(branchLifecycleEvents.length > 0 ? { branchLifecycleEvents } : {}),
    };

    try {
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
        },
        update: { metadata },
      });
    } catch (e: unknown) {
      if (getPrismaErrorCode(e) === "P2002") {
        /* swallow concurrent sync collision */
      } else {
        throw e;
      }
    }
  }

  if (unresolved.length > 0) {
    await storeUnresolvedPrRefs(tx, sessionArtifactId, unresolved);
  }
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

/**
 * ISS-4445 (wongk): fetch the existing `RelatesTo` link metadata for every
 * `(session → branch)` target in one `findMany`, so the persist loop can merge
 * against it without a per-branch `findFirst`. Returns a `targetId → metadata`
 * map (raw Prisma JSON; the loop parses each). An empty target list short-
 * circuits — Prisma would otherwise emit a `targetId IN ()` no-op query.
 */
async function loadExistingLinkMetadataByTargetId(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  sessionArtifactId: string,
  targetIds: string[]
): Promise<Map<string, unknown>> {
  const byTargetId = new Map<string, unknown>();
  if (targetIds.length === 0) {
    return byTargetId;
  }
  const existingLinks = await tx.artifactLink.findMany({
    where: {
      organizationId,
      sourceId: sessionArtifactId,
      targetId: { in: targetIds },
      linkType: LinkType.RelatesTo,
    },
    select: { targetId: true, metadata: true },
  });
  for (const link of existingLinks) {
    byTargetId.set(link.targetId, link.metadata);
  }
  return byTargetId;
}
