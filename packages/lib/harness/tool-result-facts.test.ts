import { OperationReceiptOutcome } from "@repo/api/src/types/attribution-evidence";
import { ToolResultState } from "@repo/api/src/types/operation-claims";
import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "./claude/parse-claude";
import { parseCursorTranscript } from "./cursor/parse-cursor";
import {
  MAX_NESTED_RESULT_SLUGS,
  MAX_SHELL_OPERATION_IDS,
  readClosedloopResultFacts,
  readShellOperationIds,
  readToolResultState,
  resolveClosedloopToolName,
} from "./tool-result-facts";

const TS = "2026-10-16T12:00:00.000Z";
const OPERATION_ID = "clop_01a14224-9b59-77ba-b518-16aaa9880991";
const RECEIPT = {
  operationId: OPERATION_ID,
  outcome: OperationReceiptOutcome.Committed,
};
const DOCUMENT_ID = "01a14224-0000-7000-8000-000000000001";

/** A get-document body well past the parser's 4 KB cap. */
function largeDocumentBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: DOCUMENT_ID,
    slug: "PLN-2191",
    latestVersion: 4,
    content: `Built from PRD-800 for ISS-12552. ${"x".repeat(20_000)}`,
    ...extra,
  });
}

describe("resolveClosedloopToolName", () => {
  it("reads every harness spelling of a ClosedLoop tool", () => {
    expect(
      resolveClosedloopToolName({ name: "mcp__closedloop__create-document" })
    ).toBe("create-document");
    expect(
      resolveClosedloopToolName({
        name: "closedloop__get-document",
        mcpServer: "closedloop",
        mcpMethod: "get-document",
      })
    ).toBe("get-document");
    expect(
      resolveClosedloopToolName({
        name: "get_document",
        mcpNamespace: "mcp__closedloop",
      })
    ).toBe("get-document");
    expect(
      resolveClosedloopToolName({
        name: "mcp__closedloop__create_branch_artifact",
      })
    ).toBe("create_branch_artifact");
  });

  it("is null for another server or a tool the table does not know", () => {
    expect(
      resolveClosedloopToolName({ name: "mcp__closedloop-graph__search" })
    ).toBeNull();
    expect(
      resolveClosedloopToolName({ name: "mcp__closedloop__add-loop-event" })
    ).toBeNull();
    expect(resolveClosedloopToolName({ name: "Bash" })).toBeNull();
  });
});

describe("readToolResultState", () => {
  it("separates a harness-elided result from a present or errored one", () => {
    expect(
      readToolResultState("<persisted-output>\nOutput too large", false)
    ).toBe(ToolResultState.SourceTruncated);
    expect(
      readToolResultState("head …1200 tokens truncated… tail", false)
    ).toBe(ToolResultState.SourceTruncated);
    expect(readToolResultState("ok", true)).toBe(ToolResultState.Error);
    expect(readToolResultState("ok", false)).toBe(ToolResultState.Present);
  });
});

describe("readClosedloopResultFacts", () => {
  it("reads the root entity and receipt of a body past the cap, and keeps nested slugs apart", () => {
    const facts = readClosedloopResultFacts(
      largeDocumentBody({ operationReceipt: RECEIPT }),
      false
    );

    expect(facts).toEqual({
      isError: false,
      operationReceipt: RECEIPT,
      primaryEntity: { id: DOCUMENT_ID, slug: "PLN-2191", version: 4 },
      nestedSlugs: ["PRD-800", "ISS-12552"],
    });
  });

  it("takes no receipt or entity from a body that is not a JSON object", () => {
    expect(
      readClosedloopResultFacts(`Updated PLN-7 ${OPERATION_ID}`, true)
    ).toEqual({ isError: true, nestedSlugs: ["PLN-7"] });
  });

  it("ignores a receipt whose operation id is malformed", () => {
    const facts = readClosedloopResultFacts(
      JSON.stringify({
        id: DOCUMENT_ID,
        operationReceipt: { operationId: "clop_nope", outcome: "committed" },
      }),
      false
    );

    expect(facts.operationReceipt).toBeUndefined();
  });

  it("caps nested slugs", () => {
    const slugs = Array.from(
      { length: MAX_NESTED_RESULT_SLUGS + 5 },
      (_, i) => `ISS-${i + 1}`
    );

    expect(
      readClosedloopResultFacts(slugs.join(" "), false).nestedSlugs
    ).toHaveLength(MAX_NESTED_RESULT_SLUGS);
  });
});

describe("readShellOperationIds", () => {
  it("collects each well-formed id once, in order, up to the cap", () => {
    const second = "clop_01a14224-9b59-77ba-b518-16aaa9880992";
    expect(
      readShellOperationIds(
        `{"operationReceipt":{"operationId":"${OPERATION_ID}"}}\n${second} ${OPERATION_ID} clop_short`
      )
    ).toEqual([OPERATION_ID, second]);

    const many = Array.from(
      { length: MAX_SHELL_OPERATION_IDS + 3 },
      (_, i) => `clop_01a14224-9b59-77ba-b518-${String(i).padStart(12, "0")}`
    ).join("\n");
    expect(readShellOperationIds(many)).toHaveLength(MAX_SHELL_OPERATION_IDS);
  });
});

describe("Claude parser result facts", () => {
  async function parseWithResult(name: string, content: string) {
    const lines = [
      {
        type: "assistant",
        timestamp: TS,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name, input: {} }],
        },
      },
      {
        type: "user",
        timestamp: TS,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content }],
        },
      },
    ].map((record) => JSON.stringify(record));
    const session = await parseClaudeTranscript(lines, {
      sessionId: "result-facts",
    });
    return session?.toolUses[0];
  }

  it("keeps a large write's receipt that the capped output loses", async () => {
    const tool = await parseWithResult(
      "mcp__closedloop__create-document-version",
      largeDocumentBody({ operationReceipt: RECEIPT })
    );

    expect(String(tool?.output)).not.toContain(OPERATION_ID);
    expect(tool?.resultState).toBe(ToolResultState.Present);
    expect(tool?.closedloopResultFacts?.operationReceipt).toEqual(RECEIPT);
    expect(tool?.closedloopResultFacts?.primaryEntity?.slug).toBe("PLN-2191");
    expect(tool?.shellOperationIds).toBeUndefined();
  });

  it("keeps the operation ids a script printed past the cap", async () => {
    const tool = await parseWithResult(
      "Bash",
      `${"log line\n".repeat(2000)}{"operationReceipt":{"operationId":"${OPERATION_ID}"}}`
    );

    expect(String(tool?.output)).not.toContain(OPERATION_ID);
    expect(tool?.shellOperationIds).toEqual([OPERATION_ID]);
    expect(tool?.closedloopResultFacts).toBeUndefined();
  });
});

describe("Cursor parser result facts", () => {
  it("keeps the operation ids a tool printed past the cap", async () => {
    const session = await parseCursorTranscript(
      [
        JSON.stringify({
          type: "tool_call",
          timestamp: TS,
          payload: { name: "Shell" },
        }),
        JSON.stringify({
          type: "tool_result",
          timestamp: TS,
          payload: { output: `${"x".repeat(20_000)} ${OPERATION_ID}` },
        }),
      ],
      { sessionId: "cursor-result-facts" }
    );
    const tool = session?.toolUses[0];

    expect(String(tool?.output)).not.toContain(OPERATION_ID);
    expect(tool?.shellOperationIds).toEqual([OPERATION_ID]);
  });
});
