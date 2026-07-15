/**
 * @file claude-adapter.ts
 * @description FEA-2268: Claude Code harness adapter. Maps Claude's concrete
 * tool names (the verbatim `block.name` claude-parser emits) to abstract
 * categories. This is one of the ONLY places Claude tool-name strings appear.
 */
import type { NormalizedToolUse } from "../../types.js";
import {
  type DeclaredEvidence,
  DeclaredKind,
  type HarnessAdapter,
  mcpDeclaredFromTool,
  type StructuralCategory,
  ToolCategory,
} from "../evidence-model.js";

// Claude emits tool names verbatim from the transcript `block.name`
// (claude-parser.ts). Read-only inspection tools.
const READ_SEARCH_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
]);

// File-mutation tools (Edit/Write set `diffDelta`, claude-parser).
const MUTATE_CODE_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

// Shell command execution.
const RUN_COMMAND_TOOLS = new Set(["Bash"]);

export const claudeAdapter: HarnessAdapter = {
  categorize(tool: NormalizedToolUse): StructuralCategory | null {
    if (READ_SEARCH_TOOLS.has(tool.name)) {
      return ToolCategory.ReadSearch;
    }
    if (MUTATE_CODE_TOOLS.has(tool.name)) {
      return ToolCategory.MutateCode;
    }
    if (RUN_COMMAND_TOOLS.has(tool.name)) {
      return ToolCategory.RunCommand;
    }
    // Skill / Task (subagent spawn) / TodoWrite / MCP calls are not structural
    // tool categories: a skill surfaces via the declared layer (when it carries
    // a skill identifier); the rest contribute no category (unknown → null).
    return null;
  },

  declaredFromTool(tool: NormalizedToolUse): DeclaredEvidence | null {
    if (tool.skillName) {
      return {
        kind: DeclaredKind.Skill,
        name: tool.skillName,
        timestamp: tool.timestamp,
        category: ToolCategory.DeclaredIntent,
      };
    }
    // A bare `Skill` tool use with no `skillName` carries no useful identifier,
    // so it degrades to null (via the shared MCP rule) rather than emitting a
    // misleading `name: "Skill"` declared record.
    return mcpDeclaredFromTool(tool);
  },
};
