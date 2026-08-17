/**
 * @file claude-agent-flat-tool-shape.test.ts
 * @description Both readers of an `agent-*.jsonl` file must accept the same tool
 * shapes.
 *
 * Two of them read these files. The live-hook lane reaches them through
 * `extractToolUses` (`collectors/parsing/subagent-scanner.ts`), which tries
 * `extractFlatToolUse` FIRST and so accepts a tool written at the TOP level of a
 * record — `{"type":"tool_use","name":…}` — as well as one nested in
 * `message.content`. The boot-import and `DATA_REVISION` rebuild lane reaches
 * them through this parser.
 *
 * The rewrite ported only the nested shape. That does not lose the tool at
 * capture time — live ingestion still records it — it makes the two lanes
 * disagree about the same bytes, so a rebuild silently strips tools from
 * sessions that were imported correctly. `main` accepted both shapes here, via
 * `extractToolUses`; this pins that it still does.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import { extractToolUses } from "../src/main/collectors/parsing/subagent-scanner.js";
import { writeClaudeTranscript } from "./normalized-session-test-utils.js";
import { DELEGATING_ONLY_PARENT } from "./sidecar-diff-stats-fixtures.js";

const FLAT_TOOL_USE = {
  type: "tool_use",
  timestamp: "2026-07-09T12:00:03.000Z",
  id: "toolu_flat_read",
  name: "Read",
  input: { file_path: "/repo/src/flat.ts" },
};

const FLAT_TOOL_RESULT = {
  type: "tool_result",
  timestamp: "2026-07-09T12:00:04.000Z",
  id: "toolu_flat_bash",
  name: "Bash",
  input: { command: "ls" },
  result: "a\nb",
};

test("a top-level tool_use in an agent file survives the import lane", async () => {
  const sessionId = "sess-flat-tool-use";
  const filePath = writeClaudeTranscript(sessionId, DELEGATING_ONLY_PARENT, {
    subagents: { lane: [FLAT_TOOL_USE] },
  });

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);

  const subagent = (parsed.subagents ?? []).find((s) => s.id === "agent-lane");
  assert.ok(subagent, "the agent file must still produce a sub-agent row");
  assert.deepEqual(
    (subagent.toolUses ?? []).map((toolUse) => toolUse.name),
    ["Read"],
    "a top-level tool_use must be read, as the live-hook lane reads it"
  );
});

test("a top-level tool_result in an agent file survives the import lane WITH its output", async () => {
  const sessionId = "sess-flat-tool-result";
  const filePath = writeClaudeTranscript(sessionId, DELEGATING_ONLY_PARENT, {
    subagents: { lane: [FLAT_TOOL_RESULT] },
  });

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);

  const subagent = (parsed.subagents ?? []).find((s) => s.id === "agent-lane");
  const toolUse = (subagent?.toolUses ?? [])[0];
  assert.equal(toolUse?.name, "Bash");
  // `result` is the whole reason this shape matters: it is the only position an
  // agent-file tool carries its output, and it lands in `events.data.tool_response`
  // as the Session Trace's per-call detail. Asserting the NAME alone let a version
  // of this reader ship that restored the tool row and silently dropped what the
  // tool returned.
  assert.equal(toolUse?.output, "a\nb");
});

test("the two readers of an agent file agree on which tools it holds", async () => {
  // The property that actually matters, asserted directly rather than inferred:
  // whatever the live-hook reader finds in a record, the import lane finds too.
  // Written as a comparison so a future change to either side has to move both.
  // Run over the tool_RESULT fixture: it is the only shape carrying a field the
  // two readers can disagree about. Comparing NAMES was the flaw in the first
  // version of this test — it stayed green while the import lane dropped the
  // record's `result` entirely, which is the exact divergence the file exists to
  // prevent. Compare the fields, not the labels.
  const sessionId = "sess-flat-parity";
  const filePath = writeClaudeTranscript(sessionId, DELEGATING_ONLY_PARENT, {
    subagents: { lane: [FLAT_TOOL_RESULT] },
  });

  const liveHook = extractToolUses(FLAT_TOOL_RESULT, sessionId, "agent-lane");
  const parsed = await parseClaudeFile(filePath);
  const imported =
    (parsed?.subagents ?? []).find((s) => s.id === "agent-lane")?.toolUses ??
    [];

  assert.equal(liveHook.length, 1, "control: the live-hook reader sees it");
  assert.equal(imported.length, liveHook.length, "both lanes see one tool");

  assert.equal(imported[0]?.name, liveHook[0]?.toolName, "name");
  assert.equal(imported[0]?.id, liveHook[0]?.toolUseId, "tool use id");
  // The live-hook lane stores both sides as bounded STRINGS; the import lane
  // round-trips them back through `parseJsonValue`. Compare on the live-hook
  // side's own representation so the assertion tracks content rather than shape.
  assert.deepEqual(
    imported[0]?.input,
    JSON.parse(liveHook[0]?.input as string),
    "input"
  );
  assert.deepEqual(
    imported[0]?.output,
    JSON.parse(liveHook[0]?.output as string),
    "output"
  );
});

test("a nested tool_use in an agent file still works", async () => {
  // The control for the flat-first branch: adding a shape must not shadow the
  // one that already worked.
  const sessionId = "sess-nested-still-works";
  const nested = {
    type: "assistant",
    timestamp: "2026-07-09T12:00:05.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-4",
      content: [
        {
          type: "tool_use",
          id: "toolu_nested",
          name: "Write",
          input: { file_path: "/repo/src/nested.ts" },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
  const filePath = writeClaudeTranscript(sessionId, DELEGATING_ONLY_PARENT, {
    subagents: { lane: [nested] },
  });

  const parsed = await parseClaudeFile(filePath);
  const subagent = (parsed?.subagents ?? []).find((s) => s.id === "agent-lane");
  assert.deepEqual(
    (subagent?.toolUses ?? []).map((toolUse) => toolUse.name),
    ["Write"]
  );
});
