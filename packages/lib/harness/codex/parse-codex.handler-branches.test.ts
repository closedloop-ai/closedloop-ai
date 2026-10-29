import { describe, expect, it } from "vitest";
import { collectCodexUsageIdentities, parseCodexRollout } from "./parse-codex";

const T0 = "2026-08-01T10:00:00.000Z";
const T1 = "2026-08-01T10:00:01.000Z";
const T2 = "2026-08-01T10:00:02.000Z";
const T3 = "2026-08-01T10:00:03.000Z";

const sessionMeta = (ts: string = T0) =>
  JSON.stringify({
    type: "session_meta",
    timestamp: ts,
    payload: { cwd: "/w" },
  });

const turnContext = (model: string, ts: string = T1) =>
  JSON.stringify({ type: "turn_context", timestamp: ts, payload: { model } });

const eventMsg = (payload: Record<string, unknown>, ts?: string) =>
  JSON.stringify({
    type: "event_msg",
    ...(ts ? { timestamp: ts } : {}),
    payload,
  });

const responseItem = (payload: Record<string, unknown>, ts?: string) =>
  JSON.stringify({
    type: "response_item",
    ...(ts ? { timestamp: ts } : {}),
    payload,
  });

const totalsUsage = (input: number, output: number) => ({
  input_tokens: input,
  cached_input_tokens: 0,
  output_tokens: output,
});

async function parse(lines: string[], sessionId = "branches") {
  const session = await parseCodexRollout(lines, { sessionId });
  if (!session) {
    throw new Error("expected a session");
  }
  return session;
}

describe("item_completed Plan event", () => {
  it("records a codex-plan-item plan with the event timestamp", async () => {
    const session = await parse([
      sessionMeta(),
      eventMsg(
        { type: "item_completed", item: { type: "Plan", text: "Step 1" } },
        T2
      ),
    ]);
    expect(session.plans).toEqual([
      { source: "codex-plan-item", content: "Step 1", timestamp: T2 },
    ]);
  });

  it("falls back to firstTimestamp (null before any timestamp) for an untimestamped leading plan", async () => {
    const session = await parse([
      eventMsg({
        type: "item_completed",
        item: { type: "Plan", text: "Early" },
      }),
      sessionMeta(),
    ]);
    expect(session.plans).toEqual([
      { source: "codex-plan-item", content: "Early", timestamp: null },
    ]);
  });

  it.each([
    ["missing item", {}],
    ["non-Plan item", { item: { type: "Message", text: "x" } }],
    ["non-string text", { item: { type: "Plan", text: 42 } }],
    ["blank text", { item: { type: "Plan", text: "   " } }],
  ])("ignores an item_completed with %s", async (_label, extra) => {
    const session = await parse([
      sessionMeta(),
      eventMsg({ type: "item_completed", ...extra }, T2),
    ]);
    expect(session.plans).toEqual([]);
  });
});

describe("user_message event without its own timestamp", () => {
  it("does not open a turn, so the next agent_message records no duration", async () => {
    const session = await parse([
      sessionMeta(),
      eventMsg({ type: "user_message", message: "hi" }),
      eventMsg({ type: "agent_message", message: "yo" }, T3),
    ]);
    expect(session.userMessages).toBe(1);
    expect(session.turnDurations).toEqual([]);
  });
});

describe("token_count model extraction from info.model", () => {
  it("promotes info.model to the session model", async () => {
    const session = await parse([
      sessionMeta(),
      eventMsg(
        {
          type: "token_count",
          info: { model: "gpt-info", total_token_usage: totalsUsage(10, 5) },
        },
        T2
      ),
    ]);
    expect(session.model).toBe("gpt-info");
    expect(Object.keys(session.tokensByModel)).toEqual(["gpt-info"]);
  });

  it("prefers a payload turn_context.model over info.model", async () => {
    const session = await parse([
      sessionMeta(),
      eventMsg(
        {
          type: "token_count",
          turn_context: { model: "gpt-turn" },
          info: { model: "gpt-info", total_token_usage: totalsUsage(10, 5) },
        },
        T2
      ),
    ]);
    expect(session.model).toBe("gpt-turn");
  });
});

describe("error event message fallbacks", () => {
  it("uses a string message ahead of the error field", async () => {
    const session = await parse([
      sessionMeta(),
      eventMsg({ type: "error", message: "msg", error: "boom" }, T2),
    ]);
    expect(session.apiErrors[0]?.message).toBe("msg");
  });

  it("uses the error field when message is not a string", async () => {
    const session = await parse([
      sessionMeta(),
      eventMsg({ type: "stream_error", message: 5, error: "boom" }, T2),
    ]);
    expect(session.apiErrors).toEqual([
      { type: "stream_error", message: "boom", timestamp: T2 },
    ]);
  });
});

describe("tool-begin fallback events", () => {
  it("stamps untimestamped leading begin events with a null timestamp", async () => {
    const session = await parse([
      eventMsg({ type: "mcp_tool_call_begin", server: "s", method: "m" }),
      eventMsg({ type: "patch_apply_begin", changes: "" }),
      eventMsg({ type: "exec_command_begin", command: ["ls"] }),
      sessionMeta(),
    ]);
    expect(session.toolUses.map((t) => t.timestamp)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("leaves mcpServer undefined and names the tool by method when no server is present", async () => {
    const session = await parse([
      sessionMeta(),
      eventMsg({ type: "mcp_tool_call_begin", tool: "search" }, T2),
    ]);
    expect(session.toolUses[0]).toMatchObject({
      name: "search",
      mcpServer: undefined,
      mcpMethod: "search",
    });
  });

  it("uses a null input for patch and shell begins that carry no payload", async () => {
    const session = await parse([
      sessionMeta(),
      eventMsg({ type: "patch_apply_begin" }, T2),
      eventMsg({ type: "exec_command_begin" }, T2),
    ]);
    expect(session.toolUses.map((t) => [t.name, t.input])).toEqual([
      ["apply_patch", null],
      ["shell", null],
    ]);
  });
});

describe("mcp_tool_call_end correlation", () => {
  const mcpBegin = (callId?: string) =>
    eventMsg(
      {
        type: "mcp_tool_call_begin",
        server: "srv",
        method: "m",
        ...(callId ? { call_id: callId } : {}),
      },
      T1
    );

  it("stores a string output verbatim for a by-call-id match", async () => {
    const session = await parse([
      sessionMeta(),
      mcpBegin("a"),
      eventMsg({ type: "mcp_tool_call_end", call_id: "a", output: "done" }, T2),
    ]);
    expect(session.toolUses[0]).toMatchObject({
      output: "done",
      isError: false,
    });
  });

  it("leaves output unset when the by-call-id end carries no output or result", async () => {
    const session = await parse([
      sessionMeta(),
      mcpBegin("a"),
      eventMsg({ type: "mcp_tool_call_end", call_id: "a" }, T2),
    ]);
    expect(session.toolUses[0]?.output).toBeUndefined();
    expect(session.toolResultErrors).toEqual([]);
  });

  it("JSON-serializes an object output on the ambiguous fallback path", async () => {
    const session = await parse([
      sessionMeta(),
      mcpBegin(),
      eventMsg({ type: "mcp_tool_call_end", result: { ok: 1 } }, T2),
    ]);
    expect(session.toolUses[0]).toMatchObject({
      output: JSON.stringify({ ok: 1 }),
      isError: false,
    });
    expect(session.parseQuality?.ambiguousToolOutputs).toBe(1);
  });

  it("counts an ambiguous end with no open MCP call without writing any tool", async () => {
    const session = await parse([
      sessionMeta(),
      eventMsg({ type: "exec_command_begin", command: "ls" }, T1),
      eventMsg({ type: "mcp_tool_call_end", output: "x" }, T2),
    ]);
    expect(session.toolUses).toHaveLength(1);
    expect(session.toolUses[0]?.output).toBeUndefined();
    expect(session.parseQuality?.ambiguousToolOutputs).toBe(1);
  });
});

describe("response_item messages with a synthetic -default model", () => {
  it("flags user, assistant, and reasoning messages as synthetic", async () => {
    const session = await parse([
      sessionMeta(),
      turnContext("gpt-5-default"),
      responseItem(
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "q" }],
        },
        T2
      ),
      responseItem(
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "a" }],
        },
        T2
      ),
      responseItem({ type: "reasoning", text: "think" }, T2),
    ]);
    expect(session.messages.map((m) => m.isSynthetic)).toEqual([
      true,
      true,
      true,
    ]);
  });
});

describe("untimestamped leading response_items", () => {
  it("stamps messages, plans, reasoning, and tool calls with a null timestamp", async () => {
    const session = await parse([
      responseItem({
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "<proposed_plan>P</proposed_plan>" },
        ],
      }),
      responseItem({ type: "reasoning", text: "r" }),
      responseItem({ type: "function_call", name: "f", arguments: "{}" }),
      responseItem({ type: "local_shell_call" }),
      sessionMeta(),
    ]);
    expect(session.messages.map((m) => m.timestamp)).toEqual([null, null]);
    expect(session.messageTimestamps).toEqual([]);
    expect(session.plans).toEqual([
      { source: "codex-proposed-plan", content: "P", timestamp: null },
    ]);
    expect(session.toolUses.map((t) => [t.name, t.timestamp, t.input])).toEqual(
      [
        ["f", null, {}],
        ["shell", null, null],
      ]
    );
  });

  it("uses the session model for reasoning when no turn model is set", async () => {
    const session = await parse([
      sessionMeta(),
      eventMsg(
        {
          type: "token_count",
          info: { model: "gpt-sess", total_token_usage: totalsUsage(1, 1) },
        },
        T1
      ),
      responseItem({ type: "reasoning", text: "r" }, T2),
    ]);
    expect(session.messages[0]?.model).toBe("gpt-sess");
  });
});

describe("apply_patch function_call raw input selection", () => {
  const PATCH = "*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch";

  it("reads the diff from p.input when arguments are absent", async () => {
    const session = await parse([
      sessionMeta(),
      responseItem(
        { type: "custom_tool_call", name: "apply_patch", input: PATCH },
        T2
      ),
    ]);
    expect(session.toolUses[0]?.diffDelta).toEqual({ add: 1, del: 0 });
  });

  it("records no diffDelta when arguments are a non-string object", async () => {
    const session = await parse([
      sessionMeta(),
      responseItem(
        {
          type: "function_call",
          name: "apply_patch",
          arguments: { patch: PATCH },
        },
        T2
      ),
    ]);
    expect(session.toolUses[0]?.diffDelta).toBeUndefined();
  });

  it("uses a string arguments value directly", async () => {
    const session = await parse([
      sessionMeta(),
      responseItem(
        { type: "function_call", name: "apply_patch", arguments: PATCH },
        T2
      ),
    ]);
    expect(session.toolUses[0]?.diffDelta).toEqual({ add: 1, del: 0 });
  });
});

describe("function_call_output fallbacks", () => {
  it("reads p.result when output is absent", async () => {
    const session = await parse([
      sessionMeta(),
      responseItem({ type: "function_call", name: "f", call_id: "c" }, T1),
      responseItem(
        { type: "function_call_output", call_id: "c", result: "R" },
        T2
      ),
    ]);
    expect(session.toolUses[0]?.output).toBe("R");
  });

  it("serializes an empty object when neither output nor result is present", async () => {
    const session = await parse([
      sessionMeta(),
      responseItem({ type: "function_call", name: "f", call_id: "c" }, T1),
      responseItem({ type: "function_call_output", call_id: "c" }, T2),
    ]);
    expect(session.toolUses[0]?.output).toBe("{}");
  });
});

describe("findLastOpenMcpTool skips non-candidates", () => {
  it("passes over a closed MCP call and a non-MCP call to reach the open MCP call", async () => {
    const session = await parse([
      sessionMeta(),
      eventMsg(
        { type: "mcp_tool_call_begin", server: "s", method: "open" },
        T1
      ),
      eventMsg(
        { type: "mcp_tool_call_begin", server: "s", method: "closed" },
        T1
      ),
      eventMsg({ type: "mcp_tool_call_end", output: "first" }, T2),
      eventMsg({ type: "exec_command_begin", command: "ls" }, T2),
      eventMsg({ type: "mcp_tool_call_end", output: "second" }, T3),
    ]);
    expect(session.toolUses.map((t) => [t.name, t.output])).toEqual([
      ["s__open", "second"],
      ["s__closed", "first"],
      ["shell", undefined],
    ]);
  });
});

describe("response_item without a type", () => {
  it("is ignored but still suppresses the event-only tool fallback", async () => {
    const session = await parse([
      sessionMeta(),
      responseItem({ role: "assistant" }, T1),
      eventMsg({ type: "exec_command_begin", command: "ls" }, T2),
    ]);
    expect(session.toolUses).toEqual([]);
    expect(session.messages).toEqual([]);
  });
});

describe("rebaseReplayedBurst with last_token_usage snapshots", () => {
  const tokenEvent = (ts: string, input: number, output: number) =>
    eventMsg(
      {
        type: "token_count",
        info: {
          total_token_usage: totalsUsage(input, output),
          last_token_usage: totalsUsage(input, output),
        },
      },
      ts
    );

  it("drops burst-window snapshots and keeps the post-burst one", async () => {
    const session = await parseCodexRollout(
      [
        sessionMeta("2026-08-01T10:00:00.000Z"),
        turnContext("gpt-5", "2026-08-01T10:00:00.050Z"),
        tokenEvent("2026-08-01T10:00:00.100Z", 100, 10),
        tokenEvent("2026-08-01T10:00:00.200Z", 200, 20),
        tokenEvent("2026-08-01T10:00:00.300Z", 300, 30),
        tokenEvent("2026-08-01T10:00:05.000Z", 400, 40),
      ],
      { sessionId: "rebase-snap", burstRecordMin: 3, burstWindowMs: 1000 }
    );
    expect(session?.codexLastTokenUsage?.map((s) => s.timestamp)).toEqual([
      "2026-08-01T10:00:05.000Z",
    ]);
  });

  it("keeps token entries when the leading burst holds only messages", async () => {
    const msg = (ts: string) =>
      responseItem(
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "m" }],
        },
        ts
      );
    const session = await parseCodexRollout(
      [
        sessionMeta("2026-08-01T10:00:00.000Z"),
        turnContext("gpt-5", "2026-08-01T10:00:00.050Z"),
        msg("2026-08-01T10:00:00.100Z"),
        msg("2026-08-01T10:00:00.200Z"),
        msg("2026-08-01T10:00:00.300Z"),
        tokenEvent("2026-08-01T10:00:05.000Z", 400, 40),
      ],
      { sessionId: "rebase-msgs", burstRecordMin: 3, burstWindowMs: 1000 }
    );
    expect(session?.assistantMessages).toBe(1);
    expect(session?.tokensByModel["gpt-5"]).toMatchObject({
      input: 400,
      output: 40,
    });
  });
});

describe("collectCodexUsageIdentities fallbacks", () => {
  const tokenLine = (info: Record<string, unknown>) =>
    eventMsg({ type: "token_count", info }, T2);

  it("keys the identity on info.model the same as an equivalent turn_context model", async () => {
    const viaInfo = await collectCodexUsageIdentities([
      turnContext("gpt-other"),
      tokenLine({ model: "gpt-info", total_token_usage: totalsUsage(10, 5) }),
    ]);
    const viaTurn = await collectCodexUsageIdentities([
      turnContext("gpt-info"),
      tokenLine({ total_token_usage: totalsUsage(10, 5) }),
    ]);
    const viaOther = await collectCodexUsageIdentities([
      turnContext("gpt-other"),
      tokenLine({ total_token_usage: totalsUsage(10, 5) }),
    ]);
    expect([...viaInfo]).toEqual([...viaTurn]);
    expect([...viaInfo]).not.toEqual([...viaOther]);
  });

  it("keys the identity on a payload turn_context.model", async () => {
    const viaPayloadTurn = await collectCodexUsageIdentities([
      turnContext("gpt-other"),
      eventMsg(
        {
          type: "token_count",
          turn_context: { model: "gpt-info" },
          info: { total_token_usage: totalsUsage(10, 5) },
        },
        T2
      ),
    ]);
    const viaTurn = await collectCodexUsageIdentities([
      turnContext("gpt-info"),
      tokenLine({ total_token_usage: totalsUsage(10, 5) }),
    ]);
    expect([...viaPayloadTurn]).toEqual([...viaTurn]);
  });

  it("reads totals from a bare payload with no info wrapper", async () => {
    const viaBare = await collectCodexUsageIdentities([
      turnContext("gpt-5"),
      eventMsg(
        { type: "token_count", total_token_usage: totalsUsage(10, 5) },
        T2
      ),
    ]);
    const viaCanonical = await collectCodexUsageIdentities([
      turnContext("gpt-5"),
      tokenLine({ total_token_usage: totalsUsage(10, 5) }),
    ]);
    expect(viaBare.size).toBe(1);
    expect([...viaBare]).toEqual([...viaCanonical]);
  });

  it("reads totals from info.total", async () => {
    const viaTotal = await collectCodexUsageIdentities([
      turnContext("gpt-5"),
      tokenLine({ total: totalsUsage(10, 5) }),
    ]);
    const viaCanonical = await collectCodexUsageIdentities([
      turnContext("gpt-5"),
      tokenLine({ total_token_usage: totalsUsage(10, 5) }),
    ]);
    expect(viaTotal.size).toBe(1);
    expect([...viaTotal]).toEqual([...viaCanonical]);
  });
});
