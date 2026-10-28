import { MAX_CANDIDATE_REQUEST_KEYS } from "@repo/api/src/types/operation-claims";
import { TokenSourceIdentityAvailability } from "@repo/api/src/types/token-cost-provenance";
import { describe, expect, it } from "vitest";
import { requestKeyFor } from "../request-key";
import { codexResponseIdScheme } from "./codex-request-binding";
import { parseCodexRollout } from "./parse-codex";

// ISS-12552 (PRD-800 "Proving usage"): a Codex call names the model
// request that issued it, and each usage record names the requests it covers,
// so a receipt on the call joins that request's usage. The order is Codex's
// own: the call, then the request's token_usage_record, then any McpToolCall
// the call ran, then the call output, then the token_count.

const BASE_TIME = "2026-10-20T10:00:00.000Z";

const SESSION_META = JSON.stringify({
  type: "session_meta",
  timestamp: "2026-10-20T10:00:00.000Z",
  payload: { cwd: "/workspace/proj", cli_version: "0.163.0" },
});

function line(type: string, payload: Record<string, unknown>, second: number) {
  return JSON.stringify({
    type,
    timestamp: `2026-10-20T10:00:${String(second).padStart(2, "0")}.000Z`,
    payload,
  });
}

const execCall = (callId: string, second: number) =>
  line(
    "response_item",
    { type: "custom_tool_call", call_id: callId, name: "exec", input: "run" },
    second
  );
const execOutput = (callId: string, second: number) =>
  line(
    "response_item",
    {
      type: "custom_tool_call_output",
      call_id: callId,
      output: "Script completed",
    },
    second
  );
const usageRecord = (responseId: string, second: number) =>
  line("token_usage_record", { response_id: responseId }, second);
const nestedMcpCall = (id: string, second: number) =>
  line(
    "event_msg",
    {
      type: "item_completed",
      item: {
        type: "McpToolCall",
        id,
        server: "closedloop",
        tool: "create-document",
        arguments: { title: "Plan" },
        status: "completed",
        result: { content: [{ type: "text", text: "{}" }] },
      },
    },
    second
  );
const tokenCount = (input: number, second: number) =>
  line(
    "event_msg",
    {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: 0,
          output_tokens: 10,
          reasoning_output_tokens: 0,
          total_tokens: input + 10,
        },
      },
    },
    second
  );

const key = (responseId: string) =>
  requestKeyFor(codexResponseIdScheme, responseId);

async function parse(lines: string[]) {
  const session = await parseCodexRollout(lines, {
    sessionId: "codex-request",
  });
  if (!session) {
    throw new Error("rollout did not parse");
  }
  return session;
}

describe("Codex request binding (ISS-12552)", () => {
  it("binds each call, and the MCP call it ran, to the request whose usage names it", async () => {
    const session = await parse([
      SESSION_META,
      execCall("call_1", 1),
      usageRecord("resp_1", 2),
      nestedMcpCall("exec-1", 3),
      execOutput("call_1", 4),
      tokenCount(100, 5),
      execCall("call_2", 6),
      usageRecord("resp_2", 7),
      execOutput("call_2", 8),
      tokenCount(250, 9),
    ]);

    expect(session.toolUses.map((use) => use.requestKey)).toEqual([
      key("resp_1"),
      key("resp_2"),
    ]);
    expect(
      (session.mcpCallEvidence ?? []).map((use) => use.requestKey)
    ).toEqual([key("resp_1")]);
    expect(session.tokenSeries.map((entry) => entry.sourceIdentity)).toEqual([
      {
        availability: TokenSourceIdentityAvailability.Available,
        scheme: codexResponseIdScheme,
        sourceRecordIds: ["resp_1"],
      },
      {
        availability: TokenSourceIdentityAvailability.Available,
        scheme: codexResponseIdScheme,
        sourceRecordIds: ["resp_2"],
      },
    ]);
  });

  it("names no request for an MCP call while two calls are open", async () => {
    const session = await parse([
      SESSION_META,
      execCall("call_1", 1),
      execCall("call_2", 2),
      usageRecord("resp_1", 3),
      nestedMcpCall("exec-1", 4),
      execOutput("call_1", 5),
      execOutput("call_2", 6),
      tokenCount(100, 7),
    ]);

    expect(session.mcpCallEvidence?.[0]).not.toHaveProperty("requestKey");
    expect(session.mcpCallEvidence?.[0]?.candidateRequestKeys).toEqual([
      key("resp_1"),
    ]);
  });

  it("gives an MCP call made while two calls of different requests are open both requests as candidates", async () => {
    const session = await parse([
      SESSION_META,
      execCall("call_1", 1),
      usageRecord("resp_1", 2),
      execCall("call_2", 3),
      nestedMcpCall("exec-1", 4),
      usageRecord("resp_2", 5),
      execOutput("call_1", 6),
      execOutput("call_2", 7),
      tokenCount(100, 8),
    ]);

    const [nested] = session.mcpCallEvidence ?? [];
    expect(nested).not.toHaveProperty("requestKey");
    expect(nested?.candidateRequestKeys).toEqual([
      key("resp_1"),
      key("resp_2"),
    ]);
  });

  it("gives usage no request identity when the rollout records none", async () => {
    const session = await parse([
      SESSION_META,
      execCall("call_1", 1),
      execOutput("call_1", 2),
      tokenCount(100, 3),
    ]);

    expect(session.toolUses[0]).not.toHaveProperty("requestKey");
    expect(session.toolUses[0]).not.toHaveProperty("requestUnresolved");
    expect(session.tokenSeries[0]).not.toHaveProperty("sourceIdentity");
  });

  it("marks an MCP call open inside more calls than the candidate cap unresolved, with no candidates", async () => {
    const openCalls = MAX_CANDIDATE_REQUEST_KEYS + 1;
    const lines = [SESSION_META];
    for (let index = 0; index < openCalls; index++) {
      lines.push(
        lineAt("response_item", execPayload(`call_${index}`), 2 * index),
        lineAt(
          "token_usage_record",
          { response_id: `resp_${index}` },
          2 * index + 1
        )
      );
    }
    lines.push(lineAt("event_msg", nestedPayload("exec-1"), 2 * openCalls));
    const session = await parse(lines);

    const [nested] = session.mcpCallEvidence ?? [];
    expect(nested?.requestUnresolved).toBe(true);
    expect(nested?.candidateRequestKeys).toBeUndefined();
    expect(nested).not.toHaveProperty("requestKey");
  });

  it("marks the calls of a request record with no response id unresolved, nested candidates included", async () => {
    const session = await parse([
      SESSION_META,
      execCall("call_1", 1),
      execCall("call_2", 2),
      nestedMcpCall("exec-1", 3),
      line("token_usage_record", {}, 4),
      execOutput("call_1", 5),
      execOutput("call_2", 6),
      tokenCount(100, 7),
    ]);

    const [nested] = session.mcpCallEvidence ?? [];
    expect(nested?.requestUnresolved).toBe(true);
    expect(nested?.candidateRequestKeys).toBeUndefined();
    expect(session.toolUses.map((use) => use.requestUnresolved)).toEqual([
      true,
      true,
    ]);
  });
});

/** A line some seconds past the minute, past 59 too. */
function lineAt(
  type: string,
  payload: Record<string, unknown>,
  seconds: number
) {
  return JSON.stringify({
    type,
    timestamp: new Date(Date.parse(BASE_TIME) + seconds * 1000).toISOString(),
    payload,
  });
}

function execPayload(callId: string) {
  return {
    type: "custom_tool_call",
    call_id: callId,
    name: "exec",
    input: "run",
  };
}

function nestedPayload(id: string) {
  return {
    type: "item_completed",
    item: {
      type: "McpToolCall",
      id,
      server: "closedloop",
      tool: "create-document",
      arguments: { title: "Plan" },
      status: "completed",
      result: { content: [{ type: "text", text: "{}" }] },
    },
  };
}
