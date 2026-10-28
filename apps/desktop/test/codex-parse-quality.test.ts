/**
 * @file codex-parse-quality.test.ts
 * @description The Codex parser's malformed-line signal (FEA-2907 / FEA-2979 /
 * ISS-6336). A malformed FINAL line is the benign shape of a live or
 * interrupted write; a malformed line anywhere earlier silently drops that
 * turn's messages and token usage, so the two must stay distinguishable — in
 * the main rollout and in a folded workflow journal alike.
 *
 * Carved out of `collectors-parsers.test.ts` exactly as the Claude half already
 * was into `claude-parse-quality.test.ts`, so each parser's parse-quality
 * contract is readable from the file tree and the grandfathered multi-harness
 * file keeps shrinking. Behavior is unchanged — these are the same tests,
 * relocated.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import { parseRolloutFile } from "../src/main/collectors/codex/codex-parser.js";
import { CODEX_UUID } from "./codex-rollout-fixture.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

describe("Codex parser parse quality (FEA-2907)", () => {
  // A minimal, valid Codex rollout: one user turn + one assistant turn whose
  // token usage lands in tokensByModel.
  const codexLines: unknown[] = [
    {
      timestamp: "2026-05-18T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: CODEX_UUID,
        cwd: "/workspace/project",
        cli_version: "0.40.0",
      },
    },
    {
      timestamp: "2026-05-18T10:00:01.000Z",
      type: "turn_context",
      payload: { model: "gpt-5-codex", cwd: "/workspace/project" },
    },
    {
      timestamp: "2026-05-18T10:00:02.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "fix the bug" },
    },
    {
      timestamp: "2026-05-18T10:00:05.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "on it" }],
      },
    },
    {
      timestamp: "2026-05-18T10:00:06.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1200,
            cached_input_tokens: 400,
            output_tokens: 300,
            reasoning_output_tokens: 50,
          },
        },
        turn_context: { model: "gpt-5-codex" },
      },
    },
  ];
  const validText = codexLines.map((line) => JSON.stringify(line)).join("\n");
  // A truncated mid-write line: valid JSON prefix, no closing brace.
  const truncatedLine =
    '{"timestamp":"2026-05-18T10:00:07.000Z","type":"event_msg';

  test("Codex parser reports a clean parse quality when all lines are valid", async () => {
    const dir = makeTempDir("codex-pq-clean-");
    const filePath = path.join(
      dir,
      `rollout-2026-05-18T10-00-00-${CODEX_UUID}.jsonl`
    );
    writeFileSync(filePath, `${validText}\n`, "utf8");

    const parsed = await parseRolloutFile(filePath, {
      mergeWorkflowJournalTokens: false,
    });
    assert.ok(parsed, "expected a parsed Codex rollout");
    assert.deepEqual(parsed.parseQuality, {
      totalLines: 5,
      malformedLines: 0,
      truncatedFinalLine: false,
    });
  });

  test("Codex parser flags a truncated final line as benign in parse quality (FEA-2907)", async () => {
    const dir = makeTempDir("codex-pq-truncated-");
    const filePath = path.join(
      dir,
      `rollout-2026-05-18T10-00-00-${CODEX_UUID}.jsonl`
    );
    // Valid turns followed by a truncated trailing line (live/interrupted write).
    writeFileSync(filePath, `${validText}\n${truncatedLine}\n`, "utf8");

    const parsed = await parseRolloutFile(filePath, {
      mergeWorkflowJournalTokens: false,
    });
    assert.ok(parsed, "expected a parsed Codex rollout");
    // Prior turns still parse; the trailing drop is flagged but expected.
    assert.deepEqual(parsed.tokensByModel["gpt-5-codex"], {
      input: 800,
      output: 300,
      cacheRead: 400,
      cacheWrite: 0,
    });
    assert.deepEqual(parsed.parseQuality, {
      totalLines: 6,
      malformedLines: 1,
      truncatedFinalLine: true,
    });
  });

  test("Codex parser flags mid-file corruption in parse quality (FEA-2907)", async () => {
    const dir = makeTempDir("codex-pq-corrupt-");
    const filePath = path.join(
      dir,
      `rollout-2026-05-18T10-00-00-${CODEX_UUID}.jsonl`
    );
    // A malformed line BEFORE the final line: real corruption, not truncation.
    writeFileSync(
      filePath,
      `${validText}\n${truncatedLine}\n${validText}\n`,
      "utf8"
    );

    const parsed = await parseRolloutFile(filePath, {
      mergeWorkflowJournalTokens: false,
    });
    assert.ok(parsed, "expected a parsed Codex rollout");
    // 5 valid + 1 malformed + 5 valid = 11 non-empty lines attempted.
    assert.equal(parsed.parseQuality?.totalLines, 11);
    assert.equal(parsed.parseQuality?.malformedLines, 1);
    // Final line parsed cleanly → the drop is mid-file, not a truncation.
    assert.equal(parsed.parseQuality?.truncatedFinalLine, false);
    // Consumers derive mid-file corruption = malformedLines - (truncated ? 1 : 0).
    const midFileMalformed =
      (parsed.parseQuality?.malformedLines ?? 0) -
      (parsed.parseQuality?.truncatedFinalLine ? 1 : 0);
    assert.equal(midFileMalformed, 1);
  });

  const workflowUsageLine = JSON.stringify({
    type: "usage",
    model: "gpt-5-codex",
    tokens_input: 10,
    tokens_output: 5,
    session_id: "inner-agent-1",
  });

  test("Codex parser folds a corrupt workflow journal's malformed line into parent parse quality (FEA-2979)", async () => {
    const dir = makeTempDir("codex-pq-wf-corrupt-");
    const filePath = path.join(
      dir,
      `rollout-2026-05-18T10-00-00-${CODEX_UUID}.jsonl`
    );
    writeFileSync(filePath, `${validText}\n`, "utf8");
    // Companion inner-agent journal with mid-file corruption: a malformed line
    // BEFORE the final valid line silently drops that inner turn's token usage.
    writeFileSync(
      path.join(dir, "workflow-inner.jsonl"),
      `${workflowUsageLine}\n${truncatedLine}\n${workflowUsageLine}\n`,
      "utf8"
    );

    // Default options → workflow journals ARE scanned and folded.
    const parsed = await parseRolloutFile(filePath);
    assert.ok(parsed, "expected a parsed Codex rollout");
    // 5 clean rollout lines + 3 workflow-journal lines (2 valid, 1 malformed).
    assert.deepEqual(parsed.parseQuality, {
      totalLines: 8,
      malformedLines: 1,
      truncatedFinalLine: false,
      foldedChildMalformedLines: 1,
    });
    // The valid inner-agent tokens are still folded under the workflow key.
    assert.deepEqual(parsed.tokensByModel["workflow-agent"], {
      input: 20,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test("Codex parser discounts a truncated final line in a workflow journal (FEA-2979)", async () => {
    const dir = makeTempDir("codex-pq-wf-truncated-");
    const filePath = path.join(
      dir,
      `rollout-2026-05-18T10-00-00-${CODEX_UUID}.jsonl`
    );
    writeFileSync(filePath, `${validText}\n`, "utf8");
    // Companion journal whose ONLY malformed line is the trailing one — the
    // benign shape of a live/interrupted write, discounted from the fold.
    writeFileSync(
      path.join(dir, "workflow-inner.jsonl"),
      `${workflowUsageLine}\n${truncatedLine}\n`,
      "utf8"
    );

    const parsed = await parseRolloutFile(filePath);
    assert.ok(parsed, "expected a parsed Codex rollout");
    // totalLines counts the truncated line (5 + 2) but malformedLines stays 0:
    // the trailing drop is discounted, and the main rollout is clean. ISS-6336:
    // the discount is now RECORDED, because a reader measuring corruption as a
    // ratio has to subtract from the denominator the same line the fold already
    // subtracted from the numerator.
    assert.deepEqual(parsed.parseQuality, {
      totalLines: 7,
      malformedLines: 0,
      truncatedFinalLine: false,
      childTruncatedFinalLines: 1,
    });
  });
});
