/**
 * Direct SQLite seeding of `transcript_sync_state` rows for the transcript-sync
 * E2E specs.
 *
 * The real lane cannot produce a `dead` row inside a spec's lifetime: a row only
 * reaches `dead` after the executor exhausts its missing-source attempts AND the
 * cloud acknowledges the resulting terminal skip (the ISS-4621 ack gate), which
 * needs first-party auth an E2E profile does not have. So the corpus is written
 * directly, the same way the Branches seeders write the rows their read path
 * projects from — `statusCounts()` is a `groupBy` over this exact table, so the
 * app's real census runs over what is seeded here, with no test-only code path.
 *
 * Seed while the app is DOWN and relaunch against the same `--user-data-dir`
 * (see `LaunchOptions.userDataDir`): the footnote's first poll then already sees
 * the row, instead of racing a poll interval against a concurrent insert.
 */

import {
  TranscriptSyncClass,
  TranscriptSyncStatus,
} from "../../../src/shared/transcript-sync-status-contract.js";
import {
  applyDesktopBusyTimeout,
  applyDesktopSeedPragmas,
  openSeedClient,
  SEED_SCHEMA_TIMEOUT_MS,
  type SeedClient,
  waitForMigrationsApplied,
} from "./desktop-seed-core";

const TRANSCRIPT_SYNC_TABLE = "transcript_sync_state";

/**
 * `file_key` / `source_harness` spelled as literals, unlike `status` and
 * `sync_class`.
 *
 * Their canonical owner is `main/transcript-sync/transcript-sync-types.ts`,
 * which imports `@repo/api/src/types/desktop-transcripts` — an extension-less
 * `@repo/*` subpath that resolves in the app but not under the Playwright spec
 * loader, so importing it here aborts the WHOLE E2E run at load time (see
 * `test/AGENTS.md` → "Import hazard"). The status/class unions have no such
 * problem: they live in the node-free renderer boundary module and are imported.
 */
const MAIN_FILE_KEY = "main";
const CLAUDE_SOURCE_HARNESS = "claude";

/** The dead-letter reason ISS-7094 was filed against, verbatim from the report. */
export const SOURCE_GONE_LAST_ERROR =
  "skipped: local transcript source gone after 3 attempt(s) (source_gone)";

export type DeadTranscriptSeed = {
  /** External session id the dead row is keyed by (with `fileKey`). */
  externalSessionId: string;
  /** Absolute path the row claims as its source. Deliberately nonexistent. */
  sourcePath: string;
};

/**
 * Block until the db host has applied EVERY bundled migration.
 *
 * Call this while the FIRST launch is still up. The store is created and
 * migrated asynchronously after boot, so closing the app on a fixed delay can
 * leave the file half-migrated — and a seeder polling a dead database just burns
 * its whole budget before failing.
 *
 * Waiting on the whole history rather than on `transcript_sync_state` alone is
 * the point. That table arrives in `0014`, but `missing_source_count` — a column
 * the dead-row seed writes — only arrives in `0028`, so a table-only barrier can
 * return against a store that cannot accept the insert, and fails later with
 * `no column named missing_source_count` instead of here.
 */
export async function waitForTranscriptSyncSchema(
  userDataDir: string
): Promise<void> {
  const client = openSeedClient(userDataDir);
  try {
    await applyDesktopBusyTimeout(client);
    await waitForMigrationsApplied(client, SEED_SCHEMA_TIMEOUT_MS);
  } finally {
    client.close();
  }
}

/**
 * Write one terminally dead-lettered transcript row into a launch's store.
 *
 * The shape mirrors the field report on ISS-7094: a `backfill` row whose source
 * file was deleted by the harness's own retention, dead-lettered after the
 * missing-source attempt limit with the `source_gone` reason.
 */
export async function seedDeadTranscriptSyncRow(
  userDataDir: string,
  seed: DeadTranscriptSeed
): Promise<void> {
  const client = openSeedClient(userDataDir);
  try {
    await applyDesktopSeedPragmas(client);
    // The full history, not just this table — see waitForTranscriptSyncSchema.
    await waitForMigrationsApplied(client, SEED_SCHEMA_TIMEOUT_MS);
    const now = new Date(0).toISOString();
    await client.execute({
      sql: `INSERT INTO ${TRANSCRIPT_SYNC_TABLE} (
              external_session_id, file_key, source_harness, source_path,
              source_path_hash, synced_byte_offset, status, sync_class,
              retry_count, missing_source_count, last_error,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0, 3, ?, ?, ?)`,
      args: [
        seed.externalSessionId,
        MAIN_FILE_KEY,
        CLAUDE_SOURCE_HARNESS,
        seed.sourcePath,
        `hash-${seed.externalSessionId}`,
        TranscriptSyncStatus.Dead,
        TranscriptSyncClass.Backfill,
        SOURCE_GONE_LAST_ERROR,
        now,
        now,
      ],
    });
  } finally {
    client.close();
  }
}

/** How many rows the store currently holds at `status`. */
export async function countTranscriptSyncRowsByStatus(
  userDataDir: string,
  status: TranscriptSyncStatus
): Promise<number> {
  const client: SeedClient = openSeedClient(userDataDir);
  try {
    const rs = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM ${TRANSCRIPT_SYNC_TABLE} WHERE status = ?`,
      args: [status],
    });
    return Number(rs.rows[0]?.n ?? 0);
  } finally {
    client.close();
  }
}
