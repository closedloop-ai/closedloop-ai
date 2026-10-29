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
import { parseClaudeTranscript } from "./parse-claude";

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

  it("drops the record whole when file_path is not a string", () => {
    const acc = makeAcc();
    const tu = makeTu("Edit");
    handlerMap.get("Edit")!(acc, tu, {
      old_string: "before",
      new_string: "after",
    });

    // ISS-6737: a delta with no `file_path` is attributable to no file, so the
    // record is now dropped WHOLE rather than moving the totals while
    // `filesChanged` stays put.
    expect(tu.diffDelta).toBeUndefined();
    expect(acc.totalAdded).toBe(0);
    expect(acc.totalRemoved).toBe(0);
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

  it("drops the record whole when file_path is absent", () => {
    const acc = makeAcc();
    const tu = makeTu("Write");
    handlerMap.get("Write")!(acc, tu, { content: "some\ncontent" });

    // ISS-6737: a delta with no `file_path` is attributable to no file, so the
    // record is now dropped WHOLE rather than moving the totals while
    // `filesChanged` stays put.
    // Measured before the fix: 3 added lines against 0 files.
    expect(acc.totalAdded).toBe(0);
    expect(acc.diffFiles.size).toBe(0);
    expect(acc.readContentByPath.size).toBe(0);
  });

  it("treats absent content as empty string and still adds path to diffFiles", () => {
    const acc = makeAcc();
    const tu = makeTu("Write");
    handlerMap.get("Write")!(acc, tu, { file_path: "/repo/empty.ts" });

    // ISS-6764: content defaults to "" → no lines written, so no lines counted.
    // The path is still a file this session touched.
    expect(tu.diffDelta).toEqual({ add: 0, del: 0 });
    expect(acc.totalAdded).toBe(0);
    expect(acc.diffFiles.has("/repo/empty.ts")).toBe(true);
    // ISS-6762: but the coerced default is NOT remembered — the path has no
    // known state, so a later Write of it is not diffed against an empty file.
    expect(acc.readContentByPath.size).toBe(0);
  });

  it("neither diffs against nor replaces a prior baseline when content is not a string", () => {
    // ISS-6762, on the handler itself: a payload that carries no content
    // evidences nothing about the file, so it must take the fresh-file path —
    // diffing the coerced "" against the real baseline books a mass deletion
    // nobody performed, and caching it erases the state the next genuine
    // overwrite needs. ISS-6761 has since put a schema gate in front of both
    // lanes, so no production caller reaches the handler with this payload; the
    // handler is exported and total, so the invariant is still pinned here for
    // any direct caller. The end-to-end parent-lane behavior is asserted in the
    // ISS-6761 suite below.
    const acc = makeAcc();
    const tu = makeTu("Write");
    acc.readContentByPath.set("/repo/src/app.ts", "a\nb\nc\n");

    handlerMap.get("Write")!(acc, tu, {
      file_path: "/repo/src/app.ts",
      content: 42,
    });

    // ISS-6764: the fresh path now runs `computeLineDelta`, and the coerced ""
    // has no lines — so the corrupt record books nothing rather than the one
    // phantom line `"".split("\n").length` used to return.
    expect(tu.diffDelta).toEqual({ add: 0, del: 0 });
    expect(acc.readContentByPath.get("/repo/src/app.ts")).toBe("a\nb\nc\n");
  });

  it("still diffs the NEXT real overwrite against the true baseline after a corrupt Write", () => {
    // Behavioural proof of the above, on the totals the session actually
    // reports: against a poisoned "" baseline the real overwrite reads as
    // {add: 3, del: 0} — three genuine deletions vanish and one line nobody
    // wrote is added.
    const acc = makeAcc();
    acc.readContentByPath.set("/repo/src/app.ts", "a\nb\nc\n");
    handlerMap.get("Write")!(acc, makeTu("Write"), {
      file_path: "/repo/src/app.ts",
      content: 42,
    });

    const real = makeTu("Write");
    handlerMap.get("Write")!(acc, real, {
      file_path: "/repo/src/app.ts",
      content: "x\ny\n",
    });

    expect(real.diffDelta).toEqual({ add: 2, del: 3 });
    // Every line the session reports — added and removed alike — comes from the
    // real Write. ISS-6764 dropped the one added line the corrupt record used to
    // contribute, so the corrupt payload is now fully inert on the totals.
    expect(acc.totalRemoved).toBe(3);
    expect(acc.totalAdded).toBe(2);
  });

  it("books zero added lines for empty content on a fresh file (ISS-6764)", () => {
    const acc = makeAcc();
    const tu = makeTu("Write");
    handlerMap.get("Write")!(acc, tu, {
      file_path: "/repo/blank.ts",
      content: "",
    });

    // A zero-line file adds zero lines — not the one phantom line
    // `"".split("\n").length` used to book.
    expect(tu.diffDelta).toEqual({ add: 0, del: 0 });
    expect(acc.totalAdded).toBe(0);
    expect(acc.totalRemoved).toBe(0);
    expect(acc.diffFiles.has("/repo/blank.ts")).toBe(true);
    // What separates this from the absent-content case above: an explicit ""
    // IS a known state, so it becomes the baseline the next Write diffs
    // against. ISS-6762 withholds that only from a payload carrying no string.
    expect(acc.readContentByPath.get("/repo/blank.ts")).toBe("");
  });

  it("counts an empty-content Write the same with and without a prior Read (ISS-6764)", () => {
    const fresh = makeAcc();
    const freshTu = makeTu("Write");
    handlerMap.get("Write")!(fresh, freshTu, {
      file_path: "/repo/blank.ts",
      content: "",
    });

    // Same operation, same file, only difference is an unrelated earlier Read of
    // an already-empty file. The added-line answer must not depend on it.
    const afterRead = makeAcc();
    const afterReadTu = makeTu("Write");
    afterRead.readContentByPath.set("/repo/blank.ts", "");
    handlerMap.get("Write")!(afterRead, afterReadTu, {
      file_path: "/repo/blank.ts",
      content: "",
    });

    // Pinned absolutely, not just to each other — two `undefined` deltas from a
    // future early return would satisfy equality alone.
    expect(freshTu.diffDelta).toEqual({ add: 0, del: 0 });
    expect(afterReadTu.diffDelta).toEqual({ add: 0, del: 0 });
    expect(fresh.totalAdded).toBe(afterRead.totalAdded);
  });

  it("still books the deletions when an empty Write truncates a read file", () => {
    // The prior-Read arm above seeds "", which `computeLineDelta` treats as no
    // baseline at all — so it cannot tell the fresh path from the overwrite
    // path. A NON-empty baseline can: truncating a real file to "" is a
    // deletion of every line, and ISS-6764 must not have flattened that to zero
    // along with the phantom add.
    const acc = makeAcc();
    const tu = makeTu("Write");
    acc.readContentByPath.set("/repo/app.ts", "a\nb");
    handlerMap.get("Write")!(acc, tu, {
      file_path: "/repo/app.ts",
      content: "",
    });

    expect(tu.diffDelta).toEqual({ add: 0, del: 2 });
    expect(acc.totalRemoved).toBe(2);
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

  it("drops the record whole when file_path is not a string", () => {
    const acc = makeAcc();
    const tu = makeTu("MultiEdit");
    handlerMap.get("MultiEdit")!(acc, tu, {
      edits: [{ old_string: "a", new_string: "b" }],
    });

    // ISS-6737: a delta with no `file_path` is attributable to no file, so the
    // record is now dropped WHOLE rather than moving the totals while
    // `filesChanged` stays put.
    expect(acc.diffFiles.size).toBe(0);
    expect(acc.totalAdded).toBe(0);
    expect(acc.totalRemoved).toBe(0);
    expect(tu.diffDelta).toBeUndefined();
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
 * ISS-6761: the PARENT parser lane is fed the same raw transcript JSON as the
 * sidecar lane — `block.input` straight off the parsed `.jsonl` line, with no
 * normalization of `content` — so it must reject a corrupt payload on the same
 * terms. It used to run the total handlers ungated, and the asymmetry was
 * measurable: the identical malformed `Write` booked one fabricated added line
 * and one changed file through the parent while contributing nothing through
 * `applyDiffStatsToolUse`. One shared formula, two answers.
 *
 * These assert AGREEMENT between the lanes on the malformed shape, not merely
 * that the parent produces some number.
 */
describe("ISS-6761 — the parent lane gates malformed payloads like the sidecar", () => {
  function writeToolUseLine(input: unknown): string {
    return JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [{ type: "tool_use", id: "toolu_w1", name: "Write", input }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });
  }

  it("books no line and no changed file for a Write whose content is absent", async () => {
    // Ungated, `content` coerced to "" and `"".split("\n").length` booked ONE
    // added line against one changed file that nobody wrote.
    const session = await parseClaudeTranscript(
      [USER_LINE, writeToolUseLine({ file_path: "/repo/empty.ts" })],
      { sessionId: "diff-gate-absent-content" }
    );

    expect(session?.diffStats).toBeNull();
    const writeTu = session?.toolUses.find((tu) => tu.name === "Write");
    expect(writeTu).toBeDefined();
    expect(writeTu?.diffDelta).toBeUndefined();
  });

  it("agrees with the sidecar entry point on a non-string content", async () => {
    const malformed = { file_path: "/repo/a.ts", content: 42 };

    const session = await parseClaudeTranscript(
      [USER_LINE, writeToolUseLine(malformed)],
      { sessionId: "diff-gate-nonstring-content" }
    );
    const acc = makeAcc();
    const countedBySidecarLane = applyDiffStatsToolUse(acc, "Write", malformed);

    expect(countedBySidecarLane).toBe(false);
    expect(acc.diffFiles.size).toBe(0);
    // The parent must reach the SAME verdict on the SAME block.
    expect(session?.diffStats).toBeNull();
  });

  it("drops only the malformed block — a later well-formed edit still counts", async () => {
    // The gate withholds one handler call; it must not abort the record, the
    // tool-use list, or the edits that follow it.
    const editLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:02.000Z",
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

    const session = await parseClaudeTranscript(
      [USER_LINE, writeToolUseLine({ file_path: "/repo/empty.ts" }), editLine],
      { sessionId: "diff-gate-mixed" }
    );

    expect(session?.diffStats).toEqual({
      filesChanged: 1,
      linesAdded: 2,
      linesRemoved: 1,
    });
    expect(session?.toolUses.map((tu) => tu.name)).toEqual(["Write", "Edit"]);
  });

  it("drops a partially corrupt MultiEdit WHOLE, exactly as the sidecar lane does", async () => {
    // The adopted trade, pinned: ISS-5402 drops a failing record whole rather
    // than counting it in part, so the two well-formed edits below go with the
    // corrupt third one. Relaxing that would have to move BOTH lanes together —
    // this asserts the lanes agree, not that dropping is costless.
    const malformed = {
      file_path: "/repo/src/mod.ts",
      edits: [
        { old_string: "a", new_string: "a2" },
        { old_string: "b", new_string: "b2" },
        { old_string: 42, new_string: "c2" },
      ],
    };
    const multiEditLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [
          {
            type: "tool_use",
            id: "toolu_m1",
            name: "MultiEdit",
            input: malformed,
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

    const session = await parseClaudeTranscript([USER_LINE, multiEditLine], {
      sessionId: "diff-gate-partial-multiedit",
    });
    const acc = makeAcc();

    expect(applyDiffStatsToolUse(acc, "MultiEdit", malformed)).toBe(false);
    expect(session?.diffStats).toBeNull();
  });

  it("drops an Edit whose new_string is null, losing its well-formed side", async () => {
    // The other half of the adopted trade the revision entry names. `null` is
    // not `undefined`, so `z.string().optional()` rejects it and the record goes
    // whole — `old_string` names real authored text that the parent lane no
    // longer books. Pinned so relaxing the Edit schema cannot pass unnoticed in
    // either lane.
    const malformed = {
      file_path: "/repo/src/mod.ts",
      old_string: "a\nb",
      new_string: null,
    };
    const editLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [
          { type: "tool_use", id: "toolu_e1", name: "Edit", input: malformed },
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
      sessionId: "diff-gate-null-new-string-edit",
    });
    const acc = makeAcc();

    expect(applyDiffStatsToolUse(acc, "Edit", malformed)).toBe(false);
    expect(session?.diffStats).toBeNull();
  });

  it("leaves a tool with no diffStats schema dispatching as before", async () => {
    // The gate is fail-open for a non-diffStats tool, so the registry's other
    // handlers must be untouched by it.
    const skillLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [
          {
            type: "tool_use",
            id: "toolu_s1",
            name: "Skill",
            input: { skill: "code-review" },
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

    const session = await parseClaudeTranscript([USER_LINE, skillLine], {
      sessionId: "diff-gate-non-diffstats-tool",
    });

    expect(session?.toolUses.find((tu) => tu.name === "Skill")?.skillName).toBe(
      "code-review"
    );
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
    expect(
      isUsableDiffStatsToolInput("Edit", {
        file_path: "/a.ts",
        old_string: "a",
      })
    ).toBe(true);
    expect(
      isUsableDiffStatsToolInput("Edit", {
        file_path: "/a.ts",
        new_string: "b",
      })
    ).toBe(true);
    // Neither side means no delta: a {0,0} change still claiming a changed file.
    expect(isUsableDiffStatsToolInput("Edit", { file_path: "/a.ts" })).toBe(
      false
    );
  });

  it("requires a string content on Write", () => {
    expect(
      isUsableDiffStatsToolInput("Write", { file_path: "/a.ts", content: "" })
    ).toBe(true);
    // A non-string content becomes "" in the handler, and "".split("\n") books
    // ONE added line nobody wrote.
    expect(
      isUsableDiffStatsToolInput("Write", { file_path: "/a.ts", content: 42 })
    ).toBe(false);
    expect(isUsableDiffStatsToolInput("Write", {})).toBe(false);
  });

  it("requires a non-empty edits array with at least one edited side on MultiEdit", () => {
    const path = "/a.ts";
    expect(
      isUsableDiffStatsToolInput("MultiEdit", {
        file_path: path,
        edits: [{ old_string: "a" }],
      })
    ).toBe(true);
    expect(
      isUsableDiffStatsToolInput("MultiEdit", { file_path: path, edits: [] })
    ).toBe(false);
    // Entries present, but not one of them carries a side.
    expect(
      isUsableDiffStatsToolInput("MultiEdit", {
        file_path: path,
        edits: [{}, {}],
      })
    ).toBe(false);
    // `some`, not `every`: one usable entry among unusable ones still counts.
    // ISS-6737 kept this deliberately — an entry with no string side yields
    // {0,0}, so `every` would discard real lines rather than prevent fabricated
    // ones. The module docstring now states the exception.
    expect(
      isUsableDiffStatsToolInput("MultiEdit", {
        file_path: path,
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
    // This entry point gets that from its schema gate; ISS-6762 made the same
    // invariant hold on the ungated parent lane, covered in the Write suite
    // above ("neither diffs against nor replaces a prior baseline when content
    // is not a string").
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

describe("a pathless record cannot fold into a valid one's totals (ISS-6737)", () => {
  // The hiding case named in ISS-6737: one valid edit keeps `diffStats` alive,
  // so a pathless record in the same sidecar used to add its lines to the
  // totals invisibly — `linesAdded`/`linesRemoved` moving while `filesChanged`
  // did not. A single-record test cannot catch that, because dropping the only
  // record also drops the whole `diffStats` object.
  it("counts only the record that names a file", () => {
    const acc = makeAcc();
    handlerMap.get("Edit")!(acc, makeTu("Edit"), {
      file_path: "/real.ts",
      old_string: "a\nb\nc",
      new_string: "a",
    });
    handlerMap.get("Edit")!(acc, makeTu("Edit"), {
      old_string: "x\ny\nz",
      new_string: "x",
    });

    // The valid edit removed 2 lines from one file. The pathless one adds
    // nothing — before ISS-6737 it contributed another 2 removals.
    expect(acc.totalRemoved).toBe(2);
    expect(acc.diffFiles.size).toBe(1);
    expect([...acc.diffFiles]).toEqual(["/real.ts"]);
  });

  it("holds for a pathless Write beside a valid one", () => {
    const acc = makeAcc();
    handlerMap.get("Write")!(acc, makeTu("Write"), {
      file_path: "/real.ts",
      content: "one\ntwo",
    });
    handlerMap.get("Write")!(acc, makeTu("Write"), { content: "a\nb\nc\nd" });

    expect(acc.totalAdded).toBe(2);
    expect(acc.diffFiles.size).toBe(1);
  });

  it("refuses a pathless payload at the schema gate on every diff tool", () => {
    // The gated lanes drop it before dispatch; the handler assertions above
    // cover the ungated direct caller the module's docstring warns about.
    expect(
      isUsableDiffStatsToolInput("Edit", { old_string: "a", new_string: "b" })
    ).toBe(false);
    expect(isUsableDiffStatsToolInput("Write", { content: "x" })).toBe(false);
    expect(
      isUsableDiffStatsToolInput("MultiEdit", { edits: [{ old_string: "a" }] })
    ).toBe(false);
  });
});
