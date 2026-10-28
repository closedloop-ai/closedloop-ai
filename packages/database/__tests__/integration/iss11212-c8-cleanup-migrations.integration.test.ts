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
 * ISS-11212 (PLN-2120 Step 6, PLN-2121 Step 6): the cleanup migrations against
 * real Postgres. The database under test is already migrated, so each data step
 * is cut out of the SHIPPED file by its begin/end markers and re-run over rows
 * seeded in the pre-migration shape. Every case runs in a transaction that is
 * rolled back.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const SYNC_ABANDONED_BACKFILL =
  "20261006120000_iss11212_comment_sync_abandoned_backfill";
const ARTIFACT_REQUIRED =
  "20261006120100_iss11212_comment_thread_artifact_required";

const ARTIFACT_NOT_NULL_RE = /null value in column "artifact_id"/;
const BODY_FORMAT_NOT_NULL_RE = /null value in column "body_format"/;

const traceMetadata = {
  kind: "trace_comment",
  schemaVersion: 1,
  targetType: "session",
  surface: "session_detail",
};

/** One hand-written step of a shipped migration, verbatim, between its markers. */
function step(migration: string, name: string): string {
  const sql = readFileSync(
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
  const begin = `-- ISS-11212 ${name} begin`;
  const end = `-- ISS-11212 ${name} end`;
  const start = sql.indexOf(begin);
  const stop = sql.indexOf(end);
  if (start < 0 || stop < start) {
    throw new Error(`${migration}: ${name} markers not found`);
  }
  return sql.slice(start + begin.length, stop);
}

describe.skipIf(!DATABASE_URL)("ISS-11212 cleanup migrations", () => {
  let client: Client;
  let organizationId: string;
  let artifactId: string;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    ({ organizationId } = await seedSessionDetailParents(
      client,
      "iss11212-c8"
    ));
    artifactId = await seedArtifact(client, organizationId, "ISS-1");
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  describe("the syncAbandoned backfill", () => {
    it("moves each legacy dead letter into its sync-state row and strips the key", async () => {
      const abandoned = await seedThread(client, {
        organizationId,
        artifactId,
        metadata: { ...traceMetadata, syncAbandoned: true, keep: "yes" },
      });
      const alreadyRecorded = await seedThread(client, {
        organizationId,
        artifactId,
        metadata: { ...traceMetadata, syncAbandoned: true },
      });
      await insertSyncState(client, organizationId, alreadyRecorded, "SYNCED");
      const notAbandoned = await seedThread(client, {
        organizationId,
        artifactId,
        metadata: { ...traceMetadata, syncAbandoned: false },
      });
      const liveblocks = await seedThread(client, {
        organizationId,
        artifactId,
        source: "LIVEBLOCKS",
        metadata: { syncAbandoned: true },
      });

      await client.query(
        step(SYNC_ABANDONED_BACKFILL, "sync abandoned backfill")
      );

      expect(await readThread(client, abandoned)).toEqual({
        metadata: { ...traceMetadata, keep: "yes" },
        updatedAt: "2020-01-01 00:00:00",
        syncStates: [
          {
            organization_id: organizationId,
            provider: "DESKTOP",
            direction: "INBOUND",
            state: "ABANDONED",
          },
        ],
      });
      // The row the new write path made is newer than the key, so it stands.
      expect(await readThread(client, alreadyRecorded)).toMatchObject({
        metadata: traceMetadata,
        syncStates: [expect.objectContaining({ state: "SYNCED" })],
      });
      expect(await readThread(client, notAbandoned)).toMatchObject({
        metadata: traceMetadata,
        syncStates: [],
      });
      expect(await readThread(client, liveblocks)).toMatchObject({
        metadata: { syncAbandoned: true },
        syncStates: [],
      });
    });

    it("converges when a retry follows an insert whose strip did not commit", async () => {
      const abandoned = await seedThread(client, {
        organizationId,
        artifactId,
        metadata: { ...traceMetadata, syncAbandoned: true },
      });
      const backfill = step(SYNC_ABANDONED_BACKFILL, "sync abandoned backfill");
      await client.query(backfill);
      const first = await readThread(client, abandoned);
      // Each statement commits on its own, so a failed apply can leave the row
      // written and the key still in place.
      await client.query(
        `UPDATE comment_threads
            SET metadata = metadata || '{"syncAbandoned": true}'::jsonb
          WHERE id = $1`,
        [abandoned]
      );

      await client.query(backfill);

      expect(await readThread(client, abandoned)).toEqual(first);
    });
  });

  describe("the orphan disposition before artifact_id becomes NOT NULL", () => {
    beforeEach(async () => {
      // The pre-migration shape.
      await client.query(
        "ALTER TABLE comment_threads ALTER COLUMN artifact_id DROP NOT NULL"
      );
    });

    function orphan(roomId: string | null, owner = organizationId) {
      return seedThread(client, {
        organizationId: owner,
        artifactId: null,
        source: "LIVEBLOCKS",
        roomId,
      });
    }

    async function runDisposition(): Promise<void> {
      await client.query(step(ARTIFACT_REQUIRED, "orphan attach"));
      await client.query(step(ARTIFACT_REQUIRED, "orphan delete"));
    }

    it("attaches a thread whose room resolves in its own organization, in either namespace", async () => {
      const artifactRoom = await orphan(`${organizationId}:artifact:ISS-1`);
      const documentRoom = await orphan(`${organizationId}:document:ISS-1`);
      const attached = await seedThread(client, {
        organizationId,
        artifactId,
        source: "LIVEBLOCKS",
        roomId: `${organizationId}:artifact:ISS-1`,
      });

      await runDisposition();

      expect(
        await readArtifactIds(client, [artifactRoom, documentRoom, attached])
      ).toEqual(
        new Map([
          [artifactRoom, artifactId],
          [documentRoom, artifactId],
          [attached, artifactId],
        ])
      );
    });

    it("deletes every thread whose room does not resolve, with its comments and sync state", async () => {
      const other = await seedSessionDetailParents(client, "iss11212-c8-other");
      await seedArtifact(client, other.organizationId, "ISS-2");
      const unknownSlug = await orphan(`${organizationId}:artifact:NOPE`);
      const noRoom = await orphan(null);
      const otherOrgSlug = await orphan(`${organizationId}:artifact:ISS-2`);
      const badNamespace = await orphan(`${organizationId}:foo:ISS-1`);
      const fourParts = await orphan(`${organizationId}:artifact:ISS-1:extra`);
      const commentId = await seedComment(client, unknownSlug);
      await client.query(
        `INSERT INTO comment_reactions (id, comment_id, user_id, emoji)
         VALUES ($1, $2, $3, ':+1:')`,
        [randomUUID(), commentId, randomUUID()]
      );
      await client.query(
        `INSERT INTO comment_sync_states
           (id, organization_id, comment_id, provider, direction, state, updated_at)
         VALUES ($1, $2, $3, 'LIVEBLOCKS', 'OUTBOUND', 'PENDING', now())`,
        [randomUUID(), organizationId, commentId]
      );

      await runDisposition();

      expect(
        await readArtifactIds(client, [
          unknownSlug,
          noRoom,
          otherOrgSlug,
          badNamespace,
          fourParts,
        ])
      ).toEqual(new Map());
      const { rows } = await client.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM comments WHERE id = $1)
              + (SELECT count(*) FROM comment_reactions WHERE comment_id = $1)
              + (SELECT count(*) FROM comment_sync_states WHERE comment_id = $1) AS n`,
        [commentId]
      );
      expect(Number(rows[0].n)).toBe(0);
    });
  });

  describe("after the migrations", () => {
    it("refuses a thread without an artifact and keeps no helper CHECK", async () => {
      const { rows } = await client.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'comment_threads' AND column_name = 'artifact_id'`
      );
      expect(rows).toEqual([{ is_nullable: "NO" }]);
      const { rows: checks } = await client.query(
        "SELECT 1 FROM pg_constraint WHERE conname = 'comment_threads_artifact_id_not_null'"
      );
      expect(checks).toHaveLength(0);

      await client.query("SAVEPOINT no_artifact");
      await expect(
        seedThread(client, { organizationId, artifactId: null })
      ).rejects.toThrow(ARTIFACT_NOT_NULL_RE);
      await client.query("ROLLBACK TO SAVEPOINT no_artifact");
    });

    it("has no ISS-11212 bridge left to fill a write the old bundles skipped", async () => {
      const { rows } = await client.query<{ name: string }>(
        `SELECT tgname AS name FROM pg_trigger WHERE tgname LIKE '%iss11212%'
         UNION ALL
         SELECT proname FROM pg_proc WHERE proname LIKE 'iss11212%'`
      );
      expect(rows).toEqual([]);

      const threadId = await seedThread(client, {
        organizationId,
        artifactId,
        metadata: { ...traceMetadata, anchor: { row: 0 } },
      });
      expect(await readAnchorColumns(client, threadId)).toEqual({
        anchor: null,
        metadata: { ...traceMetadata, anchor: { row: 0 } },
      });
      await client.query("SAVEPOINT no_body_format");
      await expect(seedComment(client, threadId, null)).rejects.toThrow(
        BODY_FORMAT_NOT_NULL_RE
      );
      await client.query("ROLLBACK TO SAVEPOINT no_body_format");
    });

    it("keeps the due index and drops the one it superseded", async () => {
      const { rows } = await client.query<{ name: string; valid: boolean }>(
        `SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname IN (
            'pull_request_detail_pr_state_comments_reconciled_at_idx',
            'pull_request_detail_comments_reconcile_due_idx'
          )`
      );
      expect(rows).toEqual([
        { name: "pull_request_detail_comments_reconcile_due_idx", valid: true },
      ]);
    });
  });
});

async function seedArtifact(
  client: Client,
  organizationId: string,
  slug: string
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO artifacts (id, organization_id, type, name, status, slug, updated_at)
     VALUES ($1, $2, 'BRANCH', $3, 'ACTIVE', $3, now())`,
    [id, organizationId, slug]
  );
  return id;
}

async function seedThread(
  client: Client,
  thread: {
    organizationId: string;
    artifactId: string | null;
    source?: "NATIVE" | "LIVEBLOCKS";
    roomId?: string | null;
    metadata?: unknown;
  }
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO comment_threads
       (id, organization_id, source, room_id, artifact_id, metadata, updated_at)
     VALUES ($1, $2, $3::"ThreadSource", $4, $5, $6::jsonb, '2020-01-01 00:00:00')`,
    [
      id,
      thread.organizationId,
      thread.source ?? "NATIVE",
      thread.roomId ?? null,
      thread.artifactId,
      thread.metadata === undefined ? null : JSON.stringify(thread.metadata),
    ]
  );
  return id;
}

async function seedComment(
  client: Client,
  threadId: string,
  bodyFormat: string | null = "LIVEBLOCKS_V1"
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO comments (id, thread_id, author_id, body, body_format, updated_at)
     VALUES ($1, $2, $3, '{"type":"doc","content":[]}', $4::"CommentBodyFormat", now())`,
    [id, threadId, randomUUID(), bodyFormat]
  );
  return id;
}

async function insertSyncState(
  client: Client,
  organizationId: string,
  threadId: string,
  state: string
): Promise<void> {
  await client.query(
    `INSERT INTO comment_sync_states
       (id, organization_id, thread_id, provider, direction, state, updated_at)
     VALUES ($1, $2, $3, 'DESKTOP', 'INBOUND', $4::"CommentSyncStatus", now())`,
    [randomUUID(), organizationId, threadId, state]
  );
}

async function readThread(
  client: Client,
  threadId: string
): Promise<{ metadata: unknown; updatedAt: string; syncStates: unknown[] }> {
  const { rows } = await client.query<{
    metadata: unknown;
    updated_at: string;
  }>(
    "SELECT metadata, updated_at::text AS updated_at FROM comment_threads WHERE id = $1",
    [threadId]
  );
  if (rows.length !== 1) {
    throw new Error(`expected one comment_threads row for ${threadId}`);
  }
  const { rows: syncStates } = await client.query(
    `SELECT organization_id, provider, direction, state FROM comment_sync_states
      WHERE thread_id = $1 ORDER BY provider, direction`,
    [threadId]
  );
  return {
    metadata: rows[0].metadata,
    updatedAt: rows[0].updated_at,
    syncStates,
  };
}

/** The artifact id of each thread that still exists. */
async function readArtifactIds(
  client: Client,
  threadIds: string[]
): Promise<Map<string, string | null>> {
  const { rows } = await client.query<{
    id: string;
    artifact_id: string | null;
  }>("SELECT id, artifact_id FROM comment_threads WHERE id = ANY($1::uuid[])", [
    threadIds,
  ]);
  return new Map(rows.map((row) => [row.id, row.artifact_id]));
}

async function readAnchorColumns(
  client: Client,
  threadId: string
): Promise<{ anchor: unknown; metadata: unknown }> {
  const { rows } = await client.query<{ anchor: unknown; metadata: unknown }>(
    "SELECT anchor, metadata FROM comment_threads WHERE id = $1",
    [threadId]
  );
  return rows[0];
}
