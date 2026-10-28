import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
 * ISS-11212 (PLN-2120 Step 2): what the comment-contract migration does against
 * real Postgres.
 *
 * The database under test is already migrated, so the two data steps are cut
 * out of the SHIPPED file by their begin/end markers and re-run over rows seeded
 * in the pre-migration shape. Reading the bytes means an edit to the migration
 * is what this suite checks, not a transcription of it. Every case runs in a
 * transaction that is rolled back.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const MIGRATION = "20260930150000_iss11212_comment_contract_core";
const LEGACY_ENGINEER_BODY_MIGRATION =
  "20260930140000_iss11749_legacy_engineer_comment_body";

const UNMATCHED_BODY_RE =
  /ISS-11212: 1 comments rows match no body_format rule/;
const SINGLE_TARGET_CHECK_RE = /comment_sync_states_single_target_check/;
const THREAD_UNIQUE_RE = /comment_sync_states_thread_id_provider_direction_key/;
const COMMENT_UNIQUE_RE =
  /comment_sync_states_comment_id_provider_direction_key/;

const traceAnchor = {
  traceId: "trace:session-1:0",
  turnId: "turn:session-1:0",
  row: 0,
  selectedText: "quote target",
  sourceText: "A trace quote target row",
  startOffset: 8,
  endOffset: 20,
  sessionId: "session-1",
  actor: { name: "codex", human: null },
};

function shippedMigrationSql(migration: string = MIGRATION): string {
  return readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "prisma",
      "migrations",
      migration,
      "migration.sql"
    ),
    "utf8"
  );
}

/** One data step of the shipped file, verbatim, between its markers. */
function dataStep(step: 1 | 2): string {
  const sql = shippedMigrationSql();
  const begin = `-- ISS-11212 data step ${step} begin`;
  const end = `-- ISS-11212 data step ${step} end`;
  const start = sql.indexOf(begin);
  const stop = sql.indexOf(end);
  if (start < 0 || stop < start) {
    throw new Error(`${MIGRATION}: data step ${step} markers not found`);
  }
  return sql.slice(start + begin.length, stop);
}

describe.skipIf(!DATABASE_URL)("ISS-11212 comment contract core", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    // The pre-migration shape: threads could carry no artifact until
    // 20261006120100_iss11212_comment_thread_artifact_required.
    await client.query(
      "ALTER TABLE comment_threads ALTER COLUMN artifact_id DROP NOT NULL"
    );
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  it("leaves comments.body_format NOT NULL", async () => {
    const { rows } = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'comments' AND column_name = 'body_format'`
    );
    expect(rows).toEqual([{ is_nullable: "NO" }]);
  });

  describe("data step 1: body_format backfill", () => {
    beforeEach(async () => {
      // The pre-migration shape: the column exists but holds nothing yet.
      await client.query(
        "ALTER TABLE comments ALTER COLUMN body_format DROP NOT NULL"
      );
    });

    it("classifies each stored body shape", async () => {
      const { organizationId } = await seedSessionDetailParents(
        client,
        "iss11212"
      );
      const native = await seedThread(client, organizationId, "NATIVE");
      const github = await seedThread(client, organizationId, "GITHUB");
      const liveblocks = await seedThread(client, organizationId, "LIVEBLOCKS");

      const nativeDoc = await seedComment(
        client,
        native,
        {
          type: "doc",
          content: [],
        },
        null
      );
      const githubMarkdown = await seedComment(
        client,
        github,
        {
          type: "github_markdown",
          markdown: "**hi**",
        },
        null
      );
      const liveblocksBody = await seedComment(
        client,
        liveblocks,
        {
          version: 1,
          content: [{ type: "paragraph", children: [{ text: "hi" }] }],
        },
        null
      );
      // A deleted Liveblocks comment is stored as `{}`.
      const liveblocksEmpty = await seedComment(client, liveblocks, {}, null);
      // The JSON-root rules run before the source fallback.
      const liveblocksDoc = await seedComment(
        client,
        liveblocks,
        {
          type: "doc",
          content: [],
        },
        null
      );
      // Already classified: only NULL rows are touched.
      const alreadySet = await seedComment(
        client,
        native,
        { type: "doc", content: [] },
        "MARKDOWN"
      );

      await client.query(dataStep(1));

      expect(await readBodyFormat(client, nativeDoc)).toBe("RICH_V1");
      expect(await readBodyFormat(client, githubMarkdown)).toBe("MARKDOWN");
      expect(await readBodyFormat(client, liveblocksBody)).toBe(
        "LIVEBLOCKS_V1"
      );
      expect(await readBodyFormat(client, liveblocksEmpty)).toBe(
        "LIVEBLOCKS_V1"
      );
      expect(await readBodyFormat(client, liveblocksDoc)).toBe("RICH_V1");
      expect(await readBodyFormat(client, alreadySet)).toBe("MARKDOWN");
    });

    it("classifies a legacy Engineer body once ISS-11749 has rewritten it", async () => {
      const { organizationId } = await seedSessionDetailParents(
        client,
        "iss11212"
      );
      const native = await seedThread(client, organizationId, "NATIVE");
      const liveblocks = await seedThread(client, organizationId, "LIVEBLOCKS");
      const text = "Planning has started.\n\n-Closedloop.dev";
      const legacyBody = {
        version: 1,
        content: [{ type: "paragraph", children: [{ text }] }],
      };
      const engineer = await seedComment(
        client,
        native,
        legacyBody,
        null,
        text
      );
      // No plain_text to rebuild from: left for step 1's invariant to report.
      const noText = await seedComment(client, native, legacyBody, null, null);
      // The same shape on a Liveblocks thread is a Liveblocks body.
      const liveblocksBody = await seedComment(
        client,
        liveblocks,
        legacyBody,
        null,
        text
      );

      await client.query(shippedMigrationSql(LEGACY_ENGINEER_BODY_MIGRATION));

      expect(await readBody(client, engineer)).toEqual({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      });
      expect(await readBody(client, noText)).toEqual(legacyBody);
      expect(await readBody(client, liveblocksBody)).toEqual(legacyBody);

      await client.query("DELETE FROM comments WHERE id = $1", [noText]);
      await client.query(dataStep(1));

      expect(await readBodyFormat(client, engineer)).toBe("RICH_V1");
      expect(await readBodyFormat(client, liveblocksBody)).toBe(
        "LIVEBLOCKS_V1"
      );
    });

    it("fails the migration on a body no rule matches, writing nothing", async () => {
      const { organizationId } = await seedSessionDetailParents(
        client,
        "iss11212"
      );
      const native = await seedThread(client, organizationId, "NATIVE");
      const github = await seedThread(client, organizationId, "GITHUB");
      const matched = await seedComment(
        client,
        native,
        {
          type: "doc",
          content: [],
        },
        null
      );
      // Neither a doc nor markdown, and not on a Liveblocks thread: no rule.
      await seedComment(client, github, { type: "paragraph" }, null);

      await client.query("SAVEPOINT before_step");
      await expect(client.query(dataStep(1))).rejects.toThrow(
        UNMATCHED_BODY_RE
      );
      await client.query("ROLLBACK TO SAVEPOINT before_step");

      expect(await readBodyFormat(client, matched)).toBeNull();
    });
  });

  describe("data step 2: the trace anchor move", () => {
    it("moves a trace anchor into the v1 envelope and out of metadata", async () => {
      const { organizationId } = await seedSessionDetailParents(
        client,
        "iss11212"
      );
      const trace = await seedThread(client, organizationId, "NATIVE", {
        kind: "trace_comment",
        schemaVersion: 1,
        targetType: "session",
        surface: "session_detail",
        anchor: traceAnchor,
        commentKind: "parsing_bug",
        syncAbandoned: true,
      });
      await backdate(client, trace);
      const before = await readThread(client, trace);

      await client.query(dataStep(2));

      const after = await readThread(client, trace);
      expect(after.anchor).toEqual({ v: 1, kind: "trace", ...traceAnchor });
      expect(after.anchor_state).toBe("ANCHORED");
      expect(after.metadata).toEqual({
        kind: "trace_comment",
        schemaVersion: 1,
        targetType: "session",
        surface: "session_detail",
        commentKind: "parsing_bug",
        syncAbandoned: true,
      });
      // A data move, not an edit: the list order keyed on updated_at holds.
      expect(after.updated_at).toEqual(before.updated_at);
    });

    it("leaves every row that is not a native trace anchor alone", async () => {
      const { organizationId } = await seedSessionDetailParents(
        client,
        "iss11212"
      );
      const liveblocksMetadata = { anchor: { kind: "trace" } };
      const liveblocks = await seedThread(
        client,
        organizationId,
        "LIVEBLOCKS",
        liveblocksMetadata
      );
      const otherNativeMetadata = { kind: "other", anchor: traceAnchor };
      const otherNative = await seedThread(
        client,
        organizationId,
        "NATIVE",
        otherNativeMetadata
      );
      const corruptMetadata = {
        kind: "trace_comment",
        surface: "session_detail",
        anchor: "not an object",
      };
      const corrupt = await seedThread(
        client,
        organizationId,
        "NATIVE",
        corruptMetadata
      );

      await client.query(dataStep(2));

      for (const [id, metadata] of [
        [liveblocks, liveblocksMetadata],
        [otherNative, otherNativeMetadata],
        [corrupt, corruptMetadata],
      ] as const) {
        const row = await readThread(client, id);
        expect(row.anchor).toBeNull();
        expect(row.anchor_state).toBeNull();
        expect(row.metadata).toEqual(metadata);
      }
    });
  });

  describe("comment_sync_states constraints", () => {
    it("accepts a row with exactly one target and rejects both or neither", async () => {
      const { organizationId } = await seedSessionDetailParents(
        client,
        "iss11212"
      );
      const thread = await seedThread(client, organizationId, "NATIVE");
      const comment = await seedComment(client, thread, {
        type: "doc",
        content: [],
      });

      await insertSyncState(client, organizationId, { threadId: thread });
      await insertSyncState(client, organizationId, { commentId: comment });

      await client.query("SAVEPOINT both_targets");
      await expect(
        insertSyncState(client, organizationId, {
          threadId: thread,
          commentId: comment,
          direction: "OUTBOUND",
        })
      ).rejects.toThrow(SINGLE_TARGET_CHECK_RE);
      await client.query("ROLLBACK TO SAVEPOINT both_targets");

      await client.query("SAVEPOINT no_target");
      await expect(
        insertSyncState(client, organizationId, { direction: "OUTBOUND" })
      ).rejects.toThrow(SINGLE_TARGET_CHECK_RE);
      await client.query("ROLLBACK TO SAVEPOINT no_target");
    });

    it("keeps one row per (thread, provider, direction) and per (comment, provider, direction)", async () => {
      const { organizationId } = await seedSessionDetailParents(
        client,
        "iss11212"
      );
      const thread = await seedThread(client, organizationId, "NATIVE");
      const comment = await seedComment(client, thread, {
        type: "doc",
        content: [],
      });
      await insertSyncState(client, organizationId, { threadId: thread });
      await insertSyncState(client, organizationId, { commentId: comment });
      // Another direction or provider is another row.
      await insertSyncState(client, organizationId, {
        threadId: thread,
        direction: "OUTBOUND",
      });
      await insertSyncState(client, organizationId, {
        threadId: thread,
        provider: "GITHUB",
      });

      await client.query("SAVEPOINT thread_dup");
      await expect(
        insertSyncState(client, organizationId, { threadId: thread })
      ).rejects.toThrow(THREAD_UNIQUE_RE);
      await client.query("ROLLBACK TO SAVEPOINT thread_dup");

      await client.query("SAVEPOINT comment_dup");
      await expect(
        insertSyncState(client, organizationId, { commentId: comment })
      ).rejects.toThrow(COMMENT_UNIQUE_RE);
      await client.query("ROLLBACK TO SAVEPOINT comment_dup");
    });

    it("is deleted with the thread it tracks", async () => {
      const { organizationId } = await seedSessionDetailParents(
        client,
        "iss11212"
      );
      const thread = await seedThread(client, organizationId, "NATIVE");
      await insertSyncState(client, organizationId, { threadId: thread });

      await client.query("DELETE FROM comment_threads WHERE id = $1", [thread]);

      const { rows } = await client.query(
        "SELECT 1 FROM comment_sync_states WHERE thread_id = $1",
        [thread]
      );
      expect(rows).toHaveLength(0);
    });
  });
});

async function seedThread(
  client: Client,
  organizationId: string,
  source: "NATIVE" | "GITHUB" | "LIVEBLOCKS",
  metadata: unknown = null
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO comment_threads (id, organization_id, source, metadata, updated_at)
     VALUES ($1, $2, $3::"ThreadSource", $4::jsonb, now())`,
    [
      id,
      organizationId,
      source,
      metadata === null ? null : JSON.stringify(metadata),
    ]
  );
  return id;
}

async function seedComment(
  client: Client,
  threadId: string,
  body: unknown,
  bodyFormat: string | null = "RICH_V1",
  plainText: string | null = null
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO comments (id, thread_id, author_id, body, body_format, plain_text, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::"CommentBodyFormat", $6, now())`,
    [id, threadId, randomUUID(), JSON.stringify(body), bodyFormat, plainText]
  );
  return id;
}

async function insertSyncState(
  client: Client,
  organizationId: string,
  target: {
    threadId?: string;
    commentId?: string;
    provider?: string;
    direction?: string;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO comment_sync_states
       (id, organization_id, thread_id, comment_id, provider, direction, state, updated_at)
     VALUES ($1, $2, $3, $4, $5::"CommentSyncProvider", $6::"CommentSyncDirection", 'ABANDONED', now())`,
    [
      randomUUID(),
      organizationId,
      target.threadId ?? null,
      target.commentId ?? null,
      target.provider ?? "DESKTOP",
      target.direction ?? "INBOUND",
    ]
  );
}

async function readBodyFormat(
  client: Client,
  commentId: string
): Promise<string | null> {
  const { rows } = await client.query<{ body_format: string | null }>(
    "SELECT body_format FROM comments WHERE id = $1",
    [commentId]
  );
  if (rows.length !== 1) {
    throw new Error(`expected one comments row for ${commentId}`);
  }
  return rows[0].body_format;
}

async function backdate(client: Client, threadId: string): Promise<void> {
  await client.query(
    "UPDATE comment_threads SET updated_at = TIMESTAMP '2020-01-01 00:00:00' WHERE id = $1",
    [threadId]
  );
}

async function readThread(
  client: Client,
  threadId: string
): Promise<{
  anchor: unknown;
  anchor_state: string | null;
  metadata: unknown;
  updated_at: Date;
}> {
  const { rows } = await client.query<{
    anchor: unknown;
    anchor_state: string | null;
    metadata: unknown;
    updated_at: Date;
  }>(
    "SELECT anchor, anchor_state, metadata, updated_at FROM comment_threads WHERE id = $1",
    [threadId]
  );
  if (rows.length !== 1) {
    throw new Error(`expected one comment_threads row for ${threadId}`);
  }
  return rows[0];
}

async function readBody(client: Client, commentId: string): Promise<unknown> {
  const { rows } = await client.query<{ body: unknown }>(
    "SELECT body FROM comments WHERE id = $1",
    [commentId]
  );
  if (rows.length !== 1) {
    throw new Error(`expected one comments row for ${commentId}`);
  }
  return rows[0].body;
}
