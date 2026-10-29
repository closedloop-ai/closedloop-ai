/**
 * @file claude-agent-tool-input-bound.test.ts
 * @description ISS-6480 — a delegated agent's tool input is kept WHOLE, however
 * large. This file used to pin the opposite, on purpose.
 *
 * BEHAVIOR CHANGE, not a weakened assertion. Until ISS-6480 the assertion below
 * read `assert.equal(over.input, undefined)` and this header carried a
 * KNOWN-WRONG banner, because the scanner stored every input through
 * `stringifyBounded` (1000 JSON chars) and the readers re-parsed it: past the
 * slice landed mid-token, `JSON.parse` threw, and the input was discarded
 * entirely. The bound never yielded a 1000-character preview — it yielded
 * nothing, so the 1 KB it kept bought no information at all.
 *
 * That old assertion named the exact condition for changing it — "if this now
 * holds a value, the bound was removed, which needs a golden oracle amendment
 * first" — and that is what happened: the amendment restored `input` on 84 tool
 * calls across 6 dossiers, authorized by the maintainer under
 * `packages/golden-sessions/AGENTS.md`, and `DATA_REVISION` 83 re-derives
 * already-imported sessions.
 *
 * The paired control is the load-bearing half and is unchanged in spirit: the
 * same tool and the same code path with an input that FITS proves the surviving
 * value is not an artifact of `Write` inputs being handled specially.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import { MAX_STRINGIFIED_CHARS } from "../src/main/collectors/parsing/subagent-tool-serialization.js";
import { writeClaudeTranscript } from "./normalized-session-test-utils.js";
import {
  assistantLine,
  DELEGATING_ONLY_PARENT,
} from "./sidecar-diff-stats-fixtures.js";

/** A `Write` block whose serialized input comfortably exceeds the old bound. */
function oversizedWriteBlock(id: string) {
  return {
    type: "tool_use",
    id,
    name: "Write",
    input: {
      file_path: "/repo/src/generated.ts",
      content: `// ${"x".repeat(MAX_STRINGIFIED_CHARS * 3)}`,
    },
  };
}

/** The same tool with an input that fits well inside the old bound. */
function smallWriteBlock(id: string) {
  return {
    type: "tool_use",
    id,
    name: "Write",
    input: { file_path: "/repo/src/small.ts", content: "ok" },
  };
}

test("ISS-6480: an agent tool input over the old bound survives whole", async () => {
  const sessionId = "sess-input-bound";
  const filePath = writeClaudeTranscript(sessionId, DELEGATING_ONLY_PARENT, {
    subagents: {
      lane: [
        assistantLine("sub-u1", "req_sub", "msg_sub", [
          oversizedWriteBlock("toolu_over_bound"),
          smallWriteBlock("toolu_under_bound"),
        ]),
      ],
    },
  });

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  const agent = (parsed.subagents ?? []).find((s) => s.id === "agent-lane");
  assert.ok(agent, "the agent file must produce a sub-agent row");

  const over = (agent.toolUses ?? []).find((t) => t.id === "toolu_over_bound");
  const under = (agent.toolUses ?? []).find(
    (t) => t.id === "toolu_under_bound"
  );

  assert.ok(over, "the over-bound tool use must still be recorded");
  assert.ok(under, "the under-bound tool use must still be recorded");

  // The fix. Deep-equal against the ORIGINAL block input, so a truncated prefix
  // or a re-serialized approximation fails here just as `undefined` would —
  // "whole" is the claim, not merely "non-empty".
  assert.deepEqual(
    over.input,
    oversizedWriteBlock("toolu_over_bound").input,
    "an input over the old bound must now be kept verbatim, not dropped"
  );
  assert.ok(
    JSON.stringify(over.input).length > MAX_STRINGIFIED_CHARS,
    "the fixture must still exceed the bound, or this test proves nothing"
  );

  // The paired control: same tool, same path, an input that always fit.
  assert.deepEqual(
    under.input,
    { file_path: "/repo/src/small.ts", content: "ok" },
    "an input inside the bound must survive intact"
  );
});
