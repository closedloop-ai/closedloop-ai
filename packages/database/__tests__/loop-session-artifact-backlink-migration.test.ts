/**
 * FEA-1718 back-link migrations — the DDL contract of the `source_loop_id`
 * index, plus BEHAVIOURAL coverage of the `loops.session_artifact_id` backfill
 * run verbatim against a REAL Postgres.
 *
 * The behavioural half is not optional here: the backfill's whole job is to
 * populate a UNIQUELY-indexed column from a many-to-one source, so the only
 * meaningful assertions are "does it violate the constraint" and "does it pick
 * the right row" — neither of which a text scan can answer. Each case seeds its
 * own fixture inside a transaction that is always rolled back.
 *
 * Skips when DATABASE_URL is unset (local runs without `docker compose up -d`).
 */
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

const INDEX_MIGRATION_DIR =
  "20260811130000_session_detail_source_loop_id_index";
const BACKFILL_MIGRATION_DIR =
  "20260811130100_backfill_loop_session_artifact_id";

function readMigration(dir: string): string {
  return readFileSync(
    join(
      import.meta.dirname,
      "..",
      "prisma",
      "migrations",
      dir,
      "migration.sql"
    ),
    "utf8"
  );
}

const INDEX_SQL = readMigration(INDEX_MIGRATION_DIR);
const BACKFILL_SQL = readMigration(BACKFILL_MIGRATION_DIR);

const INDEX_NAME = "session_detail_source_loop_id_idx";
const INDEXED_TABLE = "session_detail";

const CREATE_INDEX_RE =
  /CREATE INDEX(?<concurrently>\s+CONCURRENTLY)?(?<ifNotExists>\s+IF NOT EXISTS)?\s+"(?<name>[a-z_]+)"\s+ON\s+"(?<table>[a-z_]+)"\((?<columns>[^)]*)\)/;
const DESTRUCTIVE_RE = /\b(DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE)\b/i;
const UPDATE_LOOPS_RE = /UPDATE\s+"loops"/;
const SOURCE_LOOP_ID_UUID_CAST_RE = /source_loop_id"?::uuid/;
const TRANSACTION_RE = /\b(BEGIN|COMMIT|START\s+TRANSACTION)\b/i;
const DOLLAR_QUOTE_RE = /\$[A-Za-z_]*\$/;
const LINE_COMMENT_RE = /--[^\n]*/g;

/** Every assertion below is about SQL, so the header prose is stripped first. */
function stripComments(sql: string): string {
  return sql.replaceAll(LINE_COMMENT_RE, "");
}

const DATABASE_URL = process.env.DATABASE_URL;

const ORG_ID = "019f1000-0000-7000-8000-000000000001";
const OTHER_ORG_ID = "019f1000-0000-7000-8000-000000000002";
const USER_ID = "019f1000-0000-7000-8000-000000000003";
const OTHER_USER_ID = "019f1000-0000-7000-8000-000000000004";
const TARGET_ID = "019f1000-0000-7000-8000-000000000005";

const LOOP_UNLINKED = "019f1000-0000-7000-8000-000000000010";
const LOOP_ALREADY_LINKED = "019f1000-0000-7000-8000-000000000011";
const LOOP_MULTI_SESSION = "019f1000-0000-7000-8000-000000000012";
const LOOP_NO_SESSION = "019f1000-0000-7000-8000-000000000013";
const LOOP_FOREIGN_ORG = "019f1000-0000-7000-8000-000000000014";

const SESSION_SIMPLE = "019f1000-0000-7000-8000-000000000020";
const SESSION_PREEXISTING = "019f1000-0000-7000-8000-000000000021";
const SESSION_EARLIEST = "019f1000-0000-7000-8000-000000000022";
const SESSION_LATER = "019f1000-0000-7000-8000-000000000023";
const SESSION_ORPHAN_LOOP_REF = "019f1000-0000-7000-8000-000000000024";
const SESSION_CROSS_ORG = "019f1000-0000-7000-8000-000000000025";

const AT = "2026-08-01T12:00:00.000Z";

async function seedTenants(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO organizations (id, clerk_id, name, slug, updated_at)
     VALUES ($1, 'org_backlink_a', 'Backlink A', 'backlink-a', $3),
            ($2, 'org_backlink_b', 'Backlink B', 'backlink-b', $3)`,
    [ORG_ID, OTHER_ORG_ID, AT]
  );
  await client.query(
    `INSERT INTO users (id, clerk_id, organization_id, email, updated_at)
     VALUES ($1, 'user_backlink_a', $3, 'a@example.com', $5),
            ($2, 'user_backlink_b', $4, 'b@example.com', $5)`,
    [USER_ID, OTHER_USER_ID, ORG_ID, OTHER_ORG_ID, AT]
  );
  await client.query(
    `INSERT INTO compute_targets
       (id, organization_id, user_id, machine_name, platform, updated_at)
     VALUES ($1, $2, $3, 'backlink-machine', 'darwin', $4)`,
    [TARGET_ID, ORG_ID, USER_ID, AT]
  );
}

async function insertLoop(
  client: Client,
  loopId: string,
  options: { organizationId?: string; sessionArtifactId?: string } = {}
): Promise<void> {
  await client.query(
    `INSERT INTO loops
       (id, organization_id, user_id, command, session_artifact_id, updated_at)
     VALUES ($1, $2, $3, 'EXECUTE', $4, $5)`,
    [
      loopId,
      options.organizationId ?? ORG_ID,
      options.organizationId === OTHER_ORG_ID ? OTHER_USER_ID : USER_ID,
      options.sessionArtifactId ?? null,
      AT,
    ]
  );
}

async function insertSession(
  client: Client,
  artifactId: string,
  options: {
    artifactType?: string;
    organizationId?: string;
    sourceLoopId: string | null;
    startedAt?: string;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO artifacts
       (id, organization_id, type, name, status, updated_at)
     VALUES ($1, $2, $5::"ArtifactType", $3, 'active', $4)`,
    [
      artifactId,
      options.organizationId ?? ORG_ID,
      `Session ${artifactId}`,
      AT,
      options.artifactType ?? "SESSION",
    ]
  );
  await client.query(
    `INSERT INTO session_detail
       (artifact_id, compute_target_id, external_session_id, source_loop_id,
        session_started_at, session_updated_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [
      artifactId,
      TARGET_ID,
      `ext-${artifactId}`,
      options.sourceLoopId,
      options.startedAt ?? AT,
      AT,
    ]
  );
}

async function readSessionOrigin(
  client: Client,
  artifactId: string
): Promise<string | null> {
  const result = await client.query<{ origin: string }>(
    "SELECT origin FROM session_detail WHERE artifact_id = $1",
    [artifactId]
  );
  return result.rows[0]?.origin ?? null;
}

async function readLoopLink(
  client: Client,
  loopId: string
): Promise<string | null> {
  const result = await client.query<{ session_artifact_id: string | null }>(
    "SELECT session_artifact_id FROM loops WHERE id = $1",
    [loopId]
  );
  return result.rows[0]?.session_artifact_id ?? null;
}

describe(`${INDEX_MIGRATION_DIR} DDL contract`, () => {
  it("builds the index CONCURRENTLY, without IF NOT EXISTS", () => {
    const match = CREATE_INDEX_RE.exec(INDEX_SQL);
    expect(match?.groups?.name).toBe(INDEX_NAME);
    expect(match?.groups?.table).toBe(INDEXED_TABLE);
    // CONCURRENTLY: no write-blocking ACCESS EXCLUSIVE lock on the hot
    // session-ingest table while the index builds.
    expect(match?.groups?.concurrently).toBeDefined();
    // No IF NOT EXISTS: a retry must fail closed on an INVALID remnant rather
    // than record the migration applied over a permanently-unusable index.
    expect(match?.groups?.ifNotExists).toBeUndefined();
  });

  it("indexes exactly source_loop_id", () => {
    const columns = CREATE_INDEX_RE.exec(INDEX_SQL)
      ?.groups?.columns.split(",")
      .map((column) => column.trim().replaceAll('"', ""));
    expect(columns).toEqual(["source_loop_id"]);
  });

  it("keeps the file to the one bare statement a CONCURRENTLY build survives", () => {
    // A BEGIN/COMMIT or a dollar-quoted block pushes the whole file onto
    // Prisma's single-transaction fallback, where CONCURRENTLY fails 25001.
    const statements = stripComments(INDEX_SQL)
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    expect(statements).toHaveLength(1);
    expect(stripComments(INDEX_SQL)).not.toMatch(TRANSACTION_RE);
    expect(stripComments(INDEX_SQL)).not.toMatch(DOLLAR_QUOTE_RE);
  });

  it("sorts before the backfill so the backfill can use the index", () => {
    // `prisma migrate deploy` applies pending migrations in lexicographic
    // directory order; the backfill groups the whole source_loop_id column.
    expect(INDEX_MIGRATION_DIR < BACKFILL_MIGRATION_DIR).toBe(true);
  });
});

describe(`${BACKFILL_MIGRATION_DIR} DDL contract`, () => {
  it("is two additive UPDATEs with no destructive statement", () => {
    const code = stripComments(BACKFILL_SQL);
    expect(code).toMatch(UPDATE_LOOPS_RE);
    expect(code).not.toMatch(DESTRUCTIVE_RE);
    const statements = code
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    // Statement 1 marks origin (retention exemption), statement 2 links.
    expect(statements).toHaveLength(2);
  });

  it("asserts the SESSION-only invariant on the linking statement itself", () => {
    // Per-statement, not a global substring check: the org join proves WHOSE
    // artifact it is, never WHAT it is, and only the second statement writes
    // Loop.sessionArtifactId.
    const linkStatement = stripComments(BACKFILL_SQL)
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0)
      .find((statement) => UPDATE_LOOPS_RE.test(statement));
    expect(linkStatement).toBeDefined();
    expect(linkStatement).toContain(`a."type" = 'SESSION'`);
  });

  it("casts the uuid side, never the free-text source_loop_id", () => {
    // Casting `source_loop_id::uuid` would raise 22P02 on the first malformed
    // value and abort the whole migration; a uuid always casts to text.
    const code = stripComments(BACKFILL_SQL);
    expect(code).toContain('"id"::text');
    expect(code).not.toMatch(SOURCE_LOOP_ID_UUID_CAST_RE);
  });
});

describe.skipIf(!DATABASE_URL)(`${BACKFILL_MIGRATION_DIR} behaviour`, () => {
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
    await seedTenants(client);
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  it("links a loop whose session already records it", async () => {
    await insertLoop(client, LOOP_UNLINKED);
    await insertSession(client, SESSION_SIMPLE, {
      sourceLoopId: LOOP_UNLINKED,
    });

    await client.query(BACKFILL_SQL);

    expect(await readLoopLink(client, LOOP_UNLINKED)).toBe(SESSION_SIMPLE);
  });

  it("picks the earliest session when several claim one loop", async () => {
    // `session_artifact_id` is UNIQUE, so exactly one of the two must win —
    // and it must be the one that actually materialized the loop.
    await insertLoop(client, LOOP_MULTI_SESSION);
    await insertSession(client, SESSION_LATER, {
      sourceLoopId: LOOP_MULTI_SESSION,
      startedAt: "2026-08-02T12:00:00.000Z",
    });
    await insertSession(client, SESSION_EARLIEST, {
      sourceLoopId: LOOP_MULTI_SESSION,
      startedAt: "2026-08-01T09:00:00.000Z",
    });

    await client.query(BACKFILL_SQL);

    expect(await readLoopLink(client, LOOP_MULTI_SESSION)).toBe(
      SESSION_EARLIEST
    );
  });

  it("never overwrites a link the application already made", async () => {
    await insertSession(client, SESSION_PREEXISTING, { sourceLoopId: null });
    await insertLoop(client, LOOP_ALREADY_LINKED, {
      sessionArtifactId: SESSION_PREEXISTING,
    });
    await insertSession(client, SESSION_SIMPLE, {
      sourceLoopId: LOOP_ALREADY_LINKED,
    });

    await client.query(BACKFILL_SQL);

    expect(await readLoopLink(client, LOOP_ALREADY_LINKED)).toBe(
      SESSION_PREEXISTING
    );
  });

  it("skips a loop whose session artifact another loop already holds", async () => {
    // Reachable when a session's attributed loop changed between syncs: the
    // artifact is spoken for, and `session_artifact_id` is UNIQUE, so an
    // unguarded UPDATE here raises 23505 and aborts the whole migration.
    await insertSession(client, SESSION_PREEXISTING, {
      sourceLoopId: LOOP_UNLINKED,
    });
    await insertLoop(client, LOOP_ALREADY_LINKED, {
      sessionArtifactId: SESSION_PREEXISTING,
    });
    await insertLoop(client, LOOP_UNLINKED);

    await client.query(BACKFILL_SQL);

    expect(await readLoopLink(client, LOOP_UNLINKED)).toBeNull();
    expect(await readLoopLink(client, LOOP_ALREADY_LINKED)).toBe(
      SESSION_PREEXISTING
    );
  });

  it("leaves a loop with no materialized session alone", async () => {
    await insertLoop(client, LOOP_NO_SESSION);

    await client.query(BACKFILL_SQL);

    expect(await readLoopLink(client, LOOP_NO_SESSION)).toBeNull();
  });

  it("does not link across organizations", async () => {
    await insertLoop(client, LOOP_FOREIGN_ORG, {
      organizationId: OTHER_ORG_ID,
    });
    await insertSession(client, SESSION_CROSS_ORG, {
      sourceLoopId: LOOP_FOREIGN_ORG,
    });

    await client.query(BACKFILL_SQL);

    expect(await readLoopLink(client, LOOP_FOREIGN_ORG)).toBeNull();
  });

  it("tolerates a source_loop_id that is not a uuid at all", async () => {
    // The column is free text fed from a desktop payload, so a cast on that
    // side would abort the migration rather than skip the row.
    await insertLoop(client, LOOP_UNLINKED);
    await insertSession(client, SESSION_ORPHAN_LOOP_REF, {
      sourceLoopId: "loop-1",
    });
    await insertSession(client, SESSION_SIMPLE, {
      sourceLoopId: LOOP_UNLINKED,
    });

    await client.query(BACKFILL_SQL);

    expect(await readLoopLink(client, LOOP_UNLINKED)).toBe(SESSION_SIMPLE);
  });

  // wongk (review): session_detail.artifact_id is only an FK into the POLYMORPHIC
  // artifacts table, so a malformed persisted row can point at a FEATURE or
  // DOCUMENT. The org join proves ownership, never type.
  it("never links a non-SESSION artifact to a loop", async () => {
    await insertLoop(client, LOOP_UNLINKED);
    await insertSession(client, SESSION_ORPHAN_LOOP_REF, {
      artifactType: "DOCUMENT",
      sourceLoopId: LOOP_UNLINKED,
      startedAt: "2026-07-01T00:00:00.000Z",
    });

    await client.query(BACKFILL_SQL);

    expect(await readLoopLink(client, LOOP_UNLINKED)).toBeNull();
  });

  it("lets a valid session win a loop a malformed row also claims", async () => {
    // The type filter lives INSIDE the candidate CTE, so the malformed row is
    // excluded from the pick rather than becoming the earliest candidate and
    // suppressing the real session.
    await insertLoop(client, LOOP_MULTI_SESSION);
    await insertSession(client, SESSION_ORPHAN_LOOP_REF, {
      artifactType: "DOCUMENT",
      sourceLoopId: LOOP_MULTI_SESSION,
      startedAt: "2026-07-01T00:00:00.000Z",
    });
    await insertSession(client, SESSION_EARLIEST, {
      sourceLoopId: LOOP_MULTI_SESSION,
      startedAt: "2026-08-01T09:00:00.000Z",
    });

    await client.query(BACKFILL_SQL);

    expect(await readLoopLink(client, LOOP_MULTI_SESSION)).toBe(
      SESSION_EARLIEST
    );
  });

  // wongk (review): without this the phantom sweep deletes the artifact and
  // ON DELETE SET NULL erases the back-link inside a retention window.
  it("marks backfilled loop-materialized rows as LOOP origin", async () => {
    await insertLoop(client, LOOP_MULTI_SESSION);
    await insertSession(client, SESSION_EARLIEST, {
      sourceLoopId: LOOP_MULTI_SESSION,
      startedAt: "2026-08-01T09:00:00.000Z",
    });
    await insertSession(client, SESSION_LATER, {
      sourceLoopId: LOOP_MULTI_SESSION,
      startedAt: "2026-08-02T12:00:00.000Z",
    });

    await client.query(BACKFILL_SQL);

    expect(await readSessionOrigin(client, SESSION_EARLIEST)).toBe("LOOP");
    // The runner-up is still loop-materialized, so it must not be swept as
    // ephemeral desktop scratch either.
    expect(await readSessionOrigin(client, SESSION_LATER)).toBe("LOOP");
  });

  it("leaves origin alone for a cross-org or malformed claim", async () => {
    await insertLoop(client, LOOP_FOREIGN_ORG, {
      organizationId: OTHER_ORG_ID,
    });
    await insertSession(client, SESSION_CROSS_ORG, {
      sourceLoopId: LOOP_FOREIGN_ORG,
    });
    await insertLoop(client, LOOP_UNLINKED);
    await insertSession(client, SESSION_ORPHAN_LOOP_REF, {
      artifactType: "DOCUMENT",
      sourceLoopId: LOOP_UNLINKED,
    });

    await client.query(BACKFILL_SQL);

    expect(await readSessionOrigin(client, SESSION_CROSS_ORG)).toBe(
      "DESKTOP_SYNC"
    );
    expect(await readSessionOrigin(client, SESSION_ORPHAN_LOOP_REF)).toBe(
      "DESKTOP_SYNC"
    );
  });

  it("is re-runnable", async () => {
    await insertLoop(client, LOOP_UNLINKED);
    await insertSession(client, SESSION_EARLIEST, {
      sourceLoopId: LOOP_UNLINKED,
      startedAt: "2026-08-01T09:00:00.000Z",
    });

    await client.query(BACKFILL_SQL);
    await insertSession(client, SESSION_LATER, {
      sourceLoopId: LOOP_UNLINKED,
      startedAt: "2026-08-02T12:00:00.000Z",
    });
    // A second application must not trip the unique index by re-picking a
    // different winner now that a newer session claims the same loop.
    await client.query(BACKFILL_SQL);

    expect(await readLoopLink(client, LOOP_UNLINKED)).toBe(SESSION_EARLIEST);
  });
});
