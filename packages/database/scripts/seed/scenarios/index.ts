// biome-ignore-all lint/performance/noBarrelFile: The incident scenario index owns the public database-package contract.
export { seedBranchReparentingCollisionScenario } from "./branch-reparenting-collision";
export { seedMultiPrDuplicateLinksScenario } from "./multi-pr-duplicate-links";
export { seedPrWithoutSidecarScenario } from "./pr-without-sidecar";

export const IncidentScenarioName = {
  MultiPrDuplicateLinks: "multi-pr-duplicate-links",
  PrWithoutSidecar: "pr-without-sidecar",
  BranchReparentingCollision: "branch-reparenting-collision",
} as const;
export type IncidentScenarioName =
  (typeof IncidentScenarioName)[keyof typeof IncidentScenarioName];

export const IncidentScenarioGuardMessage = {
  ArtifactLinksCollision:
    "artifact_links would collide after branch reparenting",
  PullRequestWithoutDetail: "PULL_REQUEST artifact without PullRequestDetail",
  ArtifactRatingsCollision:
    "artifact_ratings would collide after branch reparenting",
} as const;
export type IncidentScenarioGuardMessage =
  (typeof IncidentScenarioGuardMessage)[keyof typeof IncidentScenarioGuardMessage];

export type SeedScenarioPgClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<{ rows: T[]; rowCount: number | null }>;
};

export type SeedScenarioContext = {
  namespace: string;
  organizationId: string;
  userId: string;
  projectId: string;
  repositoryId: string;
  installationId: string;
  now?: Date | string;
};

export type IncidentScenarioResult = {
  scenarioName: IncidentScenarioName;
  expectedGuardMessage: IncidentScenarioGuardMessage;
  organizationId: string;
  userId: string;
  projectId: string;
  repositoryId: string;
  installationId: string;
  artifactIds: string[];
  pullRequestDetailIds?: string[];
  linkIds?: string[];
  ratingIds?: string[];
};

export type MultiPrDuplicateLinksScenarioResult = IncidentScenarioResult & {
  scenarioName: typeof IncidentScenarioName.MultiPrDuplicateLinks;
  expectedGuardMessage: typeof IncidentScenarioGuardMessage.ArtifactLinksCollision;
  linkIds: string[];
};

export type PrWithoutSidecarScenarioResult = IncidentScenarioResult & {
  scenarioName: typeof IncidentScenarioName.PrWithoutSidecar;
  expectedGuardMessage: typeof IncidentScenarioGuardMessage.PullRequestWithoutDetail;
};

export type BranchReparentingCollisionScenarioResult =
  IncidentScenarioResult & {
    scenarioName: typeof IncidentScenarioName.BranchReparentingCollision;
    expectedGuardMessage: typeof IncidentScenarioGuardMessage.ArtifactRatingsCollision;
    pullRequestDetailIds: string[];
    ratingIds: string[];
  };

/**
 * Incident scenario authoring contract:
 * - Place one scenario per kebab-case file in this directory.
 * - Export a function named `seed<PascalCaseScenarioName>Scenario`.
 * - Accept only `SeedScenarioPgClient` and `SeedScenarioContext`; the caller
 *   creates base organization/user/project/repository rows and passes their IDs.
 * - Derive every scenario-owned ID, branch name, external ID, email, label, and
 *   URL from `SeedScenarioContext.namespace`.
 * - Create rows valid after Migration A
 *   `20260515002500_add_branch_artifact_foundation` and before Migration B
 *   `20260515021500_branch_artifact_destructive_cutover`.
 * - Return the exact `IncidentScenarioGuardMessage` member that the actual
 *   Migration B guard must raise.
 * - Use query parameters for all dynamic values. SQL text may contain only
 *   static table names, column names, and static SQL structure.
 * - Register the new function from this index so consumers import a stable
 *   database-owned contract.
 */
