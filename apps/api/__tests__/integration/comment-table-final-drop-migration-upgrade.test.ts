import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import {
  type PgClient,
  runMigrationUpgradeScenario,
} from "../utils/migration-upgrade-harness";

const hasDatabase = !!process.env.DATABASE_URL;
const describeWithDatabase = hasDatabase ? describe : describe.skip;
const baseMigrationName = "20260520064305_add_github_comment_identity";
const finalDropMigrationName = "20260523213000_drop_github_pr_review_comments";

describeWithDatabase("comment table final drop migration upgrade", () => {
  it("drops legacy review comments after preserving unified projection data", async () => {
    const ids = makeTestIds();
    const bodies = {
      deleted: "deleted review fixture body",
      legacyOnly: "legacy-only review fixture body",
      issue: "issue conversation fixture body",
      liveblocks: "liveblocks document comment body",
      overlapReply: "canonical overlap reply body",
      overlapRoot: "canonical overlap root body",
      root: "root review fixture body",
      reply: "reply review fixture body",
      unified: "existing unified side fixture body",
    };

    await runMigrationUpgradeScenario({
      baseMigrationName,
      targetMigrationNames: [finalDropMigrationName],
      databaseNamePrefix: "comment_final_drop",
      seed: (client) => seedFinalDropGraph(client, ids, bodies),
      assert: (client) => assertFinalDropUpgrade(client, ids, bodies),
    });
  }, 120_000);

  it("fails the destructive cutover when legacy rows lack unified projections", async () => {
    const ids = makeTestIds();
    const bodies = {
      deleted: "deleted review fixture body",
      legacyOnly: "legacy-only review fixture body",
      issue: "issue conversation fixture body",
      liveblocks: "liveblocks document comment body",
      overlapReply: "canonical overlap reply body",
      overlapRoot: "canonical overlap root body",
      root: "root review fixture body",
      reply: "reply review fixture body",
      unified: "existing unified side fixture body",
    };

    await expect(
      runMigrationUpgradeScenario({
        baseMigrationName,
        targetMigrationNames: [finalDropMigrationName],
        databaseNamePrefix: "comment_final_drop_guard",
        seed: (client) =>
          seedFinalDropGraph(client, ids, bodies, {
            includeLegacyOnlyWithoutUnifiedProjection: true,
          }),
        assert: async () => {},
      })
    ).rejects.toThrow("without unified comment projections");
  }, 120_000);
});

async function seedFinalDropGraph(
  client: PgClient,
  ids: TestIds,
  bodies: TestBodies,
  options: {
    includeLegacyOnlyWithoutUnifiedProjection?: boolean;
  } = {}
): Promise<void> {
  await client.query(
    `
      INSERT INTO "organizations" (
        "id", "clerk_id", "name", "slug", "settings", "created_at", "updated_at"
      )
      VALUES ($1, $2, 'Final Drop Org', $3, '{}'::jsonb, now(), now())
    `,
    [ids.organizationId, `clerk-${ids.suffix}`, `org-${ids.suffix}`]
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
      `final-drop-${ids.suffix}@example.com`,
    ]
  );
  await client.query(
    `
	      INSERT INTO "external_comment_authors" (
	        "id", "organization_id", "provider", "provider_user_id",
	        "provider_node_id", "provider_login", "normalized_provider_login",
	        "display_name", "avatar_url", "profile_url", "user_id",
	        "first_seen_at", "last_seen_at", "created_at", "updated_at"
	      )
	      VALUES (
	        $1, $2, 'GITHUB', 'canonical-provider-user', 'canonical-provider-node',
	        'canonical-reviewer', 'canonical-reviewer', 'Canonical Reviewer',
	        'https://avatars.example.test/canonical.png',
	        'https://github.com/canonical-reviewer', $3,
	        '2026-05-23T08:00:00.000Z', '2026-05-23T08:05:00.000Z',
	        '2026-05-23T08:00:00.000Z', '2026-05-23T08:05:00.000Z'
	      )
	    `,
    [ids.canonicalExternalAuthorId, ids.organizationId, ids.userId]
  );
  await client.query(
    `
      INSERT INTO "projects" (
        "id", "organization_id", "name", "priority", "status", "created_by_id",
        "created_at", "updated_at"
      )
      VALUES ($1, $2, 'Final Drop Project', 'MEDIUM', 'IN_PROGRESS', $3, now(), now())
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
      VALUES ($1, $2, '7654321', 'acme/final-drop', 'final-drop', 'acme', false, now(), now())
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
        ($1, $2, $3, 'BRANCH', NULL, 'feature/final-drop', NULL, 'OPEN',
          'https://github.com/acme/final-drop/tree/feature/final-drop', now(), now()),
        ($4, $2, $3, 'DOCUMENT', 'FEATURE', 'Final Drop Feature', $5,
          'IN_PROGRESS', NULL, now(), now())
    `,
    [
      ids.branchArtifactId,
      ids.organizationId,
      ids.projectId,
      ids.documentArtifactId,
      `FEA-${ids.suffix}`,
    ]
  );
  await client.query(
    `
      INSERT INTO "branch_detail" (
        "artifact_id", "repository_id", "branch_name", "base_branch",
        "current_pull_request_detail_id", "checks_status", "file_cache_status",
        "sync_status", "created_at", "updated_at"
      )
      VALUES ($1, $2, 'feature/final-drop', 'main', NULL, 'UNKNOWN', 'absent', 'idle', now(), now())
    `,
    [ids.branchArtifactId, ids.repositoryId]
  );
  await client.query(
    `
      INSERT INTO "pull_request_detail" (
        "id", "branch_artifact_id", "repository_id", "github_id", "number",
        "title", "html_url", "pr_state", "is_draft", "is_current"
      )
      VALUES ($1, $2, $3, 'github-pr-final-drop', 88, 'Final Drop PR',
        'https://github.com/acme/final-drop/pull/88', 'OPEN', false, true)
    `,
    [ids.pullRequestDetailId, ids.branchArtifactId, ids.repositoryId]
  );
  await client.query(
    `
      UPDATE "branch_detail"
      SET "current_pull_request_detail_id" = $1
      WHERE "artifact_id" = $2
    `,
    [ids.pullRequestDetailId, ids.branchArtifactId]
  );
  await client.query(
    `
      INSERT INTO "github_pr_reviews" (
        "id", "pull_request_id", "github_review_id", "author_login", "state",
        "body", "html_url", "submitted_at", "created_at", "updated_at"
      )
      VALUES ($1, $2, 'final-drop-review', 'reviewer', 'COMMENTED', 'review body',
        'https://github.com/acme/final-drop/pull/88#pullrequestreview-1',
        now(), now(), now())
    `,
    [ids.reviewId, ids.pullRequestDetailId]
  );
  await client.query(
    `
      INSERT INTO "github_pr_review_comments" (
        "id", "pull_request_id", "github_comment_id", "review_id", "body",
        "path", "line", "author_login", "author_avatar_url", "state",
        "html_url", "in_reply_to_id", "external_author_id", "created_at", "updated_at"
      )
	      VALUES
	        ($1, $3, 'legacy-root', '555', $4, 'src/final.ts', 42, 'reviewer',
	          'https://avatars.example.test/reviewer.png', 'PENDING',
	          'https://github.com/acme/final-drop/pull/88#discussion-root',
	          NULL, NULL, '2026-05-23T10:00:00.000Z', '2026-05-23T10:01:00.000Z'),
	        ($2, $3, 'legacy-reply', '555', $5, 'src/final.ts', 42, 'reviewer',
	          'https://avatars.example.test/reviewer.png', 'ADDRESSED',
	          'https://github.com/acme/final-drop/pull/88#discussion-reply',
	          'legacy-root', NULL, '2026-05-23T10:02:00.000Z', '2026-05-23T10:03:00.000Z')
	    `,
    [
      ids.legacyRootCommentId,
      ids.legacyReplyCommentId,
      ids.pullRequestDetailId,
      bodies.root,
      bodies.reply,
    ]
  );
  await client.query(
    `
      INSERT INTO "github_pr_review_comments" (
        "id", "pull_request_id", "github_comment_id", "review_id", "body",
        "path", "line", "author_login", "author_avatar_url", "state",
        "html_url", "in_reply_to_id", "external_author_id", "created_at", "updated_at"
      )
      VALUES ($1, $2, 'legacy-issue', NULL, $3, NULL, NULL, 'reviewer',
        'https://avatars.example.test/reviewer.png', 'PENDING',
        'https://github.com/acme/final-drop/pull/88#issuecomment-legacy',
        NULL, NULL, '2026-05-23T10:06:00.000Z', '2026-05-23T10:07:00.000Z')
    `,
    [ids.legacyIssueCommentId, ids.pullRequestDetailId, bodies.issue]
  );
  await client.query(
    `
      INSERT INTO "github_pr_review_comments" (
        "id", "pull_request_id", "github_comment_id", "review_id", "body",
        "path", "line", "author_login", "author_avatar_url", "state",
        "html_url", "in_reply_to_id", "external_author_id", "created_at", "updated_at"
      )
      VALUES ($1, $2, 'legacy-deleted', '555', $3, 'src/deleted.ts', 13, 'reviewer',
        'https://avatars.example.test/reviewer.png', 'PENDING',
        'https://github.com/acme/final-drop/pull/88#discussion-deleted',
        NULL, NULL, '2026-05-23T10:08:00.000Z', '2026-05-23T10:09:00.000Z')
    `,
    [ids.legacyDeletedCommentId, ids.pullRequestDetailId, bodies.deleted]
  );
  if (options.includeLegacyOnlyWithoutUnifiedProjection) {
    await client.query(
      `
        INSERT INTO "github_pr_review_comments" (
          "id", "pull_request_id", "github_comment_id", "review_id", "body",
          "path", "line", "author_login", "author_avatar_url", "state",
          "html_url", "in_reply_to_id", "external_author_id", "created_at", "updated_at"
        )
        VALUES ($1, $2, 'legacy-only', '555', $3, 'src/missing.ts', 9, 'reviewer',
          'https://avatars.example.test/reviewer.png', 'PENDING',
          'https://github.com/acme/final-drop/pull/88#discussion-missing',
          NULL, NULL, '2026-05-23T10:04:00.000Z', '2026-05-23T10:05:00.000Z')
      `,
      [ids.legacyOnlyCommentId, ids.pullRequestDetailId, bodies.legacyOnly]
    );
  }
  await client.query(
    `
	      INSERT INTO "comment_threads" (
	        "id", "organization_id", "source", "external_id", "artifact_id",
	        "status", "created_at", "updated_at"
	      )
	      VALUES ($1, $2, 'GITHUB', 'pre-final-drop-overlap-thread', $3,
	        'RESOLVED', '2026-05-23T09:00:00.000Z', '2026-05-23T09:01:00.000Z')
	    `,
    [ids.overlapThreadId, ids.organizationId, ids.branchArtifactId]
  );
  await client.query(
    `
      INSERT INTO "comment_threads" (
        "id", "organization_id", "source", "external_id", "artifact_id",
        "status", "created_at", "updated_at"
      )
      VALUES ($1, $2, 'GITHUB', 'legacy-issue-unified-thread-external-id', $3,
        'OPEN', now(), now())
    `,
    [ids.issueThreadId, ids.organizationId, ids.branchArtifactId]
  );
  await client.query(
    `
      INSERT INTO "comment_threads" (
        "id", "organization_id", "source", "external_id", "artifact_id",
        "status", "created_at", "updated_at"
      )
      VALUES ($1, $2, 'LIVEBLOCKS', 'liveblocks-final-drop-thread', $3,
        'OPEN', '2026-05-23T11:00:00.000Z', '2026-05-23T11:01:00.000Z')
    `,
    [ids.liveblocksThreadId, ids.organizationId, ids.documentArtifactId]
  );
  await client.query(
    `
      INSERT INTO "comments" (
        "id", "thread_id", "author_id", "body", "plain_text", "external_id",
        "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, jsonb_build_object('type', 'liveblocks', 'text', $4::text),
        $4::text, 'liveblocks-final-drop-comment',
        '2026-05-23T11:02:00.000Z', '2026-05-23T11:03:00.000Z')
    `,
    [
      ids.liveblocksCommentId,
      ids.liveblocksThreadId,
      ids.userId,
      bodies.liveblocks,
    ]
  );
  await client.query(
    `
      INSERT INTO "comment_threads" (
        "id", "organization_id", "source", "external_id", "artifact_id",
        "status", "created_at", "updated_at"
      )
      VALUES ($1, $2, 'GITHUB', 'legacy-deleted-unified-thread-external-id', $3,
        'RESOLVED', '2026-05-23T10:08:00.000Z', '2026-05-23T10:09:00.000Z')
    `,
    [ids.deletedThreadId, ids.organizationId, ids.branchArtifactId]
  );
  await client.query(
    `
      INSERT INTO "github_comment_thread_projections" (
        "thread_id", "branch_artifact_id", "pull_request_detail_id", "thread_kind",
        "root_comment_id", "review_thread_id", "review_id", "path", "line",
        "side", "start_line", "start_side", "html_url", "resolvable",
        "legacy_state", "deleted_at", "last_synced_at"
      )
      VALUES ($1, $2, $3, 'REVIEW_THREAD', 'legacy-deleted',
        'deleted-review-thread', '555', 'src/deleted.ts', 13, 'RIGHT', NULL, NULL,
        'https://github.com/acme/final-drop/pull/88#discussion-deleted',
        false, 'PENDING', '2026-05-23T10:10:00.000Z', '2026-05-23T10:10:00.000Z')
    `,
    [ids.deletedThreadId, ids.branchArtifactId, ids.pullRequestDetailId]
  );
  await client.query(
    `
      INSERT INTO "comments" (
        "id", "thread_id", "author_id", "body", "plain_text", "external_id",
        "deleted_at", "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, jsonb_build_object('type', 'github_markdown', 'markdown', $4::text),
        $4::text, 'legacy-deleted-unified-comment-external-id',
        '2026-05-23T10:10:00.000Z',
        '2026-05-23T10:08:00.000Z', '2026-05-23T10:09:00.000Z')
    `,
    [ids.deletedCommentId, ids.deletedThreadId, ids.userId, bodies.deleted]
  );
  await client.query(
    `
      INSERT INTO "github_comment_projections" (
        "comment_id", "thread_id", "external_author_id", "github_comment_id",
        "github_html_url", "github_updated_at", "github_deleted_at"
      )
      VALUES ($1, $2, NULL, 'legacy-deleted',
        'https://github.com/acme/final-drop/pull/88#discussion-deleted',
        '2026-05-23T10:09:00.000Z', '2026-05-23T10:10:00.000Z')
    `,
    [ids.deletedCommentId, ids.deletedThreadId]
  );
  await client.query(
    `
      INSERT INTO "github_comment_thread_projections" (
        "thread_id", "branch_artifact_id", "pull_request_detail_id", "thread_kind",
        "root_comment_id", "last_synced_at"
      )
      VALUES ($1, $2, $3, NULL, 'legacy-issue', now())
    `,
    [ids.issueThreadId, ids.branchArtifactId, ids.pullRequestDetailId]
  );
  await client.query(
    `
      INSERT INTO "comments" (
        "id", "thread_id", "author_id", "body", "plain_text", "external_id",
        "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, jsonb_build_object('type', 'github_markdown', 'markdown', $4::text),
        $4::text, 'legacy-issue-unified-comment-external-id',
        '2026-05-23T10:06:00.000Z', '2026-05-23T10:07:00.000Z')
    `,
    [ids.issueCommentId, ids.issueThreadId, ids.userId, bodies.issue]
  );
  await client.query(
    `
      INSERT INTO "github_comment_projections" (
        "comment_id", "thread_id", "external_author_id", "github_comment_id",
        "github_html_url", "github_updated_at"
      )
      VALUES ($1, $2, NULL, 'legacy-issue',
        'https://github.com/acme/final-drop/pull/88#issuecomment-legacy',
        '2026-05-23T10:07:00.000Z')
    `,
    [ids.issueCommentId, ids.issueThreadId]
  );
  await client.query(
    `
      INSERT INTO "github_comment_thread_projections" (
	        "thread_id", "branch_artifact_id", "pull_request_detail_id", "thread_kind",
	        "root_comment_id", "review_thread_id", "review_id", "path", "line",
	        "side", "start_line", "start_side", "commit_sha", "html_url", "resolvable",
	        "legacy_state", "last_synced_at"
	      )
	      VALUES ($1, $2, $3, 'REVIEW_THREAD', 'legacy-root',
	        'canonical-overlap-thread', 'canonical-review', 'src/canonical.ts', 7,
	        'LEFT', 5, 'RIGHT', 'canonical-commit-sha',
	        'https://github.com/acme/final-drop/pull/88#discussion-canonical',
	        false, 'ADDRESSED', '2026-05-23T09:02:00.000Z')
	    `,
    [ids.overlapThreadId, ids.branchArtifactId, ids.pullRequestDetailId]
  );
  await client.query(
    `
	      INSERT INTO "comments" (
	        "id", "thread_id", "author_id", "body", "plain_text", "external_id",
	        "parent_comment_id", "created_at", "updated_at"
	      )
	      VALUES
	        ($1, $3, $4, jsonb_build_object('type', 'github_markdown', 'markdown', $5::text),
	          $5::text, 'pre-final-drop-overlap-root', NULL,
	          '2026-05-23T09:03:00.000Z', '2026-05-23T09:04:00.000Z'),
	        ($2, $3, $4, jsonb_build_object('type', 'github_markdown', 'markdown', $6::text),
	          $6::text, 'pre-final-drop-overlap-reply', $1,
	          '2026-05-23T09:05:00.000Z', '2026-05-23T09:06:00.000Z')
	    `,
    [
      ids.overlapRootCommentId,
      ids.overlapReplyCommentId,
      ids.overlapThreadId,
      ids.userId,
      bodies.overlapRoot,
      bodies.overlapReply,
    ]
  );
  await client.query(
    `
      INSERT INTO "github_comment_projections" (
	        "comment_id", "thread_id", "external_author_id", "github_comment_id",
	        "github_in_reply_to_comment_id", "github_html_url", "github_updated_at"
	      )
	      VALUES
	        ($1, $3, $4, 'legacy-root', NULL,
	          'https://github.com/acme/final-drop/pull/88#discussion-canonical-root',
	          '2026-05-23T09:04:30.000Z'),
	        ($2, $3, $4, 'legacy-reply', 'legacy-root',
	          'https://github.com/acme/final-drop/pull/88#discussion-canonical-reply',
	          '2026-05-23T09:06:30.000Z')
	    `,
    [
      ids.overlapRootCommentId,
      ids.overlapReplyCommentId,
      ids.overlapThreadId,
      ids.canonicalExternalAuthorId,
    ]
  );
  await client.query(
    `
      INSERT INTO "comment_threads" (
        "id", "organization_id", "source", "external_id", "artifact_id",
        "status", "created_at", "updated_at"
      )
      VALUES ($1, $2, 'GITHUB', 'legacy-unified-thread-external-id', $3,
        'OPEN', now(), now())
    `,
    [ids.unifiedThreadId, ids.organizationId, ids.branchArtifactId]
  );
  await client.query(
    `
      INSERT INTO "github_comment_thread_projections" (
        "thread_id", "branch_artifact_id", "pull_request_detail_id", "thread_kind",
        "root_comment_id", "review_thread_id", "review_id", "path", "line",
        "side", "start_line", "start_side", "html_url", "resolvable",
        "legacy_state", "last_synced_at"
      )
      VALUES ($1, $2, $3, 'REVIEW_THREAD', 'unified-side-root',
        'unified-side-thread', '777', 'src/side.ts', 7, 'LEFT', 6, 'LEFT',
        'https://github.com/acme/final-drop/pull/88#discussion-side',
        true, 'PENDING', now())
    `,
    [ids.unifiedThreadId, ids.branchArtifactId, ids.pullRequestDetailId]
  );
  await client.query(
    `
      INSERT INTO "comments" (
        "id", "thread_id", "author_id", "body", "plain_text", "external_id",
        "created_at", "updated_at"
      )
      VALUES ($1, $2, $3, jsonb_build_object('type', 'github_markdown', 'markdown', $4::text),
        $4::text, 'legacy-unified-comment-external-id', now(), now())
    `,
    [ids.unifiedCommentId, ids.unifiedThreadId, ids.userId, bodies.unified]
  );
  await client.query(
    `
      INSERT INTO "github_comment_projections" (
        "comment_id", "thread_id", "external_author_id", "github_comment_id",
        "github_html_url", "github_updated_at"
      )
      VALUES ($1, $2, NULL, 'unified-side',
        'https://github.com/acme/final-drop/pull/88#discussion-side', now())
    `,
    [ids.unifiedCommentId, ids.unifiedThreadId]
  );
}

async function assertFinalDropUpgrade(
  client: PgClient,
  ids: TestIds,
  bodies: TestBodies
): Promise<void> {
  const droppedObjects = await client.query(
    `
      SELECT
        to_regclass('public.github_pr_review_comments') AS "legacyTable",
        to_regtype('public."PRReviewCommentState"') AS "legacyType",
        to_regclass('public.github_pr_reviews') AS "reviewsTable",
        to_regclass('public.github_comment_thread_projections') AS "threadProjectionTable",
        to_regclass('public.github_comment_projections') AS "commentProjectionTable"
    `
  );
  requireDeepEqual(droppedObjects.rows[0], {
    legacyTable: null,
    legacyType: null,
    reviewsTable: "github_pr_reviews",
    threadProjectionTable: "github_comment_thread_projections",
    commentProjectionTable: "github_comment_projections",
  });

  const legacyRows = await client.query(
    `
      SELECT
        c."id",
	        c."external_id",
	        c."thread_id",
	        encode(sha256(c."plain_text"::bytea), 'hex') AS "plain_text_sha256",
	        c."author_id",
	        c."parent_comment_id",
	        to_char(c."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "created_at",
	        to_char(c."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updated_at",
	        gcp."github_comment_id",
	        gcp."github_in_reply_to_comment_id",
	        gcp."external_author_id",
	        gcp."github_html_url",
	        to_char(gcp."github_updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "github_updated_at",
	        gctp."review_thread_id",
	        gctp."path",
	        gctp."line",
	        gctp."side",
	        gctp."start_line",
	        gctp."start_side",
	        gctp."commit_sha",
	        gctp."resolvable",
	        gctp."legacy_state",
	        ct."external_id" AS "thread_external_id",
	        ct."status",
        author."active" AS "author_active",
        author."github_username" AS "author_github_username"
      FROM "comments" c
      JOIN "github_comment_projections" gcp ON gcp."comment_id" = c."id"
      JOIN "github_comment_thread_projections" gctp ON gctp."thread_id" = gcp."thread_id"
      JOIN "comment_threads" ct ON ct."id" = c."thread_id"
      JOIN "users" author ON author."id" = c."author_id"
      WHERE gcp."github_comment_id" IN ('legacy-root', 'legacy-reply', 'legacy-issue', 'legacy-only')
      ORDER BY gcp."github_comment_id"
    `
  );
  requireDeepEqual(legacyRows.rows, [
    {
      id: ids.issueCommentId,
      external_id: "github:ISSUE_COMMENT:comment:legacy-issue",
      thread_id: ids.issueThreadId,
      plain_text_sha256: sha256(bodies.issue),
      author_id: ids.userId,
      parent_comment_id: null,
      created_at: "2026-05-23T10:06:00.000Z",
      updated_at: "2026-05-23T10:07:00.000Z",
      github_comment_id: "legacy-issue",
      github_in_reply_to_comment_id: null,
      external_author_id: null,
      github_html_url:
        "https://github.com/acme/final-drop/pull/88#issuecomment-legacy",
      github_updated_at: "2026-05-23T10:07:00.000Z",
      review_thread_id: null,
      path: null,
      line: null,
      side: null,
      start_line: null,
      start_side: null,
      commit_sha: null,
      resolvable: false,
      legacy_state: null,
      thread_external_id: `github-pr-thread:${ids.pullRequestDetailId}:ISSUE_COMMENT:root:legacy-issue`,
      status: "OPEN",
      author_active: true,
      author_github_username: null,
    },
    {
      id: ids.overlapReplyCommentId,
      external_id: "github:REVIEW_THREAD:comment:legacy-reply",
      thread_id: ids.overlapThreadId,
      plain_text_sha256: sha256(bodies.overlapReply),
      author_id: ids.userId,
      parent_comment_id: ids.overlapRootCommentId,
      created_at: "2026-05-23T09:05:00.000Z",
      updated_at: "2026-05-23T09:06:00.000Z",
      github_comment_id: "legacy-reply",
      github_in_reply_to_comment_id: "legacy-root",
      external_author_id: ids.canonicalExternalAuthorId,
      github_html_url:
        "https://github.com/acme/final-drop/pull/88#discussion-canonical-reply",
      github_updated_at: "2026-05-23T09:06:30.000Z",
      review_thread_id: "canonical-overlap-thread",
      path: "src/canonical.ts",
      line: 7,
      side: "LEFT",
      start_line: 5,
      start_side: "RIGHT",
      commit_sha: "canonical-commit-sha",
      resolvable: false,
      legacy_state: "ADDRESSED",
      thread_external_id: `github-pr-thread:${ids.pullRequestDetailId}:review-thread:canonical-overlap-thread`,
      status: "RESOLVED",
      author_active: true,
      author_github_username: null,
    },
    {
      id: ids.overlapRootCommentId,
      external_id: "github:REVIEW_THREAD:comment:legacy-root",
      thread_id: ids.overlapThreadId,
      plain_text_sha256: sha256(bodies.overlapRoot),
      author_id: ids.userId,
      parent_comment_id: null,
      created_at: "2026-05-23T09:03:00.000Z",
      updated_at: "2026-05-23T09:04:00.000Z",
      github_comment_id: "legacy-root",
      github_in_reply_to_comment_id: null,
      external_author_id: ids.canonicalExternalAuthorId,
      github_html_url:
        "https://github.com/acme/final-drop/pull/88#discussion-canonical-root",
      github_updated_at: "2026-05-23T09:04:30.000Z",
      review_thread_id: "canonical-overlap-thread",
      path: "src/canonical.ts",
      line: 7,
      side: "LEFT",
      start_line: 5,
      start_side: "RIGHT",
      commit_sha: "canonical-commit-sha",
      resolvable: false,
      legacy_state: "ADDRESSED",
      thread_external_id: `github-pr-thread:${ids.pullRequestDetailId}:review-thread:canonical-overlap-thread`,
      status: "RESOLVED",
      author_active: true,
      author_github_username: null,
    },
  ]);

  const overlapCounts = await client.query(
    `
      SELECT
        gcp."github_comment_id",
        COUNT(*)::int AS "projection_count",
        COUNT(DISTINCT c."external_id")::int AS "external_id_count"
      FROM "github_comment_projections" gcp
      JOIN "comments" c ON c."id" = gcp."comment_id"
      WHERE gcp."github_comment_id" IN ('legacy-root', 'legacy-reply', 'legacy-issue', 'legacy-only')
      GROUP BY gcp."github_comment_id"
      ORDER BY gcp."github_comment_id"
    `
  );
  requireDeepEqual(overlapCounts.rows, [
    {
      github_comment_id: "legacy-issue",
      projection_count: 1,
      external_id_count: 1,
    },
    {
      github_comment_id: "legacy-reply",
      projection_count: 1,
      external_id_count: 1,
    },
    {
      github_comment_id: "legacy-root",
      projection_count: 1,
      external_id_count: 1,
    },
  ]);

  const legacyCommentIdRows = await client.query(
    `
      SELECT COUNT(*)::int AS "count"
      FROM "comments"
      WHERE "id" IN ($1, $2, $3, $4)
    `,
    [
      ids.legacyRootCommentId,
      ids.legacyReplyCommentId,
      ids.legacyIssueCommentId,
      ids.legacyDeletedCommentId,
    ]
  );
  requireDeepEqual(legacyCommentIdRows.rows[0], { count: 0 });

  const unifiedRows = await client.query(
    `
      SELECT
        c."external_id",
        encode(sha256(c."plain_text"::bytea), 'hex') AS "plain_text_sha256",
        gcp."github_comment_id",
        gctp."thread_kind",
        gctp."path",
        gctp."line",
        gctp."side",
        gctp."start_line",
        gctp."start_side"
      FROM "comments" c
      JOIN "github_comment_projections" gcp ON gcp."comment_id" = c."id"
      JOIN "github_comment_thread_projections" gctp ON gctp."thread_id" = gcp."thread_id"
      WHERE c."id" = $1
    `,
    [ids.unifiedCommentId]
  );
  requireDeepEqual(unifiedRows.rows, [
    {
      external_id: "github:REVIEW_THREAD:comment:unified-side",
      plain_text_sha256: sha256(bodies.unified),
      github_comment_id: "unified-side",
      thread_kind: "REVIEW_THREAD",
      path: "src/side.ts",
      line: 7,
      side: "LEFT",
      start_line: 6,
      start_side: "LEFT",
    },
  ]);

  const deletedRows = await client.query(
    `
      SELECT
        c."id",
        c."external_id",
        encode(sha256(c."plain_text"::bytea), 'hex') AS "plain_text_sha256",
        to_char(c."deleted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "comment_deleted_at",
        gcp."github_comment_id",
        to_char(gcp."github_deleted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "github_deleted_at",
        gctp."thread_kind",
        gctp."review_thread_id",
        to_char(gctp."deleted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "thread_deleted_at"
      FROM "comments" c
      JOIN "github_comment_projections" gcp ON gcp."comment_id" = c."id"
      JOIN "github_comment_thread_projections" gctp ON gctp."thread_id" = gcp."thread_id"
      WHERE gcp."github_comment_id" = 'legacy-deleted'
    `
  );
  requireDeepEqual(deletedRows.rows, [
    {
      id: ids.deletedCommentId,
      external_id: "github:REVIEW_THREAD:comment:legacy-deleted",
      plain_text_sha256: sha256(bodies.deleted),
      comment_deleted_at: "2026-05-23T10:10:00.000Z",
      github_comment_id: "legacy-deleted",
      github_deleted_at: "2026-05-23T10:10:00.000Z",
      thread_kind: "REVIEW_THREAD",
      review_thread_id: "deleted-review-thread",
      thread_deleted_at: "2026-05-23T10:10:00.000Z",
    },
  ]);

  requireDeepEqual(await countRows(client, "github_pr_reviews"), 1);

  const liveblocksRows = await client.query(
    `
      SELECT
        ct."id" AS "thread_id",
        ct."source",
        ct."external_id" AS "thread_external_id",
        ct."artifact_id",
        ct."status",
        c."id" AS "comment_id",
        c."external_id" AS "comment_external_id",
        encode(sha256(c."plain_text"::bytea), 'hex') AS "plain_text_sha256",
        c."author_id",
        to_char(c."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "created_at",
        to_char(c."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updated_at",
        gctp."thread_id" AS "github_thread_projection_id",
        gcp."comment_id" AS "github_comment_projection_id"
      FROM "comment_threads" ct
      JOIN "comments" c ON c."thread_id" = ct."id"
      LEFT JOIN "github_comment_thread_projections" gctp ON gctp."thread_id" = ct."id"
      LEFT JOIN "github_comment_projections" gcp ON gcp."comment_id" = c."id"
      WHERE ct."id" = $1
    `,
    [ids.liveblocksThreadId]
  );
  requireDeepEqual(liveblocksRows.rows, [
    {
      thread_id: ids.liveblocksThreadId,
      source: "LIVEBLOCKS",
      thread_external_id: "liveblocks-final-drop-thread",
      artifact_id: ids.documentArtifactId,
      status: "OPEN",
      comment_id: ids.liveblocksCommentId,
      comment_external_id: "liveblocks-final-drop-comment",
      plain_text_sha256: sha256(bodies.liveblocks),
      author_id: ids.userId,
      created_at: "2026-05-23T11:02:00.000Z",
      updated_at: "2026-05-23T11:03:00.000Z",
      github_thread_projection_id: null,
      github_comment_projection_id: null,
    },
  ]);
}

async function countRows(client: PgClient, tableName: string): Promise<number> {
  const result = await client.query(
    `SELECT COUNT(*)::int AS "count" FROM "${tableName}"`
  );
  return result.rows[0].count as number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireDeepEqual(actual: unknown, expected: unknown): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(
      `Final drop migration upgrade assertion failed\nActual: ${JSON.stringify(actual)}\nExpected: ${JSON.stringify(expected)}`
    );
  }
}

type TestBodies = {
  deleted: string;
  issue: string;
  legacyOnly: string;
  liveblocks: string;
  overlapReply: string;
  overlapRoot: string;
  root: string;
  reply: string;
  unified: string;
};

type TestIds = {
  suffix: string;
  organizationId: string;
  userId: string;
  projectId: string;
  installationId: string;
  repositoryId: string;
  documentArtifactId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
  reviewId: string;
  canonicalExternalAuthorId: string;
  deletedThreadId: string;
  deletedCommentId: string;
  liveblocksThreadId: string;
  liveblocksCommentId: string;
  issueThreadId: string;
  issueCommentId: string;
  legacyDeletedCommentId: string;
  legacyIssueCommentId: string;
  legacyOnlyCommentId: string;
  legacyRootCommentId: string;
  legacyReplyCommentId: string;
  overlapThreadId: string;
  overlapRootCommentId: string;
  overlapReplyCommentId: string;
  unifiedThreadId: string;
  unifiedCommentId: string;
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
    pullRequestDetailId: randomUUID(),
    reviewId: randomUUID(),
    canonicalExternalAuthorId: randomUUID(),
    deletedThreadId: randomUUID(),
    deletedCommentId: randomUUID(),
    liveblocksThreadId: randomUUID(),
    liveblocksCommentId: randomUUID(),
    issueThreadId: randomUUID(),
    issueCommentId: randomUUID(),
    legacyDeletedCommentId: randomUUID(),
    legacyIssueCommentId: randomUUID(),
    legacyOnlyCommentId: randomUUID(),
    legacyRootCommentId: randomUUID(),
    legacyReplyCommentId: randomUUID(),
    overlapThreadId: randomUUID(),
    overlapRootCommentId: randomUUID(),
    overlapReplyCommentId: randomUUID(),
    unifiedThreadId: randomUUID(),
    unifiedCommentId: randomUUID(),
  };
}
