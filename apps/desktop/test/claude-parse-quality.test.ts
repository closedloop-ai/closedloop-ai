/**
 * @file claude-parse-quality.test.ts
 * @description The malformed-line signal (FEA-2771 / FEA-2905). A malformed FINAL line is the benign shape of a live or interrupted write; a malformed line anywhere earlier silently drops that turn's messages and token usage, so the two must stay distinguishable — in the main transcript and in a folded subagent sidecar alike.
 *
 * Carved out of `collectors-parsers.test.ts`, which now covers the remaining
 * four harnesses (Copilot, OpenCode, Codex, Cursor) in one grandfathered file,
 * so the Claude parser's contract is readable from the file tree. Behavior is
 * unchanged — these are the same tests, relocated.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

describe("Claude parser parse quality", () => {
  // FEA-2771: malformed JSONL lines are skipped silently; the parse-quality
  // signal must count them and separate a benign truncated final line from
  // mid-file corruption that drops a turn with no other trace.
  const userLine = JSON.stringify({
    type: "user",
    timestamp: "2024-03-09T16:00:00.000Z",
    // Synthetic, non-home cwd: these parse-quality cases don't exercise cwd
    // path handling, so keep it machine-independent (apps/desktop/AGENTS.md).
    cwd: "/workspace/project",
    message: { role: "user", content: "hello" },
  });
  const assistantLine = JSON.stringify({
    type: "assistant",
    timestamp: "2024-03-09T16:00:05.000Z",
    message: {
      model: "claude-opus-4-5",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: "text", text: "hi" }],
    },
  });
  // A truncated mid-write line: valid JSON prefix, no closing brace.
  const truncatedLine = '{"type":"assistant","timestamp":"2024-03-09T16:00:06';

  test("Claude parser reports a clean parse quality when all lines are valid", async () => {
    const dir = makeTempDir("claude-pq-clean-");
    const filePath = path.join(dir, "clean.jsonl");
    writeFileSync(filePath, `${userLine}\n${assistantLine}\n`, "utf8");

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.deepEqual(parsed.parseQuality, {
      totalLines: 2,
      malformedLines: 0,
      truncatedFinalLine: false,
    });
  });

  test("Claude parser flags a truncated final line as benign in parse quality (FEA-2771)", async () => {
    const dir = makeTempDir("claude-pq-truncated-");
    const filePath = path.join(dir, "truncated.jsonl");
    // Valid turns followed by a truncated trailing line (live/interrupted write).
    writeFileSync(
      filePath,
      `${userLine}\n${assistantLine}\n${truncatedLine}\n`,
      "utf8"
    );

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // Prior turns still parse; the trailing drop is flagged but expected.
    assert.deepEqual(parsed.tokensByModel["claude-opus-4-5"], {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
    });
    assert.deepEqual(parsed.parseQuality, {
      totalLines: 3,
      malformedLines: 1,
      truncatedFinalLine: true,
    });
  });

  test("Claude parser flags mid-file corruption in parse quality (FEA-2771)", async () => {
    const dir = makeTempDir("claude-pq-corrupt-");
    const filePath = path.join(dir, "corrupt.jsonl");
    // A malformed line BEFORE the final line: real corruption, not truncation.
    writeFileSync(
      filePath,
      `${userLine}\n${truncatedLine}\n${assistantLine}\n`,
      "utf8"
    );

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.deepEqual(parsed.parseQuality, {
      totalLines: 3,
      malformedLines: 1,
      // Final line parsed cleanly → the drop is mid-file, not a truncation.
      truncatedFinalLine: false,
    });
    // Consumers derive mid-file corruption = malformedLines - (truncated ? 1 : 0).
    const midFileMalformed =
      (parsed.parseQuality?.malformedLines ?? 0) -
      (parsed.parseQuality?.truncatedFinalLine ? 1 : 0);
    assert.equal(midFileMalformed, 1);
  });

  // A distinct valid subagent turn, used to place corruption mid-file (a
  // malformed line that is NOT the subagent's final line).
  const subAssistantLine = JSON.stringify({
    type: "assistant",
    timestamp: "2024-03-09T16:00:10.000Z",
    message: {
      model: "claude-opus-4-5",
      usage: {
        input_tokens: 20,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: "text", text: "sub" }],
    },
  });

  test("Claude parser surfaces mid-file corruption in a subagent transcript (FEA-2905)", async () => {
    const dir = makeTempDir("claude-pq-subagent-corrupt-");
    const sessionId = "claude-pq-subagent-corrupt";
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    // Clean main transcript: no corruption, no truncated final line.
    writeFileSync(filePath, `${userLine}\n${assistantLine}\n`, "utf8");

    // A subagent sidecar with a malformed line BEFORE its final line: real
    // corruption that silently drops that turn's folded token usage. Without
    // FEA-2905 the parent still reports a clean parse (malformedLines: 0).
    const subagentsDir = path.join(dir, sessionId, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      path.join(subagentsDir, "agent-corrupt.jsonl"),
      `${subAssistantLine}\n${truncatedLine}\n${subAssistantLine}\n`,
      "utf8"
    );

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // Main (2) + subagent (3) lines are aggregated; the subagent's malformed
    // line is mid-file (its final line parsed cleanly), so it reads as genuine
    // corruption rather than a benign truncation.
    assert.deepEqual(parsed.parseQuality, {
      totalLines: 5,
      malformedLines: 1,
      truncatedFinalLine: false,
    });
    const midFileMalformed =
      (parsed.parseQuality?.malformedLines ?? 0) -
      (parsed.parseQuality?.truncatedFinalLine ? 1 : 0);
    assert.equal(midFileMalformed, 1);
  });

  test("Claude parser treats a truncated subagent final line as benign, not corruption (FEA-2905)", async () => {
    const dir = makeTempDir("claude-pq-subagent-truncated-");
    const sessionId = "claude-pq-subagent-truncated";
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    // Clean main transcript.
    writeFileSync(filePath, `${userLine}\n${assistantLine}\n`, "utf8");

    // A subagent sidecar whose only malformed line is its FINAL line — the
    // benign shape of a still-running/interrupted subagent write. It must be
    // discounted the same way the main transcript's truncated final line is, so
    // it does not read as mid-file corruption for the parent session.
    const subagentsDir = path.join(dir, sessionId, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      path.join(subagentsDir, "agent-live.jsonl"),
      `${subAssistantLine}\n${truncatedLine}\n`,
      "utf8"
    );

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // The subagent's valid turn still folds its tokens into the parent.
    assert.equal(
      parsed.tokensByModel["claude-opus-4-5"]?.input,
      // main assistant (100) + subagent assistant (20)
      120
    );
    // Main (2) + subagent (2) lines counted, but the subagent's benign trailing
    // truncation is discounted → no mid-file corruption reported.
    assert.deepEqual(parsed.parseQuality, {
      totalLines: 4,
      malformedLines: 0,
      truncatedFinalLine: false,
    });
    const midFileMalformed =
      (parsed.parseQuality?.malformedLines ?? 0) -
      (parsed.parseQuality?.truncatedFinalLine ? 1 : 0);
    assert.equal(midFileMalformed, 0);
  });
});
