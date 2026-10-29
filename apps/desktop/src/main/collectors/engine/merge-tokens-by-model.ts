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
    // ISS-8565: `target` is caller-owned, so there is no container to swap to a
    // null prototype here — one caller hands us a plain `{}` built two modules
    // away. `hasOwn` is the only presence check that cannot mistake an
    // inherited member for a real bucket, and `defineProperty` DEFINES the key
    // instead of invoking `Object.prototype`'s `__proto__` setter (which would
    // create no own key and discard that model's whole spend). The descriptor
    // matches what a plain assignment creates, so a normal model is unaffected.
    const existing = Object.hasOwn(target, model) ? target[model] : undefined;
    Object.defineProperty(target, model, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: {
        input: (existing?.input ?? 0) + counts.input,
        output: (existing?.output ?? 0) + counts.output,
        cacheRead: (existing?.cacheRead ?? 0) + counts.cacheRead,
        cacheWrite: (existing?.cacheWrite ?? 0) + counts.cacheWrite,
        ...(existing?.inferred || counts.inferred ? { inferred: true } : {}),
      },
    });
  }
}
