import { OperationReceiptOutcome } from "@repo/api/src/types/attribution-evidence";
import { ToolResultState } from "@repo/api/src/types/operation-claims";
import { describe, expect, it } from "vitest";
import { parseCodexRollout } from "./parse-codex";

const OPERATION_ID = "clop_01a14224-9b59-77ba-b518-16aaa9880991";
const RECEIPT = {
  operationId: OPERATION_ID,
  outcome: OperationReceiptOutcome.Committed,
};
const SESSION_META = JSON.stringify({
  type: "session_meta",
  timestamp: "2026-10-16T10:00:00.000Z",
  payload: { cwd: "/workspace/proj", cli_version: "0.162.1" },
});

function mcpToolCallLine(
  id: string,
  tool: string,
  result: unknown,
  status = "completed"
): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp: "2026-10-16T10:00:02.000Z",
    payload: {
      type: "item_completed",
      item: {
        type: "McpToolCall",
        id,
        server: "closedloop",
        tool,
        arguments: { documentId: "PLN-2191" },
        status,
        result,
      },
      started_at_ms: Date.parse("2026-10-16T10:00:01.000Z"),
      completed_at_ms: Date.parse("2026-10-16T10:00:02.000Z"),
    },
  });
}

function textResult(body: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(body) }] };
}

async function parse(lines: string[]) {
  const session = await parseCodexRollout(lines, { sessionId: "codex-mcp" });
  if (!session) {
    throw new Error("rollout did not parse");
  }
  return session;
}

describe("Codex code-mode McpToolCall items", () => {
  it("records each call as evidence outside the tool stream, with its call id and receipt", async () => {
    const session = await parse([
      SESSION_META,
      mcpToolCallLine(
        "exec-a9769d74",
        "create-document-version",
        textResult({
          id: "d1",
          slug: "PLN-2191",
          latestVersion: 5,
          operationReceipt: RECEIPT,
        })
      ),
    ]);

    expect(session.toolUses).toEqual([]);
    expect(session.mcpCallEvidence).toEqual([
      expect.objectContaining({
        name: "closedloop__create-document-version",
        mcpServer: "closedloop",
        mcpMethod: "create-document-version",
        providerToolUseId: "exec-a9769d74",
        input: { documentId: "PLN-2191" },
        isError: false,
        resultState: ToolResultState.Present,
        timestamp: "2026-10-16T10:00:01.000Z",
        resultTimestamp: "2026-10-16T10:00:02.000Z",
        closedloopResultFacts: {
          isError: false,
          operationReceipt: RECEIPT,
          primaryEntity: { id: "d1", slug: "PLN-2191", version: 5 },
          nestedSlugs: [],
        },
      }),
    ]);
  });

  it("flags a failed call and records a replayed item once", async () => {
    const failed = mcpToolCallLine(
      "exec-2",
      "update-document",
      { content: [{ type: "text", text: "Forbidden" }], isError: true },
      "failed"
    );
    const session = await parse([SESSION_META, failed, failed]);

    expect(session.mcpCallEvidence).toHaveLength(1);
    expect(session.mcpCallEvidence?.[0]).toMatchObject({
      isError: true,
      resultState: ToolResultState.Error,
    });
  });

  it("adds a namespaced function call's id and facts to the tool stream, never a second record", async () => {
    const callId = "call_xqRHSlQFit4K1fx9O6UexE0i";
    const session = await parse([
      SESSION_META,
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-10-16T10:00:01.000Z",
        payload: {
          type: "function_call",
          name: "get_document",
          namespace: "mcp__closedloop",
          arguments: JSON.stringify({ documentId: "PLN-2191" }),
          call_id: callId,
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-10-16T10:00:02.000Z",
        payload: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ id: "d1", slug: "PLN-2191" }),
        },
      }),
      mcpToolCallLine(
        callId,
        "get-document",
        textResult({ id: "d1", slug: "PLN-2191" })
      ),
    ]);

    expect(session.mcpCallEvidence).toBeUndefined();
    expect(session.toolUses).toEqual([
      expect.objectContaining({
        name: "get_document",
        mcpNamespace: "mcp__closedloop",
        providerToolUseId: callId,
        resultState: ToolResultState.Present,
        closedloopResultFacts: expect.objectContaining({
          primaryEntity: { id: "d1", slug: "PLN-2191" },
        }),
      }),
    ]);
    expect(session.toolUses[0]?.mcpServer).toBeUndefined();
  });
});
