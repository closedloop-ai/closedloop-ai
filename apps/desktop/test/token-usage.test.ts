import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  detectSessionOrigin,
  parseApiKeySource,
  parseHarnessResult,
  parseRateLimitEvent,
  parseTokenUsage,
  RateLimitEventStatus,
  RateLimitWindowType,
  resolveClaudeOutputPath,
  SessionOrigin,
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

test("(a) normal case: accumulates all four token types and deduplicates models", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    {
      type: "assistant",
      message: {
        model: "claude-opus-4",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 300,
        },
      },
    },
    {
      type: "assistant",
      message: {
        model: "claude-opus-4",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
        },
      },
    },
    {
      type: "assistant",
      message: {
        model: "claude-sonnet-4",
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 4,
        },
      },
    },
  ]);

  const result = parseTokenUsage(dir);
  assert.equal(result.inputTokens, 111);
  assert.equal(result.outputTokens, 57);
  assert.equal(result.cacheCreationInputTokens, 223);
  assert.equal(result.cacheReadInputTokens, 334);
  assert.equal(result.turns, 3);
  assert.deepEqual(result.models.sort(), ["claude-opus-4", "claude-sonnet-4"]);
});

test("(b) cache tokens absent defaults to 0", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    {
      type: "assistant",
      message: {
        model: "claude-haiku-4",
        usage: { input_tokens: 50, output_tokens: 25 },
      },
    },
  ]);

  const result = parseTokenUsage(dir);
  assert.equal(result.inputTokens, 50);
  assert.equal(result.outputTokens, 25);
  assert.equal(result.cacheCreationInputTokens, 0);
  assert.equal(result.cacheReadInputTokens, 0);
  assert.equal(result.turns, 1);
  assert.deepEqual(result.models, ["claude-haiku-4"]);
});

test("(c) missing JSONL file returns zero values and empty arrays", () => {
  const dir = makeTempDir();
  // No claude-output.jsonl written

  const result = parseTokenUsage(dir);
  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 0);
  assert.equal(result.cacheCreationInputTokens, 0);
  assert.equal(result.cacheReadInputTokens, 0);
  assert.equal(result.turns, 0);
  assert.deepEqual(result.models, []);
});

test("(d) malformed lines are skipped", () => {
  const dir = makeTempDir();
  const content = `${[
    '{"type":"assistant","message":{"model":"claude-opus-4","usage":{"input_tokens":10,"output_tokens":5}}}',
    "not-valid-json{{{",
    '{"type":"assistant","message":{"model":"claude-opus-4","usage":{"input_tokens":20,"output_tokens":10}}}',
  ].join("\n")}\n`;
  fs.writeFileSync(path.join(dir, "claude-output.jsonl"), content, "utf-8");

  const result = parseTokenUsage(dir);
  assert.equal(result.inputTokens, 30);
  assert.equal(result.outputTokens, 15);
  assert.equal(result.turns, 2);
});

test("(e) duplicate model names are deduplicated", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    {
      type: "assistant",
      message: {
        model: "claude-opus-4",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: "assistant",
      message: {
        model: "claude-opus-4",
        usage: { input_tokens: 2, output_tokens: 2 },
      },
    },
    {
      type: "assistant",
      message: {
        model: "claude-opus-4",
        usage: { input_tokens: 3, output_tokens: 3 },
      },
    },
  ]);

  const result = parseTokenUsage(dir);
  assert.equal(result.models.length, 1);
  assert.deepEqual(result.models, ["claude-opus-4"]);
});

test("(f) tokensByModel: single model accumulates per-model counts", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    {
      type: "assistant",
      message: {
        model: "claude-opus-4",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 300,
        },
      },
    },
    {
      type: "assistant",
      message: {
        model: "claude-opus-4",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
        },
      },
    },
  ]);

  const result = parseTokenUsage(dir);
  assert.deepEqual(result.tokensByModel, {
    "claude-opus-4": {
      input: 110,
      output: 55,
      cacheCreation: 220,
      cacheRead: 330,
    },
  });
});

test("(g) tokensByModel: multiple models have independent counts", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    {
      type: "assistant",
      message: {
        model: "claude-opus-4",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 300,
        },
      },
    },
    {
      type: "assistant",
      message: {
        model: "claude-sonnet-4",
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 4,
        },
      },
    },
    {
      type: "assistant",
      message: {
        model: "claude-opus-4",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
        },
      },
    },
  ]);

  const result = parseTokenUsage(dir);
  assert.deepEqual(result.tokensByModel, {
    "claude-opus-4": {
      input: 110,
      output: 55,
      cacheCreation: 220,
      cacheRead: 330,
    },
    "claude-sonnet-4": {
      input: 1,
      output: 2,
      cacheCreation: 3,
      cacheRead: 4,
    },
  });
});

test("(h) tokensByModel: missing JSONL returns empty object", () => {
  const dir = makeTempDir();
  const result = parseTokenUsage(dir);
  assert.deepEqual(result.tokensByModel, {});
});

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
  assert.equal(parseTokenUsage(dir).inputTokens, 7);
  assert.equal(parseApiKeySource(dir), "ANTHROPIC_API_KEY");
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
  assert.equal(parseTokenUsage(dir).inputTokens, 5);
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
  assert.equal(parseTokenUsage(dir).inputTokens, 11);
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
  assert.equal(parseTokenUsage(dir).inputTokens, 13);
});

test("resolveClaudeOutputPath returns null when no output files exist", () => {
  const dir = makeTempDir();

  assert.equal(resolveClaudeOutputPath(dir), null);
  assert.equal(parseTokenUsage(dir).turns, 0);
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

  // Provenance: a result envelope means harness stdout capture.
  assert.equal(detectSessionOrigin(result), SessionOrigin.HarnessStdout);
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
  // Provenance: absence of a result envelope means an imported/interactive
  // transcript — derived reconstruction only.
  assert.equal(detectSessionOrigin(result), SessionOrigin.PersistentTranscript);
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

test("parseRateLimitEvent: extracts the latest event's status/reset/type/utilization", () => {
  const dir = makeTempDir();
  // resetsAt is a Unix epoch in SECONDS: 2026-07-20T00:00:00Z.
  const resetEpochSeconds = 1_784_505_600;
  writeJsonl(dir, [
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "five_hour",
        resetsAt: 1_784_000_000,
      },
    },
    {
      type: "assistant",
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    // The LATEST event wins — a later warning on the weekly window.
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "seven_day",
        resetsAt: resetEpochSeconds,
        utilization: 82,
      },
    },
  ]);

  const snapshot = parseRateLimitEvent(dir);
  assert.ok(snapshot, "expected a rate-limit snapshot to be parsed");
  assert.equal(snapshot.status, RateLimitEventStatus.AllowedWarning);
  assert.equal(snapshot.rateLimitType, RateLimitWindowType.SevenDay);
  assert.equal(snapshot.resetsAt, "2026-07-20T00:00:00.000Z");
  assert.equal(snapshot.utilization, 82);
});

test("parseRateLimitEvent: null when no rate_limit_event is present", () => {
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
    { type: "result", subtype: "success", is_error: false },
  ]);

  assert.equal(parseRateLimitEvent(dir), null);
});

test("parseRateLimitEvent: null (never throws) when the JSONL file is missing", () => {
  const dir = makeTempDir();
  assert.equal(parseRateLimitEvent(dir), null);
});

test("parseRateLimitEvent: utilization is null when the event omits it", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "seven_day_opus",
        resetsAt: 1_784_505_600,
      },
    },
  ]);

  const snapshot = parseRateLimitEvent(dir);
  assert.ok(snapshot);
  assert.equal(snapshot.status, RateLimitEventStatus.Rejected);
  assert.equal(snapshot.rateLimitType, RateLimitWindowType.SevenDayOpus);
  assert.equal(snapshot.utilization, null);
});

test("parseRateLimitEvent: skips status-less events but keeps a status-only (window-less) one", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "overage",
        resetsAt: 1_784_505_600,
        utilization: 40,
      },
    },
    // Unknown status — the only required field is unusable, must be skipped.
    {
      type: "rate_limit_event",
      rate_limit_info: { status: "throttled", rateLimitType: "five_hour" },
    },
    // Missing rate_limit_info entirely — must be skipped.
    { type: "rate_limit_event" },
    // Valid, but rateLimitType absent (version-gated / optional on the CLI union).
    // A status-only event still carries usable state — it must be KEPT with a
    // null window, not dropped.
    {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning", utilization: 55 },
    },
  ]);

  const snapshot = parseRateLimitEvent(dir);
  assert.ok(snapshot, "expected the status-only event to be preserved");
  assert.equal(snapshot.status, RateLimitEventStatus.AllowedWarning);
  assert.equal(snapshot.rateLimitType, null);
  assert.equal(snapshot.utilization, 55);
  assert.equal(snapshot.resetsAt, null);
});

test("parseRateLimitEvent: an unrecognized window type narrows to null, snapshot survives", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        // Not a member of RateLimitWindowType — narrows to null rather than
        // dropping the (otherwise valid) snapshot.
        rateLimitType: "one_hour",
        utilization: 100,
      },
    },
  ]);

  const snapshot = parseRateLimitEvent(dir);
  assert.ok(snapshot, "expected the snapshot to survive an unknown window");
  assert.equal(snapshot.status, RateLimitEventStatus.Rejected);
  assert.equal(snapshot.rateLimitType, null);
  assert.equal(snapshot.utilization, 100);
});

test("parseRateLimitEvent: recognizes the seven_day_overage_included window", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "seven_day_overage_included",
        resetsAt: 1_784_505_600,
        utilization: 91,
      },
    },
  ]);

  const snapshot = parseRateLimitEvent(dir);
  assert.ok(snapshot);
  assert.equal(
    snapshot.rateLimitType,
    RateLimitWindowType.SevenDayOverageIncluded
  );
  assert.equal(snapshot.utilization, 91);
});

test("parseRateLimitEvent: guards a non-positive epoch to a null reset", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "five_hour",
        resetsAt: 0,
      },
    },
  ]);

  const snapshot = parseRateLimitEvent(dir);
  assert.ok(snapshot);
  assert.equal(snapshot.resetsAt, null);
});
