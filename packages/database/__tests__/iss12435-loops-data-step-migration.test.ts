/**
 * ISS-12435 (PRD-795): behavioural coverage for the Loops data step:
 * `20261013180100_iss12435_backfill_session_cost_from_loops` then
 * `20261013180200_iss12435_empty_loops_data`.
 *
 * Runs the committed migration SQL verbatim against a REAL Postgres (the
 * migrated database the CI `test-shard` job provisions), inside a transaction
 * that is always rolled back. Only a real database can prove what matters
 * here: the session cost and cost-split ledger are copied out of the Loop rows
 * BEFORE those rows are deleted, a stored figure is never overwritten, a
 * free-text pointer or malformed block does not raise, and the RESTRICT self
 * reference on `loops.parent_loop_id` does not block the delete.
 *
 * The behavioural cases skip when DATABASE_URL is unset (local runs without a
 * database); the text pin over the three migration files always runs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { SESSION_FRUSTRATION_SETTING_KEY } from "@repo/api/src/types/settings";
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
import { PreferredComputeMode } from "../generated/enums";

function readMigration(name: string): string {
  return readFileSync(
    join(
      import.meta.dirname,
      "..",
      "prisma",
      "migrations",
      name,
      "migration.sql"
    ),
    "utf8"
  );
}

const CARRIER_SQL = readMigration(
  "20261013180000_iss12435_session_legacy_loop_cost_ledger"
);
const BACKFILL_SQL = readMigration(
  "20261013180100_iss12435_backfill_session_cost_from_loops"
);
const EMPTY_SQL = readMigration("20261013180200_iss12435_empty_loops_data");
const STATUS_SYNC_SQL = readMigration(
  "20260921132329_iss9938_search_document_status_sync_triggers"
);
const LOOP_TRIGGER_START = 'CREATE FUNCTION "sync_search_document_loop_status"';
const LOOP_TRIGGER_END =
  'EXECUTE FUNCTION "sync_search_document_loop_status"();';

const SQL_LINE_COMMENT_RE = /--.*$/gm;
const DESTRUCTIVE_DDL_RE =
  /\b(?:DROP\s+TABLE|DROP\s+COLUMN|RENAME|ALTER\s+TYPE|TRUNCATE)\b/i;
const DROP_OTHER_THAN_TRIGGER_OR_FUNCTION_RE =
  /\bDROP\s+(?!TRIGGER\b|FUNCTION\b)\w+/i;

const DATABASE_URL = process.env.DATABASE_URL;

const ORG_ID = "019f1243-0000-7000-8000-000000000001";
const USER_ID = "019f1243-0000-7000-8000-000000000002";
const TARGET_ID = "019f1243-0000-7000-8000-000000000003";
const DOCUMENT_ID = "019f1243-0000-7000-8000-000000000004";
const OTHER_ORG_ID = "019f1243-0000-7000-8000-000000000005";
const OTHER_USER_ID = "019f1243-0000-7000-8000-000000000006";
/**
 * Claimed by the subscription loop; no stored cost yet. Its pointer is upper
 * case, which the cost read matched (it compared lower case) and the cost-split
 * classifier did not (an exact-text Map lookup).
 */
const CLAIMED_SESSION_ID = "019f1243-0000-7000-8000-000000000010";
/** Claimed by the metered loop; already carries a Desktop figure. */
const STORED_SESSION_ID = "019f1243-0000-7000-8000-000000000011";
/** A pointer that is not a uuid at all. */
const FREE_TEXT_SESSION_ID = "019f1243-0000-7000-8000-000000000012";
/** A Desktop session with no loop: must come through untouched. */
const DESKTOP_SESSION_ID = "019f1243-0000-7000-8000-000000000013";
/** Points at the subscription loop in its canonical spelling; not claimed. */
const POINTER_SESSION_ID = "019f1243-0000-7000-8000-000000000014";
const SUBSCRIPTION_LOOP_ID = "019f1243-0000-7000-8000-000000000020";
const METERED_LOOP_ID = "019f1243-0000-7000-8000-000000000021";
const CHILD_LOOP_ID = "019f1243-0000-7000-8000-000000000022";
/** First synced by older API code after the backfill ran, before the cleanup. */
const LATE_SESSION_ID = "019f1243-0000-7000-8000-000000000015";
const LATE_LOOP_ID = "019f1243-0000-7000-8000-000000000023";
const LOOP_SEARCH_ROW_ID = "019f1243-0000-7000-8000-000000000030";
const DOCUMENT_SEARCH_ROW_ID = "019f1243-0000-7000-8000-000000000031";

/**
 * One claimed session per backfill edge case, each with its own loop. Every
 * case seeds a figure the backfill must NOT copy unless the case says so.
 */
const NEWEST_NO_FIGURE = edgeCase(0x40);
const REPORTED_ZERO = edgeCase(0x41);
const STRING_NUMBER = edgeCase(0x42);
const MISSING_KEY = edgeCase(0x43);
const SCALAR_BLOCK = edgeCase(0x44);
const ARRAY_DATA = edgeCase(0x45);
const UNSAFE_TURNS = edgeCase(0x46);
const NON_COMPLETED_NEWER = edgeCase(0x47);
/** Claimed by a loop in another organization. */
const CROSS_ORG = edgeCase(0x48);
/** Claimed by its own loop, but its pointer names the metered loop. */
const MISMATCHED_POINTER = edgeCase(0x49);

const LOOP_COMMAND_ID = "019f1243-0000-7000-8000-000000000070";
const OTHER_COMMAND_ID = "019f1243-0000-7000-8000-000000000071";
const CATALOG_ITEM_ID = "019f1243-0000-7000-8000-000000000072";
const AGENT_ID = "019f1243-0000-7000-8000-000000000073";
const DISMISSAL_ID = "019f1243-0000-7000-8000-000000000074";
const BOOTSTRAP_CONFIG_ID = "019f1243-0000-7000-8000-000000000075";
/** An operation id old Desktop builds still advertise; not Loop's. */
const SURVIVING_OPERATION_ID = "git_action";
const RETIRED_OPERATION_ID = "symphony_loop";
const SEEDED_UPDATED_AT = "2026-01-01T00:00:00Z";

const STORED_COST = "1.500000";
const OLDER_REPORTED_COST = 9;
const NEWER_REPORTED_COST = 2.5;
const METERED_REPORTED_COST = 4;
const EDGE_REPORTED_COST = 3;
const UNCOPIED_COST = 7;

describe.skipIf(!DATABASE_URL)("ISS-12435 Loops data step migrations", () => {
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
    await createDroppedRoutineTables(client);
    await seedFixture(client);
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  it("copies the newest completed figure into an empty column and never overwrites a stored one", async () => {
    await client.query(BACKFILL_SQL);
    await client.query(EMPTY_SQL);

    const sessions = await readSessions(client);
    expect(sessions.get(CLAIMED_SESSION_ID)?.authoritative_cost_usd).toBe(
      NEWER_REPORTED_COST.toFixed(6)
    );
    expect(sessions.get(STORED_SESSION_ID)?.authoritative_cost_usd).toBe(
      STORED_COST
    );
    // Points at the subscription loop, which claims a different session.
    expect(sessions.get(POINTER_SESSION_ID)?.authoritative_cost_usd).toBeNull();
  });

  it("leaves the column NULL when the newest completed event has no figure, over an older one that has", async () => {
    await client.query(BACKFILL_SQL);

    const sessions = await readSessions(client);
    expect(
      sessions.get(NEWEST_NO_FIGURE.sessionId)?.authoritative_cost_usd
    ).toBeNull();
  });

  it("copies a reported zero", async () => {
    await client.query(BACKFILL_SQL);

    const sessions = await readSessions(client);
    expect(sessions.get(REPORTED_ZERO.sessionId)?.authoritative_cost_usd).toBe(
      (0).toFixed(6)
    );
  });

  it("copies nothing from a malformed block, without raising", async () => {
    await client.query(BACKFILL_SQL);

    const sessions = await readSessions(client);
    for (const malformed of [
      STRING_NUMBER,
      MISSING_KEY,
      SCALAR_BLOCK,
      ARRAY_DATA,
      UNSAFE_TURNS,
    ]) {
      expect(
        sessions.get(malformed.sessionId)?.authoritative_cost_usd,
        malformed.sessionId
      ).toBeNull();
    }
  });

  it("reads only completed events", async () => {
    await client.query(BACKFILL_SQL);

    const sessions = await readSessions(client);
    expect(
      sessions.get(NON_COMPLETED_NEWER.sessionId)?.authoritative_cost_usd
    ).toBe(EDGE_REPORTED_COST.toFixed(6));
  });

  it("copies neither cost nor ledger from a loop in another organization", async () => {
    await client.query(BACKFILL_SQL);

    const session = (await readSessions(client)).get(CROSS_ORG.sessionId);
    expect(session?.authoritative_cost_usd).toBeNull();
    expect(session?.legacy_loop_cost_ledger).toBe("unknown");
  });

  it("copies no cost when the claiming loop is not the one the pointer names", async () => {
    await client.query(BACKFILL_SQL);

    const session = (await readSessions(client)).get(
      MISMATCHED_POINTER.sessionId
    );
    expect(session?.authoritative_cost_usd).toBeNull();
    // The ledger follows the pointer, as the classifier did.
    expect(session?.legacy_loop_cost_ledger).toBe("metered");
  });

  it("stores each former loop session's cost-split ledger before the loop row goes", async () => {
    await client.query(BACKFILL_SQL);
    await client.query(EMPTY_SQL);

    const sessions = await readSessions(client);
    expect(sessions.get(POINTER_SESSION_ID)?.legacy_loop_cost_ledger).toBe(
      "subscription"
    );
    expect(sessions.get(CLAIMED_SESSION_ID)?.legacy_loop_cost_ledger).toBe(
      "unknown"
    );
    expect(sessions.get(STORED_SESSION_ID)?.legacy_loop_cost_ledger).toBe(
      "metered"
    );
    expect(sessions.get(FREE_TEXT_SESSION_ID)?.legacy_loop_cost_ledger).toBe(
      "unknown"
    );
    expect(
      sessions.get(DESKTOP_SESSION_ID)?.legacy_loop_cost_ledger
    ).toBeNull();
  });

  it("copies the cost and ledger of a session first synced after the backfill, before its loop goes", async () => {
    await client.query(BACKFILL_SQL);
    // Older API code keeps accepting `source_loop_id` until the new deploy
    // serves, so a session can land between step 2 and step 3.
    await seedSession(client, LATE_SESSION_ID, {
      origin: "LOOP",
      sourceLoopId: LATE_LOOP_ID,
      storedCost: null,
    });
    await seedLoop(client, LATE_LOOP_ID, {
      sessionArtifactId: LATE_SESSION_ID,
      apiKeySource: "organization",
      parentLoopId: null,
    });
    await seedCompletedEvent(
      client,
      LATE_LOOP_ID,
      "late-completed",
      METERED_REPORTED_COST,
      NEWER
    );
    await client.query(EMPTY_SQL);

    const late = (await readSessions(client)).get(LATE_SESSION_ID);
    expect(late?.legacy_loop_cost_ledger).toBe("metered");
    expect(late?.authoritative_cost_usd).toBe(METERED_REPORTED_COST.toFixed(6));
    expect(late?.source_loop_id).toBeNull();
  });

  it("leaves no session on the LOOP origin or pointing at a loop, and keeps a Desktop session as it was", async () => {
    await client.query(BACKFILL_SQL);
    await client.query(EMPTY_SQL);

    const sessions = await readSessions(client);
    for (const session of sessions.values()) {
      expect(session.origin).toBe("DESKTOP_SYNC");
      expect(session.source_loop_id).toBeNull();
    }
    expect(sessions.get(DESKTOP_SESSION_ID)).toEqual({
      authoritative_cost_usd: null,
      legacy_loop_cost_ledger: null,
      origin: "DESKTOP_SYNC",
      source_loop_id: null,
    });
  });

  it("deletes every loop, its events and its search row, and keeps the document's search row", async () => {
    await client.query(BACKFILL_SQL);
    await client.query(EMPTY_SQL);

    const counts = await client.query<{ loops: string; events: string }>(
      `SELECT (SELECT count(*) FROM "loops") AS loops,
              (SELECT count(*) FROM "loop_events") AS events`
    );
    expect(counts.rows[0]).toEqual({ loops: "0", events: "0" });

    const searchRows = await client.query<{ id: string }>(
      `SELECT "id" FROM "search_document" WHERE "organization_id" = $1 ORDER BY "id"`,
      [ORG_ID]
    );
    expect(searchRows.rows.map((row) => row.id)).toEqual([
      DOCUMENT_SEARCH_ROW_ID,
    ]);
  });

  it("drops the loop status sync trigger and function and keeps the document one", async () => {
    // A migrated database has already lost the trigger, so put back the one
    // ISS-9938 shipped (rolled back with the rest) for the drop to act on.
    await client.query(
      `DROP TRIGGER IF EXISTS "loops_search_document_status_sync" ON "loops";
       DROP FUNCTION IF EXISTS "sync_search_document_loop_status"();`
    );
    await client.query(loopStatusSyncTriggerSql());

    await client.query(BACKFILL_SQL);
    await client.query(EMPTY_SQL);

    const triggers = await client.query<{ tgname: string }>(
      `SELECT "tgname" FROM pg_trigger
        WHERE "tgname" IN ('loops_search_document_status_sync', 'artifacts_search_document_status_sync')`
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      "artifacts_search_document_status_sync",
    ]);
    const functions = await client.query<{ proname: string }>(
      `SELECT "proname" FROM pg_proc WHERE "proname" = 'sync_search_document_loop_status'`
    );
    expect(functions.rows).toEqual([]);
  });

  // The deploy window: the previous API keeps serving after this migration
  // until the new one is promoted. These are objects its reads name; each must
  // still exist (the query would raise otherwise) and hold no loop data.
  it("keeps the Loop tables and nulled Loop columns in place, empty", async () => {
    await client.query(BACKFILL_SQL);
    await client.query(EMPTY_SQL);

    const reads = await client.query<{
      loops: string;
      tags: string;
      dismissals: string;
      pointers: string;
    }>(
      `SELECT (SELECT count(*) FROM "loops" WHERE "organization_id" = $1) AS loops,
              (SELECT count(*) FROM "tag_loops") AS tags,
              (SELECT count(*) FROM "artifact_generation_status_dismissals") AS dismissals,
              (SELECT count(*) FROM "session_detail" WHERE "source_loop_id" IS NOT NULL) AS pointers`,
      [ORG_ID]
    );
    expect(reads.rows[0]).toEqual({
      loops: "0",
      tags: "0",
      dismissals: "0",
      pointers: "0",
    });
  });

  it("clears every Loop pointer, Loop setting and queued loop launch, and keeps what is not Loop's", async () => {
    await client.query(BACKFILL_SQL);
    await client.query(EMPTY_SQL);

    const user = await client.query(
      `SELECT "claude_api_key_encrypted", "claude_api_key_last_four", "claude_api_key_set_at",
              "preferred_compute_mode", "preferred_compute_target_id", "preferred_harness"
         FROM "users" WHERE "id" = $1`,
      [USER_ID]
    );
    expect(Object.values(user.rows[0])).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);

    const org = await client.query<{
      encrypted: string | null;
      last_four: string | null;
      set_at: Date | null;
      settings: Record<string, unknown>;
      bumped: boolean;
    }>(
      `SELECT "claude_api_key_encrypted" AS encrypted, "claude_api_key_last_four" AS last_four,
              "claude_api_key_set_at" AS set_at, "settings",
              "updated_at" > $2::timestamp AS bumped
         FROM "organizations" WHERE "id" = $1`,
      [ORG_ID, SEEDED_UPDATED_AT]
    );
    expect(org.rows[0]).toEqual({
      encrypted: null,
      last_four: null,
      set_at: null,
      settings: { [SESSION_FRUSTRATION_SETTING_KEY]: true },
      bumped: true,
    });

    const commands = await client.query<{
      id: string;
      status: string;
      finished: boolean;
    }>(
      `SELECT "id", "status", "finished_at" IS NOT NULL AS finished
         FROM "desktop_commands" WHERE "compute_target_id" = $1 ORDER BY "id"`,
      [TARGET_ID]
    );
    expect(commands.rows).toEqual([
      {
        id: LOOP_COMMAND_ID,
        status: DesktopCommandStatus.Expired,
        finished: true,
      },
      {
        id: OTHER_COMMAND_ID,
        status: DesktopCommandStatus.Queued,
        finished: false,
      },
    ]);

    const pointers = await client.query<{
      catalog: string | null;
      agent: string | null;
    }>(
      `SELECT (SELECT "source_loop_id"::text FROM "catalog_items" WHERE "id" = $1) AS catalog,
              (SELECT "bootstrap_run_id"::text FROM "agents" WHERE "id" = $2) AS agent`,
      [CATALOG_ITEM_ID, AGENT_ID]
    );
    expect(pointers.rows[0]).toEqual({ catalog: null, agent: null });

    const removed = await client.query<{
      dismissals: string;
      bootstrap: string;
    }>(
      `SELECT (SELECT count(*) FROM "artifact_generation_status_dismissals" WHERE "id" = $1) AS dismissals,
              (SELECT count(*) FROM "repo_bootstrap_configs" WHERE "id" = $2) AS bootstrap`,
      [DISMISSAL_ID, BOOTSTRAP_CONFIG_ID]
    );
    expect(removed.rows[0]).toEqual({ dismissals: "0", bootstrap: "0" });
  });

  it("is safe to run twice", async () => {
    await client.query(BACKFILL_SQL);
    await client.query(EMPTY_SQL);
    const once = await readSessions(client);

    await client.query(BACKFILL_SQL);
    await client.query(EMPTY_SQL);

    expect(await readSessions(client)).toEqual(once);
  });
});

describe("ISS-12435 Loops data step migrations text pin", () => {
  it.each([
    ["carrier column", CARRIER_SQL],
    ["backfill", BACKFILL_SQL],
    ["empty loops data", EMPTY_SQL],
  ])(
    "the %s migration drops, renames and truncates nothing but the loop trigger and function",
    (_name, sql) => {
      const statements = sql.replace(SQL_LINE_COMMENT_RE, "");
      expect(statements).not.toMatch(DESTRUCTIVE_DDL_RE);
      expect(statements).not.toMatch(DROP_OTHER_THAN_TRIGGER_OR_FUNCTION_RE);
    }
  );
});

type SessionRow = {
  authoritative_cost_usd: string | null;
  legacy_loop_cost_ledger: string | null;
  origin: string;
  source_loop_id: string | null;
};

async function readSessions(client: Client): Promise<Map<string, SessionRow>> {
  const result = await client.query<SessionRow & { artifact_id: string }>(
    `SELECT s."artifact_id", s."authoritative_cost_usd"::text AS authoritative_cost_usd,
            s."legacy_loop_cost_ledger", s."origin"::text AS origin, s."source_loop_id"
       FROM "session_detail" s
       JOIN "artifacts" a ON a."id" = s."artifact_id"
      WHERE a."organization_id" = $1`,
    [ORG_ID]
  );
  return new Map(
    result.rows.map(({ artifact_id, ...row }) => [artifact_id, row])
  );
}

function reconciliation(
  costUsd: number | string | null
): Record<string, unknown> {
  return {
    sessionOrigin: "harness_stdout",
    reconciliationStatus: "matched",
    authoritativeCostUsd: costUsd,
    derivedCostUsd: null,
    reconciliationDeltaUsd: null,
    harnessNumTurns: null,
    harnessDurationMs: null,
  };
}

function completedEvent(costUsd: number): string {
  return JSON.stringify({ usageReconciliation: reconciliation(costUsd) });
}

type EdgeCase = { sessionId: string; loopId: string };

function edgeCase(index: number): EdgeCase {
  const suffix = index.toString(16).padStart(2, "0");
  return {
    sessionId: `019f1243-0000-7000-8000-0000000001${suffix}`,
    loopId: `019f1243-0000-7000-8000-0000000002${suffix}`,
  };
}

type EdgeEvent = { type: string; data: unknown; createdAt: string };

const OLDER = "2026-10-01T00:00:00Z";
const NEWER = "2026-10-02T00:00:00Z";

function completed(data: unknown, createdAt = NEWER): EdgeEvent {
  return { type: "completed", data, createdAt };
}

async function seedEdgeCase(
  client: Client,
  edge: EdgeCase,
  events: EdgeEvent[],
  input: {
    loopOrgId?: string;
    sourceLoopId?: string;
    apiKeySource?: string;
  } = {}
): Promise<void> {
  await seedSession(client, edge.sessionId, {
    origin: "LOOP",
    sourceLoopId: input.sourceLoopId ?? edge.loopId,
    storedCost: null,
  });
  await seedLoop(client, edge.loopId, {
    sessionArtifactId: edge.sessionId,
    apiKeySource: input.apiKeySource ?? null,
    parentLoopId: null,
    organizationId: input.loopOrgId,
  });
  for (const [index, event] of events.entries()) {
    await client.query(
      `INSERT INTO "loop_events" ("id", "loop_id", "type", "event_id", "data", "created_at")
       VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb, $5::timestamp)`,
      [
        edge.loopId,
        event.type,
        `edge-${index}`,
        JSON.stringify(event.data),
        event.createdAt,
      ]
    );
  }
}

async function seedBackfillEdgeCases(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO "organizations" ("id", "clerk_id", "name", "slug", "updated_at")
     VALUES ($1, 'clerk_iss12435_other', 'ISS-12435 other', 'iss-12435-other', now())`,
    [OTHER_ORG_ID]
  );
  await client.query(
    `INSERT INTO "users" ("id", "clerk_id", "organization_id", "email", "updated_at")
     VALUES ($1, 'clerk_user_iss12435_other', $2, 'iss12435-other@example.test', now())`,
    [OTHER_USER_ID, OTHER_ORG_ID]
  );

  await seedEdgeCase(client, NEWEST_NO_FIGURE, [
    completed({ usageReconciliation: reconciliation(UNCOPIED_COST) }, OLDER),
    completed({ usageReconciliation: reconciliation(null) }),
  ]);
  await seedEdgeCase(client, REPORTED_ZERO, [
    completed({ usageReconciliation: reconciliation(0) }),
  ]);
  await seedEdgeCase(client, STRING_NUMBER, [
    completed({ usageReconciliation: reconciliation(String(UNCOPIED_COST)) }),
  ]);
  const { reconciliationStatus: _dropped, ...missingKey } =
    reconciliation(UNCOPIED_COST);
  await seedEdgeCase(client, MISSING_KEY, [
    completed({ usageReconciliation: missingKey }),
  ]);
  await seedEdgeCase(client, SCALAR_BLOCK, [
    completed({ usageReconciliation: UNCOPIED_COST }),
  ]);
  await seedEdgeCase(client, ARRAY_DATA, [
    completed([{ usageReconciliation: reconciliation(UNCOPIED_COST) }]),
  ]);
  await seedEdgeCase(client, UNSAFE_TURNS, [
    completed({
      usageReconciliation: {
        ...reconciliation(UNCOPIED_COST),
        // Integral, but past the safe-integer range zod's `.int()` accepts.
        harnessNumTurns: 1e21,
      },
    }),
  ]);
  await seedEdgeCase(client, NON_COMPLETED_NEWER, [
    completed(
      { usageReconciliation: reconciliation(EDGE_REPORTED_COST) },
      OLDER
    ),
    {
      type: "failed",
      data: { usageReconciliation: reconciliation(UNCOPIED_COST) },
      createdAt: NEWER,
    },
  ]);
  await seedEdgeCase(
    client,
    CROSS_ORG,
    [completed({ usageReconciliation: reconciliation(UNCOPIED_COST) })],
    { loopOrgId: OTHER_ORG_ID, apiKeySource: "organization" }
  );
  await seedEdgeCase(
    client,
    MISMATCHED_POINTER,
    [completed({ usageReconciliation: reconciliation(UNCOPIED_COST) })],
    { sourceLoopId: METERED_LOOP_ID }
  );
}

function loopStatusSyncTriggerSql(): string {
  const start = STATUS_SYNC_SQL.indexOf(LOOP_TRIGGER_START);
  const end = STATUS_SYNC_SQL.indexOf(LOOP_TRIGGER_END);
  if (start === -1 || end === -1) {
    throw new Error("ISS-9938 migration no longer carries the loop trigger");
  }
  return STATUS_SYNC_SQL.slice(start, end + LOOP_TRIGGER_END.length);
}

async function seedLoopPointersAndSettings(client: Client): Promise<void> {
  await client.query(
    `UPDATE "users"
        SET "claude_api_key_encrypted" = 'encrypted', "claude_api_key_last_four" = '1234',
            "claude_api_key_set_at" = now(), "preferred_compute_mode" = $2::"PreferredComputeMode",
            "preferred_compute_target_id" = $3, "preferred_harness" = 'claude'
      WHERE "id" = $1`,
    [USER_ID, PreferredComputeMode.CLOUD, TARGET_ID]
  );
  await client.query(
    `UPDATE "organizations"
        SET "claude_api_key_encrypted" = 'encrypted', "claude_api_key_last_four" = '1234',
            "claude_api_key_set_at" = now(), "settings" = $2::jsonb,
            "updated_at" = $3::timestamp
      WHERE "id" = $1`,
    [
      ORG_ID,
      JSON.stringify({
        maxConcurrentLoops: 3,
        computeMode: "cloud",
        [SESSION_FRUSTRATION_SETTING_KEY]: true,
      }),
      SEEDED_UPDATED_AT,
    ]
  );
  for (const [id, operationId] of [
    [LOOP_COMMAND_ID, RETIRED_OPERATION_ID],
    [OTHER_COMMAND_ID, SURVIVING_OPERATION_ID],
  ] as const) {
    await client.query(
      `INSERT INTO "desktop_commands" ("id", "compute_target_id", "request_fingerprint",
         "operation_id", "request_payload", "status")
       VALUES ($1, $2, $3, $4, '{}'::jsonb, $5)`,
      [
        id,
        TARGET_ID,
        `fingerprint-${id}`,
        operationId,
        DesktopCommandStatus.Queued,
      ]
    );
  }
  await client.query(
    `INSERT INTO "catalog_items" ("id", "organization_id", "target_kind", "source", "scope",
       "name", "source_loop_id", "updated_at")
     VALUES ($1, $2, 'skill', 'loop', 'organization', 'item', $3, now())`,
    [CATALOG_ITEM_ID, ORG_ID, SUBSCRIPTION_LOOP_ID]
  );
  await client.query(
    `INSERT INTO "agents" ("id", "organization_id", "name", "slug", "role", "prompt",
       "created_by_id", "bootstrap_run_id", "updated_at")
     VALUES ($1, $2, 'agent', 'agent', 'role', 'prompt', $3, $4, now())`,
    [AGENT_ID, ORG_ID, USER_ID, SUBSCRIPTION_LOOP_ID]
  );
  await client.query(
    `INSERT INTO "artifact_generation_status_dismissals" ("id", "artifact_id",
       "dismissed_by_id", "run_key", "updated_at")
     VALUES ($1, $2, $3, 'run', now())`,
    [DISMISSAL_ID, DOCUMENT_ID, USER_ID]
  );
  await client.query(
    `INSERT INTO "repo_bootstrap_configs" ("id", "organization_id", "repo_full_name",
       "critic_gates", "updated_at")
     VALUES ($1, $2, 'acme/widgets', '{}'::jsonb, now())`,
    [BOOTSTRAP_CONFIG_ID, ORG_ID]
  );
}

async function seedFixture(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO "organizations" ("id", "clerk_id", "name", "slug", "updated_at")
     VALUES ($1, 'clerk_iss12435', 'ISS-12435', 'iss-12435', now())`,
    [ORG_ID]
  );
  await client.query(
    `INSERT INTO "users" ("id", "clerk_id", "organization_id", "email", "updated_at")
     VALUES ($1, 'clerk_user_iss12435', $2, 'iss12435@example.test', now())`,
    [USER_ID, ORG_ID]
  );
  await client.query(
    `INSERT INTO "compute_targets" ("id", "organization_id", "user_id", "machine_name", "platform", "updated_at")
     VALUES ($1, $2, $3, 'host', 'darwin', now())`,
    [TARGET_ID, ORG_ID, USER_ID]
  );
  await client.query(
    `INSERT INTO "artifacts" ("id", "organization_id", "type", "name", "status", "updated_at")
     VALUES ($1, $2, 'DOCUMENT', 'Plan', 'TODO', now())`,
    [DOCUMENT_ID, ORG_ID]
  );
  await seedSession(client, CLAIMED_SESSION_ID, {
    origin: "LOOP",
    // Upper case on purpose: the read matched the pointer case-insensitively.
    sourceLoopId: SUBSCRIPTION_LOOP_ID.toUpperCase(),
    storedCost: null,
  });
  await seedSession(client, STORED_SESSION_ID, {
    origin: "LOOP",
    sourceLoopId: METERED_LOOP_ID,
    storedCost: STORED_COST,
  });
  await seedSession(client, FREE_TEXT_SESSION_ID, {
    origin: "LOOP",
    sourceLoopId: "not-a-loop-id",
    storedCost: null,
  });
  await seedSession(client, POINTER_SESSION_ID, {
    origin: "LOOP",
    sourceLoopId: SUBSCRIPTION_LOOP_ID,
    storedCost: null,
  });
  await seedSession(client, DESKTOP_SESSION_ID, {
    origin: "DESKTOP_SYNC",
    sourceLoopId: null,
    storedCost: null,
  });

  await seedLoop(client, SUBSCRIPTION_LOOP_ID, {
    sessionArtifactId: CLAIMED_SESSION_ID,
    apiKeySource: "none",
    parentLoopId: null,
  });
  await seedLoop(client, METERED_LOOP_ID, {
    sessionArtifactId: STORED_SESSION_ID,
    apiKeySource: "organization",
    parentLoopId: null,
  });
  // A RESTRICT self reference between two rows the delete removes.
  await seedLoop(client, CHILD_LOOP_ID, {
    sessionArtifactId: null,
    apiKeySource: null,
    parentLoopId: SUBSCRIPTION_LOOP_ID,
  });

  await seedCompletedEvent(
    client,
    SUBSCRIPTION_LOOP_ID,
    "older",
    OLDER_REPORTED_COST,
    "2026-10-01T00:00:00Z"
  );
  await seedCompletedEvent(
    client,
    SUBSCRIPTION_LOOP_ID,
    "newer",
    NEWER_REPORTED_COST,
    "2026-10-02T00:00:00Z"
  );
  await seedCompletedEvent(
    client,
    METERED_LOOP_ID,
    "metered",
    METERED_REPORTED_COST,
    "2026-10-02T00:00:00Z"
  );

  await seedBackfillEdgeCases(client);
  await seedLoopPointersAndSettings(client);

  await client.query(
    `INSERT INTO "search_document" ("id", "organization_id", "entity_type", "entity_id", "title", "updated_at")
     VALUES ($1, $2, $3, $4, 'loop', now()), ($5, $2, $6, $7, 'Plan', now())`,
    [
      LOOP_SEARCH_ROW_ID,
      ORG_ID,
      SearchEntityType.Loop,
      SUBSCRIPTION_LOOP_ID,
      DOCUMENT_SEARCH_ROW_ID,
      SearchEntityType.Document,
      DOCUMENT_ID,
    ]
  );
}

async function seedSession(
  client: Client,
  id: string,
  input: {
    origin: "LOOP" | "DESKTOP_SYNC";
    sourceLoopId: string | null;
    storedCost: string | null;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO "artifacts" ("id", "organization_id", "type", "name", "status", "updated_at")
     VALUES ($1, $2, 'SESSION', 'session', 'inactive', now())`,
    [id, ORG_ID]
  );
  await client.query(
    `INSERT INTO "session_detail" ("artifact_id", "compute_target_id", "external_session_id",
       "session_started_at", "session_updated_at", "updated_at", "last_activity_at",
       "origin", "source_loop_id", "authoritative_cost_usd")
     VALUES ($1::uuid, $2, $1::text, now(), now(), now(), now(), $3::"SessionOrigin", $4, $5::numeric)`,
    [id, TARGET_ID, input.origin, input.sourceLoopId, input.storedCost]
  );
}

async function seedLoop(
  client: Client,
  id: string,
  input: {
    sessionArtifactId: string | null;
    apiKeySource: string | null;
    parentLoopId: string | null;
    organizationId?: string;
  }
): Promise<void> {
  const metadata =
    input.apiKeySource === null ? {} : { apiKeySource: input.apiKeySource };
  await client.query(
    `INSERT INTO "loops" ("id", "organization_id", "user_id", "command", "status",
       "session_artifact_id", "parent_loop_id", "metadata", "updated_at")
     VALUES ($1, $2, $3, 'EXECUTE', 'COMPLETED', $4, $5, $6::jsonb, now())`,
    [
      id,
      input.organizationId ?? ORG_ID,
      input.organizationId === OTHER_ORG_ID ? OTHER_USER_ID : USER_ID,
      input.sessionArtifactId,
      input.parentLoopId,
      JSON.stringify(metadata),
    ]
  );
}

async function seedCompletedEvent(
  client: Client,
  loopId: string,
  eventId: string,
  costUsd: number,
  createdAt: string
): Promise<void> {
  await client.query(
    `INSERT INTO "loop_events" ("id", "loop_id", "type", "event_id", "data", "created_at")
     VALUES (gen_random_uuid(), $1, 'completed', $2, $3::jsonb, $4::timestamp)`,
    [loopId, eventId, completedEvent(costUsd), createdAt]
  );
}

/**
 * `20261013180200_iss12435_empty_loops_data` updates `routines` and
 * `routine_runs`, which PRD-797 later dropped. Temporary stand-ins with the
 * columns that migration touches let its SQL run verbatim against a database
 * migrated past the drop; the transaction rollback discards them.
 */
async function createDroppedRoutineTables(client: Client): Promise<void> {
  await client.query(
    `CREATE TEMP TABLE IF NOT EXISTS "routine_runs" (
       "id" uuid PRIMARY KEY,
       "status" text NOT NULL,
       "finished_at" timestamptz,
       "loop_id" uuid
     )`
  );
  await client.query(
    `CREATE TEMP TABLE IF NOT EXISTS "routines" (
       "id" uuid PRIMARY KEY,
       "last_run_id" uuid,
       "last_status" text,
       "updated_at" timestamptz NOT NULL DEFAULT now(),
       "next_run_at" timestamptz,
       "runs_on" text NOT NULL,
       "source_id" text,
       "cloud_dispatch_failures" integer NOT NULL DEFAULT 0,
       "cloud_schedule_parked_until" timestamptz
     )`
  );
}
