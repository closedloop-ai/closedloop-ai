import { scenarioTimestamp, scenarioUrl, scenarioUuid } from "./helpers";
import {
  IncidentScenarioGuardMessage,
  IncidentScenarioName,
  type PrWithoutSidecarScenarioResult,
  type SeedScenarioContext,
  type SeedScenarioPgClient,
} from "./index";

export async function seedPrWithoutSidecarScenario(
  client: SeedScenarioPgClient,
  context: SeedScenarioContext
): Promise<PrWithoutSidecarScenarioResult> {
  const scenarioName = IncidentScenarioName.PrWithoutSidecar;
  const createdAt = scenarioTimestamp(context);
  const pullRequestArtifactId = scenarioUuid(
    context,
    scenarioName,
    "pull-request"
  );

  await client.query(
    `
      INSERT INTO "artifacts" (
        "id", "organization_id", "project_id", "type", "subtype", "name",
        "slug", "status", "external_url", "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, 'PULL_REQUEST', NULL, $4, NULL, 'OPEN', $5, $6, $6)
    `,
    [
      pullRequestArtifactId,
      context.organizationId,
      context.projectId,
      `Seed PR without sidecar ${context.namespace}`,
      scenarioUrl(context, scenarioName, "pull/missing-sidecar"),
      createdAt,
    ]
  );

  return {
    scenarioName,
    expectedGuardMessage: IncidentScenarioGuardMessage.PullRequestWithoutDetail,
    organizationId: context.organizationId,
    userId: context.userId,
    projectId: context.projectId,
    repositoryId: context.repositoryId,
    installationId: context.installationId,
    artifactIds: [pullRequestArtifactId],
  };
}
