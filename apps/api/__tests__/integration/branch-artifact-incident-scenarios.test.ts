// biome-ignore-all lint/suspicious/noMisplacedAssertion: The migration-upgrade harness invokes assertions from inside the test scenario.
import { performance } from "node:perf_hooks";
import { deterministicUuid } from "@repo/database/scripts/seed/helpers";
import {
  IncidentScenarioGuardMessage,
  IncidentScenarioName,
  type IncidentScenarioResult,
  type SeedScenarioContext,
  type SeedScenarioPgClient,
  seedBranchReparentingCollisionScenario,
  seedMultiPrDuplicateLinksScenario,
  seedPrWithoutSidecarScenario,
} from "@repo/database/scripts/seed/scenarios";
import { afterEach, describe, expect, it } from "vitest";
import {
  canRunMigrationUpgradeScenario,
  canRunMigrationUpgradeScenarioExpectingFailure,
  type ExpectedMigrationFailure,
  type PgClient,
  runMigrationUpgradeScenario,
  runMigrationUpgradeScenarioExpectingFailure,
} from "../utils/migration-upgrade-harness";

const describeWithDisposableDatabase = canRunMigrationUpgradeScenario()
  ? describe
  : describe.skip;
const describeWithDisposableExpectedFailureDatabase =
  canRunMigrationUpgradeScenarioExpectingFailure() ? describe : describe.skip;

const migrationAName = "20260515002500_add_branch_artifact_foundation";
const migrationBName = "20260515021500_branch_artifact_destructive_cutover";
const scenarioSetupBudgetMs = 5000;
const localDatabaseHostErrorPattern = /local DATABASE_URL host/;
const blockedDatabaseErrorPattern = /blocked database/;

type ScenarioSeeder<
  TResult extends IncidentScenarioResult = IncidentScenarioResult,
> = (
  client: SeedScenarioPgClient,
  context: SeedScenarioContext
) => Promise<TResult>;

type ScenarioSpec = {
  scenarioName: IncidentScenarioName;
  expectedGuardMessage: IncidentScenarioGuardMessage;
  seed: ScenarioSeeder;
};

const scenarioSpecs: ScenarioSpec[] = [
  {
    scenarioName: IncidentScenarioName.MultiPrDuplicateLinks,
    expectedGuardMessage: IncidentScenarioGuardMessage.ArtifactLinksCollision,
    seed: seedMultiPrDuplicateLinksScenario,
  },
  {
    scenarioName: IncidentScenarioName.PrWithoutSidecar,
    expectedGuardMessage: IncidentScenarioGuardMessage.PullRequestWithoutDetail,
    seed: seedPrWithoutSidecarScenario,
  },
  {
    scenarioName: IncidentScenarioName.BranchReparentingCollision,
    expectedGuardMessage: IncidentScenarioGuardMessage.ArtifactRatingsCollision,
    seed: seedBranchReparentingCollisionScenario,
  },
];

function makeScenarioContext(namespace: string): SeedScenarioContext {
  return {
    namespace,
    organizationId: deterministicUuid(
      `incident-scenario-base:${namespace}:org`
    ),
    userId: deterministicUuid(`incident-scenario-base:${namespace}:user`),
    projectId: deterministicUuid(`incident-scenario-base:${namespace}:project`),
    installationId: deterministicUuid(
      `incident-scenario-base:${namespace}:installation`
    ),
    repositoryId: deterministicUuid(
      `incident-scenario-base:${namespace}:repository`
    ),
    now: "2026-05-27T00:00:00.000Z",
  };
}

function withNamespace(
  context: SeedScenarioContext,
  namespace: string
): SeedScenarioContext {
  return { ...context, namespace };
}

function resultReferences(
  result: IncidentScenarioResult
): IncidentScenarioResult {
  return {
    ...result,
    artifactIds: [...result.artifactIds].sort(),
    pullRequestDetailIds: result.pullRequestDetailIds
      ? [...result.pullRequestDetailIds].sort()
      : undefined,
    linkIds: result.linkIds ? [...result.linkIds].sort() : undefined,
    ratingIds: result.ratingIds ? [...result.ratingIds].sort() : undefined,
  };
}

async function seedScenarioBaseRows(
  client: PgClient,
  context: SeedScenarioContext
): Promise<void> {
  await client.query(
    `
      INSERT INTO "organizations" (
        "id", "clerk_id", "name", "slug", "settings", "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $5)
    `,
    [
      context.organizationId,
      `seed-clerk-${context.namespace}`,
      `Seed Scenario Org ${context.namespace}`,
      `seed-scenario-${context.namespace}`,
      context.now,
    ]
  );

  await client.query(
    `
      INSERT INTO "users" (
        "id", "clerk_id", "organization_id", "email", "role", "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, $4, 'ENGINEER', $5, $5)
    `,
    [
      context.userId,
      `seed-user-${context.namespace}`,
      context.organizationId,
      `seed-${context.namespace}@example.test`,
      context.now,
    ]
  );

  await client.query(
    `
      INSERT INTO "projects" (
        "id", "organization_id", "name", "priority", "status", "created_by_id",
        "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, 'MEDIUM', 'IN_PROGRESS', $4, $5, $5)
    `,
    [
      context.projectId,
      context.organizationId,
      `Seed Scenario Project ${context.namespace}`,
      context.userId,
      context.now,
    ]
  );

  await client.query(
    `
      INSERT INTO "github_installations" (
        "id", "organization_id", "installation_id", "account_id", "account_login",
        "account_type", "sender_login", "sender_id", "status", "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, $4, $5, 'Organization', $6, $7, 'ACTIVE', $8, $8)
    `,
    [
      context.installationId,
      context.organizationId,
      `seed-installation-${context.namespace}`,
      `seed-account-${context.namespace}`,
      `seed-org-${context.namespace}`,
      `seed-sender-${context.namespace}`,
      `seed-sender-id-${context.namespace}`,
      context.now,
    ]
  );

  await client.query(
    `
      INSERT INTO "github_installation_repositories" (
        "id", "installation_id", "github_repo_id", "full_name", "name", "owner",
        "private", "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, $4, $5, $6, false, $7, $7)
    `,
    [
      context.repositoryId,
      context.installationId,
      `seed-repo-${context.namespace}`,
      `seed-org-${context.namespace}/seed-repo-${context.namespace}`,
      `seed-repo-${context.namespace}`,
      `seed-org-${context.namespace}`,
      context.now,
    ]
  );
}

async function seedScenarioAtMigrationBoundary(
  spec: ScenarioSpec,
  namespace: string
): Promise<IncidentScenarioResult> {
  const context = makeScenarioContext(namespace);
  let result: IncidentScenarioResult | null = null;

  await runMigrationUpgradeScenario({
    baseMigrationName: migrationAName,
    targetMigrationNames: [],
    databaseNamePrefix: "incident_scenario_boundary",
    seed: async (client) => {
      await seedScenarioBaseRows(client, context);
      result = await spec.seed(client, context);
    },
    assert: () => {
      expect(result).not.toBeNull();
    },
  });

  if (!result) {
    throw new Error("Scenario did not return result references");
  }
  return result;
}

function failureText(failure: ExpectedMigrationFailure): string {
  return `${failure.message}\n${failure.stderr}`;
}

describe("migration-upgrade disposable database guard", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      Reflect.deleteProperty(process.env, "DATABASE_URL");
      return;
    }
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("rejects non-local DATABASE_URL hosts before scenario seed runs", async () => {
    let seeded = false;
    process.env.DATABASE_URL =
      "postgresql://user:password@db.example.test/symphony_test";

    await expect(
      runMigrationUpgradeScenarioExpectingFailure({
        baseMigrationName: migrationAName,
        targetMigrationNames: [migrationBName],
        databaseNamePrefix: "incident_scenario_guard",
        seed: () => {
          seeded = true;
        },
        assertFailure: () => {
          throw new Error(
            "assertFailure should not run for unsafe DATABASE_URL"
          );
        },
      })
    ).rejects.toThrow(localDatabaseHostErrorPattern);

    expect(seeded).toBe(false);
  });

  it("rejects blocked default database names before scenario seed runs", async () => {
    let seeded = false;
    process.env.DATABASE_URL = "postgresql://user:password@localhost/postgres";

    await expect(
      runMigrationUpgradeScenarioExpectingFailure({
        baseMigrationName: migrationAName,
        targetMigrationNames: [migrationBName],
        databaseNamePrefix: "incident_scenario_guard",
        seed: () => {
          seeded = true;
        },
        assertFailure: () => {
          throw new Error("assertFailure should not run for blocked database");
        },
      })
    ).rejects.toThrow(blockedDatabaseErrorPattern);

    expect(seeded).toBe(false);
  });

  it("keeps success and expected-failure capability checks aligned with their runners", () => {
    process.env.DATABASE_URL = "postgresql://user:password@localhost/postgres";

    expect(canRunMigrationUpgradeScenario()).toBe(true);
    expect(canRunMigrationUpgradeScenarioExpectingFailure()).toBe(false);
  });
});

describeWithDisposableExpectedFailureDatabase(
  "branch-artifact incident scenarios at the destructive cutover guard boundary",
  () => {
    it.each(
      scenarioSpecs
    )("raises the destructive cutover guard for $scenarioName", async (spec) => {
      const context = makeScenarioContext(`guard-${spec.scenarioName}`);
      let result: IncidentScenarioResult | null = null;
      let setupDurationMs = Number.POSITIVE_INFINITY;

      await runMigrationUpgradeScenarioExpectingFailure({
        baseMigrationName: migrationAName,
        targetMigrationNames: [migrationBName],
        databaseNamePrefix: "incident_scenario_guard",
        seed: async (client) => {
          await seedScenarioBaseRows(client, context);
          const startedAt = performance.now();
          result = await spec.seed(client, context);
          setupDurationMs = performance.now() - startedAt;
        },
        assertFailure: (failure) => {
          expect(result?.scenarioName).toBe(spec.scenarioName);
          expect(result?.expectedGuardMessage).toBe(spec.expectedGuardMessage);
          expect(setupDurationMs).toBeLessThan(scenarioSetupBudgetMs);
          expect(failureText(failure)).toContain(spec.expectedGuardMessage);
        },
      });
    }, 120_000);

    it("fails closed when an expected-failure scenario unexpectedly succeeds", async () => {
      const context = makeScenarioContext("unexpected-success");

      await expect(
        runMigrationUpgradeScenarioExpectingFailure({
          baseMigrationName: migrationAName,
          targetMigrationNames: [],
          databaseNamePrefix: "incident_scenario_unexpected_success",
          seed: (client) => seedScenarioBaseRows(client, context),
          assertFailure: () => {
            throw new Error("assertFailure should not run after success");
          },
        })
      ).rejects.toThrow("Expected migration deploy to fail, but it succeeded");
    }, 120_000);
  }
);

describeWithDisposableDatabase(
  "branch-artifact incident scenarios at the additive foundation boundary",
  () => {
    it("composes all scenarios over one shared base fixture before Migration B", async () => {
      const baseContext = makeScenarioContext("composable");
      const results: IncidentScenarioResult[] = [];
      const setupDurationsMs: number[] = [];

      await runMigrationUpgradeScenario({
        baseMigrationName: migrationAName,
        targetMigrationNames: [],
        databaseNamePrefix: "incident_scenario_composable",
        seed: async (client) => {
          await seedScenarioBaseRows(client, baseContext);
          for (const spec of scenarioSpecs) {
            const context = withNamespace(
              baseContext,
              `composable-${spec.scenarioName}`
            );
            const startedAt = performance.now();
            results.push(await spec.seed(client, context));
            setupDurationsMs.push(performance.now() - startedAt);
          }
        },
        assert: async (client) => {
          const pullRequests = await client.query<{ count: number }>(
            `
            SELECT count(*)::int AS "count"
            FROM "artifacts"
            WHERE "organization_id" = $1
              AND "type" = 'PULL_REQUEST'
          `,
            [baseContext.organizationId]
          );

          expect(pullRequests.rows[0].count).toBe(5);
        },
      });

      expect(results.map((result) => result.scenarioName).sort()).toEqual(
        scenarioSpecs.map((spec) => spec.scenarioName).sort()
      );
      for (const durationMs of setupDurationsMs) {
        expect(durationMs).toBeLessThan(scenarioSetupBudgetMs);
      }
    }, 120_000);

    it("returns deterministic references for the same namespace across isolated DBs", async () => {
      for (const spec of scenarioSpecs) {
        const namespace = `deterministic-${spec.scenarioName}`;
        const firstResult = await seedScenarioAtMigrationBoundary(
          spec,
          namespace
        );
        const secondResult = await seedScenarioAtMigrationBoundary(
          spec,
          namespace
        );

        expect(resultReferences(secondResult)).toEqual(
          resultReferences(firstResult)
        );
      }
    }, 300_000);
  }
);
