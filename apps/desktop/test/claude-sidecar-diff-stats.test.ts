/**
 * @file claude-sidecar-diff-stats.test.ts
 * @description ISS-5402 — a folded Claude sub-agent's authored lines roll up to
 * the parent session's `diffStats`.
 *
 * The property under test is SYMMETRY, not magnitude: the sidecar merge has
 * always folded a child's tokens into the parent (which is what puts delegated
 * work in `est_cost`), so it must fold that child's lines too. A fixture where
 * every edit happens inside a sub-agent must not yield a finite cost over a zero
 * or absent LOC — that is the shape that understated `LOC / $` by exactly the
 * delegation rate.
 *
 * These assert the ATTRIBUTION (whose lines landed where), not merely that a
 * number is non-zero.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DIFF_STATS_TOOL_HANDLERS,
  DIFF_STATS_TOOL_NAMES,
} from "@repo/lib/harness/claude/diff-stats-tool-handlers";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import { ownDiffFilePaths } from "../src/main/collectors/claude/sidecar-diff-stats.js";
import { writeClaudeTranscript } from "./normalized-session-test-utils.js";
import {
  assistantLine,
  DELEGATING_ONLY_PARENT,
  editBlock,
  MODEL,
  OPENING_USER_LINE,
  OUTPUT_TOKENS_PER_TURN,
  parentTurn,
} from "./sidecar-diff-stats-fixtures.js";

test("ISS-5402: a session whose every edit happened in a sub-agent reports that sub-agent's lines, not zero", async () => {
  // The parent itself edits NOTHING — it only delegates. Before this fix the
  // sidecar's tokens folded into the parent (finite cost) while its lines did
  // not, so `diffStats` was `null`: a real cost over an absent LOC.
  const filePath = writeClaudeTranscript(
    "sess-all-delegated",
    DELEGATING_ONLY_PARENT,
    {
      subagents: {
        lane: [
          assistantLine(
            "sub-u1",
            "req_sub",
            "msg_sub",
            [editBlock("toolu_sub_1", "/repo/src/only-subagent-touched.ts")],
            { isSidechain: true }
          ),
        ],
      },
    }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);

  // The cost denominator provably counts the sidecar...
  assert.equal(parsed.tokenSeries.length, 2);
  assert.equal(parsed.tokensByModel[MODEL]?.output, OUTPUT_TOKENS_PER_TURN * 2);

  // ...so the LOC numerator must too. Attribution: these lines belong to the
  // sub-agent, and the parent is the only timeline they can land on.
  assert.deepEqual(parsed.diffStats, {
    filesChanged: 1,
    linesAdded: 2,
    linesRemoved: 1,
  });
});

test("ISS-5402: LOC/$ symmetry — a fully delegated session never pairs a finite cost with an absent LOC", async () => {
  // The explicit guard the ticket asks for, stated as the invariant rather than
  // as a magnitude: if any sidecar contributed cost, LOC cannot be unresolvable.
  const filePath = writeClaudeTranscript(
    "sess-symmetry",
    DELEGATING_ONLY_PARENT,
    {
      subagents: {
        one: [
          assistantLine(
            "s1",
            "req_s1",
            "msg_s1",
            [editBlock("toolu_a", "/repo/a.ts")],
            { isSidechain: true }
          ),
        ],
        two: [
          assistantLine(
            "s2",
            "req_s2",
            "msg_s2",
            [editBlock("toolu_b", "/repo/b.ts")],
            { isSidechain: true }
          ),
        ],
      },
    }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);

  // The cost basis must provably INCLUDE both sidecars, not merely be non-zero:
  // the parent's own turn already bills MODEL, so only the fold can carry this
  // to three series entries and three turns' worth of output. A `> 0` check here
  // stayed green with the sidecar token fold removed entirely.
  assert.equal(parsed.tokenSeries.length, 3);
  assert.equal(parsed.tokensByModel[MODEL]?.output, OUTPUT_TOKENS_PER_TURN * 3);
  assert.notEqual(
    parsed.diffStats,
    null,
    "a session that contributed cost from sidecars must not report an absent LOC"
  );
  // Two distinct sub-agents, two distinct files, both counted.
  assert.deepEqual(parsed.diffStats, {
    filesChanged: 2,
    linesAdded: 4,
    linesRemoved: 2,
  });
});

test("ISS-5402: a file both the parent and a sub-agent edited counts once", async () => {
  // `filesChanged` is a UNION, not a sum — otherwise the fold would inflate the
  // changed-file count on exactly the sessions delegation is most common in.
  const sharedPath = "/repo/src/shared.ts";
  const filePath = writeClaudeTranscript(
    "sess-shared-file",
    [OPENING_USER_LINE, parentTurn([editBlock("toolu_parent", sharedPath)])],
    {
      subagents: {
        lane: [
          assistantLine(
            "s1",
            "req_s1",
            "msg_s1",
            [editBlock("toolu_sub", sharedPath)],
            { isSidechain: true }
          ),
        ],
      },
    }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);

  // Lines SUM (two real edits happened); files do NOT (one file was touched).
  assert.deepEqual(parsed.diffStats, {
    filesChanged: 1,
    linesAdded: 4,
    linesRemoved: 2,
  });
});

test("ISS-5402: a genuine zero still reads as no diffStats, never a fabricated 0", async () => {
  // The honesty rule (.claude/logical/, ISS-5363 / ISS-5401): an unresolvable or
  // absent LOC must not become a `0`. A session whose sidecar only READ files
  // has no authored lines, so `diffStats` stays null and the surface can keep
  // rendering "unknown" rather than a confident zero.
  const filePath = writeClaudeTranscript(
    "sess-no-edits",
    [OPENING_USER_LINE, parentTurn([{ type: "text", text: "no edits" }])],
    {
      subagents: {
        lane: [
          assistantLine(
            "s1",
            "req_s1",
            "msg_s1",
            [
              {
                type: "tool_use",
                id: "toolu_read",
                name: "Read",
                input: { file_path: "/repo/src/untouched.ts" },
              },
            ],
            { isSidechain: true }
          ),
        ],
      },
    }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  // Positive control: the read-only sidecar WAS folded — its `Read` landed on
  // the subagent and its tokens reached the parent. This is the precise
  // asymmetry this file pins: a real cost with a legitimately absent LOC. An
  // absence-only assertion could not tell that from an empty parse.
  assert.deepEqual(
    parsed.subagents?.map((s) => s.toolUses?.map((t) => t.name)),
    [["Read"]]
  );
  // Combined, not merely present: the parent's own turn already bills MODEL, so
  // only the folded sidecar turn can carry the series to two entries and the
  // output to two turns' worth. A presence-only check stayed green with the
  // sidecar token fold removed.
  assert.equal(parsed.tokenSeries.length, 2);
  assert.equal(parsed.tokensByModel[MODEL]?.output, OUTPUT_TOKENS_PER_TURN * 2);
  assert.equal(parsed.diffStats, null);
});

test("ISS-5402: a sub-agent's overwriting Write diffs against its own prior Read", async () => {
  // The sidecar lane must reproduce the parent lane's overwrite semantics
  // (FEA-1899 AC-5). Without the Read baseline this Write would read as a fresh
  // 1-line file with zero deletions, silently under-reporting churn on exactly
  // the rewrite-a-file shape sub-agents do most.
  const target = "/repo/src/rewritten.ts";
  const filePath = writeClaudeTranscript(
    "sess-subagent-overwrite",
    DELEGATING_ONLY_PARENT,
    {
      subagents: {
        lane: [
          assistantLine(
            "s1",
            "req_s1",
            "msg_s1",
            [
              {
                type: "tool_use",
                id: "toolu_read",
                name: "Read",
                input: { file_path: target },
              },
            ],
            { isSidechain: true }
          ),
          {
            type: "user",
            timestamp: "2026-08-06T10:00:06.000Z",
            isSidechain: true,
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_read",
                  content: [{ type: "text", text: "1\told one\n2\told two" }],
                },
              ],
            },
          },
          assistantLine(
            "s2",
            "req_s2",
            "msg_s2",
            [
              {
                type: "tool_use",
                id: "toolu_write",
                name: "Write",
                input: { file_path: target, content: "new one" },
              },
            ],
            { isSidechain: true }
          ),
        ],
      },
    }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  // Read baseline was 2 lines, the Write leaves 1 => 1 added, 2 removed. A
  // no-baseline reading would have been `{ added: 1, removed: 0 }`.
  assert.deepEqual(parsed.diffStats, {
    filesChanged: 1,
    linesAdded: 1,
    linesRemoved: 2,
  });
});

test("ISS-5402: a sub-agent Write carrying no string content books no line at all", async () => {
  // The shared handlers are total: a non-string `content` is coerced to `""`,
  // and `"".split("\n").length` is ONE — so an unvalidated malformed Write is
  // persisted as a line nobody wrote. The sidecar lane reads raw transcript JSON
  // straight off disk, so it must reject the payload before dispatch. This is
  // the whole record dropping, not a partial count: no line AND no file.
  const filePath = writeClaudeTranscript(
    "sess-malformed-write",
    DELEGATING_ONLY_PARENT,
    {
      subagents: {
        lane: [
          assistantLine(
            "s1",
            "req_s1",
            "msg_s1",
            [
              {
                type: "tool_use",
                id: "toolu_bad_write",
                name: "Write",
                // A truncated/corrupt record: the path survived, the body did not.
                input: { file_path: "/repo/src/corrupt.ts", content: null },
              },
            ],
            { isSidechain: true }
          ),
        ],
      },
    }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  // Positive control: the sidecar WAS folded — its tool use landed on the
  // subagent and its tokens reached the parent. That is what makes the null
  // below mean "the corrupt record booked nothing" rather than "nothing was
  // parsed", which an absence-only assertion cannot distinguish.
  assert.deepEqual(
    parsed.subagents?.map((s) => s.toolUses?.map((t) => t.name)),
    [["Write"]]
  );
  // Combined, not merely present — see the read-only-sidecar test above.
  assert.equal(parsed.tokenSeries.length, 2);
  assert.equal(parsed.tokensByModel[MODEL]?.output, OUTPUT_TOKENS_PER_TURN * 2);
  // Not `{ filesChanged: 1, linesAdded: 1, linesRemoved: 0 }`.
  assert.equal(parsed.diffStats, null);
});

test("ISS-5402: a sub-agent Edit with no edited side claims no changed file", async () => {
  // The mirror fabrication: a corrupt `Edit`/`MultiEdit` yields a `{0, 0}` delta
  // yet still adds its `file_path` to the changed-file set, inflating
  // `filesChanged` with a file the record cannot show was changed. The valid
  // MultiEdit alongside it proves the rejection is per-record, not a blanket
  // bail-out that would have dropped real work with the corrupt payload.
  const filePath = writeClaudeTranscript(
    "sess-malformed-edit",
    DELEGATING_ONLY_PARENT,
    {
      subagents: {
        lane: [
          assistantLine(
            "s1",
            "req_s1",
            "msg_s1",
            [
              {
                type: "tool_use",
                id: "toolu_bad_edit",
                name: "Edit",
                input: { file_path: "/repo/src/no-delta.ts" },
              },
              {
                type: "tool_use",
                id: "toolu_bad_multi",
                name: "MultiEdit",
                input: { file_path: "/repo/src/no-edits.ts", edits: [] },
              },
              {
                type: "tool_use",
                id: "toolu_good_multi",
                name: "MultiEdit",
                input: {
                  file_path: "/repo/src/real.ts",
                  edits: [{ old_string: "alpha", new_string: "beta\ngamma" }],
                },
              },
            ],
            { isSidechain: true }
          ),
        ],
      },
    }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  // Only the well-formed MultiEdit counts: one file, its real 2/1 delta. The two
  // corrupt records contributed neither a file nor a line.
  assert.deepEqual(parsed.diffStats, {
    filesChanged: 1,
    linesAdded: 2,
    linesRemoved: 1,
  });
});

test("ISS-5402: sub-agent lines with no attributable file never persist as 0 files changed", async () => {
  // `parse-claude.ts` gates the parent's whole `diffStats` object on
  // `diffFiles.size > 0`, so the core can never emit lines against zero files.
  // The fold must not weaken that: a `{ filesChanged: 0, linesAdded: N }` record
  // contradicts itself and would render as "0 files changed, +N". A `Write` with
  // real content but an unusable `file_path` is exactly that shape.
  const filePath = writeClaudeTranscript(
    "sess-pathless-lines",
    DELEGATING_ONLY_PARENT,
    {
      subagents: {
        lane: [
          assistantLine(
            "s1",
            "req_s1",
            "msg_s1",
            [
              {
                type: "tool_use",
                id: "toolu_pathless",
                name: "Write",
                input: { file_path: 42, content: "one\ntwo\nthree" },
              },
            ],
            { isSidechain: true }
          ),
        ],
      },
    }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  // Positive control — see the malformed-Write test above for why an
  // absence-only assertion here proves nothing.
  assert.deepEqual(
    parsed.subagents?.map((s) => s.toolUses?.map((t) => t.name)),
    [["Write"]]
  );
  // Combined, not merely present — see the read-only-sidecar test above.
  assert.equal(parsed.tokenSeries.length, 2);
  assert.equal(parsed.tokensByModel[MODEL]?.output, OUTPUT_TOKENS_PER_TURN * 2);
  // Unknown, not a self-contradicting record and not a fabricated zero.
  assert.equal(parsed.diffStats, null);
});

test("ISS-5402: a session with no sidecars is unchanged by the fold", async () => {
  // Revert-proofing the other direction: the fold must be a no-op for the
  // (dominant) non-delegating shape, so the revision-72 rebuild re-derives those
  // sessions byte-identically.
  const filePath = writeClaudeTranscript("sess-no-sidecars", [
    OPENING_USER_LINE,
    parentTurn([editBlock("toolu_parent", "/repo/src/parent-only.ts")]),
  ]);

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  assert.deepEqual(parsed.diffStats, {
    filesChanged: 1,
    linesAdded: 2,
    linesRemoved: 1,
  });
});

// thadeusb review (PR #4531): `ownDiffFilePaths` recovers the parent's own
// changed-file paths so the parent/sidecar union can tell a genuinely new
// sidecar file from one the parent already counted. Its tool-name set used to be
// hand-maintained beside the shared handler registry; a fourth registered
// handler would then have been missing from it, dropping the parent's paths from
// that tool out of the union and double-counting every one of them as a new
// sidecar path. These drive the registry itself, so they cover a tool that does
// not exist yet rather than pinning today's three by name.
test("ISS-5402: the parent-path tool set is derived from the handler registry, never a hand copy", () => {
  assert.deepEqual(
    [...DIFF_STATS_TOOL_NAMES].sort(),
    DIFF_STATS_TOOL_HANDLERS.map(([toolName]) => toolName).sort()
  );
});

test("ISS-5402: ownDiffFilePaths claims the parent's path for EVERY registered diffStats tool", () => {
  // Iterating the registry is the point: a handler added tomorrow is covered
  // here with no edit to this test, which is what makes the drift impossible
  // rather than merely noticed.
  for (const [toolName] of DIFF_STATS_TOOL_HANDLERS) {
    const claimed = ownDiffFilePaths([
      { name: toolName, input: { file_path: `/repo/src/${toolName}.ts` } },
    ]);
    assert.deepEqual(
      [...claimed],
      [`/repo/src/${toolName}.ts`],
      `${toolName} is a registered diffStats handler, so the parent's path from it must join the union`
    );
  }
});

test("ISS-5402: a tool outside the diffStats registry claims no parent path", () => {
  // The set must stay a filter, not a passthrough — otherwise a Read or Bash
  // path would suppress a genuinely new sidecar file from the union.
  assert.equal(
    ownDiffFilePaths([
      { name: "Read", input: { file_path: "/repo/src/read-only.ts" } },
    ]).size,
    0
  );
});

// ISS-5302: the sidecar lane reads RAW transcript JSON off disk, so every block
// shape below is reachable at runtime — nothing has validated the file. The rule
// these pin is the file's own: a block the lane cannot read contributes neither
// a line nor a changed file, and never aborts the pass for the blocks after it.
test("ISS-5402: a sidecar block with no readable tool identity books nothing and does not abort the pass", async () => {
  const filePath = writeClaudeTranscript(
    "sess-unreadable-blocks",
    DELEGATING_ONLY_PARENT,
    {
      subagents: {
        lane: [
          assistantLine(
            "s1",
            "req_s1",
            "msg_s1",
            [
              // A `name` that is not a string cannot be routed to any handler.
              {
                type: "tool_use",
                id: "toolu_nameless",
                name: 7,
                input: { file_path: "/repo/src/nameless.ts", content: "x" },
              },
              // A registered tool carrying NO input at all: the payload gate
              // sees `null`, so no line is booked. Coercing an absent input to
              // `{}` would have made this a one-added-line Write nobody wrote.
              { type: "tool_use", id: "toolu_no_input", name: "Write" },
              // A real edit AFTER both, so the assertion below proves the pass
              // continued rather than stopping at the first unreadable block.
              editBlock("toolu_real", "/repo/src/real.ts"),
            ],
            { isSidechain: true }
          ),
        ],
      },
    }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  assert.deepEqual(
    parsed.diffStats,
    { filesChanged: 1, linesAdded: 2, linesRemoved: 1 },
    "only the readable edit is attributed — neither malformed block adds a file or a line"
  );
});

test("ISS-5402: a Read whose result body cannot be recovered leaves no baseline, so the Write reads as a fresh file", async () => {
  // `toolResultText` returns null for a result the lane cannot flatten to text.
  // The documented consequence is the FRESH-FILE reading (adds only) rather than
  // a fabricated baseline — fabricating one would invent deletions against text
  // the sub-agent never actually read.
  const lane = (target: string, resultContent: unknown) => [
    assistantLine(
      "r1",
      "req_r1",
      "msg_r1",
      [
        {
          type: "tool_use",
          id: `toolu_read_${target}`,
          name: "Read",
          input: { file_path: target },
        },
      ],
      { isSidechain: true }
    ),
    {
      type: "user",
      timestamp: "2026-08-06T10:00:06.000Z",
      isSidechain: true,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: `toolu_read_${target}`,
            content: resultContent,
          },
        ],
      },
    },
    assistantLine(
      "r2",
      "req_r2",
      "msg_r2",
      [
        {
          type: "tool_use",
          id: `toolu_write_${target}`,
          name: "Write",
          input: { file_path: target, content: "new one" },
        },
      ],
      { isSidechain: true }
    ),
  ];

  const filePath = writeClaudeTranscript(
    "sess-unreadable-read-result",
    DELEGATING_ONLY_PARENT,
    {
      subagents: {
        // A result whose content is neither a string nor an array.
        scalar: lane("/repo/src/scalar-result.ts", 42),
        // An array carrying no text parts at all (an image-only result).
        imageonly: lane("/repo/src/image-result.ts", [
          { type: "image", source: { type: "base64", data: "AA==" } },
        ]),
      },
    }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  // The comparison that matters is against the baseline case above, which reads
  // a 2-line file and books `{ linesAdded: 1, linesRemoved: 2 }`. Zero removals
  // here is what proves NEITHER lane cached a baseline.
  assert.deepEqual(parsed.diffStats, {
    filesChanged: 2,
    linesAdded: 2,
    linesRemoved: 0,
  });
});
