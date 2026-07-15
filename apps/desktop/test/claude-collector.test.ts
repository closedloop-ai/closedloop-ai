/**
 * @file claude-collector.test.ts
 * @description Coverage for the Claude collector descriptor's Claude-specific
 * path logic (FEA-2235 coverage gap): the subagent watch-event → parent
 * transcript remap (`sourcePathsForWatchEvent`) and the subagent change-detection
 * mtime fold (`extraMtime`/`maxSubagentMtime`). Both are module-private, so they
 * are exercised through the public `HarnessCollector` surface. The generic
 * watcher tests use synthetic collectors and never reach this Claude path.
 */
import assert from "node:assert/strict";
import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createClaudeCollector } from "../src/main/collectors/claude/claude-collector.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

/** Resolve the (optional) watch-event mapper, asserting the collector defines it. */
function mapWatchEvent(root: string, filename: string): string[] {
  const collector = createClaudeCollector();
  if (!collector.sourcePathsForWatchEvent) {
    throw new Error("claude collector must define sourcePathsForWatchEvent");
  }
  return collector.sourcePathsForWatchEvent(root, filename);
}

// ── sourcePathsForWatchEvent — subagent → parent remap ───────────────────────

test("sourcePathsForWatchEvent returns a relative transcript path joined to the root", () => {
  const root = "/projects/root";
  assert.deepEqual(mapWatchEvent(root, path.join("proj", "ses-1.jsonl")), [
    path.join(root, "proj", "ses-1.jsonl"),
  ]);
});

test("sourcePathsForWatchEvent returns an absolute non-subagent path unchanged", () => {
  const root = "/projects/root";
  const absolute = path.join(root, "proj", "ses-2.jsonl");
  assert.deepEqual(mapWatchEvent(root, absolute), [absolute]);
});

test("sourcePathsForWatchEvent remaps a relative subagent file to its parent transcript", () => {
  const root = "/projects/root";
  // A subagent change event under <proj>/<sessionId>/subagents/agent-*.jsonl
  // must re-import the PARENT session transcript, not the subagent file.
  const event = path.join("proj", "ses-9", "subagents", "agent-abc.jsonl");
  assert.deepEqual(mapWatchEvent(root, event), [
    path.join(root, "proj", "ses-9.jsonl"),
  ]);
});

test("sourcePathsForWatchEvent remaps an absolute subagent file to its parent transcript", () => {
  const root = "/projects/root";
  const event = path.join(
    root,
    "proj",
    "ses-9",
    "subagents",
    "agent-abc.jsonl"
  );
  assert.deepEqual(mapWatchEvent(root, event), [
    path.join(root, "proj", "ses-9.jsonl"),
  ]);
});

test("sourcePathsForWatchEvent does not remap when 'subagents' has no parent session segment", () => {
  const root = "/projects/root";
  // subagentsIndex < 2 (no <proj>/<sessionId> prefix) → treated as a plain file.
  const event = path.join("subagents", "agent-x.jsonl");
  assert.deepEqual(mapWatchEvent(root, event), [path.join(root, event)]);
});

// ── extraMtime — subagent change detection ───────────────────────────────────

function claudeExtraMtime(mainTranscriptPath: string): number | null {
  const collector = createClaudeCollector();
  if (!collector.extraMtime) {
    throw new Error("claude collector must define extraMtime");
  }
  return collector.extraMtime(mainTranscriptPath);
}

test("extraMtime returns null when the session has no subagents directory", () => {
  const root = makeTempDir("claude-coll-");
  const main = path.join(root, "ses-1.jsonl");
  writeFileSync(main, "{}", "utf8");
  assert.equal(claudeExtraMtime(main), null);
});

test("extraMtime returns the max mtime across the session's subagent files", () => {
  const root = makeTempDir("claude-coll-");
  const main = path.join(root, "ses-1.jsonl");
  writeFileSync(main, "{}", "utf8");
  const subagentsDir = path.join(root, "ses-1", "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  const a1 = path.join(subagentsDir, "agent-1.jsonl");
  const a2 = path.join(subagentsDir, "agent-2.jsonl");
  writeFileSync(a1, "{}", "utf8");
  writeFileSync(a2, "{}", "utf8");
  // Force distinct mtimes so "max" is unambiguous (a2 newer than a1).
  utimesSync(
    a1,
    new Date("2026-01-01T00:00:00Z"),
    new Date("2026-01-01T00:00:00Z")
  );
  utimesSync(
    a2,
    new Date("2026-02-01T00:00:00Z"),
    new Date("2026-02-01T00:00:00Z")
  );
  const expected = Math.max(statSync(a1).mtimeMs, statSync(a2).mtimeMs);
  assert.equal(claudeExtraMtime(main), expected);
});

test("extraMtime ignores files that are not agent-*.jsonl", () => {
  const root = makeTempDir("claude-coll-");
  const main = path.join(root, "ses-1.jsonl");
  writeFileSync(main, "{}", "utf8");
  const subagentsDir = path.join(root, "ses-1", "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  const agent = path.join(subagentsDir, "agent-1.jsonl");
  writeFileSync(agent, "{}", "utf8");
  writeFileSync(path.join(subagentsDir, "notes.txt"), "x", "utf8");
  writeFileSync(path.join(subagentsDir, "session.jsonl"), "{}", "utf8"); // no agent- prefix
  // Only agent-1.jsonl counts, so the result equals its mtime exactly.
  assert.equal(claudeExtraMtime(main), statSync(agent).mtimeMs);
});
