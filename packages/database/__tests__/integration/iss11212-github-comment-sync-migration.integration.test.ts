import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseStoredCommentAnchor,
  StoredCommentAnchorReadStatus,
} from "@repo/api/src/types/comment-anchor";
import { Client } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { seedSessionDetailParents } from "../test-helpers/session-detail-seed";

/**
 * ISS-11212 (PLN-2122 Step 2): the GitHub comment-sync migration against real
 * Postgres. The database under test is already migrated, and
 * 20261006120300_iss11212_drop_comment_bridges has dropped the anchor function,
 * so each case re-creates it from the SHIPPED file, then re-runs the data step
 * over rows seeded in the pre-migration shape. Every case runs in a
 * transaction that is rolled back.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const MIGRATION = "20261001185258_iss11212_github_comment_sync";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const REPOSITORY = "acme/repo";

type Section = "function" | "data step";

type Projection = {
  threadKind?: "REVIEW_THREAD" | "ISSUE_COMMENT";
  path?: string | null;
  line?: number | null;
  originalLine?: number | null;
  side?: "LEFT" | "RIGHT" | null;
  startLine?: number | null;
  startSide?: "LEFT" | "RIGHT" | null;
  commitSha?: string | null;
  fetchMechanism?: "backfill" | "webhook" | null;
};

type Fixture = {
  organizationId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
};

const codeReview: Projection = {
  threadKind: "REVIEW_THREAD",
  path: "src/a.ts",
  line: 12,
  side: "RIGHT",
  commitSha: SHA_A,
};

/** One hand-written section of the shipped file, verbatim, between its markers. */
function section(name: Section): string {
  const sql = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "prisma",
      "migrations",
      MIGRATION,
      "migration.sql"
    ),
    "utf8"
  );
  const begin = `-- ISS-11212 github anchor ${name} begin`;
  const end = `-- ISS-11212 github anchor ${name} end`;
  const start = sql.indexOf(begin);
  const stop = sql.indexOf(end);
  if (start < 0 || stop < start) {
    throw new Error(`${MIGRATION}: ${name} markers not found`);
  }
  return sql.slice(start + begin.length, stop);
}

describe.skipIf(!DATABASE_URL)("ISS-11212 GitHub comment sync", () => {
  let client: Client;
  let fixture: Fixture;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    await client.query(section("function"));
    fixture = await seedPullRequest(client, REPOSITORY);
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  it("adds the additive columns and enum value", async () => {
    const { rows: columns } = await client.query<{
      column_name: string;
      is_nullable: string;
    }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE (table_name = 'pull_request_detail'
               AND column_name IN ('comments_reconciled_at', 'comments_reconcile_claimed_at'))
           OR (table_name = 'github_comment_thread_projections' AND column_name = 'original_line')
        ORDER BY column_name`
    );
    expect(columns).toEqual([
      { column_name: "comments_reconcile_claimed_at", is_nullable: "YES" },
      { column_name: "comments_reconciled_at", is_nullable: "YES" },
      { column_name: "original_line", is_nullable: "YES" },
    ]);
    const { rows: kinds } = await client.query<{ kinds: string }>(
      `SELECT enum_range(NULL::"GitHubCommentThreadKind")::text AS kinds`
    );
    expect(kinds).toEqual([
      { kinds: "{REVIEW_THREAD,ISSUE_COMMENT,REVIEW_SUMMARY}" },
    ]);
  });

  describe("data step", () => {
    it("anchors issue comments to the artifact and review threads to code", async () => {
      const issue = await seedThread(client, fixture, {
        threadKind: "ISSUE_COMMENT",
      });
      const range = await seedThread(client, fixture, {
        ...codeReview,
        startLine: 10,
        startSide: "RIGHT",
        originalLine: 11,
      });
      const outdated = await seedThread(client, fixture, {
        ...codeReview,
        line: null,
        side: "LEFT",
        commitSha: SHA_B,
      });
      const crossSide = await seedThread(client, fixture, {
        ...codeReview,
        line: 3,
        startLine: 9,
        startSide: "LEFT",
      });
      const sideWithoutStart = await seedThread(client, fixture, {
        ...codeReview,
        startSide: "LEFT",
      });

      await client.query(section("data step"));

      expect(await readThread(client, issue)).toEqual({
        anchor: { v: 1, kind: "artifact" },
        anchor_state: "ANCHORED",
      });
      expect(await readThread(client, range)).toEqual({
        anchor: {
          v: 1,
          kind: "code",
          repository: REPOSITORY,
          commitSha: SHA_A,
          path: "src/a.ts",
          side: "right",
          startLine: 10,
          startSide: "right",
          endLine: 12,
          originalEndLine: 11,
        },
        anchor_state: "ANCHORED",
      });
      expect(await readThread(client, outdated)).toEqual({
        anchor: {
          v: 1,
          kind: "code",
          repository: REPOSITORY,
          commitSha: SHA_B,
          path: "src/a.ts",
          side: "left",
          endLine: null,
        },
        anchor_state: "OUTDATED",
      });
      expect(await readThread(client, crossSide)).toMatchObject({
        anchor: { startLine: 9, startSide: "left", endLine: 3 },
      });
      expect(
        (await readThread(client, sideWithoutStart)).anchor
      ).not.toHaveProperty("startSide");
      for (const threadId of [
        issue,
        range,
        outdated,
        crossSide,
        sideWithoutStart,
      ]) {
        const { anchor } = await readThread(client, threadId);
        expect(parseStoredCommentAnchor(anchor).status).toBe(
          StoredCommentAnchorReadStatus.Valid
        );
      }
    });

    it("leaves the anchor absent when a required field has no valid source", async () => {
      const repositoryless = await seedPullRequest(client, null, fixture);
      const unrepresentable = {
        noCommit: await seedThread(client, fixture, {
          ...codeReview,
          commitSha: null,
        }),
        shortCommit: await seedThread(client, fixture, {
          ...codeReview,
          commitSha: "abc123",
        }),
        noSide: await seedThread(client, fixture, {
          ...codeReview,
          side: null,
        }),
        reversedRange: await seedThread(client, fixture, {
          ...codeReview,
          line: 3,
          startLine: 9,
        }),
        noRepository: await seedThread(client, repositoryless, codeReview),
      };

      await client.query(section("data step"));

      for (const [shape, threadId] of Object.entries(unrepresentable)) {
        const stored = await readThread(client, threadId);
        expect({ shape, ...stored }).toEqual({
          shape,
          anchor: null,
          anchor_state: null,
        });
        expect(parseStoredCommentAnchor(stored.anchor).status).toBe(
          StoredCommentAnchorReadStatus.Absent
        );
      }
    });

    it("leaves a backfill row's line unanchored when it may be the folded original line", async () => {
      const folded = await seedThread(client, fixture, {
        ...codeReview,
        fetchMechanism: "backfill",
      });
      const backfillOutdated = await seedThread(client, fixture, {
        ...codeReview,
        line: null,
        originalLine: 11,
        fetchMechanism: "backfill",
      });
      const backfillCurrent = await seedThread(client, fixture, {
        ...codeReview,
        originalLine: 11,
        fetchMechanism: "backfill",
      });
      const webhook = await seedThread(client, fixture, {
        ...codeReview,
        fetchMechanism: "webhook",
      });

      await client.query(section("data step"));

      expect(await readThread(client, folded)).toEqual({
        anchor: null,
        anchor_state: null,
      });
      expect(await readThread(client, backfillOutdated)).toMatchObject({
        anchor: { endLine: null, originalEndLine: 11 },
        anchor_state: "OUTDATED",
      });
      expect(await readThread(client, backfillCurrent)).toMatchObject({
        anchor: { endLine: 12, originalEndLine: 11 },
        anchor_state: "ANCHORED",
      });
      expect(await readThread(client, webhook)).toMatchObject({
        anchor: { endLine: 12 },
        anchor_state: "ANCHORED",
      });
    });

    it("touches only threads without an anchor, and not their updated_at", async () => {
      const anchored = await seedThread(client, fixture, codeReview, {
        anchor: { v: 1, kind: "artifact" },
        anchorState: "MOVED",
      });
      const github = await seedThread(client, fixture, codeReview);

      await client.query(section("data step"));

      expect(await readThread(client, anchored)).toEqual({
        anchor: { v: 1, kind: "artifact" },
        anchor_state: "MOVED",
      });
      expect((await readThread(client, github)).anchor).not.toBeNull();
      expect(await readUpdatedAt(client, github)).toBe("2026-01-01 00:00:00");
    });
  });
});

/** A branch and one pull request; reuses `base`'s organization and branch when given. */
async function seedPullRequest(
  client: Client,
  repositoryFullName: string | null,
  base?: Fixture
): Promise<Fixture> {
  let organizationId = base?.organizationId;
  let branchArtifactId = base?.branchArtifactId;
  if (!(organizationId && branchArtifactId)) {
    organizationId = (await seedSessionDetailParents(client, "iss11212-gh"))
      .organizationId;
    branchArtifactId = randomUUID();
    await client.query(
      `INSERT INTO artifacts (id, organization_id, type, name, status, updated_at)
       VALUES ($1, $2, 'BRANCH', 'branch', 'ACTIVE', now())`,
      [branchArtifactId, organizationId]
    );
    await client.query(
      `INSERT INTO branch_detail (artifact_id, branch_name, updated_at, organization_id, repository_full_name)
       VALUES ($1, 'feat/x', now(), $2, $3)`,
      [branchArtifactId, organizationId, REPOSITORY]
    );
  }
  const pullRequestDetailId = randomUUID();
  await client.query(
    `INSERT INTO pull_request_detail (id, number, branch_artifact_id, organization_id, repository_full_name)
     VALUES ($1, (SELECT count(*) + 1 FROM pull_request_detail WHERE branch_artifact_id = $2), $2, $3, $4)`,
    [pullRequestDetailId, branchArtifactId, organizationId, repositoryFullName]
  );
  return { organizationId, branchArtifactId, pullRequestDetailId };
}

async function seedThread(
  client: Client,
  fixture: Fixture,
  projection: Projection,
  thread: { anchor?: unknown; anchorState?: string } = {}
): Promise<string> {
  const threadId = randomUUID();
  await client.query(
    `INSERT INTO comment_threads (id, organization_id, source, artifact_id, anchor, anchor_state, updated_at)
     VALUES ($1, $2, 'GITHUB', $3, $4::jsonb, $5::"CommentAnchorState", '2026-01-01 00:00:00')`,
    [
      threadId,
      fixture.organizationId,
      fixture.branchArtifactId,
      thread.anchor === undefined ? null : JSON.stringify(thread.anchor),
      thread.anchorState ?? null,
    ]
  );
  await client.query(
    `INSERT INTO github_comment_thread_projections
       (thread_id, branch_artifact_id, pull_request_detail_id, thread_kind, root_comment_id,
        path, line, original_line, side, start_line, start_side, commit_sha, fetch_mechanism)
     VALUES ($1, $2, $3, $4::"GitHubCommentThreadKind", $5, $6, $7, $8,
             $9::"GitHubDiffSide", $10, $11::"GitHubDiffSide", $12, $13)`,
    [
      threadId,
      fixture.branchArtifactId,
      fixture.pullRequestDetailId,
      projection.threadKind ?? "REVIEW_THREAD",
      randomUUID(),
      projection.path ?? null,
      projection.line ?? null,
      projection.originalLine ?? null,
      projection.side ?? null,
      projection.startLine ?? null,
      projection.startSide ?? null,
      projection.commitSha ?? null,
      projection.fetchMechanism ?? null,
    ]
  );
  return threadId;
}

async function readThread(
  client: Client,
  threadId: string
): Promise<{ anchor: unknown; anchor_state: string | null }> {
  const { rows } = await client.query<{
    anchor: unknown;
    anchor_state: string | null;
  }>("SELECT anchor, anchor_state FROM comment_threads WHERE id = $1", [
    threadId,
  ]);
  return rows[0];
}

async function readUpdatedAt(
  client: Client,
  threadId: string
): Promise<string> {
  const { rows } = await client.query<{ updated_at: string }>(
    "SELECT updated_at::text AS updated_at FROM comment_threads WHERE id = $1",
    [threadId]
  );
  return rows[0].updated_at;
}
