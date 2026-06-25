// biome-ignore-all lint/suspicious/noMisplacedAssertion: The migration-upgrade harness invokes assertions from inside the test scenario.
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  type MigrationUpgradeContext,
  type PgClient,
  runMigrationUpgradeScenario,
} from "../utils/migration-upgrade-harness";

const require = createRequire(import.meta.url);
const pg = require("pg") as {
  Client: new (config: { connectionString: string }) => PgClient;
};

const hasDatabase = !!process.env.DATABASE_URL;
const describeWithDatabase = hasDatabase ? describe : describe.skip;
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const migrationsDir = path.join(
  repoRoot,
  "packages/database/prisma/migrations"
);
const baseMigrationName = "20260518163305_drop_legacy_target_repo_branch";
const pullRequestDetailDropIndexMigrationName =
  "20260519132500_drop_pull_request_detail_id_key";
const targetMigrationNamePattern = /comment_table_split_1_shared_contracts$/;
const safeSqlIdentifierPattern = /^[a-z_]+$/;

describeWithDatabase("comment table convergence migration upgrade", () => {
  it("keeps legacy comments, preserves document rows, and enforces scoped projection uniqueness", async () => {
    const ids = makeTestIds();

    await runMigrationUpgradeScenario({
      baseMigrationName,
      targetMigrationNames: [
        pullRequestDetailDropIndexMigrationName,
        findTargetMigrationName(),
      ],
      databaseNamePrefix: "comment_convergence",
      seed: (client) => seedLegacyGraph(client, ids),
      assert: (client, context) => assertUpgrade(client, ids, context),
    });
  }, 120_000);
});

async function seedLegacyGraph(client: PgClient, ids: TestIds): Promise<void> {
  await client.query(
    `
      INSERT INTO "organizations" (
        "id", "clerk_id", "name", "slug", "settings", "created_at", "updated_at"
      )
      VALUES ($1, $2, 'Comment Convergence Org', $3, '{}'::jsonb, now(), now())
    `,
    [ids.organizationId, `clerk-${ids.suffix}`, `org-${ids.suffix}`]
  );
  await client.query(
    `
      INSERT INTO "organizations" (
        "id", "clerk_id", "name", "slug", "settings", "created_at", "updated_at"
      )
      VALUES ($1, $2, 'Other Comment Org', $3, '{}'::jsonb, now(), now())
    `,
    [
      ids.otherOrganizationId,
      `clerk-other-${ids.suffix}`,
      `org-other-${ids.suffix}`,
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
      `comment-${ids.suffix}@example.com`,
    ]
  );
  await client.query(
    `
      INSERT INTO "projects" (
        "id", "organization_id", "name", "priority", "status", "created_by_id",
        "created_at", "updated_at"
      )
      VALUES ($1, $2, 'Comment Convergence Project', 'MEDIUM', 'IN_PROGRESS', $3, now(), now())
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
        ($1, $2, $3, 'DOCUMENT', 'FEATURE', 'Comment Feature', $4, 'IN_PROGRESS', NULL, now(), now()),
        ($5, $2, $3, 'BRANCH', NULL, 'feature/comment-convergence', NULL, 'OPEN',
          'https://github.com/acme/widgets/tree/feature/comment-convergence', now(), now()),
        ($6, $2, $3, 'BRANCH', NULL, 'feature/comment-convergence-other', NULL, 'OPEN',
          'https://github.com/acme/widgets/tree/feature/comment-convergence-other', now(), now())
    `,
    [
      ids.documentArtifactId,
      ids.organizationId,
      ids.projectId,
      `FEA-${ids.suffix}`,
      ids.branchArtifactId,
      ids.otherBranchArtifactId,
    ]
  );
  await client.query(
    `
      INSERT INTO "branch_detail" (
        "artifact_id", "repository_id", "branch_name", "base_branch",
        "current_pull_request_detail_id", "checks_status", "file_cache_status",
        "sync_status", "created_at", "updated_at"
      )
      VALUES
        ($1, $2, 'feature/comment-convergence', 'main', NULL, 'UNKNOWN', 'absent', 'idle', now(), now()),
        ($3, $2, 'feature/comment-convergence-other', 'main', NULL, 'UNKNOWN', 'absent', 'idle', now(), now())
    `,
    [ids.branchArtifactId, ids.repositoryId, ids.otherBranchArtifactId]
  );
  await client.query(
    `
      INSERT INTO "pull_request_detail" (
        "id", "branch_artifact_id", "repository_id", "github_id", "number",
        "title", "html_url", "pr_state", "is_draft", "is_current"
      )
      VALUES
        ($1, $2, $3, 'github-pr-current', 77, 'Current PR',
          'https://github.com/acme/widgets/pull/77', 'OPEN', false, true),
        ($4, $2, $3, 'github-pr-historical', 78, 'Historical PR',
          'https://github.com/acme/widgets/pull/78', 'CLOSED', false, false),
        ($5, $6, $3, 'github-pr-other-branch', 79, 'Other Branch PR',
          'https://github.com/acme/widgets/pull/79', 'OPEN', false, true)
    `,
    [
      ids.currentPrDetailId,
      ids.branchArtifactId,
      ids.repositoryId,
      ids.historicalPrDetailId,
      ids.otherPrDetailId,
      ids.otherBranchArtifactId,
    ]
  );
  await client.query(
    `
      UPDATE "branch_detail"
      SET "current_pull_request_detail_id" = $1
      WHERE "artifact_id" = $2
    `,
    [ids.currentPrDetailId, ids.branchArtifactId]
  );
  await client.query(
    `
      INSERT INTO "github_pr_review_comments" (
        "id", "pull_request_id", "github_comment_id", "body", "path", "line",
        "author_login", "state", "html_url", "created_at", "updated_at"
      )
      VALUES
        ($1, $4, 'legacy-pending', 'pending', 'src/a.ts', 10, 'reviewer', 'PENDING',
          'https://github.com/acme/widgets/pull/77#discussion-1', now(), now()),
        ($2, $4, 'legacy-addressed', 'addressed', 'src/b.ts', 20, 'reviewer', 'ADDRESSED',
          'https://github.com/acme/widgets/pull/77#discussion-2', now(), now()),
        ($3, $4, 'legacy-dismissed', 'dismissed', 'src/c.ts', 30, 'reviewer', 'DISMISSED',
          'https://github.com/acme/widgets/pull/77#discussion-3', now(), now())
    `,
    [
      ids.legacyPendingCommentId,
      ids.legacyAddressedCommentId,
      ids.legacyDismissedCommentId,
      ids.currentPrDetailId,
    ]
  );
  await client.query(
    `
      INSERT INTO "comment_threads" (
        "id", "organization_id", "source", "external_id", "artifact_id",
        "status", "created_at", "updated_at"
      )
      VALUES ($1, $2, 'LIVEBLOCKS', 'liveblocks-thread-1', $3, 'OPEN', now(), now())
    `,
    [ids.documentThreadId, ids.organizationId, ids.documentArtifactId]
  );
  await client.query(
    `
      INSERT INTO "comments" (
        "id", "thread_id", "author_id", "body", "plain_text", "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, '{}'::jsonb, 'existing document comment', now(), now())
    `,
    [ids.documentCommentId, ids.documentThreadId, ids.userId]
  );
}

async function assertUpgrade(
  client: PgClient,
  ids: TestIds,
  context: MigrationUpgradeContext
): Promise<void> {
  const legacy = await client.query(
    `
      SELECT "github_comment_id", "state"
      FROM "github_pr_review_comments"
      WHERE "pull_request_id" = $1
      ORDER BY "github_comment_id"
    `,
    [ids.currentPrDetailId]
  );
  expect(legacy.rows).toEqual([
    { github_comment_id: "legacy-addressed", state: "ADDRESSED" },
    { github_comment_id: "legacy-dismissed", state: "DISMISSED" },
    { github_comment_id: "legacy-pending", state: "PENDING" },
  ]);

  const existingDocumentRows = await client.query(
    `
      SELECT gctp."pull_request_detail_id", gctp."resolvable",
        gcp."github_comment_id"
      FROM "comment_threads" ct
      JOIN "comments" c ON c."thread_id" = ct."id"
      LEFT JOIN "github_comment_thread_projections" gctp ON gctp."thread_id" = ct."id"
      LEFT JOIN "github_comment_projections" gcp ON gcp."comment_id" = c."id"
      WHERE ct."id" = $1
    `,
    [ids.documentThreadId]
  );
  expect(existingDocumentRows.rows).toEqual([
    {
      pull_request_detail_id: null,
      resolvable: null,
      github_comment_id: null,
    },
  ]);

  await insertProjectionThread(client, {
    id: ids.projectedThreadId,
    organizationId: ids.organizationId,
    artifactId: ids.branchArtifactId,
    pullRequestDetailId: ids.currentPrDetailId,
    rootCommentId: "remote-root-1",
    reviewThreadId: "remote-review-thread-1",
  });
  await insertProjectionThread(client, {
    id: ids.projectedHistoricalThreadId,
    organizationId: ids.organizationId,
    artifactId: ids.branchArtifactId,
    pullRequestDetailId: ids.historicalPrDetailId,
    rootCommentId: "remote-root-1",
    reviewThreadId: "remote-review-thread-1",
  });
  await insertProjectionThread(client, {
    id: ids.otherProjectedThreadId,
    organizationId: ids.organizationId,
    artifactId: ids.otherBranchArtifactId,
    pullRequestDetailId: ids.otherPrDetailId,
    rootCommentId: "remote-root-1",
    reviewThreadId: "remote-review-thread-1",
  });

  await expect(
    insertProjectionThread(client, {
      id: randomUUID(),
      organizationId: ids.organizationId,
      artifactId: ids.branchArtifactId,
      pullRequestDetailId: ids.currentPrDetailId,
      rootCommentId: "remote-root-1",
      reviewThreadId: "remote-review-thread-2",
    })
  ).rejects.toThrow();
  await expect(
    insertProjectionThread(client, {
      id: randomUUID(),
      organizationId: ids.organizationId,
      artifactId: ids.branchArtifactId,
      pullRequestDetailId: ids.currentPrDetailId,
      rootCommentId: "remote-root-2",
      reviewThreadId: "remote-review-thread-1",
    })
  ).rejects.toThrow();
  await expect(
    insertProjectionThread(client, {
      id: randomUUID(),
      organizationId: ids.organizationId,
      artifactId: ids.documentArtifactId,
      pullRequestDetailId: ids.currentPrDetailId,
      rootCommentId: "remote-root-wrong-artifact",
      reviewThreadId: "remote-review-thread-wrong-artifact",
    })
  ).rejects.toThrow();
  await expect(
    insertProjectionThread(client, {
      id: randomUUID(),
      organizationId: ids.organizationId,
      artifactId: ids.branchArtifactId,
      pullRequestDetailId: ids.otherPrDetailId,
      rootCommentId: "remote-root-cross-branch",
      reviewThreadId: "remote-review-thread-cross-branch",
    })
  ).rejects.toThrow();
  await expect(
    insertProjectionThread(client, {
      id: randomUUID(),
      organizationId: ids.otherOrganizationId,
      artifactId: ids.branchArtifactId,
      pullRequestDetailId: ids.currentPrDetailId,
      rootCommentId: "remote-root-cross-org",
      reviewThreadId: "remote-review-thread-cross-org",
    })
  ).rejects.toThrow();
  await expect(
    client.query(
      `
        UPDATE "comment_threads"
        SET "source" = 'NATIVE'
        WHERE "id" = $1
      `,
      [ids.projectedThreadId]
    )
  ).rejects.toThrow();
  await expect(
    client.query(
      `
        UPDATE "comment_threads"
        SET "organization_id" = $1
        WHERE "id" = $2
      `,
      [ids.otherOrganizationId, ids.projectedThreadId]
    )
  ).rejects.toThrow();
  await expect(
    client.query(
      `
        UPDATE "artifacts"
        SET "type" = 'DOCUMENT'
        WHERE "id" = $1
      `,
      [ids.branchArtifactId]
    )
  ).rejects.toThrow();
  await expect(
    client.query(
      `
        UPDATE "artifacts"
        SET "organization_id" = $1
        WHERE "id" = $2
      `,
      [ids.otherOrganizationId, ids.branchArtifactId]
    )
  ).rejects.toThrow();
  await insertBranchWithPullRequest(client, {
    artifactId: ids.softDeletedOnlyBranchArtifactId,
    pullRequestDetailId: ids.softDeletedOnlyPrDetailId,
    organizationId: ids.organizationId,
    projectId: ids.projectId,
    repositoryId: ids.repositoryId,
    branchName: `feature/soft-deleted-${ids.suffix}`,
    pullRequestNumber: 177,
  });
  await insertProjectionThread(client, {
    id: ids.softDeletedOnlyProjectionThreadId,
    organizationId: ids.organizationId,
    artifactId: ids.softDeletedOnlyBranchArtifactId,
    pullRequestDetailId: ids.softDeletedOnlyPrDetailId,
    rootCommentId: "remote-root-soft-deleted-only",
    reviewThreadId: "remote-review-thread-soft-deleted-only",
  });
  await client.query(
    `
      UPDATE "github_comment_thread_projections"
      SET "deleted_at" = now()
      WHERE "thread_id" = $1
    `,
    [ids.softDeletedOnlyProjectionThreadId]
  );
  await client.query(
    `
      UPDATE "comment_threads"
      SET "source" = 'NATIVE',
        "organization_id" = $1
      WHERE "id" = $2
    `,
    [ids.otherOrganizationId, ids.softDeletedOnlyProjectionThreadId]
  );
  await client.query(
    `
      UPDATE "artifacts"
      SET "type" = 'DOCUMENT',
        "organization_id" = $1
      WHERE "id" = $2
    `,
    [ids.otherOrganizationId, ids.softDeletedOnlyBranchArtifactId]
  );
  await insertProjectionThread(client, {
    id: ids.deletedProjectionThreadId,
    organizationId: ids.organizationId,
    artifactId: ids.branchArtifactId,
    pullRequestDetailId: ids.currentPrDetailId,
    rootCommentId: "remote-root-reusable",
    reviewThreadId: "remote-review-thread-reusable",
  });
  await client.query(
    `
      UPDATE "github_comment_thread_projections"
      SET "deleted_at" = now()
      WHERE "thread_id" = $1
    `,
    [ids.deletedProjectionThreadId]
  );
  await insertProjectionThread(client, {
    id: ids.reusedDeletedProjectionThreadId,
    organizationId: ids.organizationId,
    artifactId: ids.branchArtifactId,
    pullRequestDetailId: ids.currentPrDetailId,
    rootCommentId: "remote-root-reusable",
    reviewThreadId: "remote-review-thread-reusable",
  });

  await expect(
    client.query(
      `
        INSERT INTO "comments" (
          "id", "thread_id", "author_id", "body", "plain_text",
          "parent_comment_id", "created_at", "updated_at"
        )
        VALUES ($1, $2, $3, '{}'::jsonb, 'cross-thread reply',
          $4, now(), now())
      `,
      [randomUUID(), ids.projectedThreadId, ids.userId, ids.documentCommentId]
    )
  ).rejects.toThrow();

  await client.query(
    `
      INSERT INTO "comments" (
        "id", "thread_id", "author_id", "body", "plain_text", "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, '{}'::jsonb, 'parent with reply', now(), now())
    `,
    [ids.parentWithReplyCommentId, ids.projectedThreadId, ids.userId]
  );
  await client.query(
    `
      INSERT INTO "comments" (
        "id", "thread_id", "author_id", "body", "plain_text",
        "parent_comment_id", "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, '{}'::jsonb, 'same-thread reply',
        $4, now(), now())
    `,
    [
      ids.sameThreadReplyCommentId,
      ids.projectedThreadId,
      ids.userId,
      ids.parentWithReplyCommentId,
    ]
  );
  await expect(
    client.query(
      `
        UPDATE "comments"
        SET "thread_id" = $1
        WHERE "id" = $2
      `,
      [ids.documentThreadId, ids.parentWithReplyCommentId]
    )
  ).rejects.toThrow();
  await expect(
    client.query(
      `
        UPDATE "comments"
        SET "parent_comment_id" = $1
        WHERE "id" = $2
      `,
      [ids.documentCommentId, ids.sameThreadReplyCommentId]
    )
  ).rejects.toThrow();
  await assertConcurrentParentMoveIsBlocked(client, context, ids);

  await client.query(
    `
      INSERT INTO "comments" (
        "id", "thread_id", "author_id", "body", "plain_text", "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, '{}'::jsonb, 'projected comment', now(), now())
    `,
    [ids.projectedCommentId, ids.projectedThreadId, ids.userId]
  );
  await insertProjectionComment(client, {
    id: ids.projectedCommentId,
    threadId: ids.projectedThreadId,
    githubCommentId: "remote-comment-1",
  });
  await expect(
    insertProjectionComment(client, {
      id: ids.documentCommentId,
      threadId: ids.projectedThreadId,
      githubCommentId: "remote-comment-wrong-thread",
    })
  ).rejects.toThrow();
  await expect(
    insertDuplicateProjectionComment(client, {
      id: randomUUID(),
      threadId: ids.projectedThreadId,
      userId: ids.userId,
      githubCommentId: "remote-comment-1",
    })
  ).rejects.toThrow();
  await expect(
    insertProjectionComment(client, {
      id: ids.documentCommentId,
      threadId: ids.documentThreadId,
      githubCommentId: "remote-comment-no-thread-projection",
    })
  ).rejects.toThrow();

  await insertComment(client, {
    id: ids.deletedProjectedCommentId,
    threadId: ids.projectedThreadId,
    userId: ids.userId,
    plainText: "deleted projected comment",
  });
  await insertProjectionComment(client, {
    id: ids.deletedProjectedCommentId,
    threadId: ids.projectedThreadId,
    githubCommentId: "remote-comment-reusable",
  });
  await client.query(
    `
      UPDATE "github_comment_projections"
      SET "github_deleted_at" = now()
      WHERE "comment_id" = $1
    `,
    [ids.deletedProjectedCommentId]
  );
  await insertComment(client, {
    id: ids.reusedDeletedProjectedCommentId,
    threadId: ids.projectedThreadId,
    userId: ids.userId,
    plainText: "reused deleted projected comment",
  });
  await insertProjectionComment(client, {
    id: ids.reusedDeletedProjectedCommentId,
    threadId: ids.projectedThreadId,
    githubCommentId: "remote-comment-reusable",
  });

  await insertProjectionThread(client, {
    id: ids.cascadeThreadId,
    organizationId: ids.organizationId,
    artifactId: ids.branchArtifactId,
    pullRequestDetailId: ids.currentPrDetailId,
    rootCommentId: "remote-root-cascade",
    reviewThreadId: "remote-review-thread-cascade",
  });
  await insertComment(client, {
    id: ids.cascadeCommentId,
    threadId: ids.cascadeThreadId,
    userId: ids.userId,
    plainText: "cascading projected comment",
  });
  await insertProjectionComment(client, {
    id: ids.cascadeCommentId,
    threadId: ids.cascadeThreadId,
    githubCommentId: "remote-comment-cascade",
  });
  await client.query(
    `
      DELETE FROM "comment_threads"
      WHERE "id" = $1
    `,
    [ids.cascadeThreadId]
  );
  expect(
    await countRows(
      client,
      "github_comment_thread_projections",
      "thread_id",
      ids.cascadeThreadId
    )
  ).toBe(0);
  expect(
    await countRows(
      client,
      "github_comment_projections",
      "comment_id",
      ids.cascadeCommentId
    )
  ).toBe(0);

  await insertComment(client, {
    id: ids.projectedHistoricalCommentId,
    threadId: ids.projectedHistoricalThreadId,
    userId: ids.userId,
    plainText: "historical projected comment",
  });
  await insertProjectionComment(client, {
    id: ids.projectedHistoricalCommentId,
    threadId: ids.projectedHistoricalThreadId,
    githubCommentId: "remote-comment-historical",
  });
  await client.query(
    `
      DELETE FROM "pull_request_detail"
      WHERE "id" = $1
    `,
    [ids.historicalPrDetailId]
  );
  expect(
    await countRows(
      client,
      "github_comment_thread_projections",
      "thread_id",
      ids.projectedHistoricalThreadId
    )
  ).toBe(0);
  expect(
    await countRows(
      client,
      "github_comment_projections",
      "comment_id",
      ids.projectedHistoricalCommentId
    )
  ).toBe(0);
  expect(
    await countRows(
      client,
      "comment_threads",
      "id",
      ids.projectedHistoricalThreadId
    )
  ).toBe(0);
  expect(
    await countRows(client, "comments", "id", ids.projectedHistoricalCommentId)
  ).toBe(0);
  expect(
    await countRows(
      client,
      "github_comment_thread_projections",
      "thread_id",
      ids.projectedThreadId
    )
  ).toBe(1);
  expect(
    await countRows(
      client,
      "github_comment_projections",
      "comment_id",
      ids.projectedCommentId
    )
  ).toBe(1);
  expect(
    await countRows(client, "comment_threads", "id", ids.projectedThreadId)
  ).toBe(1);
  expect(
    await countRows(client, "comments", "id", ids.projectedCommentId)
  ).toBe(1);
  expect(await countRows(client, "artifacts", "id", ids.branchArtifactId)).toBe(
    1
  );

  await insertComment(client, {
    id: ids.otherProjectedCommentId,
    threadId: ids.otherProjectedThreadId,
    userId: ids.userId,
    plainText: "other branch projected comment",
  });
  await insertProjectionComment(client, {
    id: ids.otherProjectedCommentId,
    threadId: ids.otherProjectedThreadId,
    githubCommentId: "remote-comment-other-branch",
  });
  await client.query(
    `
      DELETE FROM "artifacts"
      WHERE "id" = $1
    `,
    [ids.otherBranchArtifactId]
  );
  expect(
    await countRows(
      client,
      "github_comment_thread_projections",
      "thread_id",
      ids.otherProjectedThreadId
    )
  ).toBe(0);
  expect(
    await countRows(
      client,
      "github_comment_projections",
      "comment_id",
      ids.otherProjectedCommentId
    )
  ).toBe(0);

  const documentComments = await client.query(
    `
      SELECT "plain_text"
      FROM "comments"
      WHERE "thread_id" = $1
    `,
    [ids.documentThreadId]
  );
  expect(documentComments.rows).toEqual([
    { plain_text: "existing document comment" },
  ]);
}

async function assertConcurrentParentMoveIsBlocked(
  inspectorClient: PgClient,
  context: MigrationUpgradeContext,
  ids: TestIds
): Promise<void> {
  await insertComment(inspectorClient, {
    id: ids.concurrentParentCommentId,
    threadId: ids.projectedThreadId,
    userId: ids.userId,
    plainText: "concurrency parent",
  });

  const lockingClient = new pg.Client({
    connectionString: context.databaseUrl,
  });
  const movingClient = new pg.Client({
    connectionString: context.databaseUrl,
  });
  let lockingTransactionOpen = false;
  let lockingCommitted = false;
  let updatePromise: Promise<QueryOutcome> | undefined;

  await lockingClient.connect();
  await movingClient.connect();

  try {
    await lockingClient.query("BEGIN");
    lockingTransactionOpen = true;
    await movingClient.query("BEGIN");
    await movingClient.query("SET LOCAL lock_timeout = '5s'");
    const movingPidResult = await movingClient.query(
      "SELECT pg_backend_pid()::int AS pid"
    );
    const movingPid = movingPidResult.rows[0].pid as number;

    await lockingClient.query(
      `
        INSERT INTO "comments" (
          "id", "thread_id", "author_id", "body", "plain_text",
          "parent_comment_id", "created_at", "updated_at"
        )
        VALUES ($1, $2, $3, '{}'::jsonb, 'concurrency reply',
          $4, now(), now())
      `,
      [
        ids.concurrentReplyCommentId,
        ids.projectedThreadId,
        ids.userId,
        ids.concurrentParentCommentId,
      ]
    );

    updatePromise = movingClient
      .query(
        `
          UPDATE "comments"
          SET "thread_id" = $1
          WHERE "id" = $2
        `,
        [ids.documentThreadId, ids.concurrentParentCommentId]
      )
      .then(() => ({ ok: true }) as const)
      .catch((error: unknown) => ({ ok: false, error }) as const);

    await waitForBlockedParentMove(inspectorClient, movingPid, () =>
      Boolean(updatePromise)
    );
    await lockingClient.query("COMMIT");
    lockingCommitted = true;
    lockingTransactionOpen = false;

    const updateResult = await updatePromise;
    expect(updateResult.ok).toBe(false);
    if (!updateResult.ok) {
      expect(String(updateResult.error)).toContain(
        "comments with replies cannot move to a different thread"
      );
    }
  } finally {
    if (lockingTransactionOpen && !lockingCommitted) {
      await lockingClient.query("ROLLBACK").catch(() => undefined);
    }
    if (updatePromise) {
      await updatePromise.catch(() => undefined);
    }
    await movingClient.query("ROLLBACK").catch(() => undefined);
    await lockingClient.end();
    await movingClient.end();
  }
}

async function waitForBlockedParentMove(
  inspectorClient: PgClient,
  movingPid: number,
  updateStarted: () => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const activity = await inspectorClient.query(
      `
        SELECT "wait_event_type"
        FROM "pg_stat_activity"
        WHERE "pid" = $1
      `,
      [movingPid]
    );
    if (activity.rows[0]?.wait_event_type === "Lock") {
      return;
    }
    await delay(updateStarted() ? 50 : 100);
  }

  throw new Error("parent comment thread move did not wait on reply insert");
}

async function insertProjectionThread(
  client: PgClient,
  input: {
    id: string;
    organizationId: string;
    artifactId: string;
    pullRequestDetailId: string;
    rootCommentId: string;
    reviewThreadId: string;
  }
): Promise<void> {
  await client.query(
    `
      INSERT INTO "comment_threads" (
        "id", "organization_id", "source", "artifact_id", "status",
        "created_at", "updated_at"
      )
      VALUES ($1, $2, 'GITHUB', $3, 'OPEN', now(), now())
    `,
    [input.id, input.organizationId, input.artifactId]
  );
  await client.query(
    `
      INSERT INTO "github_comment_thread_projections" (
        "thread_id", "branch_artifact_id", "pull_request_detail_id", "thread_kind",
        "root_comment_id", "review_thread_id", "resolvable"
      )
      VALUES ($1, $2, $3, 'REVIEW_THREAD', $4, $5, true)
    `,
    [
      input.id,
      input.artifactId,
      input.pullRequestDetailId,
      input.rootCommentId,
      input.reviewThreadId,
    ]
  );
}

async function insertBranchWithPullRequest(
  client: PgClient,
  input: {
    artifactId: string;
    pullRequestDetailId: string;
    organizationId: string;
    projectId: string;
    repositoryId: string;
    branchName: string;
    pullRequestNumber: number;
  }
): Promise<void> {
  await client.query(
    `
      INSERT INTO "artifacts" (
        "id", "organization_id", "project_id", "type", "subtype", "name",
        "status", "external_url", "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, 'BRANCH', NULL, $4, 'OPEN', $5, now(), now())
    `,
    [
      input.artifactId,
      input.organizationId,
      input.projectId,
      input.branchName,
      `https://github.com/acme/widgets/tree/${input.branchName}`,
    ]
  );
  await client.query(
    `
      INSERT INTO "branch_detail" (
        "artifact_id", "repository_id", "branch_name", "base_branch",
        "current_pull_request_detail_id", "checks_status", "file_cache_status",
        "sync_status", "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, 'main', NULL, 'UNKNOWN', 'absent', 'idle', now(), now())
    `,
    [input.artifactId, input.repositoryId, input.branchName]
  );
  await client.query(
    `
      INSERT INTO "pull_request_detail" (
        "id", "branch_artifact_id", "repository_id", "github_id", "number",
        "title", "html_url", "pr_state", "is_draft", "is_current"
      )
      VALUES ($1, $2, $3, $4, $5, 'Soft Deleted Projection PR',
        $6, 'OPEN', false, true)
    `,
    [
      input.pullRequestDetailId,
      input.artifactId,
      input.repositoryId,
      `github-pr-${input.pullRequestNumber}`,
      input.pullRequestNumber,
      `https://github.com/acme/widgets/pull/${input.pullRequestNumber}`,
    ]
  );
}

async function insertProjectionComment(
  client: PgClient,
  input: {
    id: string;
    threadId: string;
    githubCommentId: string;
  }
): Promise<void> {
  await client.query(
    `
      INSERT INTO "github_comment_projections" (
        "comment_id", "thread_id", "github_comment_id"
      )
      VALUES ($1, $2, $3)
    `,
    [input.id, input.threadId, input.githubCommentId]
  );
}

async function insertComment(
  client: PgClient,
  input: {
    id: string;
    threadId: string;
    userId: string;
    plainText: string;
  }
): Promise<void> {
  await client.query(
    `
      INSERT INTO "comments" (
        "id", "thread_id", "author_id", "body", "plain_text", "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, '{}'::jsonb, $4, now(), now())
    `,
    [input.id, input.threadId, input.userId, input.plainText]
  );
}

async function insertDuplicateProjectionComment(
  client: PgClient,
  input: {
    id: string;
    threadId: string;
    userId: string;
    githubCommentId: string;
  }
): Promise<void> {
  await client.query(
    `
      INSERT INTO "comments" (
        "id", "thread_id", "author_id", "body", "plain_text", "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, '{}'::jsonb, 'duplicate projected comment', now(), now())
    `,
    [input.id, input.threadId, input.userId]
  );
  await insertProjectionComment(client, input);
}

async function countRows(
  client: PgClient,
  tableName: string,
  columnName: string,
  id: string
): Promise<number> {
  if (
    !(
      safeSqlIdentifierPattern.test(tableName) &&
      safeSqlIdentifierPattern.test(columnName)
    )
  ) {
    throw new Error("Unsafe test table or column name");
  }

  const result = await client.query(
    `
      SELECT COUNT(*)::int AS "count"
      FROM "${tableName}"
      WHERE "${columnName}" = $1
    `,
    [id]
  );
  const count = result.rows[0]?.count;
  if (typeof count !== "number") {
    throw new Error("Expected COUNT(*)::int to return a numeric count");
  }

  return count;
}

function findTargetMigrationName(): string {
  const migrationName = readdirSync(migrationsDir).find((entry) =>
    targetMigrationNamePattern.test(entry)
  );
  if (!migrationName) {
    throw new Error("comment_table_split_1_shared_contracts migration missing");
  }
  return migrationName;
}

type TestIds = {
  suffix: string;
  organizationId: string;
  otherOrganizationId: string;
  userId: string;
  projectId: string;
  installationId: string;
  repositoryId: string;
  documentArtifactId: string;
  branchArtifactId: string;
  otherBranchArtifactId: string;
  currentPrDetailId: string;
  historicalPrDetailId: string;
  otherPrDetailId: string;
  legacyPendingCommentId: string;
  legacyAddressedCommentId: string;
  legacyDismissedCommentId: string;
  documentThreadId: string;
  documentCommentId: string;
  projectedThreadId: string;
  projectedHistoricalThreadId: string;
  otherProjectedThreadId: string;
  softDeletedOnlyBranchArtifactId: string;
  softDeletedOnlyPrDetailId: string;
  softDeletedOnlyProjectionThreadId: string;
  deletedProjectionThreadId: string;
  reusedDeletedProjectionThreadId: string;
  parentWithReplyCommentId: string;
  sameThreadReplyCommentId: string;
  concurrentParentCommentId: string;
  concurrentReplyCommentId: string;
  projectedCommentId: string;
  projectedHistoricalCommentId: string;
  deletedProjectedCommentId: string;
  reusedDeletedProjectedCommentId: string;
  cascadeThreadId: string;
  cascadeCommentId: string;
  otherProjectedCommentId: string;
};

type QueryOutcome = { ok: true } | { ok: false; error: unknown };

function makeTestIds(): TestIds {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  return {
    suffix,
    organizationId: randomUUID(),
    otherOrganizationId: randomUUID(),
    userId: randomUUID(),
    projectId: randomUUID(),
    installationId: randomUUID(),
    repositoryId: randomUUID(),
    documentArtifactId: randomUUID(),
    branchArtifactId: randomUUID(),
    otherBranchArtifactId: randomUUID(),
    currentPrDetailId: randomUUID(),
    historicalPrDetailId: randomUUID(),
    otherPrDetailId: randomUUID(),
    legacyPendingCommentId: randomUUID(),
    legacyAddressedCommentId: randomUUID(),
    legacyDismissedCommentId: randomUUID(),
    documentThreadId: randomUUID(),
    documentCommentId: randomUUID(),
    projectedThreadId: randomUUID(),
    projectedHistoricalThreadId: randomUUID(),
    otherProjectedThreadId: randomUUID(),
    softDeletedOnlyBranchArtifactId: randomUUID(),
    softDeletedOnlyPrDetailId: randomUUID(),
    softDeletedOnlyProjectionThreadId: randomUUID(),
    deletedProjectionThreadId: randomUUID(),
    reusedDeletedProjectionThreadId: randomUUID(),
    parentWithReplyCommentId: randomUUID(),
    sameThreadReplyCommentId: randomUUID(),
    concurrentParentCommentId: randomUUID(),
    concurrentReplyCommentId: randomUUID(),
    projectedCommentId: randomUUID(),
    projectedHistoricalCommentId: randomUUID(),
    deletedProjectedCommentId: randomUUID(),
    reusedDeletedProjectedCommentId: randomUUID(),
    cascadeThreadId: randomUUID(),
    cascadeCommentId: randomUUID(),
    otherProjectedCommentId: randomUUID(),
  };
}
