/**
 * @file copilot-adapter.ts
 * @description FEA-2268: Copilot harness adapter — the canonical LOW-SIGNAL
 * case. Copilot's parser resolves tool names to the opaque `"copilot_tool"`
 * sentinel and exposes no structured edit/MCP/skill signal, so every tool
 * categorizes to `null`. Copilot sessions therefore lean on the harness-agnostic
 * structural `humanTurnDensity`; FEA-2269 must not fabricate categories here.
 */
import type { NormalizedToolUse } from "../../types.js";
import {
  type HarnessAdapter,
  mcpDeclaredFromTool,
  type StructuralCategory,
} from "../evidence-model.js";

export const copilotAdapter: HarnessAdapter = {
  // Copilot exposes no reliable per-tool category signal (names collapse to the
  // `copilot_tool` sentinel), so every tool degrades to null by design.
  categorize(_tool: NormalizedToolUse): StructuralCategory | null {
    return null;
  },

  // The only declared signal Copilot surfaces is the agnostic `mcp__` name
  // convention — the shared rule covers it.
  declaredFromTool: mcpDeclaredFromTool,
};
