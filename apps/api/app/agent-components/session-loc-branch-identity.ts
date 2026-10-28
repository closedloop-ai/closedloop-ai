import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import {
  deriveBranchParticipationFromMetadata,
  parseSessionPrLinkMetadata,
  SessionArtifactLinkKind,
} from "@repo/api/src/types/session-artifact-link";
import type { Prisma, PrismaClient } from "@repo/database";
import {
  SessionPrLinkAudience,
  sessionPrLinkKindWhere,
} from "@/lib/session-pr-links";

export type SessionLocBranchIdentity = {
  repositoryFullName: string | null;
  branch: string | null;
};

type SessionLocBranchIdentityDb = Pick<PrismaClient, "artifactLink">;

type SessionLocBranchLink = {
  sourceId: string;
  targetId: string;
  branchParticipation: string | null;
  lastContributedAt: Date | null;
  createdAt: Date;
  metadata: unknown;
  target: {
    name: string;
    branch: {
      branchName: string;
      repositoryFullName: string;
    } | null;
  };
};

type SessionLocBranchCandidate = SessionLocBranchIdentity & {
  priority: number;
  observedAt: Date | null;
  targetId: string;
};

export async function loadSessionLocBranchIdentities(
  db: SessionLocBranchIdentityDb,
  organizationId: string,
  sessionIds: readonly string[]
): Promise<Map<string, SessionLocBranchIdentity>> {
  if (sessionIds.length === 0) {
    return new Map();
  }
  const links = await db.artifactLink.findMany({
    where: {
      organizationId,
      sourceId: { in: [...sessionIds] },
      ...sessionLocBranchLinkWhere(),
      source: {
        organizationId,
        type: ArtifactType.Session,
      },
      target: {
        organizationId,
        type: ArtifactType.Branch,
        branch: { isNot: null },
      },
    },
    select: {
      sourceId: true,
      targetId: true,
      branchParticipation: true,
      lastContributedAt: true,
      createdAt: true,
      metadata: true,
      target: {
        select: {
          name: true,
          branch: {
            select: {
              branchName: true,
              repositoryFullName: true,
            },
          },
        },
      },
    },
    orderBy: [{ sourceId: "asc" }, { targetId: "asc" }],
  });
  const candidatesBySession = new Map<string, SessionLocBranchCandidate>();
  for (const link of links) {
    const candidate = sessionLocBranchCandidate(link);
    if (!candidate) {
      continue;
    }
    const existing = candidatesBySession.get(link.sourceId);
    if (
      !existing ||
      compareSessionLocBranchCandidates(candidate, existing) < 0
    ) {
      candidatesBySession.set(link.sourceId, candidate);
    }
  }
  return new Map(
    [...candidatesBySession].map(([sessionId, candidate]) => [
      sessionId,
      {
        repositoryFullName: candidate.repositoryFullName,
        branch: candidate.branch,
      },
    ])
  );
}

export function sessionLocEntryBranchIdentity(
  sessionId: string,
  fallbackBranchBySession: ReadonlyMap<string, SessionLocBranchIdentity>,
  repositoryFullName: string | null
): SessionLocBranchIdentity {
  const identity = fallbackBranchBySession.get(sessionId);
  if (!identity) {
    return { repositoryFullName, branch: null };
  }
  return {
    repositoryFullName: identity.repositoryFullName ?? repositoryFullName,
    branch: identity.branch,
  };
}

function sessionLocBranchLinkWhere(): Prisma.ArtifactLinkWhereInput {
  return {
    linkType: LinkType.RelatesTo,
    OR: [
      ...metricSessionPrLinkKindClauses(),
      {
        metadata: {
          path: ["linkKind"],
          equals: SessionArtifactLinkKind.SessionBranch,
        },
      },
    ],
  };
}

function metricSessionPrLinkKindClauses(): Prisma.ArtifactLinkWhereInput[] {
  return sessionPrLinkKindWhere(SessionPrLinkAudience.Metric).OR ?? [];
}

function sessionLocBranchCandidate(
  link: SessionLocBranchLink
): SessionLocBranchCandidate | null {
  const priority = activeWritePriority(link);
  if (priority === null) {
    return null;
  }
  const branch =
    normalizedString(link.target.branch?.branchName) ??
    normalizedString(link.target.name);
  const repositoryFullName = normalizedString(
    link.target.branch?.repositoryFullName
  );
  if (!branch) {
    return null;
  }
  return {
    priority,
    observedAt: link.lastContributedAt ?? link.createdAt,
    targetId: link.targetId,
    repositoryFullName,
    branch,
  };
}

function activeWritePriority(
  link: Pick<SessionLocBranchLink, "branchParticipation" | "metadata">
): number | null {
  if (link.branchParticipation === BranchParticipationKind.Wrote) {
    return 0;
  }
  if (
    link.branchParticipation === BranchParticipationKind.Reviewed ||
    link.branchParticipation !== null
  ) {
    return null;
  }
  const derived = deriveBranchParticipationFromMetadata(
    parseSessionPrLinkMetadata(link.metadata)
  );
  if (derived === BranchParticipationKind.Reviewed) {
    return null;
  }
  return derived === BranchParticipationKind.Wrote ? 0 : 1;
}

function compareSessionLocBranchCandidates(
  left: SessionLocBranchCandidate,
  right: SessionLocBranchCandidate
): number {
  return (
    left.priority - right.priority ||
    compareDatesDesc(left.observedAt, right.observedAt) ||
    compareStrings(left.repositoryFullName, right.repositoryFullName) ||
    compareStrings(left.branch, right.branch) ||
    left.targetId.localeCompare(right.targetId)
  );
}

function compareDatesDesc(left: Date | null, right: Date | null): number {
  return (right?.getTime() ?? 0) - (left?.getTime() ?? 0);
}

function compareStrings(left: string | null, right: string | null): number {
  return (left ?? "").localeCompare(right ?? "");
}

function normalizedString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
