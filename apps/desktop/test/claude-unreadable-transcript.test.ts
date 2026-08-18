/**
 * @file claude-unreadable-transcript.test.ts
 * @description What happens to a transcript the importer cannot READ, as opposed
 * to one it reads fine and finds nothing in.
 *
 * The rewritten parser REJECTS on an unreadable transcript where the pre-rewrite
 * shell resolved `null`. That distinction is load-bearing and invisible from the
 * parser alone, because `null` and a rejection travel different paths through
 * every consumer:
 *
 *   `null` means "read fine, nothing importable here" — a terminal answer, so
 *   the consumer marks the source seen and never looks at it again.
 *
 *   A rejection means "could not read it" — not an answer at all. A locked file,
 *   an exhausted descriptor table, a permissions blip: retrying next boot is the
 *   whole point, and marking it seen would discard the session permanently on a
 *   transient fault.
 *
 * So these tests assert the chain, not the throw: that the collector — which is
 * what the import engine actually calls — hands the rejection up rather than
 * flattening it to an empty session list. A test that only asserted `rejects` on
 * the parser would stay green if the collector swallowed it one layer up.
 *
 * Each case is paired with its `null` control, because the bug this guards is a
 * CONFLATION and a test that only pins one side cannot see it.
 */
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { createClaudeCollector } from "../src/main/collectors/claude/claude-collector.js";
import { parseSessionFile } from "../src/main/collectors/claude/claude-parser.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

/** Top-level per `useTopLevelRegex`; these are matched once per assertion. */
const ENOENT_RE = /ENOENT/;
const UNREADABLE_RE = /EACCES|EPERM/;

const USER_LINE = JSON.stringify({
  type: "user",
  timestamp: "2024-03-09T16:00:00.000Z",
  cwd: "/workspace/project",
  message: { role: "user", content: "hello" },
});

describe("Claude parser — an unreadable transcript", () => {
  test("rejects rather than resolving null", async () => {
    const dir = makeTempDir("claude-unreadable-missing-");
    await assert.rejects(
      () => parseSessionFile(path.join(dir, "does-not-exist.jsonl")),
      ENOENT_RE
    );
  });

  test("a readable transcript with no timestamp still resolves null", async () => {
    // The paired control. Both cases produce no session, and conflating them is
    // exactly the bug: this one IS a terminal answer and must stay `null`, or
    // every timestamp-less transcript would be retried on every boot forever.
    const dir = makeTempDir("claude-unreadable-no-ts-");
    const file = path.join(dir, "no-timestamp.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })}\n`
    );
    assert.equal(await parseSessionFile(file), null);
  });

  test("the collector propagates the rejection instead of an empty session list", async () => {
    // The collector's `parse()` is what the import engine calls. Flattening a
    // rejection to `[]` here would put the source on the SAME path as a
    // successfully-parsed-but-empty one — marked seen, never retried — which is
    // the outcome the rejection exists to avoid.
    const dir = makeTempDir("claude-unreadable-collector-missing-");
    const collector = createClaudeCollector({ listSources: () => [] });
    await assert.rejects(
      () => collector.parse(path.join(dir, "does-not-exist.jsonl")),
      ENOENT_RE
    );
  });

  test("the collector still returns an empty list for a readable transcript with no timestamp", async () => {
    const dir = makeTempDir("claude-unreadable-collector-no-ts-");
    const file = path.join(dir, "no-timestamp.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })}\n`
    );
    const collector = createClaudeCollector({ listSources: () => [] });
    assert.deepEqual(await collector.parse(file), []);
  });

  test("a permission-denied transcript rejects, so it is retried rather than discarded", async () => {
    // The transient fault the old `null` swallowed: the file exists and holds a
    // real session, but this process cannot open it right now.
    const dir = makeTempDir("claude-unreadable-locked-");
    const file = path.join(dir, "locked.jsonl");
    writeFileSync(file, `${USER_LINE}\n`);
    chmodSync(file, 0o000);
    try {
      await assert.rejects(() => parseSessionFile(file), UNREADABLE_RE);
    } finally {
      // Restore before cleanup, or the temp-dir teardown cannot remove it.
      chmodSync(file, 0o600);
    }
  });
});
