/**
 * reset-counts.ts — the org-scoped row census behind reset verification.
 *
 * Split out of `reset.ts` (ISS-6317). Counting what a reset WOULD remove, and
 * what survived it, is a distinct responsibility from performing the deletes:
 * it issues only `count` reads, is safe to run at any time, and its per-model
 * list changes whenever the schema gains an org-scoped table.
 */

import type { ResetClient, ResetModelCount, ResetScope } from "./reset";

export async function getResetModelCounts(
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
    // CatalogItem supersedes Agent (T-21.1): count org-custom items for this org.
    {
      name: "CatalogItemVersion",
      query: prisma.catalogItemVersion.count({
        where: { catalogItemId: { in: scope.catalogItemIds } },
      }),
    },
    {
      name: "CatalogItem",
      query: prisma.catalogItem.count({
        where: { id: { in: scope.catalogItemIds } },
      }),
    },
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
