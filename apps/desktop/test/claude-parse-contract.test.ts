/**
 * @file claude-parse-contract.test.ts
 * @description The `parseSessionFile` contract itself: the broad shape a real transcript produces, and the documented null return for a transcript with no usable timestamp.
 *
 * Carved out of `collectors-parsers.test.ts`, which now covers the remaining
 * four harnesses (Copilot, OpenCode, Codex, Cursor) in one grandfathered file,
 * so the Claude parser's contract is readable from the file tree. Behavior is
 * unchanged — these are the same tests, relocated.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import {
  cleanupTempDirs,
  makeTempDir,
  writeJsonl,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

describe("Claude parser contract", () => {
  test("Claude parser extracts session metadata, tokens, tools, and thinking", async () => {
    const dir = makeTempDir("claude-proj-");
    const filePath = writeJsonl(dir, "claude-sess-1.jsonl", [
      {
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        gitBranch: "main",
        version: "1.2.3",
        message: {
          role: "user",
          content: "Investigate the local changes.",
        },
      },
      {
        type: "assistant",
        timestamp: "2024-03-09T16:00:05.000Z",
        message: {
          model: "claude-opus-4-5",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 5,
          },
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "tool_use", name: "Read", input: { file_path: "x" } },
          ],
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.equal(parsed.sessionId, "claude-sess-1");
    assert.equal(parsed.cwd, "/Users/dev/proj");
    assert.equal(parsed.gitBranch, "main");
    assert.equal(parsed.version, "1.2.3");
    assert.equal(parsed.model, "claude-opus-4-5");
    assert.equal(parsed.userMessages, 1);
    assert.equal(parsed.assistantMessages, 1);
    assert.equal(parsed.messages[0]?.role, "human");
    assert.equal(parsed.messages[0]?.text, "Investigate the local changes.");
    assert.equal(parsed.thinkingBlockCount, 1);
    assert.equal(parsed.toolUses.length, 1);
    assert.equal(parsed.toolUses[0].name, "Read");
    // FEA-2642: parser classifies each tool_use — Read is a builtin — and a
    // session with no Skill invocations has an empty first-class skills list.
    assert.equal(parsed.toolUses[0].kind, "builtin");
    assert.deepEqual(parsed.skills, []);
    assert.deepEqual(parsed.messageTimestamps, ["2024-03-09T16:00:05.000Z"]);
    assert.deepEqual(parsed.tokensByModel["claude-opus-4-5"], {
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
    });
    assert.equal(parsed.startedAt, "2024-03-09T16:00:00.000Z");
    assert.equal(parsed.endedAt, "2024-03-09T16:00:05.000Z");
    assert.equal(parsed.entrypoint, "claude");
  });

  test("Claude parser returns null for a transcript with no timestamps", async () => {
    const dir = makeTempDir("claude-empty-");
    const filePath = path.join(dir, "empty.jsonl");
    writeFileSync(filePath, `${JSON.stringify({ type: "summary" })}\n`, "utf8");
    assert.equal(await parseClaudeFile(filePath), null);
  });

  // An unreadable transcript REJECTS rather than resolving null. A file the
  // importer cannot read is a fact worth surfacing, not an empty result that
  // reads identically to "this session had nothing in it".
  test("Claude parser throws when the transcript does not exist", async () => {
    const dir = makeTempDir("claude-missing-");
    await assert.rejects(
      () => parseClaudeFile(path.join(dir, "absent.jsonl")),
      (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, "ENOENT");
        return true;
      }
    );
  });

  // A distinct failure POINT from the one above: opening a directory succeeds,
  // so the fault surfaces mid-read with a descriptor already held. That is the
  // shape the cleanup below has to survive.
  test("Claude parser throws when the transcript path is a directory", async () => {
    const dir = makeTempDir("claude-isdir-");
    await assert.rejects(
      () => parseClaudeFile(dir),
      (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, "EISDIR");
        return true;
      }
    );
  });
});
