/**
 * @file rehearsal-verify.ts
 * @description ISS-5104 (PRD-611 gap 4) — Phase B of the DATA_REVISION rebuild
 * rehearsal: run THIS checkout's boot path over a store built by PREVIOUS code
 * (`rehearsal-build-store.ts` in the PR's merge-base worktree), then assert the
 * seam held. The boot path mirrors production (`post-boot-maintenance.ts`)
 * minus the Electron runtime deps:
 *
 *   1. `openSqliteAgentDatabase` — the migration runner applies pending
 *      migrations at open;
 *   2. `runDataRevisionRebuild` over the golden collectors, with the same
 *      `useStoredComponentInvocationRebuild: true` and in-process
 *      `collector.parse` fallback production uses without a parse runner;
 *   3. the artifact-link + activity-segment backfills.
 *
 * Assertions: zero failed rebuild sessions, zero sessions left at
 * DATA_REVISION_IMPORT_PENDING or a stale revision, `PRAGMA foreign_key_check`
 * empty (via `assertStoreIntegrity`, ISS-5100 — this is what attributes an
 * ISS-5098-class strand to its table), and no session that had invocation/
 * analytics rows before the rebuild loses them.
 *
 * Usage: pnpm exec tsx scripts/rehearsal-verify.ts --store <dir>
 * (`<dir>` is the `--out` dir a prior rehearsal-build-store run produced.)
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATA_REVISION,
  DATA_REVISION_IMPORT_PENDING,
} from "../src/main/collectors/engine/data-revision.js";
import { runDataRevisionRebuild } from "../src/main/collectors/engine/data-revision-rebuild.js";
import { createGoldenCollectors } from "../src/main/collectors/golden/golden-collectors.js";
import { assertStoreIntegrity } from "../test/agent-db-test-utils.js";
import {
  assertBackfillsClean,
  collectSessionStates,
  openRehearsalDb,
  REHEARSAL_MANIFEST_FILE,
  runRehearsalBackfills,
  stageCorpusIntoTemp,
} from "./rehearsal-build-store.js";
import {
  collectRehearsalViolations,
  rehearsalManifestSchema,
} from "./rehearsal-verify-checks.js";

async function main(): Promise<void> {
  const storeFlagIndex = process.argv.indexOf("--store");
  const storeDir =
    storeFlagIndex >= 0 ? process.argv[storeFlagIndex + 1] : undefined;
  if (!storeDir) {
    throw new Error("usage: tsx scripts/rehearsal-verify.ts --store <dir>");
  }
  const log = (message: string) => console.log(`[rehearsal-verify] ${message}`);
  const startedAt = Date.now();

  const manifest = rehearsalManifestSchema.parse(
    JSON.parse(
      await readFile(path.join(storeDir, REHEARSAL_MANIFEST_FILE), "utf8")
    )
  );
  log(`manifest: ${manifest.sessions.length} pre-rebuild sessions`);

  const stagingDir = stageCorpusIntoTemp();
  // Boot phase 1: opening the store applies any pending migrations.
  const db = await openRehearsalDb(storeDir);
  try {
    // Boot phase 2: the DATA_REVISION rebuild, wired like post-boot-maintenance.
    const summary = await runDataRevisionRebuild({
      collectors: createGoldenCollectors(stagingDir),
      db,
      log,
      useStoredComponentInvocationRebuild: true,
      parseSource: (collector, source) => collector.parse(source),
    });
    log(
      `rebuild summary: stale=${summary.staleTotal} rebuilt=${summary.rebuilt} ` +
        `deleted=${summary.deleted} missingSource=${summary.missingSource} ` +
        `parseErrors=${summary.parseErrors} errors=${summary.errors}`
    );

    // Boot phase 3: the post-import backfills. Their per-file failures land in
    // an `errors` counter rather than throwing, so discarding the result would
    // let a wholly broken backfill leave this rehearsal green.
    assertBackfillsClean(await runRehearsalBackfills(db, stagingDir, log));

    // Quiesce writers BEFORE snapshotting and sweeping. `writeQueue.drain()`
    // alone can observe an empty queue between boot-maintenance passes, so wait
    // for that chain to settle first; then stop the scheduler and drain, which
    // mirrors openTestDb's close ordering. All three are idempotent, so the
    // close() below re-runs them safely.
    await db.whenBootMaintenanceSettled();
    await db.scheduler.stop().catch(() => undefined);
    await db.writeQueue.drain();

    const postSessions = await collectSessionStates(db);
    const violations = collectRehearsalViolations({
      manifest,
      postSessions,
      outcome: summary,
      currentRevision: DATA_REVISION,
      importPendingSentinel: DATA_REVISION_IMPORT_PENDING,
    });
    // The FK sweep is the ISS-5098-class detector: its failure message names
    // the table holding the dangling rows (e.g. agent_component_invocations).
    try {
      await assertStoreIntegrity(db);
    } catch (integrityError) {
      violations.push(String(integrityError));
    }
    if (violations.length > 0) {
      throw new Error(
        `DATA_REVISION rebuild rehearsal FAILED:\n - ${violations.join("\n - ")}`
      );
    }
    log(
      `rehearsal PASSED (${Math.round((Date.now() - startedAt) / 1000)}s): ` +
        `${postSessions.length} sessions clean at revision ${DATA_REVISION}`
    );
  } finally {
    await db.close();
    await rm(stagingDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[rehearsal-verify] ${error}`);
    process.exitCode = 1;
  });
}
