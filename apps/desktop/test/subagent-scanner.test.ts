import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { estimateAgentComponentFootprintTokens } from "@repo/api/src/types/agent-component-footprint";
import { afterEach, test } from "vitest";
import { scanSubagentTranscriptStream } from "../src/main/collectors/parsing/subagent-scanner.js";
import {
  MAX_STRINGIFIED_CHARS,
  stringifyBoundedResult,
} from "../src/main/collectors/parsing/subagent-tool-serialization.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

test("scanSubagentTranscriptStream returns empty for non-existent file", async () => {
  const result = await scanSubagentTranscriptStream(
    "/nonexistent/file.jsonl",
    "ses-1",
    "agent-1"
  );
  assert.deepEqual(result, { toolUses: [], conflictedToolUseIds: [] });
});

test("scanSubagentTranscriptStream handles multi-line tool_use entries", async () => {
  const dir = makeTempDir("sub-");
  const fp = path.join(dir, "agent-2.jsonl");
  writeFileSync(
    fp,
    [
      JSON.stringify({
        type: "tool_use",
        name: "Bash",
        timestamp: "2025-01-15T10:00:00Z",
        input: { command: "ls -la" },
      }),
      "",
    ].join("\n"),
    "utf8"
  );
  const result = await scanSubagentTranscriptStream(fp, "ses-2", "agent-2");
  assert.equal(result.toolUses.length, 1);
  assert.equal(result.toolUses[0].toolName, "Bash");
});

test("scanSubagentTranscriptStream extracts nested Claude message tool_use blocks", async () => {
  const dir = makeTempDir("sub-");
  const fp = path.join(dir, "agent-4.jsonl");
  writeFileSync(
    fp,
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-24T10:01:00Z",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_456",
            name: "Bash",
            input: { command: "pwd" },
          },
        ],
      },
    }),
    "utf8"
  );

  const result = await scanSubagentTranscriptStream(fp, "ses-4", "agent-4");

  assert.equal(result.toolUses.length, 1);
  assert.equal(result.toolUses[0].toolName, "Bash");
  assert.equal(result.toolUses[0].toolUseId, "toolu_456");
  // ISS-6738: the normalizer emits CANONICAL ISO, so a second-precision input
  // gains `.000`. The fixture stamp above is deliberately left at second
  // precision so this exercises the normalization rather than echoing it.
  // Carried over from the deleted synchronous twin (ISS-6899), which held the
  // only assertion of this contract at the scanner boundary.
  assert.equal(result.toolUses[0].timestamp, "2026-06-24T10:01:00.000Z");
  assert.deepEqual(result.toolUses[0].input, { command: "pwd" });
});

test("scanSubagentTranscriptStream skips a corrupt line and keeps the rest", async () => {
  // BEHAVIOR CHANGE (ISS-6454), not a weakened assertion. This asserted
  // `{ toolUses: [] }` — one corrupt line discarded the whole file, so the
  // well-formed line below it was thrown away too.
  //
  // The corrupt line still contributes NOTHING, which was the real intent: a
  // line failing `JSON.parse` never becomes an entry, so no half-read block can
  // reach `extractToolUses`. What changed is that its neighbours survive it.
  const dir = makeTempDir("sub-corrupt-");
  const fp = path.join(dir, "agent-corrupt.jsonl");
  writeFileSync(
    fp,
    [
      "{not-json",
      JSON.stringify({
        type: "tool_use",
        name: "Read",
        timestamp: "2025-01-15T10:02:00Z",
        input: { path: "/tmp/survives-the-corrupt-line.txt" },
      }),
      "",
    ].join("\n"),
    "utf8"
  );

  const result = await scanSubagentTranscriptStream(fp, "ses-5", "agent-5");

  assert.equal(
    result.toolUses.length,
    1,
    "the corrupt line yields nothing and the well-formed line survives it"
  );
  assert.equal(result.toolUses[0]?.toolName, "Read");
});

test("sidecar results join by exact id before or after the action as valid bounded JSON", async () => {
  const dir = makeTempDir("sub-results-");
  const outputText = String.raw`escaped \"quote\" and slash \\ `.repeat(200);
  const action = {
    type: "assistant",
    timestamp: "2026-08-17T20:00:00.000Z",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_result_join",
          name: "Read",
          input: { file_path: "src/index.ts" },
        },
      ],
    },
  };
  const result = {
    type: "user",
    timestamp: "2026-08-17T20:00:01.000Z",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_result_join",
          content: outputText,
        },
      ],
    },
  };

  for (const [index, entries] of [
    [action, result],
    [result, action],
  ].entries()) {
    const fp = path.join(dir, `agent-order-${index}.jsonl`);
    writeFileSync(
      fp,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8"
    );
    const scan = await scanSubagentTranscriptStream(
      fp,
      `session-${index}`,
      `agent-${index}`
    );
    assert.equal(scan.toolUses.length, 1);
    const joined = scan.toolUses[0];
    assert.ok(joined.output);
    assert.ok(joined.output.length <= MAX_STRINGIFIED_CHARS);
    assert.equal(typeof JSON.parse(joined.output), "string");
    assert.equal(joined.isError, null);
    assert.equal(joined.resultTimestamp, result.timestamp);
  }
});

test("omitted and false sidecar error state reconcile as one successful completion", async () => {
  const dir = makeTempDir("sub-error-compat-");
  const fp = path.join(dir, "agent-error-compat.jsonl");
  const timestamp = "2026-08-17T20:00:01.000Z";
  const resultBlock = {
    type: "tool_result",
    tool_use_id: "toolu_error_compat",
    content: "done",
  };
  writeFileSync(
    fp,
    [
      {
        type: "assistant",
        timestamp: "2026-08-17T20:00:00.000Z",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_error_compat",
              name: "Bash",
              input: { command: "pwd" },
            },
          ],
        },
      },
      { type: "user", timestamp, message: { content: [resultBlock] } },
      {
        type: "user",
        timestamp,
        message: { content: [{ ...resultBlock, is_error: false }] },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
    "utf8"
  );

  const scan = await scanSubagentTranscriptStream(
    fp,
    "session-error",
    "agent-error"
  );

  assert.equal(scan.toolUses.length, 1);
  assert.equal(scan.toolUses[0].isError, false);
  assert.equal(JSON.parse(scan.toolUses[0].output ?? "null"), "done");
});

test("conflicting sidecar result duplicates quarantine the invocation", async () => {
  const dir = makeTempDir("sub-result-conflict-");
  const fp = path.join(dir, "agent-result-conflict.jsonl");
  const result = (content: string) => ({
    type: "user",
    timestamp: "2026-08-17T20:00:01.000Z",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_conflict",
          content,
        },
      ],
    },
  });
  writeFileSync(
    fp,
    [
      {
        type: "assistant",
        timestamp: "2026-08-17T20:00:00.000Z",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_conflict",
              name: "Read",
              input: { file_path: "src/index.ts" },
            },
          ],
        },
      },
      result("first"),
      result("second"),
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
    "utf8"
  );

  assert.deepEqual(await scanSubagentTranscriptStream(fp, "session", "agent"), {
    toolUses: [],
    conflictedToolUseIds: ["toolu_conflict"],
  });
});

test("bounded structured results preserve object and array roots", () => {
  const objectResult = stringifyBoundedResult({
    rows: Array.from({ length: 200 }, (_, index) => ({
      index,
      value: "x".repeat(40),
    })),
  });
  const arrayResult = stringifyBoundedResult(
    Array.from({ length: 200 }, (_, index) => ({
      index,
      value: "y".repeat(40),
    }))
  );

  assert.ok(objectResult);
  assert.ok(arrayResult);
  assert.equal(Array.isArray(JSON.parse(objectResult)), false);
  assert.equal(Array.isArray(JSON.parse(arrayResult)), true);
  assert.ok(objectResult.length <= MAX_STRINGIFIED_CHARS);
  assert.ok(arrayResult.length <= MAX_STRINGIFIED_CHARS);
});

test("equal-timestamp tool actions retain source sequence before id order", async () => {
  const dir = makeTempDir("sub-source-order-");
  const fp = path.join(dir, "agent-source-order.jsonl");
  writeFileSync(
    fp,
    `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-17T20:00:00.000Z",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_z",
            name: "Read",
            input: { path: "first" },
          },
          {
            type: "tool_use",
            id: "toolu_a",
            name: "Read",
            input: { path: "second" },
          },
        ],
      },
    })}\n`,
    "utf8"
  );

  const scan = await scanSubagentTranscriptStream(fp, "session", "agent");
  assert.deepEqual(
    scan.toolUses.map((toolUse) => toolUse.toolUseId),
    ["toolu_z", "toolu_a"]
  );
});

/**
 * ISS-10736 (tamsinb review of #7816). Tool calls made INSIDE a Claude subagent
 * never pass through `parse-claude-user`'s counter — they come from the sidecar
 * `agent-*.jsonl` files through this scanner — so every row
 * `appendSidecarSubagentToolCandidates` emitted reached the writer with a NULL
 * footprint while main-transcript rows filled. That is the ticket's
 * "producer exists but unreached" case, on a large share of `tool` rows, and no
 * suite covered it because the all-kinds suite builds main-transcript tool uses
 * only.
 *
 * `output` keeps its `MAX_STRINGIFIED_CHARS` bound, so the count MUST be taken
 * here, over `entry.result`, before that bound applies.
 */
test("scanSubagentTranscriptStream counts a sidecar result before the bound", async () => {
  const dir = makeTempDir("sub-");
  const fp = path.join(dir, "agent-fp.jsonl");
  const huge = "x".repeat(20_000);
  writeFileSync(
    fp,
    JSON.stringify({
      type: "tool_use",
      id: "toolu_fp",
      name: "Bash",
      timestamp: "2026-09-23T10:00:00Z",
      input: { command: "ls" },
      result: huge,
    }),
    "utf8"
  );

  const result = await scanSubagentTranscriptStream(fp, "ses-fp", "agent-fp");
  const [toolUse] = result.toolUses;

  assert.equal(
    toolUse.outputFootprintTokens,
    estimateAgentComponentFootprintTokens(huge)
  );
  // The carried `output` is a strict prefix, so a count over it is strictly
  // smaller — which is the under-statement taking it here avoids.
  assert.ok(String(toolUse.output).length < huge.length);
  assert.ok(
    estimateAgentComponentFootprintTokens(String(toolUse.output)) <
      (toolUse.outputFootprintTokens ?? 0)
  );
});

test("scanSubagentTranscriptStream leaves the count absent with no result", async () => {
  const dir = makeTempDir("sub-");
  const fp = path.join(dir, "agent-nofp.jsonl");
  writeFileSync(
    fp,
    JSON.stringify({
      type: "tool_use",
      id: "toolu_nofp",
      name: "Bash",
      timestamp: "2026-09-23T10:00:00Z",
      input: { command: "ls" },
    }),
    "utf8"
  );

  const result = await scanSubagentTranscriptStream(
    fp,
    "ses-nofp",
    "agent-nofp"
  );

  assert.equal(result.toolUses[0].outputFootprintTokens, null);
});
