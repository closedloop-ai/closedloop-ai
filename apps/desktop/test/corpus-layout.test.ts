import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  classifyRawFiles,
  listDossierDirs,
  listDossierRawDirs,
} from "../src/main/collectors/golden/corpus-layout.js";

// --- Helpers ---

/**
 * Builds a synthetic corpus with two real dossier dirs plus all the entry
 * types that listDossierDirs must skip: _templates, collection-kit, a
 * dot-dir, and a plain file.
 */
function makeCorpus(): { corpusDir: string } {
  const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), "cl-corpus-"));

  // Non-dossier directories (NON_DOSSIER_DIRS set in implementation)
  fs.mkdirSync(path.join(corpusDir, "_templates"));
  fs.mkdirSync(path.join(corpusDir, "collection-kit"));

  // Dot-directory — must be skipped regardless of name
  fs.mkdirSync(path.join(corpusDir, ".hidden-dir"));

  // Plain file — not a directory, must be skipped
  fs.writeFileSync(path.join(corpusDir, "readme.txt"), "");

  // Real dossier directories — sorted alphabetically: alpha < beta
  fs.mkdirSync(path.join(corpusDir, "session-alpha-001"));
  fs.mkdirSync(path.join(corpusDir, "session-beta-002"));

  return { corpusDir };
}

// --- listDossierDirs ---

test("listDossierDirs skips _templates, collection-kit, dot-dirs, and plain files; returns sorted dossier dirs", () => {
  const { corpusDir } = makeCorpus();
  const result = listDossierDirs(corpusDir);

  assert.equal(result.length, 2);
  assert.equal(result[0].sessionId, "session-alpha-001");
  assert.equal(result[1].sessionId, "session-beta-002");
  assert.equal(result[0].dir, path.join(corpusDir, "session-alpha-001"));
  assert.equal(result[1].dir, path.join(corpusDir, "session-beta-002"));
});

test("listDossierDirs returns empty array when root does not exist", () => {
  const nonexistent = path.join(os.tmpdir(), `cl-missing-${Date.now()}`);
  assert.deepEqual(listDossierDirs(nonexistent), []);
});

test("listDossierDirs skips the node_modules directory", () => {
  const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), "cl-nm-"));
  fs.mkdirSync(path.join(corpusDir, "node_modules"));
  fs.mkdirSync(path.join(corpusDir, "real-dossier"));
  const result = listDossierDirs(corpusDir);
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, "real-dossier");
});

test("listDossierDirs returns empty array when corpus contains only non-dossier entries", () => {
  const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), "cl-only-skipped-"));
  fs.mkdirSync(path.join(corpusDir, "_templates"));
  fs.writeFileSync(path.join(corpusDir, "plain.txt"), "");
  assert.deepEqual(listDossierDirs(corpusDir), []);
});

// --- listDossierRawDirs ---

test("listDossierRawDirs appends /raw and carries sessionId and dir from each dossier", () => {
  const { corpusDir } = makeCorpus();
  const result = listDossierRawDirs(corpusDir);

  assert.equal(result.length, 2);

  assert.equal(result[0].sessionId, "session-alpha-001");
  assert.equal(result[0].dir, path.join(corpusDir, "session-alpha-001"));
  assert.equal(
    result[0].rawDir,
    path.join(corpusDir, "session-alpha-001", "raw")
  );

  assert.equal(result[1].sessionId, "session-beta-002");
  assert.equal(
    result[1].rawDir,
    path.join(corpusDir, "session-beta-002", "raw")
  );
});

// --- classifyRawFiles ---

test("classifyRawFiles: single .db file → opencode with dbFile", () => {
  const sid = "session-ocd-001";
  const result = classifyRawFiles([`${sid}.db`], sid);
  assert.deepEqual(result, { kind: "opencode", dbFile: `${sid}.db` });
});

test("classifyRawFiles: rollout files with one rollout containing the sessionId → codex", () => {
  // Parent rollout name includes the full session ID; child names do not.
  const sid = "01JX9ABCDEF";
  const parent = `rollout-${sid}-v1.jsonl`;
  const child = "rollout-01JX9CHILD-v1.jsonl";
  // Supply in reverse sorted order to verify the function sorts internally.
  const result = classifyRawFiles([child, parent], sid);
  assert.equal(result.kind, "codex");
  if (result.kind === "codex") {
    assert.equal(result.parent, parent);
    assert.deepEqual(result.rollouts, [parent, child].sort());
  }
});

test("classifyRawFiles: rollout files with no rollout containing the sessionId → throws", () => {
  assert.throws(
    () =>
      classifyRawFiles(
        ["rollout-child1-v1.jsonl", "rollout-child2-v1.jsonl"],
        "parent-session-xyz"
      ),
    Error
  );
});

test("classifyRawFiles: <sessionId>.jsonl present → claude with main filename", () => {
  const sid = "session-claude-001";
  const result = classifyRawFiles([`${sid}.jsonl`], sid);
  assert.deepEqual(result, { kind: "claude", main: `${sid}.jsonl` });
});

test("classifyRawFiles: missing <sessionId>.jsonl with no rollouts and no .db → throws", () => {
  assert.throws(
    () => classifyRawFiles(["other-file.jsonl"], "my-session"),
    Error
  );
});

test("classifyRawFiles: empty file list → throws", () => {
  assert.throws(() => classifyRawFiles([], "my-session"), Error);
});

test("classifyRawFiles: .db file present alongside rollout files → opencode wins (.db checked first)", () => {
  const sid = "session-mixed";
  const result = classifyRawFiles([`rollout-${sid}-v1.jsonl`, "store.db"], sid);
  // The .db branch triggers before the rollout branch in classifyRawFiles.
  assert.deepEqual(result, { kind: "opencode", dbFile: "store.db" });
});
