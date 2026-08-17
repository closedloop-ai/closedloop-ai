/**
 * @file rehearsal-build-store.ts
 * @description ISS-5104 (PRD-611 gap 4) — Phase A of the DATA_REVISION rebuild
 * rehearsal: build a desktop store from the golden corpus using THIS checkout's
 * importer, plus a manifest of per-session pre-state. The rehearsal workflow
 * runs this inside the PR's MERGE-BASE worktree, so the store is "written by
 * previous code"; `rehearsal-verify.ts` then runs the CURRENT code's boot path
 * (migrations → runDataRevisionRebuild → backfills) over it.
 *
 * COPY-IN COMPATIBILITY (do not break): when a merge-base predates this script,
 * the workflow copies the PR's copy of THIS ONE FILE into the merge-base
 * worktree and runs it there. It must therefore stay self-contained (no imports
 * from sibling rehearsal modules) and import only long-stable desktop modules:
 * `openSqliteAgentDatabase`, `CollectorManager`, the golden-mode staging helpers
 * (FEA-2648), and the two post-import backfills. `rehearsal-verify.ts` imports
 * the shared helpers exported here; the guarded `main()` below keeps that import
 * side-effect-free.
 *
 * Usage: pnpm exec tsx scripts/rehearsal-build-store.ts --out <dir>
 * Output: <dir>/agent-dashboard.sqlite (cleanly closed) + <dir>/manifest.json
 */
import { mkdtempSync, readdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import {
  classifyRawFiles,
  listDossierDirs,
} from "../src/main/collectors/golden/corpus-layout.js";
import {
  createGoldenCollectors,
  stageGoldenCorpus,
} from "../src/main/collectors/golden/golden-collectors.js";
import { backfillActivitySegmentsFromTranscripts } from "../src/main/collectors/parsing/activity-segment-backfill.js";
import { backfillArtifactLinksFromTranscripts } from "../src/main/collectors/parsing/artifact-link-backfill.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

/**
 * Fixed clock for both rehearsal phases: later than every timestamp in the
 * frozen corpus, so every imported session classifies as terminal (the rebuild
 * skips active sessions) and reruns are deterministic (no wall-clock reliance).
 */
export const REHEARSAL_NOW_ISO = "2027-01-01T00:00:00.000Z";

/** The store file name under the rehearsal output dir (dataDir = this file). */
export const REHEARSAL_STORE_FILE = "agent-dashboard.sqlite";

/** The manifest file name under the rehearsal output dir. */
export const REHEARSAL_MANIFEST_FILE = "manifest.json";

export type RehearsalSessionState = {
  id: string;
  dataRevision: number;
  invocationCount: number;
  analyticsCount: number;
};

/** Open the rehearsal store with the fixed rehearsal defaults. */
export function openRehearsalDb(outDir: string): Promise<SqliteAgentDatabase> {
  return openSqliteAgentDatabase({
    dataDir: path.join(outDir, REHEARSAL_STORE_FILE),
    detectBillingMode: () => "metered_api",
    now: () => REHEARSAL_NOW_ISO,
    // The frozen corpus spans more than the 90-day default data-governance
    // window, and the fixed clock sits after every corpus timestamp — without
    // this, Phase B's boot-time retention sweep would purge the whole store
    // before the rebuild runs. 100 years keeps every dossier retained.
    retentionDays: 36_500,
  });
}

/**
 * The staged corpus's Claude main transcripts, for injecting into the two
 * transcript backfills (their default enumeration walks the operator's REAL
 * `~/.claude` tree — never acceptable in a rehearsal). Mirrors the
 * classification walk in `createGoldenCollectors`, which does not export its
 * per-harness source lists. Codex/opencode dossiers are skipped: the backfill
 * injection hooks are single-harness and default to the Claude adapters.
 */
export function listStagedClaudeMains(stagingDir: string): string[] {
  const mains: string[] = [];
  for (const { sessionId, dir } of listDossierDirs(stagingDir)) {
    const classification = classifyRawFiles(readdirSync(dir), sessionId);
    if (classification.kind === "claude") {
      mains.push(path.join(dir, classification.main));
    }
  }
  return mains;
}

/**
 * Run the two post-import boot backfills over the staged Claude transcripts and
 * report their error counters. Both backfills swallow per-file failures into
 * `errors` rather than throwing, so a caller that discards the results lets a
 * wholly broken backfill leave the rehearsal green — callers MUST fail on a
 * non-zero total.
 */
export async function runRehearsalBackfills(
  db: SqliteAgentDatabase,
  stagingDir: string,
  log: (message: string) => void
): Promise<{ errors: number; scanned: number }> {
  const stagedClaudeMains = listStagedClaudeMains(stagingDir);
  if (stagedClaudeMains.length === 0) {
    throw new Error(
      "no staged Claude main transcripts — both backfills would run over an empty file list and pass vacuously"
    );
  }
  const injection = {
    log,
    listTranscriptFiles: () => stagedClaudeMains,
    sessionIdFromPath: (filePath: string) => path.basename(filePath, ".jsonl"),
  };
  const artifactLinks = await backfillArtifactLinksFromTranscripts(
    db.prisma,
    injection
  );
  const activitySegments = await backfillActivitySegmentsFromTranscripts(
    db.prisma,
    injection
  );
  return {
    errors: artifactLinks.errors + activitySegments.errors,
    scanned: artifactLinks.scanned + activitySegments.scanned,
  };
}

/** Throw when either post-import backfill reported a per-file failure. */
export function assertBackfillsClean(result: {
  errors: number;
  scanned: number;
}): void {
  if (result.errors > 0) {
    throw new Error(
      `post-import backfills reported ${result.errors} per-file error(s) across ${result.scanned} scanned transcript(s)`
    );
  }
}

/**
 * Per-session store state: data_revision plus the ROW COUNTS of the invocation
 * and analytics projections. Counts, not booleans — an `EXISTS` probe only
 * catches total loss, so a rebuild that dropped 51 of a session's 52 invocation
 * rows would still look preserved. Tolerates a store predating the
 * `agent_component_invocations` table (an old merge-base) by reporting 0.
 */
export async function collectSessionStates(
  db: SqliteAgentDatabase
): Promise<RehearsalSessionState[]> {
  const tables = await db.prisma.client.$queryRawUnsafe<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_component_invocations'"
  );
  const invocationsExpr =
    tables.length > 0
      ? "(SELECT COUNT(*) FROM agent_component_invocations i WHERE i.session_id = s.id)"
      : "0";
  const rows = await db.prisma.client.$queryRawUnsafe<
    Array<{
      id: string;
      data_revision: number;
      invocation_count: number;
      analytics_count: number;
    }>
  >(
    `SELECT s.id, s.data_revision,
       ${invocationsExpr} AS invocation_count,
       (SELECT COUNT(*) FROM session_analytics a WHERE a.session_id = s.id) AS analytics_count
     FROM sessions s ORDER BY s.id`
  );
  return rows.map((row) => ({
    id: row.id,
    dataRevision: Number(row.data_revision),
    invocationCount: Number(row.invocation_count),
    analyticsCount: Number(row.analytics_count),
  }));
}

/** Stage the frozen corpus into a fresh temp dir and return the staging path. */
export function stageCorpusIntoTemp(): string {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    ".."
  );
  const corpusDir = path.join(repoRoot, "packages", "golden-sessions");
  const stagingDir = mkdtempSync(
    path.join(os.tmpdir(), "iss5104-golden-staging-")
  );
  stageGoldenCorpus(corpusDir, stagingDir);
  return stagingDir;
}

async function runBootImport(
  db: SqliteAgentDatabase,
  stagingDir: string,
  log: (message: string) => void
): Promise<void> {
  const collectors = createGoldenCollectors(stagingDir);
  if (collectors.length === 0) {
    throw new Error("golden corpus produced no collectors — empty staging dir");
  }
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "iss5104-state-"));
  let resolveBootComplete!: () => void;
  const bootComplete = new Promise<void>((resolve) => {
    resolveBootComplete = resolve;
  });
  const manager = new CollectorManager({
    importer: db.importer,
    detectBillingMode: () => "metered_api",
    stateDir,
    emit: () => {},
    getCollectionMode: () => "disabled",
    onBootImportComplete: () => {
      resolveBootComplete();
    },
    collectors,
    catchupPollMs: null,
  });
  manager.start();
  await bootComplete;
  manager.stop();
  await rm(stateDir, { recursive: true, force: true });
  log("boot import complete");
}

async function main(): Promise<void> {
  const outFlagIndex = process.argv.indexOf("--out");
  const outDir = outFlagIndex >= 0 ? process.argv[outFlagIndex + 1] : undefined;
  if (!outDir) {
    throw new Error("usage: tsx scripts/rehearsal-build-store.ts --out <dir>");
  }
  const log = (message: string) =>
    console.log(`[rehearsal-build-store] ${message}`);
  const startedAt = Date.now();
  await mkdir(outDir, { recursive: true });
  const stagingDir = stageCorpusIntoTemp();
  const db = await openRehearsalDb(outDir);
  try {
    await runBootImport(db, stagingDir, log);
    assertBackfillsClean(await runRehearsalBackfills(db, stagingDir, log));
    // `openSqliteAgentDatabase` kicks off its boot-maintenance chain in the
    // background; without this the manifest could snapshot a store that chain
    // is still mutating, making Phase B's before/after comparison meaningless.
    await db.whenBootMaintenanceSettled();
    const sessions = await collectSessionStates(db);
    if (sessions.length === 0) {
      throw new Error(
        "store built from the golden corpus contains zero sessions — the rehearsal would be vacuous"
      );
    }
    await writeFile(
      path.join(outDir, REHEARSAL_MANIFEST_FILE),
      `${JSON.stringify({ rehearsalManifestVersion: 1, sessions }, null, 2)}\n`
    );
    log(
      `store built: ${sessions.length} sessions, ` +
        `${sessions.reduce((n, s) => n + s.invocationCount, 0)} invocation rows, ` +
        `${sessions.reduce((n, s) => n + s.analyticsCount, 0)} analytics rows ` +
        `(${Math.round((Date.now() - startedAt) / 1000)}s)`
    );
  } finally {
    await db.close();
    await rm(stagingDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[rehearsal-build-store] FAILED: ${error}`);
    process.exitCode = 1;
  });
}
