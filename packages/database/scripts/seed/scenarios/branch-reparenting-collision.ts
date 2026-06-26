import {
  scenarioBranchName,
  scenarioTimestamp,
  scenarioUrl,
  scenarioUuid,
  seedTwoPullRequestDetailRows,
} from "./helpers";
import {
  type BranchReparentingCollisionScenarioResult,
  IncidentScenarioGuardMessage,
  IncidentScenarioName,
  type SeedScenarioContext,
  type SeedScenarioPgClient,
} from "./index";

export async function seedBranchReparentingCollisionScenario(
  client: SeedScenarioPgClient,
  context: SeedScenarioContext
): Promise<BranchReparentingCollisionScenarioResult> {
  const scenarioName = IncidentScenarioName.BranchReparentingCollision;
  const createdAt = scenarioTimestamp(context);
  const branchName = scenarioBranchName(context, scenarioName);
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
  const firstRatingId = scenarioUuid(context, scenarioName, "rating-1");
  const secondRatingId = scenarioUuid(context, scenarioName, "rating-2");
  const approvedRatingScore = 5;
  const firstRatingComment = `Synthetic rating for ${context.namespace} collision 1`;
  const secondRatingComment = `Synthetic rating for ${context.namespace} collision 2`;

  await client.query(
    `
      INSERT INTO "artifacts" (
        "id", "organization_id", "project_id", "type", "subtype", "name",
        "slug", "status", "external_url", "created_at", "updated_at"
      )
      VALUES
        ($1, $2, $3, 'PULL_REQUEST', NULL, $4, NULL, 'OPEN', $5, $6, $6),
        ($7, $2, $3, 'PULL_REQUEST', NULL, $8, NULL, 'OPEN', $9, $6, $6)
    `,
    [
      firstPrArtifactId,
      context.organizationId,
      context.projectId,
      `Seed PR rating collision ${context.namespace} 1`,
      scenarioUrl(context, scenarioName, "pull/1"),
      createdAt,
      secondPrArtifactId,
      `Seed PR rating collision ${context.namespace} 2`,
      scenarioUrl(context, scenarioName, "pull/2"),
    ]
  );

  await seedTwoPullRequestDetailRows(client, context, scenarioName, {
    branchName,
    pullRequestNumberBase: 300_000,
    pullRequests: [
      {
        artifactId: firstPrArtifactId,
        detailId: firstPullRequestDetailId,
        index: 1,
        headSha: `${context.namespace}-ratings-head-sha-1`,
        title: `Seed PR rating collision ${context.namespace} 1`,
        body: `Synthetic body for ${context.namespace} rating collision 1`,
        urlSuffix: "pull/1",
      },
      {
        artifactId: secondPrArtifactId,
        detailId: secondPullRequestDetailId,
        index: 2,
        headSha: `${context.namespace}-ratings-head-sha-2`,
        title: `Seed PR rating collision ${context.namespace} 2`,
        body: `Synthetic body for ${context.namespace} rating collision 2`,
        urlSuffix: "pull/2",
      },
    ],
  });

  await client.query(
    `
      INSERT INTO "artifact_ratings" (
        "id", "artifact_id", "user_id", "organization_id", "score", "comment",
        "artifact_version", "created_at", "updated_at"
      )
      VALUES
        ($1, $2, $3, $4, $5, $6, NULL, $7, $7),
        ($8, $9, $3, $4, $5, $10, NULL, $7, $7)
    `,
    [
      firstRatingId,
      firstPrArtifactId,
      context.userId,
      context.organizationId,
      approvedRatingScore,
      firstRatingComment,
      createdAt,
      secondRatingId,
      secondPrArtifactId,
      secondRatingComment,
    ]
  );

  return {
    scenarioName,
    expectedGuardMessage: IncidentScenarioGuardMessage.ArtifactRatingsCollision,
    organizationId: context.organizationId,
    userId: context.userId,
    projectId: context.projectId,
    repositoryId: context.repositoryId,
    installationId: context.installationId,
    artifactIds: [firstPrArtifactId, secondPrArtifactId],
    pullRequestDetailIds: [firstPullRequestDetailId, secondPullRequestDetailId],
    ratingIds: [firstRatingId, secondRatingId],
  };
}
