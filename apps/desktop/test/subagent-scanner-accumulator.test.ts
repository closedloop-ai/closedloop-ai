/**
 * @file subagent-scanner-accumulator.test.ts
 * @description ISS-11281: pins the file-scoped native-id accumulator behind
 * `scanSubagentTranscriptStream` — how a repeated `tool_use.id` merges or turns
 * into a conflict, how results pair with a single top-level `toolUseResult`
 * error flag, and which lines the stream reader skips.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  accumulateSubagentToolUseEntry,
  createSubagentToolUseAccumulator,
  extractToolUses,
  finalizeSubagentToolUses,
  scanSubagentTranscriptStream,
} from "../src/main/collectors/parsing/subagent-scanner.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

const TS = "2026-01-15T10:00:00.000Z";
const TS_LATER = "2026-01-15T10:00:05.000Z";

function assistantToolUse(
  id: string,
  input: unknown,
  timestamp = TS
): Record<string, unknown> {
  return {
    timestamp,
    message: {
      content: [{ type: "tool_use", id, name: "Bash", input }],
    },
  };
}

function userToolResult(
  blocks: Record<string, unknown>[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { timestamp: TS_LATER, message: { content: blocks }, ...extra };
}

function accumulate(entries: Record<string, unknown>[]) {
  const accumulator = createSubagentToolUseAccumulator("ses-1", "agent-1");
  for (const entry of entries) {
    accumulateSubagentToolUseEntry(accumulator, entry);
  }
  return {
    toolUses: finalizeSubagentToolUses(accumulator),
    conflicted: [...accumulator.conflictedIds].sort(),
  };
}

describe("scanSubagentTranscriptStream line handling", () => {
  it("skips unparseable lines and a replayed uuid without abandoning the file", async () => {
    const filePath = path.join(makeTempDir("subagent-acc-"), "agent-1.jsonl");
    const first = { uuid: "u-1", ...assistantToolUse("t1", { cmd: "ls" }) };
    const replay = { uuid: "u-1", ...assistantToolUse("t9", { cmd: "rm" }) };
    const second = { uuid: "u-2", ...assistantToolUse("t2", { cmd: "pwd" }) };
    writeFileSync(
      filePath,
      [
        JSON.stringify(first),
        "{not json",
        JSON.stringify(replay),
        JSON.stringify(second),
      ].join("\n"),
      "utf8"
    );
    const result = await scanSubagentTranscriptStream(
      filePath,
      "ses-1",
      "agent-1"
    );
    assert.deepEqual(
      result.toolUses.map((t) => t.toolUseId),
      ["t1", "t2"]
    );
    assert.deepEqual(result.conflictedToolUseIds, []);
  });
});

describe("flat tool entries", () => {
  it("returns nothing for a flat entry with an empty name", () => {
    assert.deepEqual(
      extractToolUses(
        { type: "tool_use", name: "", input: { a: 1 } },
        "ses-1",
        "agent-1"
      ),
      []
    );
  });

  // ISS-10713 (tamsinb on #8910): one flat line holds call and result, so it
  // observed no separate result instant; copying the line stamp read as 0ms.
  it("keeps a flat result's boolean is_error and reports no result timestamp", () => {
    const [toolUse] = extractToolUses(
      {
        type: "tool_result",
        name: "Read",
        id: "flat-1",
        timestamp: TS,
        result: "boom",
        is_error: true,
      },
      "ses-1",
      "agent-1"
    );
    assert.equal(toolUse.isError, true);
    assert.equal(toolUse.output, '"boom"');
    assert.equal(toolUse.resultTimestamp, null);
    assert.equal(toolUse.input, null);
  });
});

describe("tool_result pairing", () => {
  it("uses a lone result block's top-level toolUseResult.is_error when the block has none", () => {
    const { toolUses } = accumulate([
      assistantToolUse("t1", { cmd: "false" }),
      userToolResult(
        [
          { type: "tool_result", tool_use_id: "t1", content: "exit 1" },
          { type: "tool_result", tool_use_id: "", content: "no id" },
          { type: "tool_result", content: "missing id" },
        ],
        { toolUseResult: { is_error: true } }
      ),
    ]);
    // The top-level flag describes one block; with three result blocks it is
    // ambiguous, keyed or not (subagent-scanner.ts unambiguousTopLevelError).
    assert.equal(toolUses[0].isError, null);
    assert.equal(toolUses[0].output, '"exit 1"');

    const lone = accumulate([
      assistantToolUse("t1", { cmd: "false" }),
      userToolResult(
        [{ type: "tool_result", tool_use_id: "t1", content: "exit 1" }],
        { toolUseResult: { is_error: true } }
      ),
    ]);
    assert.equal(lone.toolUses[0].isError, true);
    assert.equal(lone.toolUses[0].resultTimestamp, TS_LATER);
  });

  it("keeps the first result's error flag when an identical result repeats without one", () => {
    const { toolUses, conflicted } = accumulate([
      assistantToolUse("t1", { cmd: "x" }),
      userToolResult([
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "same",
          is_error: false,
        },
      ]),
      userToolResult([
        { type: "tool_result", tool_use_id: "t1", content: "same" },
      ]),
    ]);
    assert.deepEqual(conflicted, []);
    assert.equal(toolUses[0].isError, false);
  });
});

describe("repeated native ids", () => {
  it("merges an identical repeated tool_use into one record", () => {
    const { toolUses, conflicted } = accumulate([
      assistantToolUse("t1", { cmd: "ls" }),
      assistantToolUse("t1", { cmd: "ls" }),
    ]);
    assert.deepEqual(conflicted, []);
    assert.equal(toolUses.length, 1);
    assert.equal(toolUses[0].output, null);
    assert.equal(toolUses[0].isError, null);
  });

  it("conflicts an id whose repeat disagrees, then ignores every later action and result for it", () => {
    const { toolUses, conflicted } = accumulate([
      assistantToolUse("t1", { cmd: "ls" }),
      assistantToolUse("t1", { cmd: "rm -rf" }),
      assistantToolUse("t1", { cmd: "ls" }),
      userToolResult([
        { type: "tool_result", tool_use_id: "t1", content: "late" },
      ]),
      assistantToolUse("t2", { cmd: "pwd" }),
    ]);
    assert.deepEqual(conflicted, ["t1"]);
    assert.deepEqual(
      toolUses.map((t) => t.toolUseId),
      ["t2"]
    );
  });

  it("conflicts on a repeated action whose timestamp differs", () => {
    const { conflicted } = accumulate([
      assistantToolUse("t1", { cmd: "ls" }, TS),
      assistantToolUse("t1", { cmd: "ls" }, TS_LATER),
    ]);
    assert.deepEqual(conflicted, ["t1"]);
  });

  it("completes a bare action from a flat repeat that carries the result", () => {
    const flatWithResult = {
      type: "tool_use",
      name: "Bash",
      id: "t1",
      timestamp: TS,
      input: { cmd: "ls" },
      result: "files",
      is_error: false,
    };
    const { toolUses } = accumulate([
      assistantToolUse("t1", { cmd: "ls" }),
      flatWithResult,
    ]);
    assert.equal(toolUses.length, 1);
    assert.equal(toolUses[0].output, '"files"');
    // The flat repeat carries no separate result instant (ISS-10713).
    assert.equal(toolUses[0].resultTimestamp, null);
    assert.equal(toolUses[0].isError, false);

    const reversed = accumulate([
      flatWithResult,
      assistantToolUse("t1", { cmd: "ls" }),
    ]);
    assert.equal(reversed.toolUses[0].output, '"files"');
    assert.equal(reversed.toolUses[0].isError, false);
  });

  it("merges two flat repeats that agree on their result, and conflicts two that disagree", () => {
    const flat = (result: string, isError: boolean) => ({
      type: "tool_use",
      name: "Bash",
      id: "t1",
      timestamp: TS,
      input: { cmd: "ls" },
      result,
      is_error: isError,
    });
    const agree = accumulate([flat("files", false), flat("files", false)]);
    assert.deepEqual(agree.conflicted, []);
    assert.equal(agree.toolUses[0].output, '"files"');

    assert.deepEqual(
      accumulate([flat("files", false), flat("other", false)]).conflicted,
      ["t1"]
    );
    assert.deepEqual(
      accumulate([flat("files", false), flat("files", true)]).conflicted,
      ["t1"]
    );
  });
});

describe("tool_use block extraction", () => {
  it("skips non-tool blocks and nameless tool_use blocks, and nulls a non-string id and a missing input", () => {
    const toolUses = extractToolUses(
      {
        timestamp: TS,
        message: {
          content: [
            { type: "text", text: "thinking" },
            { type: "tool_use", id: "empty-name", name: "" },
            { type: "tool_use", id: "numeric-name", name: 5 },
            { type: "tool_use", id: 7, name: "Glob" },
            null,
          ],
        },
      },
      "ses-1",
      "agent-1"
    );
    assert.deepEqual(
      toolUses.map((t) => [t.toolName, t.toolUseId, t.input, t.timestamp]),
      [["Glob", null, null, TS]]
    );
  });

  it("reads a flat entry of another type through the message path, and nulls an absent result and a non-boolean is_error", () => {
    assert.deepEqual(
      extractToolUses(
        { type: "assistant", name: "Bash", message: { content: [] } },
        "ses-1",
        "agent-1"
      ),
      []
    );
    const [flat] = extractToolUses(
      {
        type: "tool_use",
        name: "Bash",
        id: "f1",
        timestamp: TS,
        input: 0,
        is_error: "yes",
      },
      "ses-1",
      "agent-1"
    );
    assert.deepEqual(
      [flat.input, flat.output, flat.resultTimestamp, flat.isError],
      [0, null, null, null]
    );
  });
});

describe("repeated ids by tool name, and ordering", () => {
  it("conflicts a repeated id whose tool name differs", () => {
    const renamed = {
      timestamp: TS,
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
      },
    };
    assert.deepEqual(
      accumulate([assistantToolUse("t1", {}), renamed]).conflicted,
      ["t1"]
    );
  });

  it("orders by timestamp, carrying the last seen timestamp to an untimed call, then by arrival", () => {
    const T_EARLY = "2026-01-15T09:59:00.000Z";
    const { toolUses } = accumulate([
      assistantToolUse("a", { n: 1 }, TS_LATER),
      { message: { content: [{ type: "tool_use", id: "b", name: "Bash" }] } },
      assistantToolUse("c", { n: 3 }, T_EARLY),
      assistantToolUse("d", { n: 4 }, T_EARLY),
    ]);
    assert.deepEqual(
      toolUses.map((t) => [t.toolUseId, t.timestamp]),
      [
        ["c", T_EARLY],
        ["d", T_EARLY],
        ["a", TS_LATER],
        ["b", null],
      ]
    );
  });
});
