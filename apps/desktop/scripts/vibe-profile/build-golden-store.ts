import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type VibeCorpusTimeMap,
  vibeCorpusTimeMapPath,
} from "@repo/api/src/vibe-seed-corpus-time";
import { CollectorManager } from "../../src/main/collectors/engine/collector-manager.js";
import { createGoldenCollectors } from "../../src/main/collectors/golden/golden-collectors.js";
import {
  type StaleSessionSweepResult,
  sweepOrphanedSessions,
} from "../../src/main/database/session-maintenance.js";
import type { SqliteAgentDatabase } from "../../src/main/database/sqlite.js";
import { openSqliteAgentDatabase } from "../../src/main/database/sqlite.js";
import {
  assertBackfillsClean,
  runRehearsalBackfills,
  stageCorpusIntoTemp,
} from "../rehearsal-build-store";
import { rewriteStoreCorpus } from "./corpus-rewrite";
import {
  CORPUS_SESSION_SPANS_SQL,
  computeCorpusShiftMs,
  findCorpusIdleGaps,
  NEWEST_CORPUS_INSTANT_SQL,
  shiftEmbeddedSessionInstants,
  shiftStoreTimestamps,
} from "./corpus-time-shift";
import { settleStaleBranches } from "./settle-stale-branches";

export type GoldenStoreBuild = {
  readonly newestCorpusInstant: string;
  readonly corpusShiftMs: number;
  readonly sessionCount: number;
};

/**
 * The frozen corpus spans more than the 90-day retention window, so the import
 * open keeps everything; the shifted store is then reopened on the production
 * default, which applies the same sweep the launched app would.
 */
const IMPORT_RETENTION_DAYS = 36_500;

/**
 * Builds the golden corpus into `storePath` with the same importer and
 * post-import backfills the DATA_REVISION rehearsal uses
 * (`scripts/rehearsal-build-store.ts`), then moves corpus time so the newest
 * session lands on `nowIso` (see `corpus-time-shift.ts`), records that shift
 * beside the store (`vibeCorpusTimeMapPath`) for the transcripts the web seed
 * uploads, rewrites the corpus to
 * Acme Co's work (`corpus-rewrite.ts`), closes the sessions idle past Desktop's
 * own threshold, and re-derives the
 * analytics rollups from the shifted rows through the store's own recompute.
 *
 * Unlike the rehearsal it injects no missing-source fixture and claims no
 * owner identity: the signed-in Desktop claims the corpus for the real account
 * on its first launch.
 */
export async function buildShiftedGoldenStore(
  storePath: string,
  nowIso: string,
  log: (message: string) => void
): Promise<GoldenStoreBuild> {
  const importStartedAt = new Date().toISOString();
  const stagingDir = stageCorpusIntoTemp();
  const db = await openSqliteAgentDatabase({
    dataDir: storePath,
    detectBillingMode: () => "metered_api",
    retentionDays: IMPORT_RETENTION_DAYS,
    log,
  });
  try {
    await runGoldenBootImport(db, stagingDir, log);
    assertBackfillsClean(await runRehearsalBackfills(db, stagingDir, log));
    await db.whenBootMaintenanceSettled();
    const newestCorpusInstant = await readNewestCorpusInstant(db);
    const corpusShiftMs = computeCorpusShiftMs(newestCorpusInstant, nowIso);
    const idleGaps = findCorpusIdleGaps(
      await db.prisma.client.$queryRawUnsafe<
        { startedAt: string; lastActivityAt: string }[]
      >(CORPUS_SESSION_SPANS_SQL)
    );
    const shifted = await shiftStoreTimestamps(
      db.prisma,
      corpusShiftMs,
      importStartedAt,
      idleGaps
    );
    const timeMap: VibeCorpusTimeMap = {
      shiftMs: corpusShiftMs,
      importStartedAt,
      idleGaps,
    };
    writeFileSync(
      vibeCorpusTimeMapPath(storePath),
      `${JSON.stringify(timeMap, null, 2)}\n`
    );
    const embedded = await shiftEmbeddedSessionInstants(
      db.prisma,
      corpusShiftMs,
      importStartedAt,
      idleGaps
    );
    log(`shifted the instants inside ${embedded} session JSON value(s)`);
    log(
      `closed ${idleGaps.length} idle gap(s) in the corpus, ${Math.round(idleGaps.reduce((sum, gap) => sum + gap.closeMs, 0) / 86_400_000)} day(s) in all`
    );
    log(
      `shifted ${shifted.columnsShifted} time columns by ${corpusShiftMs} ms (newest corpus session ${newestCorpusInstant} -> ${nowIso})`
    );
    const rewrite = await rewriteStoreCorpus(db);
    log(
      `rewrote ${rewrite.valuesRewritten} corpus value(s) to Acme work, retitled ${rewrite.sessionsRetitled} session(s)`
    );
    log(
      `settled ${await settleStaleBranches(db, nowIso)} stale branch(es) through the pull request their session opened`
    );
    const closed = await closeIdleSessions(db, nowIso);
    log(
      `closed ${closed.swept} idle session(s) (${closed.heldBack} held back)`
    );
    const sessionIds = await readSessionIds(db);
    const recompute = await db.recomputeAnalyticsRollups(sessionIds);
    if (recompute.failed > 0) {
      throw new Error(
        `analytics recompute failed for ${recompute.failed} of ${recompute.attempted} shifted sessions`
      );
    }
    return {
      newestCorpusInstant,
      corpusShiftMs,
      sessionCount: sessionIds.length,
    };
  } finally {
    await db.close();
    await rm(stagingDir, { recursive: true, force: true });
  }
}

/**
 * The rehearsal's boot import (`runBootImport` there is module-private and
 * that file must stay copy-in self-contained, so it cannot export it): one
 * collector boot pass over the staged corpus, with collection disabled so no
 * live capture starts.
 */
async function runGoldenBootImport(
  db: SqliteAgentDatabase,
  stagingDir: string,
  log: (message: string) => void
): Promise<void> {
  const collectors = createGoldenCollectors(stagingDir);
  if (collectors.length === 0) {
    throw new Error("golden corpus produced no collectors: empty staging dir");
  }
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "vibe-profile-state-"));
  let resolveBootComplete: () => void = () => undefined;
  const bootComplete = new Promise<void>((resolve) => {
    resolveBootComplete = resolve;
  });
  const manager = new CollectorManager({
    importer: db.importer,
    stateDir,
    emit: () => undefined,
    getCollectionMode: () => "disabled",
    onBootImportComplete: () => resolveBootComplete(),
    collectors,
    catchupPollMs: null,
  });
  try {
    manager.start();
    await bootComplete;
    await manager.stop();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
  log("golden boot import complete");
}

async function readNewestCorpusInstant(
  db: SqliteAgentDatabase
): Promise<string> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { newest: string | null }[]
  >(NEWEST_CORPUS_INSTANT_SQL);
  const newest = rows[0]?.newest;
  if (!newest) {
    throw new Error("the golden corpus imported zero sessions");
  }
  return newest;
}

async function readSessionIds(db: SqliteAgentDatabase): Promise<string[]> {
  const rows = await db.prisma.client.session.findMany({
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * ISS-12135: the importer stamps `sessions.updated_at` with its own clock, so
 * every corpus session looked freshly updated and Desktop's idle sweep
 * (`sweepOrphanedSessions`, the one a launched Desktop runs at boot) left them
 * all active: months-old runs showed as live with an ever-growing duration. A
 * corpus session was last updated when it was last active; with that restored,
 * the product's own sweep closes every session idle past its threshold at its
 * last activity, and only the recent ones stay active.
 */
export async function closeIdleSessions(
  db: SqliteAgentDatabase,
  nowIso: string
): Promise<StaleSessionSweepResult> {
  await db.prisma.write((client) =>
    client.$executeRawUnsafe(
      "UPDATE sessions SET updated_at = last_activity_at WHERE last_activity_at > '2000' AND updated_at > last_activity_at"
    )
  );
  return sweepOrphanedSessions(db.prisma, nowIso);
}
