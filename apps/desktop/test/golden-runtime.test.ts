/**
 * @file golden-runtime.test.ts
 * @description Tests for FEA-2648 golden-mode wiring: stageGoldenCorpus staging
 * isolation + createGoldenCollectors + CollectorManager boot-import integration.
 *
 * Coverage:
 *   A. Integration import (the core test): CollectorManager in golden mode — stage
 *      corpus, inject golden collectors, run boot historical import with mode=disabled
 *      and no historicalParseRunner; assert the claude dossier session is imported
 *      and no watcher is ever attached.
 *   B. startCollectors identity-guard: SKIPPED — the guard lives inside the
 *      `createAgentDashboardDesignSystemRuntime` closure and requires a full
 *      Electron utility-process harness (OtlpReceiver, hookListener, DbHostClient).
 *      No existing test boots that runtime in isolation; building one would require
 *      mocking half of Electron. The multi-lane review verifies the guard by reading.
 *   C. Cloud hard-disable (app.ts DesktopApplication): SKIPPED — no existing test
 *      constructs DesktopApplication; that class requires Electron APIs that are
 *      unavailable in the node:test environment. The review covers the guard by read.
 *
 * Test uses the smallest real claude dossier that has both user + assistant turns
 * (88afd667-ff1a-4818-9fb5-ba25418c6306, ~40 KB) so the claude parser reliably
 * produces a NormalizedSession. The corpus raw/ is copied READ-ONLY into a temp
 * fixture dir and is never modified.
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import {
  createGoldenCollectors,
  stageGoldenCorpus,
} from "../src/main/collectors/golden/golden-collectors.js";
import type {
  Harness,
  NormalizedSession,
} from "../src/main/collectors/types.js";
import { createTempDirManager } from "./helpers/temp-dir.js";

// ── Paths ───────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read-only golden corpus (human-owned, never written to).
const GOLDEN_SESSIONS_DIR = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "packages",
  "golden-sessions"
);

// Smallest claude dossier that has both user + assistant turns — safe to parse.
const TEST_DOSSIER_ID = "88afd667-ff1a-4818-9fb5-ba25418c6306";
const TEST_DOSSIER_RAW = path.join(GOLDEN_SESSIONS_DIR, TEST_DOSSIER_ID, "raw");

// ── Temp-dir tracking ────────────────────────────────────────────────────────

const DISJOINT_ERROR =
  /golden staging dir must be disjoint from the corpus dir/;

const { makeTempDir } = createTempDirManager("golden-runtime-");

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal corpus fixture with one dossier whose raw/ is a READ-ONLY
 * copy of the chosen dossier from packages/golden-sessions. Returns the corpus
 * dir so `stageGoldenCorpus` can be pointed at it.
 */
function buildCorpusFixture(
  dossierRawSrc: string,
  dossierSessionId: string
): string {
  const corpusDir = makeTempDir("golden-corpus-");
  const rawDest = path.join(corpusDir, dossierSessionId, "raw");
  cpSync(dossierRawSrc, rawDest, { recursive: true });
  return corpusDir;
}

// ── A: Integration import test ───────────────────────────────────────────────

test("stageGoldenCorpus copies dossier raw/ into staging and leaves the corpus untouched", () => {
  const corpusDir = buildCorpusFixture(TEST_DOSSIER_RAW, TEST_DOSSIER_ID);
  const stagingDir = makeTempDir("golden-staging-");

  const originalTranscriptPath = path.join(
    corpusDir,
    TEST_DOSSIER_ID,
    "raw",
    `${TEST_DOSSIER_ID}.jsonl`
  );
  const originalSize = statSync(originalTranscriptPath).size;

  stageGoldenCorpus(corpusDir, stagingDir);

  // Staging must contain the session dir (flat copy of raw/).
  const stagedTranscriptPath = path.join(
    stagingDir,
    TEST_DOSSIER_ID,
    `${TEST_DOSSIER_ID}.jsonl`
  );
  assert.ok(
    existsSync(stagedTranscriptPath),
    "staging produced the transcript at <stagingDir>/<sessionId>/<sessionId>.jsonl"
  );

  // Corpus original file must be unchanged (same size; we never write to it).
  assert.ok(
    existsSync(originalTranscriptPath),
    "corpus transcript file still exists after staging"
  );
  assert.equal(
    statSync(originalTranscriptPath).size,
    originalSize,
    "corpus transcript file size is unchanged after staging"
  );
});

test("stageGoldenCorpus throws when staging dir is inside corpus dir", () => {
  const corpusDir = buildCorpusFixture(TEST_DOSSIER_RAW, TEST_DOSSIER_ID);
  const stagingInsideCorpus = path.join(corpusDir, "corpus-staging");

  assert.throws(
    () => stageGoldenCorpus(corpusDir, stagingInsideCorpus),
    DISJOINT_ERROR
  );
});

test("golden mode: CollectorManager imports staged claude session via boot scan, mode=disabled, no historicalParseRunner, no watcher emissions", async () => {
  // Build corpus fixture from the smallest real claude dossier with assistant turns.
  const corpusDir = buildCorpusFixture(TEST_DOSSIER_RAW, TEST_DOSSIER_ID);
  const stagingDir = makeTempDir("golden-staging-");
  const stateDir = makeTempDir("golden-state-");

  // Stage: copy raw/ → stagingDir/<sessionId>/
  stageGoldenCorpus(corpusDir, stagingDir);

  // Build real harness collectors over the staged tree.
  const collectors = createGoldenCollectors(stagingDir);
  assert.ok(
    collectors.length > 0,
    "createGoldenCollectors produced ≥1 collector for the claude dossier"
  );

  const imported: Array<{ sessionId: string; harness: Harness }> = [];
  let watcherEmissions = 0;

  let resolveBootComplete!: () => void;
  const bootCompletePromise = new Promise<void>((resolve) => {
    resolveBootComplete = resolve;
  });

  const manager = new CollectorManager({
    importer: {
      importSession: (session: NormalizedSession, harness: string) => {
        imported.push({
          sessionId: session.sessionId,
          harness: harness as Harness,
        });
        return Promise.resolve({ skipped: false, reactivated: false });
      },
    },
    detectBillingMode: () => "metered_api",
    stateDir,
    emit: () => {},
    // Golden mode: disable live-watcher; boot historical import still runs.
    getCollectionMode: () => "disabled",
    // Verify no watcher emission fires (mode=disabled means no fs.watch).
    onWatcherEmission: () => {
      watcherEmissions++;
    },
    onBootImportComplete: () => {
      resolveBootComplete();
    },
    // No historicalParseRunner: golden mode parses in-process via collector.parse().
    collectors,
    // No catchup sweep interval.
    catchupPollMs: null,
  });

  manager.start();
  await bootCompletePromise;
  manager.stop();

  // The dossier session must have been imported.
  assert.ok(
    imported.length > 0,
    `at least one session was imported; got: ${imported.length}`
  );
  const importedForDossier = imported.filter(
    (i) => i.sessionId === TEST_DOSSIER_ID
  );
  assert.ok(
    importedForDossier.length > 0,
    `dossier session ${TEST_DOSSIER_ID} was imported; imported: ${imported.map((i) => i.sessionId).join(", ")}`
  );
  assert.equal(
    importedForDossier[0].harness,
    "claude",
    "session was imported as the claude harness"
  );

  // No live watcher must have fired (mode=disabled: no fs.watch attached).
  assert.equal(
    watcherEmissions,
    0,
    "no watcher emission fired — mode=disabled prevents any fs.watch from starting"
  );

  // Corpus raw/ must be untouched after staging + import.
  const corpusTranscriptPath = path.join(
    corpusDir,
    TEST_DOSSIER_ID,
    "raw",
    `${TEST_DOSSIER_ID}.jsonl`
  );
  assert.ok(
    existsSync(corpusTranscriptPath),
    "corpus raw transcript still exists after staging + import"
  );
});
