import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import {
  parseHarnessResult,
  resolveClaudeOutputPath,
} from "../src/main/cost/token-usage.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-usage-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeJsonl(
  dir: string,
  lines: unknown[],
  filename = "claude-output.jsonl"
): void {
  const content = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
  fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

test("resolveClaudeOutputPath uses sidecar-selected renamed output", () => {
  const dir = makeTempDir();
  writeJsonl(
    dir,
    [
      { type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" },
      {
        type: "assistant",
        message: {
          model: "claude-opus-4",
          usage: { input_tokens: 7, output_tokens: 3 },
        },
      },
    ],
    "claude-output-run-1.jsonl"
  );
  fs.writeFileSync(
    path.join(dir, "claude-output.name.txt"),
    "claude-output-run-1.jsonl\n",
    "utf-8"
  );

  assert.equal(
    resolveClaudeOutputPath(dir),
    path.join(dir, "claude-output-run-1.jsonl")
  );
});

test("resolveClaudeOutputPath treats an empty sidecar as legacy-only", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    {
      type: "assistant",
      message: {
        model: "claude-opus-4",
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    },
  ]);
  writeJsonl(
    dir,
    [
      {
        type: "assistant",
        message: {
          model: "claude-opus-4",
          usage: { input_tokens: 999, output_tokens: 1 },
        },
      },
    ],
    "claude-output-stale.jsonl"
  );
  fs.writeFileSync(path.join(dir, "claude-output.name.txt"), "", "utf-8");

  assert.equal(
    resolveClaudeOutputPath(dir),
    path.join(dir, "claude-output.jsonl")
  );
});

test("resolveClaudeOutputPath falls back from stale sidecar to newest renamed output", () => {
  const dir = makeTempDir();
  const older = path.join(dir, "claude-output-old.jsonl");
  const newer = path.join(dir, "claude-output-new.jsonl");
  writeJsonl(
    dir,
    [
      {
        type: "assistant",
        message: {
          model: "claude-opus-4",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ],
    path.basename(older)
  );
  writeJsonl(
    dir,
    [
      {
        type: "assistant",
        message: {
          model: "claude-opus-4",
          usage: { input_tokens: 11, output_tokens: 1 },
        },
      },
    ],
    path.basename(newer)
  );
  fs.utimesSync(older, new Date(1000), new Date(1000));
  fs.utimesSync(newer, new Date(2000), new Date(2000));
  fs.writeFileSync(
    path.join(dir, "claude-output.name.txt"),
    "claude-output-missing.jsonl\n",
    "utf-8"
  );

  assert.equal(resolveClaudeOutputPath(dir), newer);
});

test("resolveClaudeOutputPath preserves legacy fixed-path fallback", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    {
      type: "assistant",
      message: {
        model: "claude-opus-4",
        usage: { input_tokens: 13, output_tokens: 2 },
      },
    },
  ]);

  assert.equal(
    resolveClaudeOutputPath(dir),
    path.join(dir, "claude-output.jsonl")
  );
});

test("resolveClaudeOutputPath returns null when no output files exist", () => {
  const dir = makeTempDir();

  assert.equal(resolveClaudeOutputPath(dir), null);
});

test("resolveClaudeOutputPath rejects sidecar path traversal", () => {
  const dir = makeTempDir();
  const outsideDir = makeTempDir();
  writeJsonl(
    outsideDir,
    [
      {
        type: "assistant",
        message: {
          model: "claude-opus-4",
          usage: { input_tokens: 99, output_tokens: 1 },
        },
      },
    ],
    "claude-output-evil.jsonl"
  );
  fs.writeFileSync(
    path.join(dir, "claude-output.name.txt"),
    "../claude-output-evil.jsonl\n",
    "utf-8"
  );

  assert.equal(resolveClaudeOutputPath(dir), null);
});

test("parseHarnessResult: captures Claude Code's authoritative result envelope", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    { type: "system", subtype: "init", apiKeySource: "none" },
    {
      type: "assistant",
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 1.2345,
      num_turns: 7,
      duration_ms: 42_000,
      duration_api_ms: 30_000,
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 200,
        server_tool_use: { web_search_requests: 3 },
      },
      modelUsage: {
        "claude-opus-4-8": {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 900,
          cacheCreationInputTokens: 200,
          costUSD: 1.2345,
        },
      },
    },
  ]);

  const result = parseHarnessResult(dir);
  assert.ok(result, "expected a result envelope to be parsed");
  assert.equal(result.subtype, "success");
  assert.equal(result.isError, false);
  assert.equal(result.totalCostUsd, 1.2345);
  assert.equal(result.numTurns, 7);
  assert.equal(result.durationMs, 42_000);
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.usage?.input, 100);
  assert.equal(result.usage?.cacheRead, 900);
  assert.equal(result.usage?.cacheWrite, 200);
  assert.equal(result.usage?.webSearchRequests, 3);
  assert.equal(result.modelUsage["claude-opus-4-8"]?.costUsd, 1.2345);
  assert.equal(result.modelUsage["claude-opus-4-8"]?.cacheCreation, 200);
});

test("parseHarnessResult: captures permission denials, dropping the raw tool input", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    {
      type: "result",
      subtype: "success",
      permission_denials: [
        {
          tool_name: "Bash",
          tool_use_id: "toolu_01",
          // Carries the refused command verbatim — must NOT be forwarded.
          tool_input: { command: "rm -rf /etc/secrets" },
        },
        { tool_name: "Write", tool_use_id: null },
        // Malformed entries carry no signal: skipped, never half-stored.
        { tool_use_id: "toolu_03" },
        null,
        "nonsense",
      ],
    },
  ]);

  const result = parseHarnessResult(dir);
  assert.ok(result);
  assert.deepEqual(result.permissionDenials, [
    { toolName: "Bash", toolUseId: "toolu_01" },
    { toolName: "Write", toolUseId: null },
  ]);
});

test("parseHarnessResult: absent permission_denials is unknown (null), an empty array is known-zero", () => {
  const unknownDir = makeTempDir();
  writeJsonl(unknownDir, [{ type: "result", subtype: "success" }]);
  assert.equal(
    parseHarnessResult(unknownDir)?.permissionDenials,
    null,
    "an older CLI that omits the field must read as unknown, not as zero denials"
  );

  const knownZeroDir = makeTempDir();
  writeJsonl(knownZeroDir, [
    { type: "result", subtype: "success", permission_denials: [] },
  ]);
  assert.deepEqual(parseHarnessResult(knownZeroDir)?.permissionDenials, []);
});

test("parseHarnessResult: a retry appended to a reused work dir reports the LAST envelope, not the first", () => {
  const dir = makeTempDir();
  // The harness appends to claude-output.jsonl when a work dir is reused, so a
  // retried run's capture holds the failed attempt's envelope ahead of its own.
  writeJsonl(dir, [
    {
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      total_cost_usd: 9.99,
      num_turns: 40,
      duration_ms: 111,
      permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_stale" }],
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 1.25,
      num_turns: 7,
      duration_ms: 222,
      permission_denials: [],
    },
  ]);

  const result = parseHarnessResult(dir);
  assert.ok(result);
  assert.equal(
    result.totalCostUsd,
    1.25,
    "the retry's own cost is authoritative, not the abandoned attempt's"
  );
  assert.equal(result.subtype, "success");
  assert.equal(result.isError, false);
  assert.equal(result.numTurns, 7);
  assert.equal(result.durationMs, 222);
  assert.deepEqual(
    result.permissionDenials,
    [],
    "the stale attempt's denials must not be reported against this run"
  );
});

test("parseHarnessResult: a corrupt token counter drops the usage block instead of zeroing the bad slot", () => {
  for (const badUsage of [
    { input_tokens: -1, output_tokens: 50 },
    { input_tokens: 12.5, output_tokens: 50 },
    { input_tokens: "100", output_tokens: 50 },
    { input_tokens: 100 },
    { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: -5 },
    { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 1.5 },
  ]) {
    const dir = makeTempDir();
    writeJsonl(dir, [
      {
        type: "result",
        subtype: "success",
        usage: {
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          ...badUsage,
        },
      },
    ]);

    const result = parseHarnessResult(dir);
    assert.ok(result);
    assert.equal(
      result.usage,
      null,
      `corrupt usage ${JSON.stringify(badUsage)} must read as unknown, not as a partially-zeroed session total`
    );
  }
});

test("parseHarnessResult: a present-but-corrupt web_search_requests drops the usage block, an absent one is known-zero", () => {
  const absentDir = makeTempDir();
  writeJsonl(absentDir, [
    {
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  ]);
  // The CLI omits server_tool_use entirely when no server tool ran.
  assert.equal(parseHarnessResult(absentDir)?.usage?.webSearchRequests, 0);

  const corruptDir = makeTempDir();
  writeJsonl(corruptDir, [
    {
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        server_tool_use: { web_search_requests: -2 },
      },
    },
  ]);
  assert.equal(parseHarnessResult(corruptDir)?.usage, null);
});

test("parseHarnessResult: a corrupt per-model row is skipped, valid rows survive", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    {
      type: "result",
      subtype: "success",
      modelUsage: {
        "claude-opus-4-5": {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 5,
          costUSD: 1.25,
        },
        // A zero-filled row would read downstream as a model that ran for free.
        "claude-haiku-4-5": {
          inputTokens: -1,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.1,
        },
        "claude-sonnet-4-5": { inputTokens: 3.5 },
      },
    },
  ]);

  const result = parseHarnessResult(dir);
  assert.ok(result);
  assert.deepEqual(Object.keys(result.modelUsage), ["claude-opus-4-5"]);
  assert.equal(result.modelUsage["claude-opus-4-5"]?.costUsd, 1.25);
});

test("parseHarnessResult: a corrupt per-model cost narrows to null while the row's valid counts survive", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    {
      type: "result",
      subtype: "success",
      modelUsage: {
        "claude-opus-4-5": {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: -3,
        },
      },
    },
  ]);

  const row = parseHarnessResult(dir)?.modelUsage["claude-opus-4-5"];
  assert.ok(row);
  // costUsd is nullable by contract, so UNKNOWN is representable without lying.
  assert.equal(row.costUsd, null);
  assert.equal(row.input, 100);
});

test("parseHarnessResult: corrupt scalars read as unknown, never as a real figure", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    {
      type: "result",
      subtype: "success",
      total_cost_usd: -1.5,
      num_turns: 7.5,
      duration_ms: -10,
      duration_api_ms: "fast",
    },
  ]);

  const result = parseHarnessResult(dir);
  assert.ok(result);
  assert.equal(
    result.totalCostUsd,
    null,
    "a negative authoritative total is corrupt, not a real spend"
  );
  assert.equal(result.numTurns, null, "turns are discrete");
  assert.equal(result.durationMs, null);
  assert.equal(result.durationApiMs, null);
});

test("parseHarnessResult: null for a persistent transcript (no result envelope)", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    {
      type: "assistant",
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    },
    { type: "user", message: { role: "user", content: "hi" } },
  ]);

  const result = parseHarnessResult(dir);
  assert.equal(result, null);
});

test("parseHarnessResult: tolerates a result envelope with missing fields", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    { type: "result", subtype: "error_during_execution", is_error: true },
  ]);

  const result = parseHarnessResult(dir);
  assert.ok(result);
  assert.equal(result.subtype, "error_during_execution");
  assert.equal(result.isError, true);
  assert.equal(result.totalCostUsd, null);
  assert.equal(result.usage, null);
  assert.deepEqual(result.modelUsage, {});
});

/**
 * ISS-8565: `parseHarnessModelUsage` folded Claude Code's own
 * `claude-output.jsonl` `modelUsage` envelope onto a plain `{}`, so a model
 * literally named `__proto__` lost its whole row — and that map is serialized
 * onto the cloud reconciliation event.
 *
 * The fixture builds the key with `Object.create(null)`, not a literal: a
 * quoted `"__proto__"` in an object LITERAL is the prototype-setter form and
 * creates no own key, so `JSON.stringify` would never emit it and the test
 * would silently prove nothing.
 */
test("ISS-8565: harness modelUsage keeps a __proto__ model", () => {
  const dir = makeTempDir();
  const modelUsage: Record<string, unknown> = Object.create(null);
  // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
  modelUsage.__proto__ = {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadInputTokens: 40,
    cacheCreationInputTokens: 7,
    costUSD: 1.25,
  };
  writeJsonl(dir, [{ type: "result", subtype: "success", modelUsage }]);

  const result = parseHarnessResult(dir);

  assert.ok(result, "expected a result envelope to be parsed");
  assert.ok(Object.keys(result.modelUsage).includes("__proto__"));
  // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
  assert.deepEqual(result.modelUsage.__proto__, {
    input: 1000,
    output: 500,
    cacheRead: 40,
    cacheCreation: 7,
    costUsd: 1.25,
  });
  assert.equal(Object.getPrototypeOf(result.modelUsage), Object.prototype);
});
