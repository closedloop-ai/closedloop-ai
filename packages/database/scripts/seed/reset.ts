import type { PrismaClient } from "../../generated/client";
import type { TransactionClient } from "../../generated/internal/prismaNamespace";
import {
  getSeedTransactionStrategy,
  SeedProfileName,
  type SeedProfileName as SeedProfileNameValue,
  SeedTransactionMode,
} from "./profiles";

export const SeedResetFailureReason = {
  ResetTargetAmbiguous: "reset_target_ambiguous",
  ResetUserAmbiguous: "reset_user_ambiguous",
  ResetTargetNotFound: "reset_target_not_found",
  ResetUserNotInOrg: "reset_user_not_in_org",
  ResetConfirmationRequired: "reset_confirmation_required",
  ResetCancelled: "reset_cancelled",
  ResetDeleteFailed: "reset_delete_failed",
  ResetVerificationFailed: "reset_verification_failed",
} as const;
export type SeedResetFailureReason =
  (typeof SeedResetFailureReason)[keyof typeof SeedResetFailureReason];

export type ResetModelCount = {
  name: string;
  count: number;
};

export type ResetTarget = {
  organizationId: string;
  userId: string;
  source: "explicit-flags" | "inferred";
};

export type ResetSummary = {
  modelCounts: ResetModelCount[];
  totalRows: number;
};

type ResetClient = PrismaClient | TransactionClient;

export type ResetScope = {
  projectIds: string[];
  teamIds: string[];
  artifactIds: string[];
  documentDetailIds: string[];
  branchArtifactIds: string[];
  pullRequestDetailIds: string[];
  loopIds: string[];
  computeTargetIds: string[];
  desktopCommandIds: string[];
  agentSessionIds: string[];
  customFieldIds: string[];
  customFieldEnumOptionIds: string[];
  tagIds: string[];
  githubInstallationIds: string[];
  githubRepositoryIds: string[];
  agentIds: string[];
};

export type ResetVerificationSnapshot = {
  organizationId: string;
  scope: ResetScope;
};

export async function countResettableOrgRows(
  prisma: PrismaClient,
  organizationId: string,
  snapshot?: ResetVerificationSnapshot
): Promise<ResetSummary> {
  const scope = snapshotMatchesOrg(snapshot, organizationId)
    ? snapshot.scope
    : await collectResetScope(prisma, organizationId);
  const modelCounts = await getResetModelCounts(prisma, organizationId, scope);
  return summarizeResetCounts(modelCounts);
}

export async function collectResetVerificationSnapshot(
  prisma: PrismaClient,
  organizationId: string
): Promise<ResetVerificationSnapshot> {
  return {
    organizationId,
    scope: await collectResetScope(prisma, organizationId),
  };
}

export async function resetOrgData(
  prisma: PrismaClient,
  organizationId: string,
  profile: SeedProfileNameValue = SeedProfileName.Local
): Promise<ResetSummary> {
  const strategy = getSeedTransactionStrategy(profile);
  const runReset = async (client: ResetClient) => {
    const scope = await collectResetScope(client, organizationId);
    await clearPreservedIdentityScalars(client, organizationId);
    return deleteResettableRows(client, organizationId, scope);
  };

  const modelCounts =
    strategy.mode === SeedTransactionMode.SingleTransaction
      ? await prisma.$transaction((tx) => runReset(tx), {
          timeout: strategy.timeoutMs,
          maxWait: strategy.maxWaitMs,
        })
      : await runReset(prisma);
  return summarizeResetCounts(modelCounts);
}

export async function verifyResetComplete(
  prisma: PrismaClient,
  organizationId: string,
  snapshot?: ResetVerificationSnapshot
): Promise<{ ok: true } | { ok: false; remaining: ResetModelCount[] }> {
  const currentScope = await collectResetScope(prisma, organizationId);
  const scope = snapshotMatchesOrg(snapshot, organizationId)
    ? mergeResetScopes(snapshot.scope, currentScope)
    : currentScope;
  const modelCounts = await getResetModelCounts(prisma, organizationId, scope);
  const summary = summarizeResetCounts(modelCounts);
  const remaining = summary.modelCounts.filter(({ count }) => count > 0);
  if (remaining.length > 0) {
    return { ok: false, remaining };
  }
  return { ok: true };
}

function snapshotMatchesOrg(
  snapshot: ResetVerificationSnapshot | undefined,
  organizationId: string
): snapshot is ResetVerificationSnapshot {
  return snapshot?.organizationId === organizationId;
}

function mergeResetScopes(left: ResetScope, right: ResetScope): ResetScope {
  return {
    projectIds: mergeIds(left.projectIds, right.projectIds),
    teamIds: mergeIds(left.teamIds, right.teamIds),
    artifactIds: mergeIds(left.artifactIds, right.artifactIds),
    documentDetailIds: mergeIds(
      left.documentDetailIds,
      right.documentDetailIds
    ),
    branchArtifactIds: mergeIds(
      left.branchArtifactIds,
      right.branchArtifactIds
    ),
    pullRequestDetailIds: mergeIds(
      left.pullRequestDetailIds,
      right.pullRequestDetailIds
    ),
    loopIds: mergeIds(left.loopIds, right.loopIds),
    computeTargetIds: mergeIds(left.computeTargetIds, right.computeTargetIds),
    desktopCommandIds: mergeIds(
      left.desktopCommandIds,
      right.desktopCommandIds
    ),
    agentSessionIds: mergeIds(left.agentSessionIds, right.agentSessionIds),
    customFieldIds: mergeIds(left.customFieldIds, right.customFieldIds),
    customFieldEnumOptionIds: mergeIds(
      left.customFieldEnumOptionIds,
      right.customFieldEnumOptionIds
    ),
    tagIds: mergeIds(left.tagIds, right.tagIds),
    githubInstallationIds: mergeIds(
      left.githubInstallationIds,
      right.githubInstallationIds
    ),
    githubRepositoryIds: mergeIds(
      left.githubRepositoryIds,
      right.githubRepositoryIds
    ),
    agentIds: mergeIds(left.agentIds, right.agentIds),
  };
}

function mergeIds(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])];
}

export function formatResetSummary(summary: ResetSummary): string[] {
  const lines = ["[seed] Reset summary:"];
  for (const { name, count } of summary.modelCounts) {
    if (count > 0) {
      lines.push(`[seed]   ${name.padEnd(36)} ${count}`);
    }
  }
  lines.push(`[seed]   ${"Total".padEnd(36)} ${summary.totalRows}`);
  return lines;
}

async function collectResetScope(
  prisma: ResetClient,
  organizationId: string
): Promise<ResetScope> {
  const [
    projects,
    teams,
    artifacts,
    loops,
    computeTargets,
    customFields,
    tags,
    githubInstallations,
    agents,
  ] = await Promise.all([
    prisma.project.findMany({
      where: { organizationId },
      select: { id: true },
    }),
    prisma.team.findMany({ where: { organizationId }, select: { id: true } }),
    prisma.artifact.findMany({
      where: { organizationId },
      select: { id: true },
    }),
    prisma.loop.findMany({ where: { organizationId }, select: { id: true } }),
    prisma.computeTarget.findMany({
      where: { organizationId },
      select: { id: true },
    }),
    prisma.customField.findMany({
      where: { organizationId },
      select: { id: true },
    }),
    prisma.tag.findMany({ where: { organizationId }, select: { id: true } }),
    prisma.gitHubInstallation.findMany({
      where: { organizationId },
      select: { id: true },
    }),
    prisma.agent.findMany({ where: { organizationId }, select: { id: true } }),
  ]);

  const projectIds = projects.map(({ id }) => id);
  const teamIds = teams.map(({ id }) => id);
  const artifactIds = artifacts.map(({ id }) => id);
  const loopIds = loops.map(({ id }) => id);
  const computeTargetIds = computeTargets.map(({ id }) => id);
  const customFieldIds = customFields.map(({ id }) => id);
  const tagIds = tags.map(({ id }) => id);
  const githubInstallationIds = githubInstallations.map(({ id }) => id);
  const agentIds = agents.map(({ id }) => id);

  const [
    documentDetails,
    branchDetails,
    pullRequestDetails,
    desktopCommands,
    agentSessions,
    customFieldEnumOptions,
    githubRepositories,
  ] = await Promise.all([
    prisma.documentDetail.findMany({
      where: { artifactId: { in: artifactIds } },
      select: { artifactId: true },
    }),
    prisma.branchDetail.findMany({
      where: { artifactId: { in: artifactIds } },
      select: { artifactId: true },
    }),
    prisma.pullRequestDetail.findMany({
      where: { branchArtifactId: { in: artifactIds } },
      select: { id: true },
    }),
    prisma.desktopCommand.findMany({
      where: { computeTargetId: { in: computeTargetIds } },
      select: { id: true },
    }),
    prisma.sessionDetail.findMany({
      where: { artifact: { is: { organizationId } } },
      select: { artifactId: true },
    }),
    prisma.customFieldEnumOption.findMany({
      where: { customFieldId: { in: customFieldIds } },
      select: { id: true },
    }),
    prisma.gitHubInstallationRepository.findMany({
      where: { installationId: { in: githubInstallationIds } },
      select: { id: true },
    }),
  ]);

  return {
    projectIds,
    teamIds,
    artifactIds,
    documentDetailIds: documentDetails.map(({ artifactId }) => artifactId),
    branchArtifactIds: branchDetails.map(({ artifactId }) => artifactId),
    pullRequestDetailIds: pullRequestDetails.map(({ id }) => id),
    loopIds,
    computeTargetIds,
    desktopCommandIds: desktopCommands.map(({ id }) => id),
    agentSessionIds: agentSessions.map(({ artifactId }) => artifactId),
    customFieldIds,
    customFieldEnumOptionIds: customFieldEnumOptions.map(({ id }) => id),
    tagIds,
    githubInstallationIds,
    githubRepositoryIds: githubRepositories.map(({ id }) => id),
    agentIds,
  };
}

async function clearPreservedIdentityScalars(
  prisma: ResetClient,
  organizationId: string
): Promise<void> {
  await prisma.user.updateMany({
    where: { organizationId },
    data: {
      claudeApiKeyEncrypted: null,
      claudeApiKeyLastFour: null,
      claudeApiKeySetAt: null,
      preferredComputeTargetId: null,
    },
  });
  await prisma.organization.update({
    where: { id: organizationId },
    data: {
      claudeApiKeyEncrypted: null,
      claudeApiKeyLastFour: null,
      claudeApiKeySetAt: null,
    },
  });
}

async function deleteResettableRows(
  prisma: ResetClient,
  organizationId: string,
  scope: ResetScope
): Promise<ResetModelCount[]> {
  const counts: ResetModelCount[] = [];

  await deleteAndRecord(counts, "DesktopCommandEvent", () =>
    prisma.desktopCommandEvent.deleteMany({
      where: { commandId: { in: scope.desktopCommandIds } },
    })
  );
  await deleteAndRecord(counts, "LoopExecutionCredentialConsumption", () =>
    prisma.loopExecutionCredentialConsumption.deleteMany({
      where: {
        OR: [
          { commandId: { in: scope.desktopCommandIds } },
          { loopId: { in: scope.loopIds } },
          { computeTargetId: { in: scope.computeTargetIds } },
        ],
      },
    })
  );
  await deleteAndRecord(counts, "AgentSessionEvent", () =>
    prisma.agentSessionEvent.deleteMany({
      where: { agentSessionId: { in: scope.agentSessionIds } },
    })
  );
  await deleteAndRecord(counts, "AgentSessionTokenUsage", () =>
    prisma.agentSessionTokenUsage.deleteMany({
      where: { agentSessionId: { in: scope.agentSessionIds } },
    })
  );
  await deleteAndRecord(counts, "ComputeTargetHealthCheck", () =>
    prisma.computeTargetHealthCheck.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "DesktopCommand", () =>
    prisma.desktopCommand.deleteMany({
      where: { id: { in: scope.desktopCommandIds } },
    })
  );
  await deleteAndRecord(counts, "SessionDetail", () =>
    prisma.sessionDetail.deleteMany({
      where: { artifact: { is: { organizationId } } },
    })
  );
  await deleteAndRecord(counts, "ChatSession", () =>
    prisma.chatSession.deleteMany({ where: { organizationId } })
  );

  await deleteAndRecord(counts, "ApiKey", () =>
    prisma.apiKey.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "OAuthAuthorizationCode", () =>
    prisma.oAuthAuthorizationCode.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "OAuthRefreshToken", () =>
    prisma.oAuthRefreshToken.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "UserPublicKey", () =>
    prisma.userPublicKey.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "DesktopOnboardingAttempt", () =>
    prisma.desktopOnboardingAttempt.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "DesktopOnboardingDeviceSession", () =>
    prisma.desktopOnboardingDeviceSession.deleteMany({
      where: { organizationId },
    })
  );

  // Comment/thread sub-trees: scope through the org-owned CommentThread relation
  // rather than materialized id lists. The perf profile produces 75k+ comments
  // per org; an `IN (...)` predicate with that many bind parameters exceeds
  // Postgres' 65535 parameter limit and breaks mid-reset. Relation predicates
  // push the join into a single bounded WHERE clause.
  await deleteAndRecord(counts, "GitHubCommentProjection", () =>
    prisma.gitHubCommentProjection.deleteMany({
      where: { threadProjection: { thread: { organizationId } } },
    })
  );
  await deleteAndRecord(counts, "GitHubCommentThreadProjection", () =>
    prisma.gitHubCommentThreadProjection.deleteMany({
      where: { thread: { organizationId } },
    })
  );
  await deleteAndRecord(counts, "CommentReaction", () =>
    prisma.commentReaction.deleteMany({
      where: { comment: { thread: { organizationId } } },
    })
  );
  await deleteAndRecord(counts, "CommentAttachment", () =>
    prisma.commentAttachment.deleteMany({
      where: { comment: { thread: { organizationId } } },
    })
  );
  await deleteAndRecord(counts, "Comment", () =>
    prisma.comment.deleteMany({
      where: { thread: { organizationId } },
    })
  );
  await deleteAndRecord(counts, "CommentThread", () =>
    prisma.commentThread.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "ExternalCommentAuthor", () =>
    prisma.externalCommentAuthor.deleteMany({ where: { organizationId } })
  );

  await deleteAndRecord(counts, "CustomFieldValue", () =>
    prisma.customFieldValue.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "CustomFieldSetting", () =>
    prisma.customFieldSetting.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "CustomFieldEnumOption", () =>
    prisma.customFieldEnumOption.deleteMany({
      where: { id: { in: scope.customFieldEnumOptionIds } },
    })
  );
  await deleteAndRecord(counts, "CustomField", () =>
    prisma.customField.deleteMany({ where: { organizationId } })
  );

  await deleteAndRecord(counts, "TagProject", () =>
    prisma.tagProject.deleteMany({ where: { tagId: { in: scope.tagIds } } })
  );
  await deleteAndRecord(counts, "TagArtifact", () =>
    prisma.tagArtifact.deleteMany({ where: { tagId: { in: scope.tagIds } } })
  );
  await deleteAndRecord(counts, "TagLoop", () =>
    prisma.tagLoop.deleteMany({ where: { tagId: { in: scope.tagIds } } })
  );
  await deleteAndRecord(counts, "Tag", () =>
    prisma.tag.deleteMany({ where: { organizationId } })
  );

  await deleteAndRecord(counts, "JudgeHumanScore", () =>
    prisma.judgeHumanScore.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "JudgeScore", () =>
    prisma.judgeScore.deleteMany({
      where: { evaluation: { organizationId } },
    })
  );
  await deleteAndRecord(counts, "ArtifactEvaluation", () =>
    prisma.artifactEvaluation.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "ArtifactRating", () =>
    prisma.artifactRating.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "FavoriteArtifact", () =>
    prisma.favoriteArtifact.deleteMany({
      where: { artifactId: { in: scope.artifactIds } },
    })
  );
  await deleteAndRecord(counts, "FavoriteProject", () =>
    prisma.favoriteProject.deleteMany({
      where: { projectId: { in: scope.projectIds } },
    })
  );
  await deleteAndRecord(counts, "FileAttachment", () =>
    prisma.fileAttachment.deleteMany({
      where: { artifactId: { in: scope.artifactIds } },
    })
  );
  await deleteAndRecord(counts, "ArtifactLink", () =>
    prisma.artifactLink.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "DocumentGenerationStatusDismissal", () =>
    prisma.documentGenerationStatusDismissal.deleteMany({
      where: { artifactId: { in: scope.artifactIds } },
    })
  );
  await deleteAndRecord(counts, "GitHubPRReview", () =>
    prisma.gitHubPRReview.deleteMany({
      where: { pullRequestId: { in: scope.pullRequestDetailIds } },
    })
  );
  await deleteAndRecord(counts, "BranchFileChange", () =>
    prisma.branchFileChange.deleteMany({
      where: { branchArtifactId: { in: scope.branchArtifactIds } },
    })
  );
  // Explicitly delete BranchStatusCheck so the row count is reported in the
  // reset summary and the delete/count list-sync test can catch leftover rows
  // when the cascade relationship changes. The schema already cascades on
  // BranchDetail delete, but a silent cascade hides scope drift from operators
  // and reviewers.
  await deleteAndRecord(counts, "BranchStatusCheck", () =>
    prisma.branchStatusCheck.deleteMany({
      where: { branchArtifactId: { in: scope.branchArtifactIds } },
    })
  );
  await prisma.branchDetail.updateMany({
    where: { artifactId: { in: scope.branchArtifactIds } },
    data: { currentPullRequestDetailId: null },
  });
  await deleteAndRecord(counts, "PullRequestDetail", () =>
    prisma.pullRequestDetail.deleteMany({
      where: { branchArtifactId: { in: scope.artifactIds } },
    })
  );
  await deleteAndRecord(counts, "BranchDetail", () =>
    prisma.branchDetail.deleteMany({
      where: { artifactId: { in: scope.artifactIds } },
    })
  );
  await deleteAndRecord(counts, "DeploymentDetail", () =>
    prisma.deploymentDetail.deleteMany({
      where: { artifactId: { in: scope.artifactIds } },
    })
  );
  await deleteAndRecord(counts, "DocumentVersion", () =>
    prisma.documentVersion.deleteMany({
      where: { documentId: { in: scope.documentDetailIds } },
    })
  );
  await deleteAndRecord(counts, "DocumentDetail", () =>
    prisma.documentDetail.deleteMany({
      where: { artifactId: { in: scope.documentDetailIds } },
    })
  );

  await deleteAndRecord(counts, "LoopEvent", () =>
    prisma.loopEvent.deleteMany({ where: { loopId: { in: scope.loopIds } } })
  );
  await deleteAndRecord(counts, "LoopTokenRefresh", () =>
    prisma.loopTokenRefresh.deleteMany({
      where: { loopId: { in: scope.loopIds } },
    })
  );
  await prisma.loop.updateMany({
    where: { id: { in: scope.loopIds } },
    data: { computeTargetId: null, parentLoopId: null },
  });
  await deleteAndRecord(counts, "Loop", () =>
    prisma.loop.deleteMany({ where: { organizationId } })
  );

  await deleteAndRecord(counts, "LinearSubtask", () =>
    prisma.linearSubtask.deleteMany({ where: { organizationId } })
  );

  await deleteAndRecord(counts, "Artifact", () =>
    prisma.artifact.deleteMany({ where: { organizationId } })
  );

  await deleteAndRecord(counts, "TeamRepository", () =>
    prisma.teamRepository.deleteMany({
      where: { teamId: { in: scope.teamIds } },
    })
  );
  await deleteAndRecord(counts, "ProjectTeam", () =>
    prisma.projectTeam.deleteMany({
      where: {
        OR: [
          { teamId: { in: scope.teamIds } },
          { projectId: { in: scope.projectIds } },
        ],
      },
    })
  );
  await deleteAndRecord(counts, "TeamMember", () =>
    prisma.teamMember.deleteMany({ where: { teamId: { in: scope.teamIds } } })
  );
  await deleteAndRecord(counts, "Team", () =>
    prisma.team.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "Project", () =>
    prisma.project.deleteMany({ where: { organizationId } })
  );

  await deleteAndRecord(counts, "GitHubInstallationRepository", () =>
    prisma.gitHubInstallationRepository.deleteMany({
      where: { id: { in: scope.githubRepositoryIds } },
    })
  );
  await deleteAndRecord(counts, "GitHubInstallation", () =>
    prisma.gitHubInstallation.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "GitHubUserConnection", () =>
    prisma.gitHubUserConnection.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "PublicRepository", () =>
    prisma.publicRepository.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "LinearIntegration", () =>
    prisma.linearIntegration.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "SlackIntegration", () =>
    prisma.slackIntegration.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "GoogleIntegration", () =>
    prisma.googleIntegration.deleteMany({ where: { organizationId } })
  );

  await deleteAndRecord(counts, "AgentVersion", () =>
    prisma.agentVersion.deleteMany({
      where: { agentId: { in: scope.agentIds } },
    })
  );
  await deleteAndRecord(counts, "Agent", () =>
    prisma.agent.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "RepoBootstrapConfig", () =>
    prisma.repoBootstrapConfig.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "SlugCounter", () =>
    prisma.slugCounter.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "ComputeTarget", () =>
    prisma.computeTarget.deleteMany({ where: { organizationId } })
  );
  await deleteAndRecord(counts, "Prompt", () =>
    prisma.prompt.deleteMany({ where: { organizationId } })
  );

  // These global/no-owner tables are intentionally excluded: OAuthRevokedToken,
  // OAuthRateLimit, LocalGatewayChallengeJti, and PreviewSchema. They do not
  // have a safe organization ownership path in schema.prisma.
  return counts;
}

async function getResetModelCounts(
  prisma: ResetClient,
  organizationId: string,
  scope: ResetScope
): Promise<ResetModelCount[]> {
  const modelQueries: Array<{ name: string; query: Promise<number> }> = [
    {
      name: "ApiKey",
      query: prisma.apiKey.count({ where: { organizationId } }),
    },
    {
      name: "OAuthAuthorizationCode",
      query: prisma.oAuthAuthorizationCode.count({ where: { organizationId } }),
    },
    {
      name: "OAuthRefreshToken",
      query: prisma.oAuthRefreshToken.count({ where: { organizationId } }),
    },
    {
      name: "UserPublicKey",
      query: prisma.userPublicKey.count({ where: { organizationId } }),
    },
    {
      name: "ComputeTargetHealthCheck",
      query: prisma.computeTargetHealthCheck.count({
        where: { organizationId },
      }),
    },
    {
      name: "DesktopCommandEvent",
      query: prisma.desktopCommandEvent.count({
        where: { commandId: { in: scope.desktopCommandIds } },
      }),
    },
    {
      name: "LoopExecutionCredentialConsumption",
      query: prisma.loopExecutionCredentialConsumption.count({
        where: {
          OR: [
            { commandId: { in: scope.desktopCommandIds } },
            { loopId: { in: scope.loopIds } },
            { computeTargetId: { in: scope.computeTargetIds } },
          ],
        },
      }),
    },
    {
      name: "DesktopCommand",
      query: prisma.desktopCommand.count({
        where: { id: { in: scope.desktopCommandIds } },
      }),
    },
    {
      name: "AgentSessionEvent",
      query: prisma.agentSessionEvent.count({
        where: { agentSessionId: { in: scope.agentSessionIds } },
      }),
    },
    {
      name: "AgentSessionTokenUsage",
      query: prisma.agentSessionTokenUsage.count({
        where: { agentSessionId: { in: scope.agentSessionIds } },
      }),
    },
    {
      name: "SessionDetail",
      query: prisma.sessionDetail.count({
        where: { artifact: { is: { organizationId } } },
      }),
    },
    {
      name: "ChatSession",
      query: prisma.chatSession.count({ where: { organizationId } }),
    },
    {
      name: "DesktopOnboardingAttempt",
      query: prisma.desktopOnboardingAttempt.count({
        where: { organizationId },
      }),
    },
    {
      name: "DesktopOnboardingDeviceSession",
      query: prisma.desktopOnboardingDeviceSession.count({
        where: { organizationId },
      }),
    },
    {
      name: "CommentThread",
      query: prisma.commentThread.count({ where: { organizationId } }),
    },
    {
      name: "Comment",
      query: prisma.comment.count({
        where: { thread: { organizationId } },
      }),
    },
    {
      name: "CommentReaction",
      query: prisma.commentReaction.count({
        where: { comment: { thread: { organizationId } } },
      }),
    },
    {
      name: "CommentAttachment",
      query: prisma.commentAttachment.count({
        where: { comment: { thread: { organizationId } } },
      }),
    },
    {
      name: "GitHubCommentThreadProjection",
      query: prisma.gitHubCommentThreadProjection.count({
        where: { thread: { organizationId } },
      }),
    },
    {
      name: "GitHubCommentProjection",
      query: prisma.gitHubCommentProjection.count({
        where: { threadProjection: { thread: { organizationId } } },
      }),
    },
    {
      name: "ExternalCommentAuthor",
      query: prisma.externalCommentAuthor.count({ where: { organizationId } }),
    },
    {
      name: "CustomField",
      query: prisma.customField.count({ where: { organizationId } }),
    },
    {
      name: "CustomFieldEnumOption",
      query: prisma.customFieldEnumOption.count({
        where: { id: { in: scope.customFieldEnumOptionIds } },
      }),
    },
    {
      name: "CustomFieldSetting",
      query: prisma.customFieldSetting.count({ where: { organizationId } }),
    },
    {
      name: "CustomFieldValue",
      query: prisma.customFieldValue.count({ where: { organizationId } }),
    },
    { name: "Tag", query: prisma.tag.count({ where: { organizationId } }) },
    {
      name: "TagProject",
      query: prisma.tagProject.count({
        where: { tagId: { in: scope.tagIds } },
      }),
    },
    {
      name: "TagArtifact",
      query: prisma.tagArtifact.count({
        where: { tagId: { in: scope.tagIds } },
      }),
    },
    {
      name: "TagLoop",
      query: prisma.tagLoop.count({ where: { tagId: { in: scope.tagIds } } }),
    },
    {
      name: "JudgeHumanScore",
      query: prisma.judgeHumanScore.count({ where: { organizationId } }),
    },
    {
      name: "JudgeScore",
      query: prisma.judgeScore.count({
        where: { evaluation: { organizationId } },
      }),
    },
    {
      name: "ArtifactEvaluation",
      query: prisma.artifactEvaluation.count({ where: { organizationId } }),
    },
    {
      name: "ArtifactRating",
      query: prisma.artifactRating.count({ where: { organizationId } }),
    },
    {
      name: "FileAttachment",
      query: prisma.fileAttachment.count({
        where: { artifactId: { in: scope.artifactIds } },
      }),
    },
    {
      name: "FavoriteArtifact",
      query: prisma.favoriteArtifact.count({
        where: { artifactId: { in: scope.artifactIds } },
      }),
    },
    {
      name: "FavoriteProject",
      query: prisma.favoriteProject.count({
        where: { projectId: { in: scope.projectIds } },
      }),
    },
    {
      name: "ArtifactLink",
      query: prisma.artifactLink.count({ where: { organizationId } }),
    },
    {
      name: "DocumentGenerationStatusDismissal",
      query: prisma.documentGenerationStatusDismissal.count({
        where: { artifactId: { in: scope.artifactIds } },
      }),
    },
    {
      name: "DocumentVersion",
      query: prisma.documentVersion.count({
        where: { documentId: { in: scope.documentDetailIds } },
      }),
    },
    {
      name: "GitHubPRReview",
      query: prisma.gitHubPRReview.count({
        where: { pullRequestId: { in: scope.pullRequestDetailIds } },
      }),
    },
    {
      name: "BranchFileChange",
      query: prisma.branchFileChange.count({
        where: { branchArtifactId: { in: scope.branchArtifactIds } },
      }),
    },
    {
      name: "BranchStatusCheck",
      query: prisma.branchStatusCheck.count({
        where: { branchArtifactId: { in: scope.branchArtifactIds } },
      }),
    },
    {
      name: "PullRequestDetail",
      query: prisma.pullRequestDetail.count({
        where: { branchArtifactId: { in: scope.artifactIds } },
      }),
    },
    {
      name: "BranchDetail",
      query: prisma.branchDetail.count({
        where: { artifactId: { in: scope.artifactIds } },
      }),
    },
    {
      name: "DeploymentDetail",
      query: prisma.deploymentDetail.count({
        where: { artifactId: { in: scope.artifactIds } },
      }),
    },
    {
      name: "DocumentDetail",
      query: prisma.documentDetail.count({
        where: { artifactId: { in: scope.documentDetailIds } },
      }),
    },
    { name: "Loop", query: prisma.loop.count({ where: { organizationId } }) },
    {
      name: "LoopEvent",
      query: prisma.loopEvent.count({
        where: { loopId: { in: scope.loopIds } },
      }),
    },
    {
      name: "LoopTokenRefresh",
      query: prisma.loopTokenRefresh.count({
        where: { loopId: { in: scope.loopIds } },
      }),
    },
    {
      name: "LinearSubtask",
      query: prisma.linearSubtask.count({ where: { organizationId } }),
    },
    {
      name: "Artifact",
      query: prisma.artifact.count({ where: { organizationId } }),
    },
    {
      name: "TeamRepository",
      query: prisma.teamRepository.count({
        where: { teamId: { in: scope.teamIds } },
      }),
    },
    {
      name: "ProjectTeam",
      query: prisma.projectTeam.count({
        where: {
          OR: [
            { teamId: { in: scope.teamIds } },
            { projectId: { in: scope.projectIds } },
          ],
        },
      }),
    },
    {
      name: "TeamMember",
      query: prisma.teamMember.count({
        where: { teamId: { in: scope.teamIds } },
      }),
    },
    { name: "Team", query: prisma.team.count({ where: { organizationId } }) },
    {
      name: "Project",
      query: prisma.project.count({ where: { organizationId } }),
    },
    {
      name: "GitHubInstallationRepository",
      query: prisma.gitHubInstallationRepository.count({
        where: { id: { in: scope.githubRepositoryIds } },
      }),
    },
    {
      name: "GitHubInstallation",
      query: prisma.gitHubInstallation.count({ where: { organizationId } }),
    },
    {
      name: "GitHubUserConnection",
      query: prisma.gitHubUserConnection.count({ where: { organizationId } }),
    },
    {
      name: "PublicRepository",
      query: prisma.publicRepository.count({ where: { organizationId } }),
    },
    {
      name: "LinearIntegration",
      query: prisma.linearIntegration.count({ where: { organizationId } }),
    },
    {
      name: "SlackIntegration",
      query: prisma.slackIntegration.count({ where: { organizationId } }),
    },
    {
      name: "GoogleIntegration",
      query: prisma.googleIntegration.count({ where: { organizationId } }),
    },
    {
      name: "AgentVersion",
      query: prisma.agentVersion.count({
        where: { agentId: { in: scope.agentIds } },
      }),
    },
    { name: "Agent", query: prisma.agent.count({ where: { organizationId } }) },
    {
      name: "RepoBootstrapConfig",
      query: prisma.repoBootstrapConfig.count({ where: { organizationId } }),
    },
    {
      name: "SlugCounter",
      query: prisma.slugCounter.count({ where: { organizationId } }),
    },
    {
      name: "ComputeTarget",
      query: prisma.computeTarget.count({ where: { organizationId } }),
    },
    {
      name: "Prompt",
      query: prisma.prompt.count({ where: { organizationId } }),
    },
  ];

  const counts = await Promise.all(modelQueries.map(({ query }) => query));
  return modelQueries.map(({ name }, index) => ({
    name,
    count: counts[index],
  }));
}

async function deleteAndRecord(
  counts: ResetModelCount[],
  name: string,
  runDelete: () => Promise<{ count: number }>
): Promise<void> {
  try {
    const result = await runDelete();
    counts.push({ name, count: result.count });
  } catch (error) {
    throw new ResetDeleteError(name, error);
  }
}

function summarizeResetCounts(modelCounts: ResetModelCount[]): ResetSummary {
  return {
    modelCounts,
    totalRows: modelCounts.reduce((sum, { count }) => sum + count, 0),
  };
}

export class ResetDeleteError extends Error {
  readonly modelName: string;
  readonly reason = SeedResetFailureReason.ResetDeleteFailed;

  constructor(modelName: string, cause: unknown) {
    super(`Reset failed while deleting ${modelName}.`, { cause });
    this.name = "ResetDeleteError";
    this.modelName = modelName;
  }
}
