import { deterministicUuid } from "../helpers";

import type {
  IncidentScenarioName,
  SeedScenarioContext,
  SeedScenarioPgClient,
} from "./index";

export function scenarioUuid(
  context: SeedScenarioContext,
  scenarioName: IncidentScenarioName,
  key: string
): string {
  return deterministicUuid(
    `incident-scenario:${context.namespace}:${scenarioName}:${key}`
  );
}

export function scenarioTimestamp(context: SeedScenarioContext): Date | string {
  return context.now ?? "2026-05-27T00:00:00.000Z";
}

export function scenarioBranchName(
  context: SeedScenarioContext,
  scenarioName: IncidentScenarioName
): string {
  return `seed/${context.namespace}/${scenarioName}`;
}

export function scenarioGithubId(
  context: SeedScenarioContext,
  scenarioName: IncidentScenarioName,
  index: number
): string {
  return `seed-${context.namespace}-${scenarioName}-github-${index}`;
}

export function scenarioPullRequestNumber(
  context: SeedScenarioContext,
  scenarioName: IncidentScenarioName,
  index: number,
  base: number
): number {
  const uuid = scenarioUuid(context, scenarioName, "number");
  const namespaceValue = Number.parseInt(
    uuid.replaceAll("-", "").slice(0, 6),
    16
  );
  return base + (namespaceValue % 10_000) * 10 + index;
}

export function scenarioUrl(
  context: SeedScenarioContext,
  scenarioName: IncidentScenarioName,
  suffix: string
): string {
  return `https://example.test/seed/${context.namespace}/${scenarioName}/${suffix}`;
}

export type PullRequestDetailSeedSpec = {
  artifactId: string;
  detailId: string;
  index: number;
  headSha: string;
  title: string;
  body: string;
  urlSuffix: string;
};

export async function seedTwoPullRequestDetailRows(
  client: SeedScenarioPgClient,
  context: SeedScenarioContext,
  scenarioName: IncidentScenarioName,
  options: {
    branchName: string;
    pullRequestNumberBase: number;
    pullRequests: [PullRequestDetailSeedSpec, PullRequestDetailSeedSpec];
  }
): Promise<void> {
  const [firstPullRequest, secondPullRequest] = options.pullRequests;

  await client.query(
    `
      INSERT INTO "pull_request_detail" (
        "artifact_id", "id", "repository_id", "github_id", "number", "body",
        "head_branch", "base_branch", "head_sha", "pr_state", "is_draft",
        "checks_status", "review_decision", "title", "html_url"
      )
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, 'main', $8, 'OPEN', false, 'PASSING', 'APPROVED', $9, $10),
        ($11, $12, $3, $13, $14, $15, $7, 'main', $16, 'OPEN', false, 'PASSING', 'APPROVED', $17, $18)
    `,
    [
      firstPullRequest.artifactId,
      firstPullRequest.detailId,
      context.repositoryId,
      scenarioGithubId(context, scenarioName, firstPullRequest.index),
      scenarioPullRequestNumber(
        context,
        scenarioName,
        firstPullRequest.index,
        options.pullRequestNumberBase
      ),
      firstPullRequest.body,
      options.branchName,
      firstPullRequest.headSha,
      firstPullRequest.title,
      scenarioUrl(context, scenarioName, firstPullRequest.urlSuffix),
      secondPullRequest.artifactId,
      secondPullRequest.detailId,
      scenarioGithubId(context, scenarioName, secondPullRequest.index),
      scenarioPullRequestNumber(
        context,
        scenarioName,
        secondPullRequest.index,
        options.pullRequestNumberBase
      ),
      secondPullRequest.body,
      secondPullRequest.headSha,
      secondPullRequest.title,
      scenarioUrl(context, scenarioName, secondPullRequest.urlSuffix),
    ]
  );
}
