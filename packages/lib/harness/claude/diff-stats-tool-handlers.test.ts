/**
 * ISS-5292 Packet C: branch coverage for `diff-stats-tool-handlers.ts`.
 *
 * Tests fall into two groups:
 *
 * 1. Direct handler calls via `DIFF_STATS_TOOL_HANDLERS` — exercise every
 *    conditional branch in Edit / Write / MultiEdit without going through the
 *    full transcript parser.
 *
 * 2. Wiring test — drives the handlers through `parseClaudeTranscript` so that
 *    removing `...DIFF_STATS_TOOL_HANDLERS` from parse-claude.ts:892 causes this
 *    suite to fail (mandatory per the packet spec).
 */
import { describe, expect, it } from "vitest";
import type { NormalizedToolUse } from "../types";
import {
  applyDiffStatsToolUse,
  applyDiffStatsToolUseState,
  captureDiffStatsReadResult,
  DIFF_STATS_TOOL_HANDLERS,
  DIFF_STATS_TOOL_NAMES,
  type DiffStatsAccumulator,
  isUsableDiffStatsToolInput,
} from "./diff-stats-tool-handlers";
import { parseClaudeTranscript } from "./parse-claude-core";

function makeAcc(): DiffStatsAccumulator {
  return {
    totalAdded: 0,
    totalRemoved: 0,
    diffFiles: new Set<string>(),
    readContentByPath: new Map<string, string>(),
  };
}

function makeTu(name: string): NormalizedToolUse {
  return { name, timestamp: null };
}

const handlerMap = new Map(DIFF_STATS_TOOL_HANDLERS);

const USER_LINE = JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T12:00:00.000Z",
  cwd: "/workspace/project",
  message: { role: "user", content: "edit the file" },
});

// ---------------------------------------------------------------------------
// Edit handler
// ---------------------------------------------------------------------------

describe("DIFF_STATS_TOOL_HANDLERS — Edit", () => {
  it("computes delta for string old/new and adds path to diffFiles", () => {
    const acc = makeAcc();
    const tu = makeTu("Edit");
    handlerMap.get("Edit")!(acc, tu, {
      file_path: "/repo/src/app.ts",
      old_string: "const x = 1;",
      new_string: "const x = 2;\nconst y = 3;",
    });

    // computeLineDelta: "const x = 2;" and "const y = 3;" are new; "const x = 1;" removed
    expect(tu.diffDelta).toEqual({ add: 2, del: 1 });
    expect(acc.totalAdded).toBe(2);
    expect(acc.totalRemoved).toBe(1);
    expect(acc.diffFiles.has("/repo/src/app.ts")).toBe(true);
  });

  it("yields a defined delta even when old_string and new_string are absent", () => {
    const acc = makeAcc();
    const tu = makeTu("Edit");
    // inp.old_string / inp.new_string are not strings → both coerce to null
    handlerMap.get("Edit")!(acc, tu, { file_path: "/repo/mod.ts" });

    expect(tu.diffDelta).toBeDefined();
    expect(acc.totalAdded).toBe(tu.diffDelta!.add);
    expect(acc.totalRemoved).toBe(tu.diffDelta!.del);
    expect(acc.diffFiles.has("/repo/mod.ts")).toBe(true);
  });

  it("skips diffFiles when file_path is not a string", () => {
    const acc = makeAcc();
    const tu = makeTu("Edit");
    handlerMap.get("Edit")!(acc, tu, {
      old_string: "before",
      new_string: "after",
    });

    // Delta is still computed, but diffFiles stays empty.
    expect(tu.diffDelta).toBeDefined();
    expect(acc.diffFiles.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Write handler
// ---------------------------------------------------------------------------

describe("DIFF_STATS_TOOL_HANDLERS — Write", () => {
  it("counts all lines as added for a fresh file (no prior Read)", () => {
    const acc = makeAcc();
    const tu = makeTu("Write");
    handlerMap.get("Write")!(acc, tu, {
      file_path: "/repo/new.ts",
      content: "line one\nline two\nline three",
    });

    // Three lines, no prior read → all added, zero removed.
    expect(tu.diffDelta).toEqual({ add: 3, del: 0 });
    expect(acc.totalAdded).toBe(3);
    expect(acc.totalRemoved).toBe(0);
    expect(acc.diffFiles.has("/repo/new.ts")).toBe(true);
    // Content is cached so a subsequent Write of the same path can diff against it.
    expect(acc.readContentByPath.get("/repo/new.ts")).toBe(
      "line one\nline two\nline three"
    );
  });

  it("diffs against a prior Read when the path was read earlier", () => {
    const acc = makeAcc();
    const tu = makeTu("Write");
    acc.readContentByPath.set(
      "/repo/src/index.ts",
      "const a = 1;\nconst b = 2;"
    );

    handlerMap.get("Write")!(acc, tu, {
      file_path: "/repo/src/index.ts",
      content: "const a = 1;\nconst b = 2;\nconst c = 3;",
    });

    // Prior: 2 lines; new: 3 lines — one line added.
    expect(tu.diffDelta).toEqual({ add: 1, del: 0 });
    expect(acc.totalAdded).toBe(1);
    expect(acc.totalRemoved).toBe(0);
    expect(acc.diffFiles.has("/repo/src/index.ts")).toBe(true);
  });

  it("increments linesAdded but skips diffFiles when file_path is absent", () => {
    const acc = makeAcc();
    const tu = makeTu("Write");
    handlerMap.get("Write")!(acc, tu, { content: "some\ncontent" });

    // No file_path → totalAdded is non-zero, diffFiles stays empty.
    expect(acc.totalAdded).toBeGreaterThan(0);
    expect(acc.diffFiles.size).toBe(0);
    // And no path is cached (filePath == null guard).
    expect(acc.readContentByPath.size).toBe(0);
  });

  it("treats absent content as empty string and still adds path to diffFiles", () => {
    const acc = makeAcc();
    const tu = makeTu("Write");
    handlerMap.get("Write")!(acc, tu, { file_path: "/repo/empty.ts" });

    // content defaults to "" → 1 empty line counted as added.
    expect(tu.diffDelta?.add).toBeGreaterThanOrEqual(1);
    expect(tu.diffDelta?.del).toBe(0);
    expect(acc.diffFiles.has("/repo/empty.ts")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MultiEdit handler
// ---------------------------------------------------------------------------

describe("DIFF_STATS_TOOL_HANDLERS — MultiEdit", () => {
  it("yields zero delta for an empty edits array but still registers the file", () => {
    const acc = makeAcc();
    const tu = makeTu("MultiEdit");
    handlerMap.get("MultiEdit")!(acc, tu, {
      file_path: "/repo/src/mod.ts",
      edits: [],
    });

    expect(tu.diffDelta).toEqual({ add: 0, del: 0 });
    expect(acc.totalAdded).toBe(0);
    expect(acc.totalRemoved).toBe(0);
    expect(acc.diffFiles.has("/repo/src/mod.ts")).toBe(true);
  });

  it("sums line deltas across all edits and counts the file once", () => {
    const acc = makeAcc();
    const tu = makeTu("MultiEdit");
    handlerMap.get("MultiEdit")!(acc, tu, {
      file_path: "/repo/src/utils.ts",
      edits: [
        // computeLineDelta("keep\ndrop", "keep") → {add:0, del:1}
        { old_string: "keep\ndrop", new_string: "keep" },
        // computeLineDelta("old", "new1\nnew2") → {add:2, del:1}
        { old_string: "old", new_string: "new1\nnew2" },
      ],
    });

    // Summed: add=2, del=2.
    expect(tu.diffDelta).toEqual({ add: 2, del: 2 });
    expect(acc.totalAdded).toBe(2);
    expect(acc.totalRemoved).toBe(2);
    expect(acc.diffFiles.has("/repo/src/utils.ts")).toBe(true);
    expect(acc.diffFiles.size).toBe(1);
  });

  it("falls back to an empty edits array when edits is not an array", () => {
    const acc = makeAcc();
    const tu = makeTu("MultiEdit");
    handlerMap.get("MultiEdit")!(acc, tu, {
      file_path: "/repo/x.ts",
      edits: null,
    });

    expect(tu.diffDelta).toEqual({ add: 0, del: 0 });
    expect(acc.totalAdded).toBe(0);
    expect(acc.totalRemoved).toBe(0);
  });

  it("skips diffFiles when file_path is not a string", () => {
    const acc = makeAcc();
    const tu = makeTu("MultiEdit");
    handlerMap.get("MultiEdit")!(acc, tu, {
      edits: [{ old_string: "a", new_string: "b" }],
    });

    expect(acc.diffFiles.size).toBe(0);
    expect(tu.diffDelta).toBeDefined();
  });

  // The two cases below are trust-boundary coercions: `edits[]` comes from
  // parsed JSONL, so an element's `old_string` / `new_string` can be any JSON
  // value regardless of what the types say. Each drops ONLY the non-string side
  // to null and still counts the other, rather than discarding the whole edit.
  //
  // They also kill the `typeof … === "string" ? … : null` mutants: without the
  // guard the raw value reaches `computeLineDelta`, which calls `.split("\n")`
  // on anything truthy and throws `TypeError: …split is not a function`.
  it("treats a non-string new_string as absent, counting the old side as removed", () => {
    const acc = makeAcc();
    const tu = makeTu("MultiEdit");
    handlerMap.get("MultiEdit")!(acc, tu, {
      file_path: "/repo/x.ts",
      edits: [{ old_string: "a\nb", new_string: 123 }],
    });

    // new side dropped → both old lines read as removals, nothing added.
    expect(tu.diffDelta).toEqual({ add: 0, del: 2 });
    expect(acc.totalRemoved).toBe(2);
    expect(acc.totalAdded).toBe(0);
  });

  it("treats a non-string old_string as absent, counting the new side as added", () => {
    const acc = makeAcc();
    const tu = makeTu("MultiEdit");
    handlerMap.get("MultiEdit")!(acc, tu, {
      file_path: "/repo/x.ts",
      edits: [{ old_string: { was: "an object" }, new_string: "a\nb\nc" }],
    });

    expect(tu.diffDelta).toEqual({ add: 3, del: 0 });
    expect(acc.totalAdded).toBe(3);
    expect(acc.totalRemoved).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Wiring: Edit/Write/MultiEdit through parseClaudeTranscript (MANDATORY)
// ---------------------------------------------------------------------------

describe("DIFF_STATS_TOOL_HANDLERS — wiring through parseClaudeTranscript", () => {
  it("populates session.diffStats and tu.diffDelta when Edit is registered (parse-claude.ts:892)", async () => {
    // If ...DIFF_STATS_TOOL_HANDLERS were removed from TOOL_USE_HANDLERS at
    // parse-claude.ts:892, the Edit handler would never run, diffFiles would
    // stay empty, session.diffStats would be null, and tu.diffDelta would be
    // undefined — failing both assertions below.
    const editLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [
          {
            type: "tool_use",
            id: "toolu_e1",
            name: "Edit",
            input: {
              file_path: "/repo/src/app.ts",
              old_string: "const x = 1;",
              new_string: "const x = 2;\nconst y = 3;",
            },
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });

    const session = await parseClaudeTranscript([USER_LINE, editLine], {
      sessionId: "diff-wiring-edit",
    });

    expect(session?.diffStats).not.toBeNull();
    expect(session?.diffStats?.filesChanged).toBe(1);
    expect(session?.diffStats?.linesAdded).toBe(2);
    expect(session?.diffStats?.linesRemoved).toBe(1);

    const editTu = session?.toolUses.find((tu) => tu.name === "Edit");
    expect(editTu?.diffDelta).toEqual({ add: 2, del: 1 });
  });

  it("applies Write handler and uses prior Read as the diff baseline", async () => {
    const readLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [
          {
            type: "tool_use",
            id: "toolu_r1",
            name: "Read",
            input: { file_path: "/repo/src/index.ts" },
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });
    const readResultLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:02.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_r1",
            // Line-number prefixes are stripped; stored as "const a = 1;\nconst b = 2;"
            content: "1\tconst a = 1;\n2\tconst b = 2;",
          },
        ],
      },
    });
    const writeLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:03.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [
          {
            type: "tool_use",
            id: "toolu_w1",
            name: "Write",
            input: {
              file_path: "/repo/src/index.ts",
              content: "const a = 1;\nconst b = 2;\nconst c = 3;",
            },
          },
        ],
        usage: {
          input_tokens: 15,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });

    const session = await parseClaudeTranscript(
      [USER_LINE, readLine, readResultLine, writeLine],
      { sessionId: "diff-wiring-write" }
    );

    // Write diffs prior Read (2 lines) → new content (3 lines): +1 line.
    expect(session?.diffStats?.linesAdded).toBe(1);
    expect(session?.diffStats?.linesRemoved).toBe(0);
    expect(session?.diffStats?.filesChanged).toBe(1);
  });
});

/**
 * ISS-6733: the four EXPORTED entry points the ISS-5402/ISS-5426 sidecar lane
 * calls were entirely unexercised — the suite above drives the handler TABLE
 * directly and never goes through them. Mutation testing reported it precisely:
 * 43 of this file's mutants had no covering test at all, and every mutant of the
 * shared `if (!(handler && isUsable…))` guard survived, INCLUDING `if (true)` and
 * `if (false)` — a guard that can be inverted or short-circuited to a constant
 * without a single test noticing.
 *
 * These are the schema gates that stop a corrupt payload from materializing a
 * plausible-but-wrong LOC number, so "no test would notice" is the expensive kind
 * of gap: the failure it prevents is a believable number, not a crash.
 */
describe("isUsableDiffStatsToolInput", () => {
  it("passes a tool that has no diffStats schema — not-a-diffStats-tool is not unusable", () => {
    expect(isUsableDiffStatsToolInput("Bash", { command: "ls" })).toBe(true);
  });

  it("requires at least one edited side on Edit", () => {
    expect(isUsableDiffStatsToolInput("Edit", { old_string: "a" })).toBe(true);
    expect(isUsableDiffStatsToolInput("Edit", { new_string: "b" })).toBe(true);
    // Neither side means no delta: a {0,0} change still claiming a changed file.
    expect(isUsableDiffStatsToolInput("Edit", { file_path: "/a.ts" })).toBe(
      false
    );
  });

  it("requires a string content on Write", () => {
    expect(isUsableDiffStatsToolInput("Write", { content: "" })).toBe(true);
    // A non-string content becomes "" in the handler, and "".split("\n") books
    // ONE added line nobody wrote.
    expect(isUsableDiffStatsToolInput("Write", { content: 42 })).toBe(false);
    expect(isUsableDiffStatsToolInput("Write", {})).toBe(false);
  });

  it("requires a non-empty edits array with at least one edited side on MultiEdit", () => {
    expect(
      isUsableDiffStatsToolInput("MultiEdit", {
        edits: [{ old_string: "a" }],
      })
    ).toBe(true);
    expect(isUsableDiffStatsToolInput("MultiEdit", { edits: [] })).toBe(false);
    // Entries present, but not one of them carries a side.
    expect(isUsableDiffStatsToolInput("MultiEdit", { edits: [{}, {}] })).toBe(
      false
    );
    // `some`, not `every`: one usable entry among unusable ones still counts.
    expect(
      isUsableDiffStatsToolInput("MultiEdit", {
        edits: [{}, { new_string: "b" }],
      })
    ).toBe(true);
  });

  // ISS-5544: the guard fails OPEN on a tool with no schema entry, so a handler
  // registered without one silently ungates the sidecar lane for that tool. The
  // schema table is now a keys-covered Record over the handler registry and a
  // gap fails `tsc`; this asserts the same property at runtime. An empty payload
  // carries no usable side for ANY diffStats tool, so a `true` here means the
  // named tool reached the fail-open branch rather than a schema.
  it("gates every registered diffStats tool — no handler falls through unschema'd", () => {
    for (const toolName of DIFF_STATS_TOOL_NAMES) {
      expect(isUsableDiffStatsToolInput(toolName, {})).toBe(false);
    }
  });
});

describe("applyDiffStatsToolUse", () => {
  it("applies a valid tool use and reports that it did", () => {
    const acc = makeAcc();
    expect(
      applyDiffStatsToolUse(acc, "Edit", {
        file_path: "/a.ts",
        old_string: "one\ntwo",
        new_string: "one",
      })
    ).toBe(true);
    expect(acc.totalRemoved).toBe(1);
    expect([...acc.diffFiles]).toEqual(["/a.ts"]);
  });

  it("refuses a tool with no diffStats handler, leaving the accumulator untouched", () => {
    const acc = makeAcc();
    expect(applyDiffStatsToolUse(acc, "Bash", { command: "ls" })).toBe(false);
    expect(acc.totalAdded).toBe(0);
    expect(acc.totalRemoved).toBe(0);
    expect(acc.diffFiles.size).toBe(0);
  });

  it("refuses a KNOWN tool whose payload fails its schema", () => {
    // The half the handler lookup cannot catch: right tool, corrupt payload.
    // Dropping it whole is the point — counting it in part is the same
    // fabrication in a quieter form.
    const acc = makeAcc();
    expect(applyDiffStatsToolUse(acc, "Write", { file_path: "/a.ts" })).toBe(
      false
    );
    expect(acc.totalAdded).toBe(0);
    expect(acc.diffFiles.size).toBe(0);
  });
});

describe("applyDiffStatsToolUseState", () => {
  it("advances the overwrite baseline while contributing NO lines or files", () => {
    // The whole reason this function exists (ISS-5426): a suppressed tool use
    // must still let the NEXT record measure against it. If it contributed
    // counts too, the caller that already counted this record would double it.
    const acc = makeAcc();
    applyDiffStatsToolUseState(acc, "Write", {
      file_path: "/a.ts",
      content: "one\ntwo\nthree",
    });
    expect(acc.totalAdded).toBe(0);
    expect(acc.totalRemoved).toBe(0);
    expect(acc.diffFiles.size).toBe(0);
    expect(acc.readContentByPath.get("/a.ts")).toBe("one\ntwo\nthree");
  });

  it("makes the advanced baseline the diff target for the NEXT write", () => {
    // Behavioural proof of the above rather than a field check: without the
    // state advance the second Write reads as a fresh all-added file and
    // overcounts by exactly the lines it did not change.
    const acc = makeAcc();
    applyDiffStatsToolUseState(acc, "Write", {
      file_path: "/a.ts",
      content: "one\ntwo\nthree",
    });
    applyDiffStatsToolUse(acc, "Write", {
      file_path: "/a.ts",
      content: "one\ntwo",
    });
    expect(acc.totalAdded).toBe(0);
    expect(acc.totalRemoved).toBe(1);
  });

  it("does not advance the baseline for an unknown tool or a corrupt payload", () => {
    const acc = makeAcc();
    applyDiffStatsToolUseState(acc, "Bash", { command: "ls" });
    expect(acc.readContentByPath.size).toBe(0);

    // A corrupt Write must not poison the baseline the next real one diffs from.
    applyDiffStatsToolUseState(acc, "Write", {
      file_path: "/a.ts",
      content: 42,
    });
    expect(acc.readContentByPath.size).toBe(0);
  });
});

describe("captureDiffStatsReadResult", () => {
  it("caches a full read and strips the line-number prefixes", () => {
    const acc = makeAcc();
    captureDiffStatsReadResult(
      acc,
      { file_path: "/a.ts" },
      "  1\tone\n  2\ttwo"
    );
    expect(acc.readContentByPath.get("/a.ts")).toBe("one\ntwo");
  });

  it("refuses a PARTIAL read, which would fabricate deletions", () => {
    // A slice diffed against a later full Write reads as a mass deletion of the
    // lines the slice never contained.
    const withOffset = makeAcc();
    captureDiffStatsReadResult(
      withOffset,
      { file_path: "/a.ts", offset: 10 },
      "x"
    );
    expect(withOffset.readContentByPath.size).toBe(0);

    const withLimit = makeAcc();
    captureDiffStatsReadResult(
      withLimit,
      { file_path: "/a.ts", limit: 5 },
      "x"
    );
    expect(withLimit.readContentByPath.size).toBe(0);
  });

  it("caches when offset and limit are explicitly null, which is not a partial read", () => {
    // `!= null` is deliberate: an explicit null is absence, not a slice.
    const acc = makeAcc();
    captureDiffStatsReadResult(
      acc,
      { file_path: "/a.ts", offset: null, limit: null },
      "one"
    );
    expect(acc.readContentByPath.get("/a.ts")).toBe("one");
  });

  it("ignores a non-string file_path", () => {
    const acc = makeAcc();
    captureDiffStatsReadResult(acc, { file_path: 7 }, "one");
    expect(acc.readContentByPath.size).toBe(0);
  });
});
