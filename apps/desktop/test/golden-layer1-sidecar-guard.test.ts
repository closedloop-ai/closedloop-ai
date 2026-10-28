/**
 * ISS-10167: the Layer 1 sidecar guard must FAIL on a planted sidecar. Runs
 * over a synthetic corpus under a temp dir — never the frozen corpus, which is
 * read-only and must never hold a sidecar even briefly.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { findSqliteSidecars } from "../src/main/collectors/golden/corpus-layout.js";

const created: string[] = [];

function makeCorpus(): string {
  const dir = mkdtempSync(join(tmpdir(), "golden-sidecar-guard-"));
  created.push(dir);
  return dir;
}

function plantDossier(
  corpus: string,
  sessionId: string,
  rawEntries: readonly string[]
): string {
  const rawDir = join(corpus, sessionId, "raw");
  mkdirSync(rawDir, { recursive: true });
  for (const entry of rawEntries) {
    writeFileSync(join(rawDir, entry), "");
  }
  return rawDir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clean corpus reports no sidecars", () => {
  const corpus = makeCorpus();
  plantDossier(corpus, "ses_clean", ["opencode.db", "expectations.yaml"]);
  plantDossier(corpus, "ses_claude", ["ses_claude.jsonl"]);
  assert.deepEqual(findSqliteSidecars(corpus), []);
});

test("a planted -wal, -shm, or -journal beside a corpus db is named by path", () => {
  const corpus = makeCorpus();
  const walRaw = plantDossier(corpus, "ses_wal", ["x.db", "x.db-wal"]);
  const shmRaw = plantDossier(corpus, "ses_shm", ["y.db", "y.db-shm"]);
  const journalRaw = plantDossier(corpus, "ses_journal", [
    "z.db",
    "z.db-journal",
  ]);
  assert.deepEqual(findSqliteSidecars(corpus), [
    join(journalRaw, "z.db-journal"),
    join(shmRaw, "y.db-shm"),
    join(walRaw, "x.db-wal"),
  ]);
});

test("scaffolding dirs and a dossier without raw/ are skipped, not errors", () => {
  const corpus = makeCorpus();
  mkdirSync(join(corpus, "_templates", "raw"), { recursive: true });
  writeFileSync(join(corpus, "_templates", "raw", "t.db-wal"), "");
  mkdirSync(join(corpus, "ses_noraw"), { recursive: true });
  assert.deepEqual(findSqliteSidecars(corpus), []);
});
