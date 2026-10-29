import { BranchPushSource, LinkType } from "@repo/api/src/types/artifact";
import {
  BranchParticipationKind,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { GitHubPRState } from "@repo/api/src/types/github";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, type withDb } from "@repo/database";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";

export const ACTIVITY_AT = new Date("2026-07-01T00:00:00.000Z");

export type TestDb = Parameters<Parameters<typeof withDb>[0]>[0];

export async function createBranchArtifact(
  db: TestDb,
  organizationId: string,
  branchName: string,
  options: {
    firstPushedAt: Date | null;
    lastActivityAt?: Date | null;
    repositoryFullName?: string;
  }
): Promise<string> {
  const lastActivityAt =
    options.lastActivityAt === undefined ? ACTIVITY_AT : options.lastActivityAt;
  const artifact = await db.artifact.create({
    data: {
      organizationId,
      type: ArtifactType.BRANCH,
      name: branchName,
      status: BranchStatus.Open,
    },
    select: { id: true },
  });
  const repositoryFullName = options.repositoryFullName ?? `acme/${branchName}`;
  await db.branchDetail.create({
    data: {
      artifactId: artifact.id,
      organizationId,
      repositoryFullName,
      branchName,
      // Publication evidence is present only when firstPushedAt and its verified
      // source are both set; null seeds a Session-only Branch.
      firstPushedAt: options.firstPushedAt,
      pushSource: options.firstPushedAt ? BranchPushSource.Session : null,
      // Canonical activity remains independent from Product membership.
      lastActivityAt,
    },
    select: { artifactId: true },
  });
  if (lastActivityAt) {
    await db.branchActivityAtom.create({
      data: {
        version: BranchActivityAtomVersion.V1,
        organizationId,
        branchArtifactId: artifact.id,
        source: BranchActivitySource.GitHead,
        sourceEventId: `fixture:${branchName}`,
        occurredAt: lastActivityAt,
        attributionKind: BranchActivityAttributionKind.Branch,
        completeness: BranchActivityEvidenceCompleteness.Complete,
      },
      select: { id: true },
    });
  }
  await db.publicRepository.create({
    data: {
      organizationId,
      ...persistedGitHubRepositoryAuthority({
        githubRepoId: `repo-${artifact.id}`,
        fullName: repositoryFullName,
      }),
      owner: repositoryFullName.split("/")[0] ?? "acme",
      name: repositoryFullName.split("/")[1] ?? branchName,
      htmlUrl: `https://github.com/${repositoryFullName}`,
    },
    select: { id: true },
  });
  return artifact.id;
}

export async function linkValidSession(
  db: TestDb,
  organizationId: string,
  branchArtifactId: string,
  branchName: string,
  userId: string,
  participation: BranchParticipationKind | null = BranchParticipationKind.Wrote
): Promise<string> {
  const session = await db.artifact.create({
    data: {
      organizationId,
      type: ArtifactType.SESSION,
      name: `session-for-${branchName}`,
      status: SESSION_STATUS.ACTIVE,
    },
    select: { id: true },
  });
  const computeTarget = await db.computeTarget.create({
    data: {
      organizationId,
      userId,
      machineName: `machine-${branchName}`,
      platform: "darwin",
    },
    select: { id: true },
  });
  await db.sessionDetail.create({
    data: {
      artifactId: session.id,
      computeTargetId: computeTarget.id,
      externalSessionId: `ext-${branchName}`,
      harness: "claude",
      sessionStartedAt: ACTIVITY_AT,
      sessionUpdatedAt: ACTIVITY_AT,
      lastActivityAt: ACTIVITY_AT,
    },
    select: { artifactId: true },
  });
  await db.artifactLink.create({
    data: {
      organizationId,
      sourceId: session.id,
      targetId: branchArtifactId,
      linkType: LinkType.RelatesTo,
      branchParticipation: participation,
      metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
    },
    select: { id: true },
  });
  return session.id;
}

export async function createCountedPullRequest(
  db: TestDb,
  organizationId: string,
  branchArtifactId: string,
  input: {
    number: number;
    repositoryFullName: string;
    additions: number | null;
    deletions: number | null;
    githubId?: string;
    mergedAt?: Date;
    closedAt?: Date;
    isDraft?: boolean;
  }
): Promise<void> {
  await db.pullRequestDetail.create({
    data: {
      organizationId,
      branchArtifactId,
      number: input.number,
      repositoryFullName: input.repositoryFullName,
      additions: input.additions,
      deletions: input.deletions,
      githubId: input.githubId ?? null,
      mergedAt: input.mergedAt ?? null,
      closedAt: input.closedAt ?? input.mergedAt ?? null,
      isDraft: input.isDraft ?? false,
      prState: input.mergedAt ? GitHubPRState.Merged : GitHubPRState.Closed,
      lastVerifiedAt: ACTIVITY_AT,
    },
    select: { id: true },
  });
  const session = await db.artifact.create({
    data: {
      organizationId,
      type: ArtifactType.SESSION,
      name: `pr-session-${branchArtifactId}-${input.number}`,
      status: SESSION_STATUS.INACTIVE,
    },
    select: { id: true },
  });
  await db.artifactLink.create({
    data: {
      organizationId,
      sourceId: session.id,
      targetId: branchArtifactId,
      linkType: LinkType.RelatesTo,
      metadata: {
        linkKind: SessionArtifactLinkKind.SessionPr,
        repositoryFullName: input.repositoryFullName,
        prNumber: input.number,
      },
    },
    select: { id: true },
  });
}
