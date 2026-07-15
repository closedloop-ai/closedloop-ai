// biome-ignore-all lint/suspicious/noMisplacedAssertion: The migration-upgrade harness invokes assertions from inside the test scenario.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type MigrationUpgradeContext,
  type PgClient,
  runMigrationUpgradeScenario,
} from "../utils/migration-upgrade-harness";

const hasDatabase = !!process.env.DATABASE_URL;
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const migrationAName = "20260515002500_add_branch_artifact_foundation";
const migrationBName = "20260515021500_branch_artifact_destructive_cutover";
const branchStatusChecksMigrationName =
  "20260528035717_add_branch_status_checks";

function runPostMigrationApiRead(
  databaseUrl: string,
  repositoryId: string,
  pullRequestNumber: number
): { id: string; headSha: string; githubId: string } {
  // pnpm can emit notices to stdout (e.g. the "$" overrides deprecation [WARN]),
  // so the subprocess marks its JSON result with a sentinel that we extract below
  // — otherwise that noise gets prepended to the payload and breaks JSON.parse.
  const resultMarker = "__MIGRATION_API_READ__";
  const script = `
    (async () => {
      const serviceModule = await import("./app/pull-requests/pull-request-service.ts");
      const { pullRequestService } = serviceModule.default ?? serviceModule;
      const [repositoryId, number] = process.argv.slice(-2);
      const artifact = await pullRequestService.findByRepositoryAndNumber(repositoryId, Number(number));
      console.log("${resultMarker}" + JSON.stringify({
        id: artifact?.id ?? null,
        headSha: artifact?.branch?.headSha ?? null,
        githubId: artifact?.branch?.currentPullRequestDetail?.githubId ?? null,
      }));
      process.exit(0);
    })();
  `;
  const output = execFileSync(
    "pnpm",
    [
      "-C",
      path.join(repoRoot, "apps/api"),
      "exec",
      "tsx",
      "-e",
      script,
      repositoryId,
      String(pullRequestNumber),
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const resultLine = output
    .split("\n")
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.startsWith(resultMarker));
  if (!resultLine) {
    throw new Error(
      `Could not find migration API read result in subprocess output:\n${output}`
    );
  }
  return JSON.parse(resultLine.slice(resultMarker.length)) as {
    id: string;
    headSha: string;
    githubId: string;
  };
}

async function seedLegacyPullRequestGraph(client: PgClient, ids: TestIds) {
  await client.query(
    `
      INSERT INTO "organizations" (
        "id", "clerk_id", "name", "slug", "settings", "created_at", "updated_at"
      )
      VALUES ($1, $2, 'Migration Upgrade Org', $3, '{}'::jsonb, now(), now())
    `,
    [
      ids.organizationId,
      `clerk-${ids.suffix}`,
      `migration-upgrade-${ids.suffix}`,
    ]
  );
  await client.query(
    `
      INSERT INTO "users" (
        "id", "clerk_id", "organization_id", "email", "role", "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, $4, 'ENGINEER', now(), now())
    `,
    [
      ids.userId,
      `user-${ids.suffix}`,
      ids.organizationId,
      `migration-${ids.suffix}@example.com`,
    ]
  );
  await client.query(
    `
      INSERT INTO "projects" (
        "id", "organization_id", "name", "priority", "status", "created_by_id",
        "created_at", "updated_at"
      )
      VALUES ($1, $2, 'Migration Upgrade Project', 'MEDIUM', 'IN_PROGRESS', $3, now(), now())
    `,
    [ids.projectId, ids.organizationId, ids.userId]
  );
  await client.query(
    `
      INSERT INTO "github_installations" (
        "id", "organization_id", "installation_id", "account_id", "account_login",
        "account_type", "sender_login", "sender_id", "status", "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, 'account-1', 'acme', 'Organization', 'octocat', 'sender-1', 'ACTIVE', now(), now())
    `,
    [ids.installationId, ids.organizationId, `install-${ids.suffix}`]
  );
  await client.query(
    `
      INSERT INTO "github_installation_repositories" (
        "id", "installation_id", "github_repo_id", "full_name", "name", "owner",
        "private", "created_at", "updated_at"
      )
      VALUES ($1, $2, '987654', 'acme/widgets', 'widgets', 'acme', false, now(), now())
    `,
    [ids.repositoryId, ids.installationId]
  );
  await client.query(
    `
      INSERT INTO "artifacts" (
        "id", "organization_id", "project_id", "type", "subtype", "name", "slug",
        "status", "external_url", "created_at", "updated_at"
      )
      VALUES
        ($1, $2, $3, 'DOCUMENT', 'IMPLEMENTATION_PLAN', 'PLN-587 Source', $4, 'IN_REVIEW', NULL, now(), now()),
        ($5, $2, $3, 'BRANCH', NULL, 'stale branch name', NULL, 'OPEN', 'https://github.com/acme/widgets/tree/stale', now(), now()),
        ($6, $2, $3, 'PULL_REQUEST', NULL, 'Legacy PR artifact title', NULL, 'OPEN', 'https://github.com/acme/widgets/pull/77', now(), now())
    `,
    [
      ids.documentArtifactId,
      ids.organizationId,
      ids.projectId,
      `PLN-587-${ids.suffix}`,
      ids.branchArtifactId,
      ids.pullRequestArtifactId,
    ]
  );
  await client.query(
    `
      INSERT INTO "branch_detail" (
        "artifact_id", "repository_id", "branch_name", "checks_status",
        "file_cache_status", "sync_status", "created_at", "updated_at"
      )
      VALUES ($1, $2, 'feature/upgrade', 'UNKNOWN', 'absent', 'idle', now(), now())
    `,
    [ids.branchArtifactId, ids.repositoryId]
  );
  await client.query(
    `
      INSERT INTO "pull_request_detail" (
        "artifact_id", "repository_id", "github_id", "number", "body",
        "head_branch", "base_branch", "head_sha", "pr_state", "is_draft",
        "checks_status", "review_decision"
      )
      VALUES ($1, $2, 'github-pr-77', 77, 'legacy body', 'feature/upgrade',
        'main', 'legacy-head-sha', 'OPEN', false, 'PASSING', 'APPROVED')
    `,
    [ids.pullRequestArtifactId, ids.repositoryId]
  );
  await client.query(
    `
      INSERT INTO "github_pr_reviews" (
        "id", "pull_request_id", "github_review_id", "author_login", "state",
        "body", "html_url", "submitted_at", "created_at", "updated_at"
      )
      VALUES ($1, $2, 'review-77', 'reviewer', 'APPROVED', 'ship it',
        'https://github.com/acme/widgets/pull/77#review', now(), now(), now())
    `,
    [ids.reviewId, ids.pullRequestArtifactId]
  );
  await client.query(
    `
      INSERT INTO "github_pr_review_comments" (
        "id", "pull_request_id", "github_comment_id", "body", "path", "line",
        "author_login", "state", "html_url", "created_at", "updated_at"
      )
      VALUES ($1, $2, 'comment-77', 'please adjust', 'src/file.ts', 12,
        'reviewer', 'PENDING', 'https://github.com/acme/widgets/pull/77#discussion', now(), now())
    `,
    [ids.commentId, ids.pullRequestArtifactId]
  );
  await client.query(
    `
      INSERT INTO "artifact_links" (
        "id", "organization_id", "source_id", "target_id", "link_type", "created_at"
      )
      VALUES ($1, $2, $3, $4, 'PRODUCES', now())
    `,
    [
      ids.artifactLinkId,
      ids.organizationId,
      ids.documentArtifactId,
      ids.pullRequestArtifactId,
    ]
  );
  await client.query(
    `
      INSERT INTO "artifacts" (
        "id", "organization_id", "project_id", "type", "subtype", "name", "slug",
        "status", "external_url", "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, 'DEPLOYMENT', NULL, 'Preview deployment', NULL,
        'success', 'https://preview.example.test', now(), now())
    `,
    [ids.deploymentArtifactId, ids.organizationId, ids.projectId]
  );
  await client.query(
    `
      INSERT INTO "deployment_detail" (
        "artifact_id", "environment", "ref", "sha", "github_status_url",
        "github_deployment_url", "transient", "production",
        "pull_request_artifact_id", "branch_artifact_id"
      )
      VALUES ($1, 'preview', 'feature/upgrade', 'legacy-head-sha',
        'https://github.com/acme/widgets/deployments/status',
        'https://github.com/acme/widgets/deployments/1', false, false, $2, NULL)
    `,
    [ids.deploymentArtifactId, ids.pullRequestArtifactId]
  );
  await client.query(
    `
      INSERT INTO "loops" (
        "id", "organization_id", "user_id", "artifact_id", "status", "command",
        "repo", "metadata", "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, $4, 'COMPLETED', 'EXECUTE',
        $5::jsonb, '{}'::jsonb, now(), now())
    `,
    [
      ids.loopId,
      ids.organizationId,
      ids.userId,
      ids.pullRequestArtifactId,
      JSON.stringify({ fullName: "acme/widgets", branch: "feature/upgrade" }),
    ]
  );
}

type TestIds = {
  suffix: string;
  organizationId: string;
  userId: string;
  projectId: string;
  installationId: string;
  repositoryId: string;
  documentArtifactId: string;
  branchArtifactId: string;
  pullRequestArtifactId: string;
  deploymentArtifactId: string;
  loopId: string;
  reviewId: string;
  commentId: string;
  artifactLinkId: string;
};

function makeTestIds(): TestIds {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  return {
    suffix,
    organizationId: randomUUID(),
    userId: randomUUID(),
    projectId: randomUUID(),
    installationId: randomUUID(),
    repositoryId: randomUUID(),
    documentArtifactId: randomUUID(),
    branchArtifactId: randomUUID(),
    pullRequestArtifactId: randomUUID(),
    deploymentArtifactId: randomUUID(),
    loopId: randomUUID(),
    reviewId: randomUUID(),
    commentId: randomUUID(),
    artifactLinkId: randomUUID(),
  };
}

describeWithDatabase("PLN-587 Migration B upgrade fixture", () => {
  it("promotes legacy PR data into branch-backed rows and remains readable by the current Prisma schema", async () => {
    const ids = makeTestIds();
    await runMigrationUpgradeScenario({
      baseMigrationName: migrationAName,
      targetMigrationNames: [migrationBName, branchStatusChecksMigrationName],
      databaseNamePrefix: "branch_artifact_upgrade",
      seed: (client) => seedLegacyPullRequestGraph(client, ids),
      assert: (client, context) =>
        assertMigratedBranchGraph(client, context, ids),
    });
  }, 120_000);
});

async function assertMigratedBranchGraph(
  client: PgClient,
  context: MigrationUpgradeContext,
  ids: TestIds
) {
  // PLN-1034: this scenario pins the schema to the Migration-B cutover (its raw
  // asserts read intermediate-only tables like github_pr_review_comments that
  // later migrations drop, so it can't run to HEAD). But runPostMigrationApiRead
  // below loads branch rows through the CURRENT Prisma client, which selects
  // every BranchDetail and PullRequestDetail scalar. Add columns introduced by
  // later migrations so that live read resolves while this fixture still pins
  // its destructive-cutover assertions to the intermediate schema.
  await client.query(
    'ALTER TABLE "branch_detail" ADD COLUMN IF NOT EXISTS "last_activity_at" TIMESTAMP(3)'
  );
  await client.query(`
    ALTER TABLE "branch_detail"
      ADD COLUMN IF NOT EXISTS "check_run_retry_state" VARCHAR(32),
      ADD COLUMN IF NOT EXISTS "check_run_retry_head_sha" TEXT,
      ADD COLUMN IF NOT EXISTS "check_run_retry_resource_id" VARCHAR(255),
      ADD COLUMN IF NOT EXISTS "check_run_retry_idempotency_key" VARCHAR(255),
      ADD COLUMN IF NOT EXISTS "check_run_retry_attempts" INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "check_run_retry_next_at" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "check_run_retry_last_attempt_at" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "check_run_retry_reason" VARCHAR(64)
  `);
  await client.query(`
    ALTER TABLE "branch_detail"
      ADD COLUMN IF NOT EXISTS "fetch_credential_owner_id" UUID,
      ADD COLUMN IF NOT EXISTS "fetch_credential_type" VARCHAR(32),
      ADD COLUMN IF NOT EXISTS "fetch_mechanism" VARCHAR(32),
      ADD COLUMN IF NOT EXISTS "fetch_observed_at" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "fetch_result_reason" VARCHAR(64),
      ADD COLUMN IF NOT EXISTS "fetch_trigger" VARCHAR(32)
  `);
  // PLN-1099 Phase 0 (PRD-510 D2/FR13): the current Prisma client selects the
  // new D2 identity + push-state columns, which are non-null in the live schema.
  // Add them here, then backfill the write-once org copy from the parent artifact
  // and the normalized full name from the installation repo — mirroring the real
  // migration's backfill — so the legacy-seeded branch row reads back cleanly.
  await client.query(`
    ALTER TABLE "branch_detail"
      ADD COLUMN IF NOT EXISTS "organization_id" UUID,
      ADD COLUMN IF NOT EXISTS "repository_full_name" TEXT,
      ADD COLUMN IF NOT EXISTS "first_pushed_at" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "push_source" TEXT
  `);
  await client.query(`
    UPDATE "branch_detail" bd
      SET "organization_id" = a."organization_id"
      FROM "artifacts" a
      WHERE a."id" = bd."artifact_id" AND bd."organization_id" IS NULL
  `);
  await client.query(`
    UPDATE "branch_detail" bd
      SET "repository_full_name" = lower(gir."full_name")
      FROM "github_installation_repositories" gir
      WHERE gir."id" = bd."repository_id" AND bd."repository_full_name" IS NULL
  `);
  await client.query(`
    ALTER TABLE "pull_request_detail"
      ADD COLUMN IF NOT EXISTS "additions" INTEGER,
      ADD COLUMN IF NOT EXISTS "deletions" INTEGER,
      ADD COLUMN IF NOT EXISTS "changed_files" INTEGER,
      ADD COLUMN IF NOT EXISTS "fetch_credential_owner_id" UUID,
      ADD COLUMN IF NOT EXISTS "fetch_credential_type" VARCHAR(32),
      ADD COLUMN IF NOT EXISTS "fetch_mechanism" VARCHAR(32),
      ADD COLUMN IF NOT EXISTS "fetch_observed_at" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "fetch_result_reason" VARCHAR(64),
      ADD COLUMN IF NOT EXISTS "fetch_trigger" VARCHAR(32)
  `);
  // FEA-2732 (PRD-510 D2): the current Prisma client selects the new
  // PullRequestDetail D2 identity columns. Add them and backfill the write-once
  // org copy from the parent branch artifact (mirroring the real migration) so
  // the legacy-seeded PR row reads back cleanly under the pinned fixture.
  await client.query(`
    ALTER TABLE "pull_request_detail"
      ADD COLUMN IF NOT EXISTS "organization_id" UUID,
      ADD COLUMN IF NOT EXISTS "repository_full_name" TEXT
  `);
  await client.query(`
    UPDATE "pull_request_detail" prd
      SET "organization_id" = a."organization_id"
      FROM "artifacts" a
      WHERE a."id" = prd."branch_artifact_id" AND prd."organization_id" IS NULL
  `);

  const branch = await client.query(
    `
      SELECT
        bd."artifact_id",
        bd."branch_name",
        bd."base_branch",
        bd."base_branch_source",
        bd."head_sha",
        bd."head_sha_source",
        bd."checks_status",
        bd."current_pull_request_detail_id",
        a."type",
        a."name",
        a."external_url",
        a."status"
      FROM "branch_detail" bd
      JOIN "artifacts" a ON a."id" = bd."artifact_id"
      WHERE bd."artifact_id" = $1
    `,
    [ids.branchArtifactId]
  );
  expect(branch.rows).toEqual([
    expect.objectContaining({
      artifact_id: ids.branchArtifactId,
      branch_name: "feature/upgrade",
      base_branch: "main",
      base_branch_source: "migration_pr_base",
      head_sha: "legacy-head-sha",
      head_sha_source: "migration_pr_head",
      checks_status: "PASSING",
      type: "BRANCH",
      name: "feature/upgrade",
      external_url: "https://github.com/acme/widgets/tree/feature%2Fupgrade",
      status: "OPEN",
    }),
  ]);

  const detail = await client.query(
    `
      SELECT "id", "artifact_id", "branch_artifact_id", "title",
        "html_url", "pr_state", "review_decision", "is_current"
      FROM "pull_request_detail"
      WHERE "github_id" = 'github-pr-77'
    `
  );
  expect(detail.rows).toEqual([
    expect.objectContaining({
      artifact_id: null,
      branch_artifact_id: ids.branchArtifactId,
      title: "Legacy PR artifact title",
      html_url: "https://github.com/acme/widgets/pull/77",
      pr_state: "OPEN",
      review_decision: "APPROVED",
      is_current: true,
    }),
  ]);
  const detailId = detail.rows[0].id;
  expect(branch.rows[0].current_pull_request_detail_id).toBe(detailId);

  const droppedColumns = await client.query(
    `
      SELECT "column_name"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'pull_request_detail'
        AND column_name = ANY($1)
    `,
    [["head_branch", "base_branch", "head_sha", "checks_status"]]
  );
  expect(droppedColumns.rows).toEqual([]);

  const review = await client.query(
    'SELECT "pull_request_id" FROM "github_pr_reviews" WHERE "id" = $1',
    [ids.reviewId]
  );
  const comment = await client.query(
    'SELECT "pull_request_id" FROM "github_pr_review_comments" WHERE "id" = $1',
    [ids.commentId]
  );
  expect(review.rows[0].pull_request_id).toBe(detailId);
  expect(comment.rows[0].pull_request_id).toBe(detailId);

  const link = await client.query(
    'SELECT "source_id", "target_id" FROM "artifact_links" WHERE "id" = $1',
    [ids.artifactLinkId]
  );
  expect(link.rows).toEqual([
    {
      source_id: ids.documentArtifactId,
      target_id: ids.branchArtifactId,
    },
  ]);

  const deployment = await client.query(
    `
      SELECT "artifact_id", "branch_artifact_id"
      FROM "deployment_detail"
      WHERE "artifact_id" = $1
    `,
    [ids.deploymentArtifactId]
  );
  expect(deployment.rows).toEqual([
    {
      artifact_id: ids.deploymentArtifactId,
      branch_artifact_id: ids.branchArtifactId,
    },
  ]);
  const droppedDeploymentColumn = await client.query(
    `
      SELECT "column_name"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'deployment_detail'
        AND column_name = 'pull_request_artifact_id'
    `
  );
  expect(droppedDeploymentColumn.rows).toEqual([]);

  const loop = await client.query(
    'SELECT "artifact_id" FROM "loops" WHERE "id" = $1',
    [ids.loopId]
  );
  expect(loop.rows).toEqual([{ artifact_id: ids.branchArtifactId }]);

  const legacyArtifact = await client.query(
    'SELECT 1 FROM "artifacts" WHERE "id" = $1',
    [ids.pullRequestArtifactId]
  );
  expect(legacyArtifact.rowCount).toBe(0);

  expect(
    runPostMigrationApiRead(context.databaseUrl, ids.repositoryId, 77)
  ).toEqual({
    id: ids.branchArtifactId,
    headSha: "legacy-head-sha",
    githubId: "github-pr-77",
  });
}
