/**
 * @file claude-agent-tool-input-bound.test.ts
 * @description ISS-6480 — a delegated agent's tool input larger than
 * `MAX_STRINGIFIED_CHARS` is DROPPED ENTIRELY, not truncated.
 *
 * ⚠️ THIS PINS KNOWN-WRONG BEHAVIOUR ON PURPOSE. Do not "fix" the production
 * code to make a golden test pass without amending the oracle under
 * `packages/golden-sessions/AGENTS.md` — see ISS-6480 for the argument and the
 * open question that gates it.
 *
 * The mechanism: `agentToolUses` round-trips each input through
 * `stringifyBounded` (1000 JSON chars) and then `parseJsonValue`. For an input
 * whose serialization exceeds the bound, the slice lands MID-TOKEN, `JSON.parse`
 * throws, and `parseJsonValue` returns `undefined`. So the bound does not yield a
 * 1000-character preview — it yields nothing. Measured across the golden corpus:
 * 84 of 1,886 agent tool calls, every one of them over the bound and every one
 * under it intact.
 *
 * Why this file exists: before it, the ONLY thing that noticed a change here was
 * a golden Layer-1 deep-equal, whose failure message names no ticket and reads as
 * an oracle that needs re-blessing. That is precisely the shape that gets
 * answered with an oracle amendment instead of a conversation. A named red is
 * cheaper than a silent re-bless.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import { MAX_STRINGIFIED_CHARS } from "../src/main/collectors/parsing/subagent-scanner.js";
import { writeClaudeTranscript } from "./normalized-session-test-utils.js";
import {
  assistantLine,
  DELEGATING_ONLY_PARENT,
} from "./sidecar-diff-stats-fixtures.js";

/** A `Write` block whose serialized input comfortably exceeds the bound. */
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

/** The same tool with an input that fits well inside the bound. */
function smallWriteBlock(id: string) {
  return {
    type: "tool_use",
    id,
    name: "Write",
    input: { file_path: "/repo/src/small.ts", content: "ok" },
  };
}

test("ISS-6480: an agent tool input over the bound is dropped whole, and one under it survives", async () => {
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

  // Both calls are RECORDED — the bound costs the input, not the tool use. If
  // this half fails, the change is worse than ISS-6480 describes.
  assert.ok(over, "the over-bound tool use must still be recorded");
  assert.ok(under, "the under-bound tool use must still be recorded");

  // The defect itself. `undefined`, not a truncated prefix, not a partial object.
  assert.equal(
    over.input,
    undefined,
    "KNOWN-WRONG (ISS-6480): an over-bound input is discarded entirely rather than truncated — if this now holds a value, the bound was removed, which needs a golden oracle amendment first"
  );

  // The paired control that makes the assertion above meaningful: the same tool,
  // the same code path, an input that fits — proving the drop is caused by the
  // bound and not by `Write` inputs being dropped generally.
  assert.deepEqual(
    under.input,
    { file_path: "/repo/src/small.ts", content: "ok" },
    "an input inside the bound must survive intact"
  );
});
