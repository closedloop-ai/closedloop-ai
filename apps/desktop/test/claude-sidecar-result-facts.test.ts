/**
 * ISS-12552: a Claude subagent's sidecar results are bounded
 * to 1,000 characters, so a write's receipt and a script's printed operation
 * ids are read from the FULL result before that bound, the same way the main
 * transcript lane reads them before its 4 KB cap.
 */
import "./support/attribution-parse-policy.js";
import assert from "node:assert/strict";
import { OperationReceiptOutcome } from "@repo/api/src/types/attribution-evidence";
import { ToolResultState } from "@repo/api/src/types/operation-claims";
import { test } from "vitest";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import { PARSE_POLICY_BASE } from "../src/main/parse-policy/parse-policy.js";
import { writeClaudeTranscript } from "./normalized-session-test-utils.js";
import {
  assistantLine,
  DELEGATING_ONLY_PARENT,
} from "./sidecar-diff-stats-fixtures.js";

const OPERATION_ID = "clop_01a14224-9b59-77ba-b518-16aaa9880991";
const RECEIPT = {
  operationId: OPERATION_ID,
  outcome: OperationReceiptOutcome.Committed,
};

function toolResultLine(toolUseId: string, content: string) {
  return {
    type: "user",
    timestamp: "2026-08-06T10:00:06.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
  };
}

test("a sidecar subagent's large results keep their receipt and printed ids", async () => {
  const sessionId = "sess-sidecar-result-facts";
  const writeBody = JSON.stringify({
    id: "01a14224-0000-7000-8000-000000000001",
    slug: "PLN-2191",
    latestVersion: 5,
    content: "x".repeat(5000),
    operationReceipt: RECEIPT,
  });
  const filePath = writeClaudeTranscript(sessionId, DELEGATING_ONLY_PARENT, {
    subagents: {
      lane: [
        assistantLine("sub-u1", "req_sub", "msg_sub", [
          {
            type: "tool_use",
            id: "toolu_write",
            name: "mcp__closedloop__create-document-version",
            input: { documentId: "PLN-2191", content: "..." },
          },
          {
            type: "tool_use",
            id: "toolu_shell",
            name: "Bash",
            input: { command: "node file-bug.mjs" },
          },
        ]),
        toolResultLine("toolu_write", writeBody),
        toolResultLine(
          "toolu_shell",
          `${"progress\n".repeat(300)}{"operationReceipt":{"operationId":"${OPERATION_ID}"}}`
        ),
      ],
    },
  });

  const parsed = await parseClaudeFile(filePath);

  const subagent = (parsed?.subagents ?? []).find((s) => s.id === "agent-lane");
  assert.ok(subagent, "the sidecar must produce a sub-agent row");
  const [write, shell] = subagent.toolUses ?? [];
  assert.ok(!String(write?.output).includes(OPERATION_ID));
  assert.equal(write?.resultState, ToolResultState.Present);
  assert.deepEqual(write?.closedloopResultFacts?.operationReceipt, RECEIPT);
  assert.deepEqual(write?.closedloopResultFacts?.primaryEntity, {
    id: "01a14224-0000-7000-8000-000000000001",
    slug: "PLN-2191",
    version: 5,
  });
  assert.equal(write?.shellOperationIds, undefined);
  assert.ok(!String(shell?.output).includes(OPERATION_ID));
  assert.deepEqual(shell?.shellOperationIds, [OPERATION_ID]);
  assert.equal(shell?.closedloopResultFacts, undefined);
});

test("a sidecar subagent's results carry no facts with the attribution policy off", async () => {
  const filePath = writeClaudeTranscript(
    "sess-sidecar-result-facts-off",
    DELEGATING_ONLY_PARENT,
    {
      subagents: {
        lane: [
          assistantLine("sub-u1", "req_sub", "msg_sub", [
            {
              type: "tool_use",
              id: "toolu_shell",
              name: "Bash",
              input: { command: "node file-bug.mjs" },
            },
          ]),
          toolResultLine("toolu_shell", `printed ${OPERATION_ID}`),
        ],
      },
    }
  );

  const parsed = await parseClaudeFile(
    filePath,
    undefined,
    undefined,
    PARSE_POLICY_BASE
  );

  const subagent = (parsed?.subagents ?? []).find((s) => s.id === "agent-lane");
  const [shell] = subagent?.toolUses ?? [];
  assert.ok(shell, "the sidecar call must still be parsed");
  assert.equal(shell.resultState, undefined);
  assert.equal(shell.shellOperationIds, undefined);
});
