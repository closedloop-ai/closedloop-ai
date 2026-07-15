/**
 * @file opencode-adapter.ts
 * @description FEA-2268: OpenCode harness adapter. OpenCode records tool uses as
 * generic part records (default name `"opencode_tool"`) and signals edits via a
 * `patch` part that attaches a `diffDelta` to the tool use — so a mutation is
 * recognized by the harness-agnostic `diffDelta` field rather than a tool name.
 * Concrete OpenCode tool-name strings live ONLY in this file.
 */
import type { NormalizedToolUse } from "../../types.js";
import {
  type HarnessAdapter,
  mcpDeclaredFromTool,
  type StructuralCategory,
  ToolCategory,
} from "../evidence-model.js";

// The OpenCode part type that carries an edit; also the most reliable name hint.
const PATCH_TOOL_NAME = "patch";

export const opencodeAdapter: HarnessAdapter = {
  categorize(tool: NormalizedToolUse): StructuralCategory | null {
    // OpenCode mutations surface as a `diffDelta` on an otherwise generic-named
    // tool use (the `patch` part), so the normalized delta is the authoritative
    // mutate signal; the `patch` name is a secondary hint.
    if (tool.name === PATCH_TOOL_NAME || tool.diffDelta != null) {
      return ToolCategory.MutateCode;
    }
    // The generic `opencode_tool` sentinel and any unrecognized name degrade to
    // null (unknown, not an error).
    return null;
  },

  // The only declared signal OpenCode surfaces is the agnostic `mcp__` name
  // convention — the shared rule covers it.
  declaredFromTool: mcpDeclaredFromTool,
};
