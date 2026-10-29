import { createHash } from "node:crypto";
import path from "node:path";
import { recordThreadViewed } from "../../src/main/database/session-viewership-store.js";
import type { SqliteAgentDatabase } from "../../src/main/database/sqlite.js";
import { observeTranscriptRef } from "../../src/main/transcript-sync/transcript-observe.js";
import {
  TRANSCRIPT_MAIN_FILE_KEY,
  TranscriptSourceHarness,
} from "../../src/main/transcript-sync/transcript-sync-types.js";
import { TranscriptSyncClass } from "../../src/shared/transcript-sync-status-contract.js";

type SessionRow = {
  id: string;
  harness: string | null;
  last_activity_at: string;
};

/** Every third session (by id) has been opened, as a returning user's would. */
const VIEWED_SESSION_STRIDE = 3;
const VIEWED_AFTER_ACTIVITY_MS = 5 * 60_000;

export type LocalActivityCounts = {
  readonly viewed: number;
  readonly transcriptRows: number;
};

/**
 * The rows a person's own use of Desktop leaves behind, written through the
 * same functions the app calls: sessions opened (`recordThreadViewed`) and the
 * transcript archive lane's fingerprints (`observeTranscriptRef`).
 */
export async function seedLocalActivity(
  db: SqliteAgentDatabase,
  homes: { claudeHome: string; codexHome: string },
  now: Date
): Promise<LocalActivityCounts> {
  const sessions = await db.prisma.client.$queryRawUnsafe<SessionRow[]>(
    "SELECT id, harness, last_activity_at FROM sessions ORDER BY id"
  );
  const viewed = await seedViewership(db, sessions, now);
  const transcriptRows = await seedTranscriptSyncRows(db, sessions, homes, now);
  return { viewed, transcriptRows };
}

async function seedViewership(
  db: SqliteAgentDatabase,
  sessions: readonly SessionRow[],
  now: Date
): Promise<number> {
  let viewed = 0;
  for (const [index, session] of sessions.entries()) {
    if (index % VIEWED_SESSION_STRIDE !== 0) {
      continue;
    }
    const at = Math.min(
      Date.parse(session.last_activity_at) + VIEWED_AFTER_ACTIVITY_MS,
      now.getTime()
    );
    if (
      await recordThreadViewed(
        db.prisma,
        session.id,
        new Date(at).toISOString()
      )
    ) {
      viewed += 1;
    }
  }
  return viewed;
}

/**
 * The archive lane records every transcript it discovers. Each session's main
 * transcript is observed at the path its harness home holds and settled idle,
 * the lane's state for a file with nothing to upload. `prepare` then writes
 * the file there (`writeSeededTranscripts`), shifted onto the store's clock,
 * and drops the row of any session the corpus has no transcript for.
 */
async function seedTranscriptSyncRows(
  db: SqliteAgentDatabase,
  sessions: readonly SessionRow[],
  homes: { claudeHome: string; codexHome: string },
  now: Date
): Promise<number> {
  const nowIso = now.toISOString();
  let rows = 0;
  for (const session of sessions) {
    const ref = transcriptRefFor(session, homes);
    if (ref === null) {
      continue;
    }
    await observeTranscriptRef(
      {
        statFile: () => Promise.resolve(null),
        hashPath: (filePath) =>
          createHash("sha256").update(filePath).digest("hex"),
        getComputeTargetId: () => null,
        now: () => nowIso,
      },
      db.transcriptSync,
      ref,
      TranscriptSyncClass.Backfill
    );
    await db.transcriptSync.markIdle(
      ref.externalSessionId,
      ref.fileKey,
      nowIso
    );
    rows += 1;
  }
  return rows;
}

function transcriptRefFor(
  session: SessionRow,
  homes: { claudeHome: string; codexHome: string }
) {
  if (session.harness === TranscriptSourceHarness.Claude) {
    return {
      externalSessionId: session.id,
      fileKey: TRANSCRIPT_MAIN_FILE_KEY,
      sourceHarness: TranscriptSourceHarness.Claude,
      sourcePath: path.join(
        homes.claudeHome,
        "projects",
        "vibe",
        `${session.id}.jsonl`
      ),
    };
  }
  if (session.harness === TranscriptSourceHarness.Codex) {
    return {
      externalSessionId: session.id,
      fileKey: TRANSCRIPT_MAIN_FILE_KEY,
      sourceHarness: TranscriptSourceHarness.Codex,
      sourcePath: path.join(
        homes.codexHome,
        "sessions",
        `rollout-${session.id}.jsonl`
      ),
    };
  }
  return null;
}
