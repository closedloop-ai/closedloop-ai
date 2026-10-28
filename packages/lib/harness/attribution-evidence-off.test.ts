import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "./claude/parse-claude";
import { parseCodexRollout } from "./codex/parse-codex";
import { parseCursorTranscript } from "./cursor/parse-cursor";
import type { NormalizedSession, NormalizedToolUse } from "./types";

// ISS-12552 (PRD-800 "Rollout"): with `attributionEvidence: false` each
// parser reads a transcript as it did before PRD-800, which is how Desktop
// parses with the attribution-evidence-policy flag off. Every case pairs the
// off parse with the default (on) parse of the same lines, so a case cannot
// pass because the fixture never exercised the evidence.

const OPERATION_ID = "clop_01a14224-9b59-77ba-b518-16aaa9880991";
const TS = "2026-10-20T10:00:00.000Z";

const CODEX_META = JSON.stringify({
  type: "session_meta",
  timestamp: TS,
  payload: { cwd: "/workspace/proj", cli_version: "0.163.0" },
});

function codexLine(
  type: string,
  payload: Record<string, unknown>,
  second: number
): string {
  return JSON.stringify({
    type,
    timestamp: `2026-10-20T10:00:${String(second).padStart(2, "0")}.000Z`,
    payload,
  });
}

const CODEX_USER_TEXT = "Create a PRD for the login page.";
const CODEX_ENVIRONMENT =
  "<environment_context>\n  <cwd>/workspace/proj</cwd>\n</environment_context>";

const CODEX_LINES = [
  CODEX_META,
  codexLine(
    "response_item",
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: CODEX_ENVIRONMENT }],
    },
    1
  ),
  codexLine(
    "response_item",
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: CODEX_USER_TEXT }],
    },
    1
  ),
  codexLine(
    "event_msg",
    {
      type: "item_completed",
      item: {
        type: "UserMessage",
        id: "user-1",
        content: [{ type: "text", text: CODEX_USER_TEXT }],
      },
    },
    1
  ),
  codexLine(
    "response_item",
    {
      type: "function_call",
      call_id: "call-ns",
      name: "create-document",
      namespace: "mcp__closedloop",
      arguments: "{}",
    },
    2
  ),
  codexLine("token_usage_record", { response_id: "resp_1" }, 3),
  codexLine(
    "response_item",
    {
      type: "function_call_output",
      call_id: "call-ns",
      output: `created ${OPERATION_ID}`,
    },
    4
  ),
  codexLine(
    "event_msg",
    {
      type: "item_completed",
      item: {
        type: "McpToolCall",
        id: "exec-1",
        server: "closedloop",
        tool: "get-document",
        arguments: { documentId: "PLN-2191" },
        status: "completed",
        result: { content: [{ type: "text", text: "{}" }] },
      },
    },
    5
  ),
  codexLine(
    "event_msg",
    {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 0,
          output_tokens: 10,
          reasoning_output_tokens: 0,
          total_tokens: 110,
        },
      },
    },
    6
  ),
];

const CLAUDE_LINES = [
  {
    type: "user",
    uuid: "11111111-1111-4111-8111-111111111111",
    timestamp: TS,
    message: { role: "user", content: "write the plan" },
  },
  {
    type: "assistant",
    uuid: "33333333-3333-4333-8333-333333333333",
    timestamp: TS,
    requestId: "req_1",
    message: {
      id: "msg_1",
      role: "assistant",
      model: "claude-opus-4",
      content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  },
  {
    type: "user",
    timestamp: TS,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: `printed ${OPERATION_ID}`,
        },
      ],
    },
  },
].map((record) => JSON.stringify(record));

const CURSOR_LINES = [
  JSON.stringify({
    type: "tool_call",
    timestamp: TS,
    payload: { name: "Shell" },
  }),
  JSON.stringify({
    type: "tool_result",
    timestamp: TS,
    payload: { output: `printed ${OPERATION_ID}` },
  }),
];

async function codex(
  attributionEvidence?: boolean
): Promise<NormalizedSession> {
  const session = await parseCodexRollout(CODEX_LINES, {
    sessionId: "codex-off",
    ...(attributionEvidence === undefined ? {} : { attributionEvidence }),
  });
  if (!session) {
    throw new Error("rollout did not parse");
  }
  return session;
}

function evidenceOf(toolUse: NormalizedToolUse | undefined) {
  return {
    requestKey: toolUse?.requestKey,
    resultState: toolUse?.resultState,
    shellOperationIds: toolUse?.shellOperationIds,
    mcpNamespace: toolUse?.mcpNamespace,
  };
}

const NO_EVIDENCE = {
  requestKey: undefined,
  resultState: undefined,
  shellOperationIds: undefined,
  mcpNamespace: undefined,
};

describe("Codex with attribution evidence off", () => {
  it("binds no request and names no usage source", async () => {
    const on = await codex();
    const off = await codex(false);

    expect(on.toolUses[0]?.requestKey).toBeDefined();
    expect(on.tokenSeries[0]?.sourceIdentity).toBeDefined();
    expect(off.toolUses[0]?.requestKey).toBeUndefined();
    expect(off.tokenSeries[0]?.sourceIdentity).toBeUndefined();
  });

  it("reads no result facts and keeps no MCP namespace", async () => {
    expect(evidenceOf((await codex()).toolUses[0])).not.toEqual(NO_EVIDENCE);
    expect(evidenceOf((await codex(false)).toolUses[0])).toEqual(NO_EVIDENCE);
    expect((await codex(false)).toolUses[0]?.providerToolUseId).toBeUndefined();
  });

  it("records no code-mode McpToolCall evidence", async () => {
    expect((await codex()).mcpCallEvidence).toHaveLength(1);
    expect((await codex(false)).mcpCallEvidence).toBeUndefined();
  });

  it("counts human turns without the 0.163 UserMessage items", async () => {
    expect((await codex()).userMessages).toBe(1);
    expect((await codex(false)).userMessages).toBe(2);
  });
});

describe("Claude with attribution evidence off", () => {
  it("names no request and reads no result facts", async () => {
    const parse = (attributionEvidence?: boolean) =>
      parseClaudeTranscript(CLAUDE_LINES, {
        sessionId: "claude-off",
        ...(attributionEvidence === undefined ? {} : { attributionEvidence }),
      });

    const on = (await parse())?.toolUses[0];
    expect(on?.requestKey).toBeDefined();
    expect(on?.shellOperationIds).toEqual([OPERATION_ID]);
    expect(evidenceOf((await parse(false))?.toolUses[0])).toEqual(NO_EVIDENCE);
  });
});

describe("Cursor with attribution evidence off", () => {
  it("reads no result facts", async () => {
    const parse = (attributionEvidence?: boolean) =>
      parseCursorTranscript(CURSOR_LINES, {
        sessionId: "cursor-off",
        ...(attributionEvidence === undefined ? {} : { attributionEvidence }),
      });

    expect((await parse())?.toolUses[0]?.shellOperationIds).toEqual([
      OPERATION_ID,
    ]);
    expect(evidenceOf((await parse(false))?.toolUses[0])).toEqual(NO_EVIDENCE);
  });
});
