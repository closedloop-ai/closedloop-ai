/**
 * @file opencode-materialized-discovery.test.ts
 * @description FEA-3932: enumerate materialized OpenCode files under the state
 * dir and map them to `(externalSessionId, fileKey)` refs, plus the discovery
 * composition that appends OpenCode refs after Claude + Codex.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { listOpencodeMaterializedFiles } from "../src/main/transcript-sync/opencode-materialized-discovery.js";
import { opencodeMaterializedRoot } from "../src/main/transcript-sync/opencode-materializer.js";
import { opencodeRefsFromSessions } from "../src/main/transcript-sync/transcript-discovery.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

test("listOpencodeMaterializedFiles maps main + subagent files to refs", () => {
  const stateDir = makeTempDir("opencode-mat-");
  const root = opencodeMaterializedRoot(stateDir);
  const sessionDir = join(root, "opencode-root");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "main.jsonl"), "{}\n");
  writeFileSync(join(sessionDir, "subagent:child.jsonl"), "{}\n");
  // A non-jsonl sibling must be ignored.
  writeFileSync(join(sessionDir, "notes.txt"), "ignore me");

  const files = listOpencodeMaterializedFiles(stateDir);
  const byKey = new Map(files.map((f) => [f.fileKey, f]));
  assert.equal(files.length, 2);
  assert.equal(byKey.get("main")?.externalSessionId, "opencode-root");
  assert.equal(byKey.get("subagent:child")?.externalSessionId, "opencode-root");

  const refs = opencodeRefsFromSessions(files);
  assert.deepEqual(
    refs
      .map((r) => `${r.externalSessionId}:${r.fileKey}:${r.sourceHarness}`)
      .sort(),
    [
      "opencode-root:main:opencode",
      "opencode-root:subagent:child:opencode",
    ].sort()
  );
  rmSync(stateDir, { recursive: true, force: true });
});

test("listOpencodeMaterializedFiles returns empty when the root is absent", () => {
  const files = listOpencodeMaterializedFiles("/nonexistent-state-dir-xyz");
  assert.deepEqual(files, []);
});

test.after(() => cleanupTempDirs());
