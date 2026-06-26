import {
  scenarioBranchName,
  scenarioTimestamp,
  scenarioUrl,
  scenarioUuid,
  seedTwoPullRequestDetailRows,
} from "./helpers";
import {
  IncidentScenarioGuardMessage,
  IncidentScenarioName,
  type MultiPrDuplicateLinksScenarioResult,
  type SeedScenarioContext,
  type SeedScenarioPgClient,
} from "./index";

export async function seedMultiPrDuplicateLinksScenario(
  client: SeedScenarioPgClient,
  context: SeedScenarioContext
): Promise<MultiPrDuplicateLinksScenarioResult> {
  const scenarioName = IncidentScenarioName.MultiPrDuplicateLinks;
  const createdAt = scenarioTimestamp(context);
  const branchName = scenarioBranchName(context, scenarioName);
  const targetArtifactId = scenarioUuid(
    context,
    scenarioName,
    "target-document"
  );
  const firstPrArtifactId = scenarioUuid(
    context,
    scenarioName,
    "pull-request-1"
  );
  const secondPrArtifactId = scenarioUuid(
    context,
    scenarioName,
    "pull-request-2"
  );
  const firstPullRequestDetailId = scenarioUuid(
    context,
    scenarioName,
    "pull-request-detail-1"
  );
  const secondPullRequestDetailId = scenarioUuid(
    context,
    scenarioName,
    "pull-request-detail-2"
  );
  const firstLinkId = scenarioUuid(context, scenarioName, "link-1");
  const secondLinkId = scenarioUuid(context, scenarioName, "link-2");

  await client.query(
    `
      INSERT INTO "artifacts" (
        "id", "organization_id", "project_id", "type", "subtype", "name",
        "slug", "status", "external_url", "created_at", "updated_at"
      )
      VALUES
        ($1, $2, $3, 'DOCUMENT', 'IMPLEMENTATION_PLAN', $4, NULL, 'IN_REVIEW', $5, $6, $6),
        ($7, $2, $3, 'PULL_REQUEST', NULL, $8, NULL, 'OPEN', $9, $6, $6),
        ($10, $2, $3, 'PULL_REQUEST', NULL, $11, NULL, 'OPEN', $12, $6, $6)
    `,
    [
      targetArtifactId,
      context.organizationId,
      context.projectId,
      `Seed target for ${context.namespace}`,
      scenarioUrl(context, scenarioName, "target"),
      createdAt,
      firstPrArtifactId,
      `Seed PR link collision ${context.namespace} 1`,
      scenarioUrl(context, scenarioName, "pull/1"),
      secondPrArtifactId,
      `Seed PR link collision ${context.namespace} 2`,
      scenarioUrl(context, scenarioName, "pull/2"),
    ]
  );

  await seedTwoPullRequestDetailRows(client, context, scenarioName, {
    branchName,
    pullRequestNumberBase: 100_000,
    pullRequests: [
      {
        artifactId: firstPrArtifactId,
        detailId: firstPullRequestDetailId,
        index: 1,
        headSha: `${context.namespace}-links-head-sha-1`,
        title: `Seed PR link collision ${context.namespace} 1`,
        body: `Synthetic body for ${context.namespace} link collision 1`,
        urlSuffix: "pull/1",
      },
      {
        artifactId: secondPrArtifactId,
        detailId: secondPullRequestDetailId,
        index: 2,
        headSha: `${context.namespace}-links-head-sha-2`,
        title: `Seed PR link collision ${context.namespace} 2`,
        body: `Synthetic body for ${context.namespace} link collision 2`,
        urlSuffix: "pull/2",
      },
    ],
  });

  await client.query(
    `
      INSERT INTO "artifact_links" (
        "id", "organization_id", "source_id", "target_id", "link_type", "created_at"
      )
      VALUES
        ($1, $2, $3, $5, 'PRODUCES', $6),
        ($4, $2, $7, $5, 'PRODUCES', $6)
    `,
    [
      firstLinkId,
      context.organizationId,
      firstPrArtifactId,
      secondLinkId,
      targetArtifactId,
      createdAt,
      secondPrArtifactId,
    ]
  );

  return {
    scenarioName,
    expectedGuardMessage: IncidentScenarioGuardMessage.ArtifactLinksCollision,
    organizationId: context.organizationId,
    userId: context.userId,
    projectId: context.projectId,
    repositoryId: context.repositoryId,
    installationId: context.installationId,
    artifactIds: [targetArtifactId, firstPrArtifactId, secondPrArtifactId],
    pullRequestDetailIds: [firstPullRequestDetailId, secondPullRequestDetailId],
    linkIds: [firstLinkId, secondLinkId],
  };
}
