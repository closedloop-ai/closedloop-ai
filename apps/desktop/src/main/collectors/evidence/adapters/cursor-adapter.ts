/**
 * @file cursor-adapter.ts
 * @description FEA-2268: Cursor harness adapter. Cursor emits a `file_edit`
 * marker for edits and otherwise resolves tool names best-effort, defaulting to
 * the opaque `"tool"` literal when no name is present — which categorizes to
 * `null` (unknown, not an error). Concrete Cursor tool-name strings live ONLY here.
 */
import type { NormalizedToolUse } from "../../types.js";
import {
  type HarnessAdapter,
  mcpDeclaredFromTool,
  type StructuralCategory,
  ToolCategory,
} from "../evidence-model.js";

// Cursor file-edit markers (cursor-parser's file-edit handler aliases).
const MUTATE_CODE_TOOLS = new Set(["file_edit", "apply_edit", "code_edit"]);

// Recognizable command-execution names (cursor-parser's tool-call aliases that
// denote a shell/terminal run); the generic `"tool"` default is NOT here, so it
// falls through to null.
const RUN_COMMAND_TOOLS = new Set(["terminal_command", "command_execution"]);

export const cursorAdapter: HarnessAdapter = {
  categorize(tool: NormalizedToolUse): StructuralCategory | null {
    if (MUTATE_CODE_TOOLS.has(tool.name)) {
      return ToolCategory.MutateCode;
    }
    if (RUN_COMMAND_TOOLS.has(tool.name)) {
      return ToolCategory.RunCommand;
    }
    return null;
  },

  // Cursor sets no skill/MCP fields; only the agnostic `mcp__` name convention
  // can surface a declared call — the shared rule covers it exactly.
  declaredFromTool: mcpDeclaredFromTool,
};
