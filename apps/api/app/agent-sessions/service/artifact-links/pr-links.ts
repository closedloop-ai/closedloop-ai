import { LinkType } from "@repo/api/src/types/artifact";
import type { SyncedSessionPrRef } from "@repo/api/src/types/session-artifact-link";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { getPrismaErrorCode } from "@/lib/db-utils";
import type { AgentSessionUpsertTx } from "../records";
import { resolveRepoIdsByFullName, storeUnresolvedRefs } from "./shared";

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
};

export type UnresolvedPrRef = { repositoryFullName: string; prNumber: number };

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
    } else {
      byBranch.set(resolution.branchArtifactId, {
        relationTypes: new Set([prRef.relationType]),
        repositoryFullName: prRef.repositoryFullName,
        prNumber: prRef.prNumber,
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
      typeof (value as Record<string, unknown>).prNumber === "number",
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

  const installation = await tx.gitHubInstallation.findFirst({
    where: { organizationId },
    select: { id: true },
  });

  const repoIdByFullName = await resolveRepoIdsByFullName(
    tx,
    installation?.id,
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

  for (const [branchArtifactId, ref] of byBranch) {
    if (branchArtifactId === sessionArtifactId) {
      continue;
    }

    // FEA-2729 (deferred, self-healing): this write replaces the whole metadata
    // blob. On a shared session_pr + session_branch row, a partial sync that
    // sends prRefs but omits artifactRefs transiently drops the branch fields
    // (the branch lane early-returns and does not re-merge). It self-heals on
    // the next sync that includes artifactRefs, since the desktop re-sends the
    // session's full ref set and the branch lane (which runs after this one)
    // re-merges. Branch metadata has no reader yet, so the window is benign;
    // making this a read-merge is tracked but not done pre-PMF.
    const metadata = {
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [...ref.relationTypes].sort(),
      source: SESSION_PR_LINK_SOURCE,
      confidence: 1.0,
      extractorVersion: 1,
      repositoryFullName: ref.repositoryFullName,
      prNumber: ref.prNumber,
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
