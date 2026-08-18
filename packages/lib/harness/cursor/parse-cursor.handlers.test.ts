/**
 * @file parse-cursor.handlers.test.ts
 * Per-handler branch coverage for parseCursorTranscript — tool-result, token-count,
 * error, buildCursorSession, and reasoning/implicit-else paths.
 * Each section drives parseCursorTranscript with synthetic inline JSONL lines that
 * exercise one specific uncovered branch, paired with an opposite/control case so
 * falsifiability is guaranteed.
 *
 * Constraint: types: [] in tsconfig — no Buffer, process, or node:* imports.
 */
import { describe, expect, it } from "vitest";
import { parseCursorTranscript } from "./parse-cursor";

const TS0 = "2026-07-11T09:00:00.000Z";
const TS1 = "2026-07-11T09:00:01.000Z";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

// ── resolveToolResultOutput: three-way cascade ───────────────────────────────

describe("resolveToolResultOutput: output field cascade", () => {
  it("string output is used directly (Branch 37[0])", async () => {
    const lines = [
      line({ type: "tool_call", timestamp: TS0, payload: { name: "R" } }),
      line({
        type: "tool_result",
        timestamp: TS1,
        payload: { output: "direct string" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "ro-output",
    });
    expect(session?.toolUses[0]?.output).toBe("direct string");
  });

  it("string content is used when output is absent (Branch 37[1], 38[0])", async () => {
    const lines = [
      line({ type: "tool_call", timestamp: TS0, payload: { name: "R" } }),
      line({
        type: "tool_result",
        timestamp: TS1,
        payload: { content: "from content" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "ro-content",
    });
    expect(session?.toolUses[0]?.output).toBe("from content");
  });

  it("result field is JSON-stringified when output and content are absent (Branch 38[1])", async () => {
    const lines = [
      line({ type: "tool_call", timestamp: TS0, payload: { name: "R" } }),
      line({
        type: "tool_result",
        timestamp: TS1,
        payload: { result: { code: 0 } },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "ro-result",
    });
    expect(session?.toolUses[0]?.output).toBe(JSON.stringify({ code: 0 }));
  });

  it("null output when all three are absent", async () => {
    const lines = [
      line({ type: "tool_call", timestamp: TS0, payload: { name: "R" } }),
      line({ type: "tool_result", timestamp: TS1, payload: {} }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "ro-null",
    });
    expect(session?.toolUses[0]?.output).toBeNull();
  });
});

// ── handleToolResult: error content and no-lastTool paths ────────────────────

describe("handleToolResult: error content and lastTool guard", () => {
  it("error with string output uses output.slice (Branch 40[0])", async () => {
    const lines = [
      line({ type: "tool_call", timestamp: TS0, payload: { name: "X" } }),
      line({
        type: "tool_result",
        timestamp: TS1,
        payload: { output: "boom", is_error: true },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "err-strout",
    });
    expect(session?.toolResultErrors[0]?.content).toBe("boom");
    expect(session?.toolUses[0]?.isError).toBe(true);
  });

  it("error with non-string output + error field: uses JSON.stringify(error) (Branch 40[1], 41[0])", async () => {
    // output is not a string; error field is truthy → JSON.stringify(error) used
    const lines = [
      line({ type: "tool_call", timestamp: TS0, payload: { name: "Y" } }),
      line({
        type: "tool_result",
        timestamp: TS1,
        payload: { success: false, error: { code: "E_PERM", msg: "denied" } },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "err-errorfield",
    });
    expect(session?.toolResultErrors[0]?.content).toBe(
      JSON.stringify({ code: "E_PERM", msg: "denied" })
    );
  });

  it("error with non-string output obj and no error field: JSON.stringify(output) (Branch 41[1])", async () => {
    // is_error: true; output is object (not string); error is absent → JSON.stringify(output)
    const lines = [
      line({ type: "tool_call", timestamp: TS0, payload: { name: "Z" } }),
      line({
        type: "tool_result",
        timestamp: TS1,
        payload: { is_error: true, output: { stderr: "fail" } },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "err-objout",
    });
    expect(session?.toolResultErrors[0]?.content).toBe(
      JSON.stringify({ stderr: "fail" })
    );
  });

  it("error with neither output nor error falls back to JSON.stringify(payload) (Branch 41[2])", async () => {
    // is_error: true; output and error absent → JSON.stringify(payload)
    const lines = [
      line({ type: "tool_call", timestamp: TS0, payload: { name: "W" } }),
      line({
        type: "tool_result",
        timestamp: TS1,
        payload: { is_error: true },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "err-payload",
    });
    // content is JSON.stringify({is_error:true}).slice(0,500)
    expect(session?.toolResultErrors[0]?.content).toBe(
      JSON.stringify({ is_error: true })
    );
  });

  it("tool_result without preceding tool_call: no output attached (Branch 42[1], 43[1])", async () => {
    // toolUses is empty → lastTool is null → the if(lastTool) body is skipped
    const lines = [
      line({ type: "session_meta", timestamp: TS0, payload: { cwd: "/p" } }),
      line({
        type: "tool_result",
        timestamp: TS1,
        payload: { output: "orphan" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "orphan-result",
    });
    // No tool use was created, no output attached anywhere
    expect(session?.toolUses).toHaveLength(0);
    // No error either (not an error result)
    expect(session?.toolResultErrors).toHaveLength(0);
  });

  it("non-error tool_result with no lastTool: isError stays unset (Branch 43[1] false path)", async () => {
    const lines = [
      line({ type: "session_meta", timestamp: TS0, payload: { cwd: "/p" } }),
      line({
        type: "tool_result",
        timestamp: TS1,
        payload: { output: "ok", is_error: true },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "orphan-err",
    });
    // Error was recorded in toolResultErrors
    expect(session?.toolResultErrors).toHaveLength(1);
    // But no toolUse exists to attach isError to
    expect(session?.toolUses).toHaveLength(0);
  });

  it("is_error:true is first disjunct that short-circuits isToolResultError", async () => {
    const lines = [
      line({ type: "tool_call", timestamp: TS0, payload: { name: "T" } }),
      line({
        type: "tool_result",
        timestamp: TS1,
        payload: { is_error: true },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "ioe-disjunct",
    });
    expect(session?.toolUses[0]?.isError).toBe(true);
  });

  it("success:false is second disjunct of isToolResultError", async () => {
    const lines = [
      line({ type: "tool_call", timestamp: TS0, payload: { name: "T" } }),
      line({
        type: "tool_result",
        timestamp: TS1,
        payload: { success: false },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "ioe-success",
    });
    expect(session?.toolResultErrors).toHaveLength(1);
    expect(session?.toolUses[0]?.isError).toBe(true);
  });

  it("!!error is fourth disjunct of isToolResultError", async () => {
    const lines = [
      line({ type: "tool_call", timestamp: TS0, payload: { name: "T" } }),
      line({
        type: "tool_result",
        timestamp: TS1,
        payload: { error: "something failed" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "ioe-error",
    });
    expect(session?.toolResultErrors).toHaveLength(1);
    expect(session?.toolUses[0]?.isError).toBe(true);
  });

  it("tool_output and command_output aliases route to handleToolResult", async () => {
    const lines = [
      line({ type: "tool_call", timestamp: TS0, payload: { name: "T" } }),
      line({
        type: "tool_output",
        timestamp: TS1,
        payload: { output: "out1" },
      }),
    ];
    const s1 = await parseCursorTranscript(lines, { sessionId: "tool-output" });
    expect(s1?.toolUses[0]?.output).toBe("out1");

    const lines2 = [
      line({
        type: "command_execution",
        timestamp: TS0,
        payload: { name: "T" },
      }),
      line({
        type: "command_output",
        timestamp: TS1,
        payload: { output: "out2" },
      }),
    ];
    const s2 = await parseCursorTranscript(lines2, { sessionId: "cmd-output" });
    expect(s2?.toolUses[0]?.output).toBe("out2");
  });
});

// ── handleTokenCount: usage alias chain and timestamp fallbacks ───────────────

describe("handleTokenCount: usage aliases and timestamp fallbacks", () => {
  it("reads from payload.usage (control)", async () => {
    const lines = [
      line({
        type: "token_count",
        timestamp: TS0,
        payload: { usage: { input_tokens: 50, output_tokens: 20 } },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-usage",
    });
    expect(session?.tokensByModel?.["cursor-default"]?.input).toBe(50);
  });

  it("reads from payload.token_count alias when usage is absent (Branch 45[1])", async () => {
    const lines = [
      line({
        type: "token_count",
        timestamp: TS0,
        payload: { token_count: { input_tokens: 30, output_tokens: 15 } },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-alias",
    });
    expect(session?.tokensByModel?.["cursor-default"]?.input).toBe(30);
  });

  it("reads token fields directly from payload when usage and token_count absent (Branch 45[2])", async () => {
    // asRecord(payload.usage ?? payload.token_count ?? payload) → payload itself
    const lines = [
      line({
        type: "usage",
        timestamp: TS0,
        payload: { input_tokens: 10, output_tokens: 5 },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-direct",
    });
    expect(session?.tokensByModel?.["cursor-default"]?.input).toBe(10);
    expect(session?.tokensByModel?.["cursor-default"]?.output).toBe(5);
  });

  it("overrides acc.model from payload.model in token event (Branch 46[0])", async () => {
    const lines = [
      line({
        type: "token_count",
        timestamp: TS0,
        payload: {
          model: "gpt-4",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-model",
    });
    // model was set by token_count
    expect(session?.model).toBe("gpt-4");
    expect(session?.tokensByModel?.["gpt-4"]?.input).toBe(10);
  });

  it("tokenTs uses lastTimestamp when iso is null (Branch 47[1])", async () => {
    // Give an earlier record to set lastTimestamp, then a token_count without timestamp
    const lines = [
      line({ type: "session_meta", timestamp: TS0, payload: { cwd: "/p" } }),
      line({
        type: "user_message",
        timestamp: TS1,
        payload: { content: "hi" },
      }),
      JSON.stringify({
        type: "token_count",
        payload: { input_tokens: 5, output_tokens: 2 },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-lastts",
    });
    // tokenSeries should have a record using TS1 (lastTimestamp at that point)
    expect(session?.tokenSeries).toHaveLength(1);
    expect(session?.tokenSeries[0]?.timestamp).toBe(TS1);
  });

  it("tokenTs uses firstTimestamp when iso and lastTimestamp are both null (Branch 47[2])", async () => {
    // session_meta sets first/last; token_count has no timestamp so iso=null,
    // so tokenTs = lastTimestamp = TS0.
    const lines = [
      line({ type: "session_meta", timestamp: TS0, payload: { cwd: "/p" } }),
      JSON.stringify({
        type: "token_count",
        payload: { input_tokens: 1, output_tokens: 1 },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-firstts",
    });
    expect(session?.tokenSeries).toHaveLength(1);
    // lastTimestamp = TS0 (only timestamp seen before token_count line)
    expect(session?.tokenSeries[0]?.timestamp).toBe(TS0);
  });

  it("no tokenSeries record when tokenTs is null (Branch 48[1])", async () => {
    // The ONLY line is a token_count with no timestamp → firstTimestamp never set
    // → tokenTs is null → tokenSeries push is skipped
    const lines = [
      JSON.stringify({
        type: "token_count",
        payload: { input_tokens: 5, output_tokens: 2 },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-nots",
    });
    // No timestamp ever → parseCursorTranscript returns null (firstTimestamp null)
    expect(session).toBeNull();
  });

  it("tokenSeries model uses currentTurnModel when available", async () => {
    const lines = [
      line({
        type: "turn_context",
        timestamp: TS0,
        payload: { model: "turn-model" },
      }),
      line({
        type: "token_count",
        timestamp: TS1,
        payload: { input_tokens: 8, output_tokens: 3 },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-turnmodel",
    });
    expect(session?.tokenSeries[0]?.model).toBe("turn-model");
  });

  it("tokenSeries model falls to acc.model when currentTurnModel null (Branch 49[1])", async () => {
    // session_meta sets model; no turn_context → currentTurnModel stays null
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/p", model: "meta-mod" },
      }),
      line({
        type: "token_count",
        timestamp: TS1,
        payload: { input_tokens: 7, output_tokens: 2 },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-metamod",
    });
    expect(session?.tokenSeries[0]?.model).toBe("meta-mod");
  });

  it("tokenSeries model uses 'cursor-default' when both are null (Branch 49[2])", async () => {
    // No session_meta model, no turn_context → both null → "cursor-default"
    const lines = [
      line({
        type: "token_count",
        timestamp: TS0,
        payload: { input_tokens: 3, output_tokens: 1 },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-nomodel",
    });
    expect(session?.tokenSeries[0]?.model).toBe("cursor-default");
  });

  it("token_usage alias routes to handleTokenCount", async () => {
    const lines = [
      line({
        type: "token_usage",
        timestamp: TS0,
        payload: { input_tokens: 20, output_tokens: 10 },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "token-usage",
    });
    expect(session?.tokensByModel?.["cursor-default"]?.input).toBe(20);
  });

  it("last-wins: second token_count overwrites first (not cumulative)", async () => {
    const lines = [
      line({
        type: "token_count",
        timestamp: TS0,
        payload: { input_tokens: 100, output_tokens: 40 },
      }),
      line({
        type: "token_count",
        timestamp: TS1,
        payload: { input_tokens: 50, output_tokens: 20 },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-lastwin",
    });
    // Second value overwrites first → 50, not 150
    expect(session?.tokensByModel?.["cursor-default"]?.input).toBe(50);
    expect(session?.tokensByModel?.["cursor-default"]?.output).toBe(20);
    // But tokenSeries has one record per event
    expect(session?.tokenSeries).toHaveLength(2);
  });
});

// ── handleError: message field fallbacks ──────────────────────────────────────

describe("handleError: message fallbacks", () => {
  it("uses string message when truthy (Branch 50[0])", async () => {
    const lines = [
      line({
        type: "error",
        timestamp: TS0,
        payload: { message: "rate limited" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "err-msg",
    });
    expect(session?.apiErrors[0]?.message).toBe("rate limited");
    expect(session?.apiErrors[0]?.type).toBe("error");
  });

  it("falls to error field when message is empty string (Branch 50[1])", async () => {
    // typeof "" === "string" but "" is falsy → && short-circuits → falls to asStringOrNull(error)
    const lines = [
      line({
        type: "error",
        timestamp: TS0,
        payload: { message: "", error: "api down" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "err-empty-msg",
    });
    expect(session?.apiErrors[0]?.message).toBe("api down");
  });

  it("falls to error field when message is not a string (Branch 50[1], 50[2])", async () => {
    // message is a number (not string) → typeof check fails → falls to error field
    const lines = [
      line({
        type: "api_error",
        timestamp: TS0,
        payload: { message: 42, error: "non-string message" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "err-numericmsg",
    });
    expect(session?.apiErrors[0]?.message).toBe("non-string message");
    expect(session?.apiErrors[0]?.type).toBe("api_error");
  });

  it("uses 'Cursor error' fallback when message and error are absent (Branch 50[3])", async () => {
    const lines = [line({ type: "stream_error", timestamp: TS0, payload: {} })];
    const session = await parseCursorTranscript(lines, {
      sessionId: "err-default",
    });
    expect(session?.apiErrors[0]?.message).toBe("Cursor error");
    expect(session?.apiErrors[0]?.type).toBe("stream_error");
  });

  it("api_error and stream_error aliases both route to handleError", async () => {
    const lines = [
      line({
        type: "api_error",
        timestamp: TS0,
        payload: { message: "auth failed" },
      }),
      line({
        type: "stream_error",
        timestamp: TS1,
        payload: { message: "timeout" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "err-aliases",
    });
    expect(session?.apiErrors).toHaveLength(2);
    expect(session?.apiErrors[0]?.message).toBe("auth failed");
    expect(session?.apiErrors[1]?.message).toBe("timeout");
  });
});

// ── buildCursorSession: tokensByModel guard and model fallback ─────────────────

describe("buildCursorSession: tokensByModel", () => {
  it("tokensByModel is empty when no token events occurred", async () => {
    const lines = [
      line({
        type: "user_message",
        timestamp: TS0,
        payload: { content: "hi" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "no-tokens",
    });
    expect(session?.tokensByModel).toEqual({});
  });

  it("tokensByModel key is 'cursor-default' when model was never set (Branch 65[1])", async () => {
    // No session_meta model, no turn_context → model stays null → key = "cursor-default"
    const lines = [
      line({
        type: "token_count",
        timestamp: TS0,
        payload: { input_tokens: 5, output_tokens: 2 },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tbm-nomodel",
    });
    expect(session?.tokensByModel).toHaveProperty("cursor-default");
    expect(session?.tokensByModel?.["cursor-default"]?.input).toBe(5);
  });

  it("tokensByModel uses the actual model when one was set", async () => {
    const lines = [
      line({
        type: "turn_context",
        timestamp: TS0,
        payload: { model: "gpt-5-codex" },
      }),
      line({
        type: "token_count",
        timestamp: TS1,
        payload: { input_tokens: 20, output_tokens: 8 },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tbm-model",
    });
    expect(session?.tokensByModel).toHaveProperty("gpt-5-codex");
    expect(session?.tokensByModel?.["gpt-5-codex"]?.input).toBe(20);
  });

  it("no tool uses → emptyArtifacts() (no prs or issues)", async () => {
    const lines = [
      line({
        type: "user_message",
        timestamp: TS0,
        payload: { content: "hi" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "no-tools",
    });
    expect(session?.artifacts?.prs).toHaveLength(0);
    expect(session?.artifacts?.issues).toHaveLength(0);
  });
});

// ── Reasoning aliases ─────────────────────────────────────────────────────────

describe("reasoning and thinking aliases", () => {
  it("thinking and agent_reasoning aliases increment thinkingBlockCount", async () => {
    const lines = [
      line({ type: "thinking", timestamp: TS0, payload: {} }),
      line({ type: "agent_reasoning", timestamp: TS1, payload: {} }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "reasoning",
    });
    expect(session?.thinkingBlockCount).toBe(2);
  });
});

// ── Remaining implicit-else paths ─────────────────────────────────────────────

describe("handleAssistantMessage: iso absent (implicit-else of if(iso))", () => {
  it("assistant_message with no timestamp skips messageTimestamps push (Branch 26[1] candidate)", async () => {
    // handleAssistantMessage has if (iso) { acc.messageTimestamps.push(iso) }
    // When iso is null the push is skipped; this exercises that implicit-else path.
    const lines = [
      line({ type: "session_meta", timestamp: TS0, payload: { cwd: "/p" } }),
      JSON.stringify({
        type: "assistant_message",
        payload: { content: "no ts" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "am-no-ts",
    });
    expect(session?.assistantMessages).toBe(1);
    // messageTimestamps only holds ISO strings from assistant_message events that had timestamps
    expect(session?.messageTimestamps).toHaveLength(0);
  });
});

describe("handleToolCall: iso absent uses firstTimestamp (Branch 32[1] candidate)", () => {
  it("tool_call without timestamp falls back to firstTimestamp for the timestamp field", async () => {
    // iso || acc.firstTimestamp: iso is null → evaluate acc.firstTimestamp
    const lines = [
      line({ type: "session_meta", timestamp: TS0, payload: { cwd: "/p" } }),
      JSON.stringify({ type: "tool_call", payload: { name: "NoTs" } }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-no-ts",
    });
    expect(session?.toolUses[0]?.name).toBe("NoTs");
    // timestamp falls back to firstTimestamp = TS0
    expect(session?.toolUses[0]?.timestamp).toBe(TS0);
  });
});

describe("handleSessionMeta: gitBranch null with non-object git and no git_branch (Branch 17[1] candidate)", () => {
  it("null git field and no git_branch leaves gitBranch null", async () => {
    // payload.git = null: typeof null === "object" is true, but null is falsy → && short-circuits
    // Falls to else-if: payload.git_branch is undefined → false → branch 17[1]
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/p", git: null },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "git-null",
    });
    expect(session?.gitBranch).toBeNull();
  });
});

describe("handleTurnContext: if(payload.model) false path (Branch 17[1] other candidate)", () => {
  it("turn_context with no model field skips model update (Branch 17[1])", async () => {
    // if (payload.model) false → model stays from acc (or null)
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/p", model: "orig" },
      }),
      // turn_context with ONLY cwd, no model field
      line({
        type: "turn_context",
        timestamp: TS1,
        payload: { cwd: "/workspace/new" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-no-model",
    });
    // model was NOT overridden by turn_context (payload.model was absent)
    expect(session?.model).toBe("orig");
    // cwd was already set by session_meta, so turn_context cwd is ignored
    expect(session?.cwd).toBe("/p");
  });
});
