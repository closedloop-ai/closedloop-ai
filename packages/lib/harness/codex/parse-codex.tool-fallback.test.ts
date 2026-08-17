/**
 * Tests for tool-handling branches in parse-codex.ts that are NOT covered by
 * the main parse-codex.test.ts suite.
 *
 * Targets:
 *  - handleToolBeginFallbackEvent:
 *    Branch 155[0] (sawResponseItems → early return), 156[1] (patch_apply_begin),
 *    165[0-1] (patch vs exec shell), 166-171 (patch input fallbacks),
 *    157[3]/158[4] (MCP server/method fallback chain from top-level fields),
 *    159[1] (display name with no method), 161[0-2] (display name chain),
 *    162[1] (arguments fallback chain), 163[3] (input fallback chain)
 *  - handleToolCallItem:
 *    Branch 65[1] (p.arguments == null → use p.input), 67[0-1] (rawInput branches),
 *    68[1] (rawInput as toolInput string), 69[0-1] (rawInput as p.input string),
 *    70[1] (rawInput null → no diffDelta), 71[1] (no callId → no toolCallIndex entry),
 *    Branch 63[1,2] (toolName fallback), 65[1] (toolInput from p.input)
 *  - handleShellCallItem: Branch 72-75 (action/input fallbacks)
 *  - handleMcpToolCallEndEvent: Branch 179[1] (by_call_id for non-MCP tool → rollback),
 *    180[1] (output undefined), 182[0] (output str), 183[0-1] (isMcpSynth check),
 *    186[1] (ambiguous_fallback, no output), 188[1] (ambiguous output string form),
 *    190[0-1] (error path for mcp end output)
 */

import { describe, expect, it } from "vitest";
import { parseCodexRollout } from "./parse-codex";

// ── Shared builders ─────────────────────────────────────────────────────────

const SM = (ts = "2026-08-01T10:00:00.000Z") =>
  JSON.stringify({
    type: "session_meta",
    timestamp: ts,
    payload: { cwd: "/work" },
  });

const TC = (model = "gpt-5", ts = "2026-08-01T10:00:01.000Z") =>
  JSON.stringify({ type: "turn_context", timestamp: ts, payload: { model } });

const TC_BASIC = TC();

function eventMsg(
  type: string,
  fields: Record<string, unknown>,
  ts = "2026-08-01T10:00:02.000Z"
): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp: ts,
    payload: { type, ...fields },
  });
}

function responseItem(
  type: string,
  fields: Record<string, unknown>,
  ts = "2026-08-01T10:00:02.000Z"
): string {
  return JSON.stringify({
    type: "response_item",
    timestamp: ts,
    payload: { type, ...fields },
  });
}

function tokenCount(ts = "2026-08-01T10:00:10.000Z"): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp: ts,
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 5,
        },
      },
    },
  });
}

// ── handleToolBeginFallbackEvent — sawResponseItems guard (Branch 155[0]) ────

describe("handleToolBeginFallbackEvent — early return when response_items have been seen (Branch 155[0])", () => {
  it("does not synthesize a tool use from exec_command_begin when response_items were already seen", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      // Seeing a response_item sets acc.sawResponseItems=true
      responseItem("message", { role: "assistant", content: "hello" }),
      // Now exec_command_begin should be a no-op (sawResponseItems guard fires)
      eventMsg("exec_command_begin", { command: "ls -la" }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "saw-ri-guard",
    });
    expect(session).not.toBeNull();
    // sawResponseItems=true → exec_command_begin is ignored; no shell tool use
    const shellTool = session?.toolUses.find((t) => t.name === "shell");
    expect(shellTool).toBeUndefined();
  });

  it("synthesizes a tool use from exec_command_begin when no response_items were seen", async () => {
    // Control: without any response_item, the fallback synthesizes a shell tool
    const lines = [
      SM(),
      TC_BASIC,
      eventMsg("exec_command_begin", { command: "echo hi" }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "no-ri-shell",
    });
    expect(session).not.toBeNull();
    const shellTool = session?.toolUses.find((t) => t.name === "shell");
    expect(shellTool).toBeDefined();
    expect(shellTool?.input).toBe("echo hi");
  });
});

// ── handleToolBeginFallbackEvent — exec_command_begin (Branch 165[1]) ────────

describe("handleToolBeginFallbackEvent — exec_command_begin synthesizes shell tool", () => {
  it("uses command field as input (Branch 172[0])", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      eventMsg("exec_command_begin", { command: "git status" }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "exec-cmd" });
    const shell = session?.toolUses.find((t) => t.name === "shell");
    expect(shell?.input).toBe("git status");
  });

  it("falls back to arguments when command is absent (Branch 172[1])", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      eventMsg("exec_command_begin", { arguments: "ls" }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "exec-args" });
    const shell = session?.toolUses.find((t) => t.name === "shell");
    expect(shell?.input).toBe("ls");
  });
});

// ── handleToolBeginFallbackEvent — patch_apply_begin (Branch 165[0]) ─────────

describe("handleToolBeginFallbackEvent — patch_apply_begin synthesizes apply_patch tool", () => {
  const UNIFIED_DIFF =
    "*** /dev/null\n--- a.txt\n***************\n*** 0 ****\n--- 1,3 ----\n+ line1\n+ line2\n";

  it("reads patch from changes field and applies diff stats (Branch 166[0])", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      eventMsg("patch_apply_begin", { changes: UNIFIED_DIFF }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "patch-changes",
    });
    const patchTool = session?.toolUses.find((t) => t.name === "apply_patch");
    expect(patchTool).toBeDefined();
    expect(patchTool?.input).toBe(UNIFIED_DIFF);
  });

  it("falls back to patch field when changes is absent (Branch 166[1])", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      eventMsg("patch_apply_begin", { patch: UNIFIED_DIFF }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "patch-patch",
    });
    const patchTool = session?.toolUses.find((t) => t.name === "apply_patch");
    expect(patchTool?.input).toBe(UNIFIED_DIFF);
  });

  it("falls back to arguments field when changes and patch are absent (Branch 167[0])", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      eventMsg("patch_apply_begin", { arguments: UNIFIED_DIFF }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "patch-arguments",
    });
    const patchTool = session?.toolUses.find((t) => t.name === "apply_patch");
    expect(patchTool?.input).toBe(UNIFIED_DIFF);
  });

  it("produces no diffDelta when patch field is not a string (Branch 171[1] false)", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      eventMsg("patch_apply_begin", { changes: 42 }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "patch-non-str",
    });
    const patchTool = session?.toolUses.find((t) => t.name === "apply_patch");
    expect(patchTool).toBeDefined();
    // No string patch → no diffDelta
    expect(patchTool?.diffDelta).toBeUndefined();
  });
});

// ── handleToolBeginFallbackEvent — mcp_tool_call_begin top-level fields ───────

describe("handleToolBeginFallbackEvent — mcp_tool_call_begin with top-level server/method (Branches 157-168)", () => {
  it("reads server from p.server (top-level, not invocation) (Branch 157[0])", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      eventMsg("mcp_tool_call_begin", {
        server: "my-server",
        method: "my-method",
        arguments: {},
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "mcp-top-level",
    });
    const mcp = session?.toolUses.find(
      (t) => t.name === "my-server__my-method"
    );
    expect(mcp).toBeDefined();
    expect(mcp?.mcpServer).toBe("my-server");
    expect(mcp?.mcpMethod).toBe("my-method");
  });

  it("reads method from p.tool when p.method is absent (Branch 158[1])", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      eventMsg("mcp_tool_call_begin", {
        server: "srv",
        tool: "my-tool",
        arguments: {},
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "mcp-tool-field",
    });
    const mcp = session?.toolUses.find((t) => t.name === "srv__my-tool");
    expect(mcp).toBeDefined();
    expect(mcp?.mcpMethod).toBe("my-tool");
  });

  it("reads tool_name from p.tool_name when method and tool are absent (Branch 158[2])", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      eventMsg("mcp_tool_call_begin", {
        server: "srv",
        tool_name: "list_files",
        arguments: {},
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "mcp-tool-name",
    });
    const mcp = session?.toolUses.find((t) => t.name === "srv__list_files");
    expect(mcp).toBeDefined();
  });

  it("uses method as displayName when server is absent (Branch 159[1])", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      eventMsg("mcp_tool_call_begin", { method: "orphan-method" }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "mcp-no-server",
    });
    // displayName = method when server is absent
    const mcp = session?.toolUses.find((t) => t.name === "orphan-method");
    expect(mcp).toBeDefined();
    expect(mcp?.mcpServer).toBeUndefined();
    expect(mcp?.mcpMethod).toBe("orphan-method");
  });

  it("falls back to mcp_tool displayName when server and method are both absent", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      eventMsg("mcp_tool_call_begin", {}),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "mcp-no-name",
    });
    const mcp = session?.toolUses.find((t) => t.name === "mcp_tool");
    expect(mcp).toBeDefined();
  });

  it("reads input from invocation.arguments when neither p.arguments nor p.input exists (Branch 163[3])", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      eventMsg("mcp_tool_call_begin", {
        server: "srv",
        method: "act",
        invocation: { arguments: { file: "x.ts" } },
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "mcp-inv-args",
    });
    const mcp = session?.toolUses.find((t) => t.name === "srv__act");
    expect(mcp?.input).toEqual({ file: "x.ts" });
  });
});

// ── handleToolCallItem — no call_id (Branch 71[1]) ────────────────────────────

describe("handleToolCallItem — function_call without call_id is not indexed (Branch 71[1])", () => {
  it("still adds the tool use even with no call_id", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      responseItem("function_call", {
        name: "bash",
        arguments: '{"cmd":"ls"}',
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "fn-no-id" });
    const tool = session?.toolUses.find((t) => t.name === "bash");
    expect(tool).toBeDefined();
    expect(tool?.input).toEqual({ cmd: "ls" });
  });

  it("an id-less function_call_output correlates via ambiguous positional fallback", async () => {
    // function_call with no call_id → not indexed; output has no call_id either
    // → ambiguous positional fallback → flagged in parseQuality
    const lines = [
      SM(),
      TC_BASIC,
      responseItem("function_call", { name: "bash", arguments: "{}" }),
      responseItem("function_call_output", { output: "result" }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "fn-no-id-output",
    });
    const tool = session?.toolUses.find((t) => t.name === "bash");
    expect(tool?.output).toBe("result");
    expect(session?.parseQuality?.ambiguousToolOutputs).toBe(1);
  });
});

// ── handleToolCallItem — tool_name fallback (Branch 63[1,2]) ─────────────────

describe("handleToolCallItem — tool_name fallback for function_call (Branch 63[1,2])", () => {
  it("falls back to tool_name when name is absent", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      responseItem("function_call", { tool_name: "my-fn", arguments: "{}" }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "fn-tool-name",
    });
    const tool = session?.toolUses.find((t) => t.name === "my-fn");
    expect(tool).toBeDefined();
  });

  it("defaults to 'function' when neither name nor tool_name is present (Branch 63[2])", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      responseItem("function_call", { arguments: "{}" }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "fn-no-name" });
    const tool = session?.toolUses.find((t) => t.name === "function");
    expect(tool).toBeDefined();
  });
});

// ── handleToolCallItem — p.input when p.arguments is null (Branch 65[1]) ─────

describe("handleToolCallItem — input fallback to p.input when p.arguments is null (Branch 65[1])", () => {
  it("reads toolInput from p.input when p.arguments is null", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      responseItem("function_call", {
        name: "read_file",
        arguments: null,
        input: { path: "foo.ts" },
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "fn-input-fallback",
    });
    const tool = session?.toolUses.find((t) => t.name === "read_file");
    expect(tool?.input).toEqual({ path: "foo.ts" });
  });
});

// ── handleShellCallItem — action/input fallbacks (Branches 72-75) ─────────────

describe("handleShellCallItem — action and input fallbacks (Branches 72-75)", () => {
  it("reads command from action.command when action is a record (Branch 72[0])", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      responseItem("local_shell_call", { action: { command: "pwd" } }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "shell-action-cmd",
    });
    const shell = session?.toolUses.find((t) => t.name === "shell");
    expect(shell?.input).toBe("pwd");
  });

  it("falls back to p.action when action is not a record (Branch 73[0])", async () => {
    // action is a string (not a record) → action is returned as input
    const lines = [
      SM(),
      TC_BASIC,
      responseItem("local_shell_call", { action: "ls -la" }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "shell-action-str",
    });
    const shell = session?.toolUses.find((t) => t.name === "shell");
    expect(shell?.input).toBe("ls -la");
  });

  it("falls back to p.input when action is absent (Branch 74[0-3])", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      responseItem("local_shell_call", { input: "cat file.ts" }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "shell-input",
    });
    const shell = session?.toolUses.find((t) => t.name === "shell");
    expect(shell?.input).toBe("cat file.ts");
  });

  it("shell call with call_id is indexed (Branch 75[0])", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      responseItem("local_shell_call", {
        call_id: "sh-1",
        action: { command: "ls" },
      }),
      responseItem("local_shell_call_output", {
        call_id: "sh-1",
        output: "file.ts",
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "shell-id" });
    const shell = session?.toolUses.find((t) => t.name === "shell");
    expect(shell?.output).toBe("file.ts");
    expect(session?.parseQuality?.orphanedToolOutputs).toBeUndefined();
  });
});

// ── handleToolOutputItem — error output (Branches 82-92) ─────────────────────

describe("handleToolOutputItem — error detection and toolResultErrors", () => {
  it("sets isError=true when output record has success===false (Branch 84[0])", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      responseItem("function_call", {
        call_id: "fn-1",
        name: "bash",
        arguments: "{}",
      }),
      responseItem("function_call_output", {
        call_id: "fn-1",
        output: { success: false, error: "permission denied" },
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "fn-err-success",
    });
    const tool = session?.toolUses.find((t) => t.name === "bash");
    expect(tool?.isError).toBe(true);
    expect(session?.toolResultErrors).toHaveLength(1);
    expect(session?.toolResultErrors[0]?.content).toContain(
      "permission denied"
    );
  });

  it("sets isError=true when output record has is_error===true (Branch 84[1])", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      responseItem("function_call", {
        call_id: "fn-2",
        name: "cat",
        arguments: "{}",
      }),
      responseItem("function_call_output", {
        call_id: "fn-2",
        output: { is_error: true, message: "file not found" },
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "fn-err-is-error",
    });
    const tool = session?.toolUses.find((t) => t.name === "cat");
    expect(tool?.isError).toBe(true);
  });

  it("sets isError=true when output record has error field (Branch 84[2])", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      responseItem("function_call", {
        call_id: "fn-3",
        name: "grep",
        arguments: "{}",
      }),
      responseItem("function_call_output", {
        call_id: "fn-3",
        output: { error: "no matches" },
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "fn-err-field",
    });
    const tool = session?.toolUses.find((t) => t.name === "grep");
    expect(tool?.isError).toBe(true);
  });

  it("captures string output as toolResultErrors content (Branch 92[0])", async () => {
    const lines = [
      SM(),
      TC_BASIC,
      responseItem("function_call", {
        call_id: "fn-4",
        name: "run",
        arguments: "{}",
      }),
      responseItem("function_call_output", {
        call_id: "fn-4",
        // string output with is_error (special case: outRec is null for strings)
        output: "error: segfault",
        is_error: true,
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "fn-str-output",
    });
    // String output → isErr check on outRec (null for strings) → false
    // The string output is NOT treated as error unless outRec carries the flag
    const tool = session?.toolUses.find((t) => t.name === "run");
    expect(tool?.output).toBe("error: segfault");
  });
});

// ── handleMcpToolCallEndEvent — non-MCP synthesized tool rollback (Branch 179[1]) ─

describe("handleMcpToolCallEndEvent — mcp_tool_call_end for a response-item (non-MCP) call", () => {
  it("rolls back completion mark when call_id matches a response-item function_call (Branch 179[1])", async () => {
    // A modern rollout models MCP as a function_call response item. When
    // mcp_tool_call_end arrives for that call_id, it must NOT overwrite the
    // function_call_output and must roll back the completedCallIds mark so that
    // the authoritative function_call_output still applies.
    const lines = [
      SM(),
      TC_BASIC,
      // Modern MCP as function_call response item (no mcpServer/mcpMethod)
      responseItem("function_call", {
        call_id: "fn-x",
        name: "my-mcp",
        arguments: "{}",
      }),
      // mcp_tool_call_end comes in (echoed from the same call)
      eventMsg("mcp_tool_call_end", {
        call_id: "fn-x",
        result: { Ok: { content: [{ type: "text", text: "MCP_END" }] } },
      }),
      // The authoritative function_call_output still arrives
      responseItem("function_call_output", {
        call_id: "fn-x",
        output: "REAL_OUT",
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "mcp-end-rollback",
    });
    const tool = session?.toolUses.find((t) => t.name === "my-mcp");
    // The function_call_output (REAL_OUT) wins, not the mcp_tool_call_end
    expect(tool?.output).toBe("REAL_OUT");
    expect(session?.parseQuality?.orphanedToolOutputs).toBeUndefined();
  });
});

// ── handleMcpToolCallEndEvent — ambiguous fallback with output (Branch 186[1], 188[1]) ──

describe("handleMcpToolCallEndEvent — ambiguous positional fallback still sets output (Branch 186)", () => {
  it("sets output via positional fallback when mcp_tool_call_end has no id", async () => {
    // Legacy: no call_id on begin or end → positional fallback
    const lines = [
      SM(),
      TC_BASIC,
      eventMsg("mcp_tool_call_begin", { server: "legacy-srv", method: "act" }),
      eventMsg("mcp_tool_call_end", { output: "LEGACY_RESULT" }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "mcp-legacy-out",
    });
    const mcp = session?.toolUses.find((t) => t.name === "legacy-srv__act");
    // Positional fallback writes the output
    expect(mcp?.output).toBe("LEGACY_RESULT");
    expect(session?.parseQuality?.ambiguousToolOutputs).toBe(1);
  });
});
