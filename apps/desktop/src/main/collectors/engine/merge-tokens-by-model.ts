/**
 * @file merge-tokens-by-model.ts
 * @description Additive per-model token merge shared by the collector fold
 * paths. Both the Codex descendant fold (`foldCodexDescendants`) and the
 * OpenCode subagent fold (`foldOpencodeSubagents`) aggregate a child session's
 * `tokensByModel` into its root parent so the root's totals include its
 * subagents' spend; keeping the merge here is the one SSOT so the two folds
 * cannot drift.
 */
import type { NormalizedTokenCounts } from "../types.js";

/** Merge `source` token totals into `target` in place (per-model additive). */
export function mergeTokensByModel(
  target: Record<string, NormalizedTokenCounts>,
  source: Record<string, NormalizedTokenCounts>
): void {
  for (const [model, counts] of Object.entries(source)) {
    const existing = target[model];
    target[model] = {
      input: (existing?.input ?? 0) + counts.input,
      output: (existing?.output ?? 0) + counts.output,
      cacheRead: (existing?.cacheRead ?? 0) + counts.cacheRead,
      cacheWrite: (existing?.cacheWrite ?? 0) + counts.cacheWrite,
      ...(existing?.inferred || counts.inferred ? { inferred: true } : {}),
    };
  }
}
