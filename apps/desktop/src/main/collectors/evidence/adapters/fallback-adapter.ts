/**
 * @file fallback-adapter.ts
 * @description FEA-2268: the adapter used for an unknown/unregistered harness.
 * It categorizes nothing (structural-only degradation) and reads only the
 * harness-AGNOSTIC declared conventions — the `mcp__` tool-name prefix and the
 * normalized `skillName` field — never any vendor-specific tool name. This is
 * what makes a future harness yield well-formed (if thin) evidence instead of
 * throwing.
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

export const fallbackAdapter: HarnessAdapter = {
  categorize(_tool: NormalizedToolUse): StructuralCategory | null {
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
    return mcpDeclaredFromTool(tool);
  },
};
