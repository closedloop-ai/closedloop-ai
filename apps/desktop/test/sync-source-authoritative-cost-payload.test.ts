import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, test } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

/**
 * ISS-7229: how `sessions.authoritative_cost_usd` reaches the cloud payload.
 *
 * The subject is the ABSENT case, not the present one. The cloud column holds
 * figures this payload did not write (the ISS-12435 backfill of the retired
 * loop-event figures), so a session can already hold a real Claude-reported
 * figure this desktop knows nothing about. OTel capture is gated
 * on a Labs setting and reaches a minority of sessions, so if a desktop with no
 * capture sent `null`, the ingest would erase that figure.
 *
 * The payload therefore OMITS the key rather than sending `null`, and the wire
 * schema refuses `null` outright (`desktop-agent-sessions-schema.authoritative-cost.test.ts`
 * is the other half of this guard). Absence means "no opinion, keep what you
 * have"; there is deliberately no wire spelling for "clear it".
 */

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const NOW = "2026-09-01T12:00:00.000Z";
let opened: { db: SqliteDb; dir: string } | null = null;
/**
 * The desktop diagnostic sink the sync source writes through, captured so the
 * refused-figure case can assert the omission was REPORTED and the uncaptured
 * case can assert it was not. Cleared per case rather than per file: the db is
 * opened once and shared, so the sink is too.
 */
const logged: string[] = [];

async function openDb(): Promise<SqliteDb> {
  if (!opened) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss7229-payload-"));
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "api",
      now: () => NOW,
      log: (message: string) => {
        logged.push(message);
      },
    });
    opened = { db, dir };
  }
  logged.length = 0;
  return opened.db;
}

/** Lines the sync source emitted about one session's authoritative cost. */
function costOmissionLogs(sessionId: string): string[] {
  return logged.filter(
    (line) => line.includes(sessionId) && line.includes("authoritative cost")
  );
}

afterAll(async () => {
  if (opened) {
    const { db, dir } = opened;
    opened = null;
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function seedSession(
  db: SqliteDb,
  sessionId: string,
  authoritativeCostUsd: number | null
): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, name, status, started_at, updated_at, last_activity_at, harness, user_id, organization_id, authoritative_cost_usd)
     VALUES ($1, $1, 'inactive', $2, $2, $2, 'claude_code', NULL, NULL, $3)`,
    sessionId,
    NOW,
    authoritativeCostUsd
  );
}

async function syncedPayload(db: SqliteDb, sessionId: string) {
  const [synced] = await db.syncSource.loadSyncedSessions([sessionId], {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  });
  if (!synced) {
    // A fixture precondition, not a claim about the subject — thrown rather
    // than asserted so it stays out of a test body's assertion budget and
    // satisfies Biome's `noMisplacedAssertion`.
    throw new Error(`session ${sessionId} did not hydrate into a payload`);
  }
  return synced as Record<string, unknown>;
}

describe("authoritativeCostUsd in the sync payload (ISS-7229)", () => {
  test("carries a captured figure", async () => {
    const db = await openDb();
    await seedSession(db, "payload-captured", 1502.1);

    assert.equal(
      (await syncedPayload(db, "payload-captured")).authoritativeCostUsd,
      1502.1
    );
  });

  test("carries a REPORTED zero, which is a measurement", async () => {
    // The case a truthiness check would silently drop, turning "Claude charged
    // nothing" into "we have no figure".
    const db = await openDb();
    await seedSession(db, "payload-zero", 0);

    const payload = await syncedPayload(db, "payload-zero");
    assert.equal(payload.authoritativeCostUsd, 0);
    assert.ok(
      Object.hasOwn(payload, "authoritativeCostUsd"),
      "a reported zero must be SENT, not omitted"
    );
  });

  test("OMITS the key entirely when nothing was captured", async () => {
    // The data-loss guard. `hasOwn` rather than a truthiness or `== null` check:
    // a payload carrying `authoritativeCostUsd: null` would satisfy a loose
    // assertion and still erase a loop-projected figure at the ingest, and the
    // wire schema would reject the whole session for it.
    const db = await openDb();
    await seedSession(db, "payload-uncaptured", null);

    const payload = await syncedPayload(db, "payload-uncaptured");
    assert.equal(
      Object.hasOwn(payload, "authoritativeCostUsd"),
      false,
      "an uncaptured session must omit the key, never send null"
    );
    // ...and says NOTHING about it. OTel capture reaches a minority of
    // sessions, so this is the majority path; logging here would bury the
    // refusal below under its own volume.
    assert.deepEqual(costOmissionLogs("payload-uncaptured"), []);
  });

  test("REPORTS an omission when the column holds a figure it will not publish", async () => {
    // The silent drop. A stored value this build refuses is NOT the absent case:
    // the session is still acked, the sync cursor still advances and the outbox
    // still clears, so the figure stays local permanently and no later sync
    // re-offers it. Nothing else in the pipeline can notice — which is exactly
    // the shape AGENTS.md's "Handling Bad or Nonsensical Data" requires be
    // routed to the monitored path rather than absorbed.
    //
    // A NEGATIVE is the input because it is the one unpublishable shape the
    // column can hold that the ingest guard does not already prevent upstream,
    // and `publishableStoredCostUsd` refuses it by policy rather than by range.
    const db = await openDb();
    await seedSession(db, "payload-refused", -1);

    const payload = await syncedPayload(db, "payload-refused");
    assert.equal(
      Object.hasOwn(payload, "authoritativeCostUsd"),
      false,
      "an unpublishable figure must not reach the wire"
    );
    const reported = costOmissionLogs("payload-refused");
    assert.equal(reported.length, 1, `expected one report, got: ${reported}`);
  });
});
