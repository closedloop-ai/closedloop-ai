import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedLocalActivity } from "../scripts/vibe-profile/seed-local-activity";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { TranscriptSourceHarness } from "../src/main/transcript-sync/transcript-sync-types.js";
import { TranscriptSyncClass } from "../src/shared/transcript-sync-status-contract.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const NOW = new Date("2026-10-05T12:00:00.000Z");
const EARLY = "2026-10-01T10:00:00.000Z";
const LATE = "2026-10-05T11:58:00.000Z";
const PRE_VIEWED_AT = "2026-10-01T09:00:00.000Z";

let dir: string;
let db: SqliteDb;
let homes: { claudeHome: string; codexHome: string };

async function insertSession(
  id: string,
  harness: string | null,
  lastActivityAt: string
): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, started_at, updated_at, last_activity_at, harness, billing_mode)
     VALUES ($1, 'inactive', $2, $2, $3, $4, 'api')`,
    id,
    EARLY,
    lastActivityAt,
    harness
  );
}

describe("seedLocalActivity", () => {
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "vibe-seed-local-activity-"));
    homes = {
      claudeHome: path.join(dir, "claude"),
      codexHome: path.join(dir, "codex"),
    };
    db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "api",
      now: () => NOW.toISOString(),
    });
  });

  afterEach(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("views every third session, observes claude and codex transcripts", async () => {
    await insertSession("s0", "claude", EARLY);
    await insertSession("s1", "codex", EARLY);
    await insertSession("s2", "cursor", EARLY);
    await insertSession("s3", "codex", LATE);
    await insertSession("s4", null, EARLY);
    await insertSession("s5", "claude", EARLY);
    await insertSession("s6", "cursor", EARLY);
    // s0 was already opened: its first view time is kept, and it still counts
    // as viewed because recordThreadViewed reports an existing view as true
    await db.run(
      "INSERT INTO session_viewership (session_id, first_viewed_at) VALUES ('s0', $1)",
      PRE_VIEWED_AT
    );

    const result = await seedLocalActivity(db, homes, NOW);

    expect(result).toEqual({ viewed: 3, transcriptRows: 4 });

    const views = await db.prisma.client.$queryRawUnsafe<
      { session_id: string; first_viewed_at: string }[]
    >(
      "SELECT session_id, first_viewed_at FROM session_viewership ORDER BY session_id"
    );
    expect(views).toEqual([
      { session_id: "s0", first_viewed_at: PRE_VIEWED_AT },
      // last activity + 5 minutes
      { session_id: "s3", first_viewed_at: NOW.toISOString() },
      { session_id: "s6", first_viewed_at: "2026-10-01T10:05:00.000Z" },
    ]);

    const transcripts = await db.prisma.client.$queryRawUnsafe<
      {
        external_session_id: string;
        source_harness: string;
        source_path: string;
        status: string;
        sync_class: string;
      }[]
    >(
      `SELECT external_session_id, source_harness, source_path, status, sync_class
         FROM transcript_sync_state ORDER BY external_session_id`
    );
    expect(transcripts.map((row) => row.external_session_id)).toEqual([
      "s0",
      "s1",
      "s3",
      "s5",
    ]);
    expect(transcripts[0]).toMatchObject({
      source_harness: TranscriptSourceHarness.Claude,
      source_path: path.join(homes.claudeHome, "projects", "vibe", "s0.jsonl"),
      status: "idle",
      sync_class: TranscriptSyncClass.Backfill,
    });
    expect(transcripts[1]).toMatchObject({
      source_harness: TranscriptSourceHarness.Codex,
      source_path: path.join(homes.codexHome, "sessions", "rollout-s1.jsonl"),
    });
  });
});
