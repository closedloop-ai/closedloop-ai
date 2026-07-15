/**
 * @file codex-adapter.ts
 * @description FEA-2268: Codex harness adapter. Codex normalizes shell calls to
 * the `shell` tool name and edits to `apply_patch`, and is the one harness that
 * populates `mcpServer`/`mcpMethod` (from `mcp_tool_call_begin`). Concrete Codex
 * tool-name strings live ONLY here.
 */
import type { NormalizedToolUse } from "../../types.js";
import {
  type DeclaredEvidence,
  DeclaredKind,
  type HarnessAdapter,
  MCP_TOOL_NAME_PREFIX,
  type StructuralCategory,
  ToolCategory,
} from "../evidence-model.js";

// Codex shell execution: `local_shell_call`/`exec_command` events normalize to
// the `shell` tool name (codex-parser); the raw event names are included
// defensively in case a future parser path surfaces them directly.
const RUN_COMMAND_TOOLS = new Set([
  "shell",
  "local_shell_call",
  "exec_command",
]);

// Codex edits arrive as a single `apply_patch` tool use (sets `diffDelta`).
const MUTATE_CODE_TOOLS = new Set(["apply_patch"]);

export const codexAdapter: HarnessAdapter = {
  categorize(tool: NormalizedToolUse): StructuralCategory | null {
    if (MUTATE_CODE_TOOLS.has(tool.name)) {
      return ToolCategory.MutateCode;
    }
    if (RUN_COMMAND_TOOLS.has(tool.name)) {
      return ToolCategory.RunCommand;
    }
    return null;
  },

  declaredFromTool(tool: NormalizedToolUse): DeclaredEvidence | null {
    // Codex preserves the MCP server/method on the tool use; the display name
    // is already `server__method`. Either signal marks an MCP call.
    if (tool.mcpServer || tool.name.startsWith(MCP_TOOL_NAME_PREFIX)) {
      const name = tool.mcpServer
        ? `${tool.mcpServer}${tool.mcpMethod ? `__${tool.mcpMethod}` : ""}`
        : tool.name;
      return {
        kind: DeclaredKind.McpCall,
        name,
        timestamp: tool.timestamp,
        category: ToolCategory.DeclaredIntent,
      };
    }
    return null;
  },
};
