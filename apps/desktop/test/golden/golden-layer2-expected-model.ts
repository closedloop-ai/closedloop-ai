/**
 * @file golden-layer2-expected-model.ts
 * @description ISS-4649 finding 8: the Layer 2 oracle for `sessions.model` —
 * what the store's model column SHOULD hold for a given normalized session.
 * Extracted from `golden-layer2.ts`, which is at the file-size ceiling and
 * shrink-only (see `biome.jsonc`), so this rule grows here instead of there —
 * the same reason `golden-layer2-cell-normalization.ts` lives beside it.
 *
 * DELIBERATELY RESTATED, never imported from
 * `src/main/database/session-model-backfill.ts`. An oracle that calls the
 * implementation under test is a tautology: it would go green on any change to
 * the selector, including a revert to the positional `tokenSeries.at(-1)` read
 * that this finding is about. Root AGENTS.md's golden contract — a red golden
 * test means the collector is wrong by default — only holds while the oracle is
 * independent of the collector. The cost is that this has to be kept in step by
 * hand, which is why it states the RULE in its own terms rather than mirroring
 * the implementation's structure.
 */
import type { NormalizedSession } from "../../src/main/collectors/types.js";

/**
 * The model the store should hold for `input`.
 *
 * The rule, in its own terms:
 *  - a session that names its own model keeps it;
 *  - otherwise the model is derived from `tokensByModel`, whose nonblank keys
 *    are the ONLY admissible answers — the raw `tokenSeries` may name labels the
 *    aggregate deliberately excludes (Codex remaps `codex-auto-review` out of it
 *    because it is a reviewer label, not a model);
 *  - one admissible key is the answer outright;
 *  - with several, the session's own round trips decide — records carrying a
 *    `subagentId` came from a folded subagent and do not describe the parent, so
 *    they are consulted only when the parent contributes nothing;
 *  - among those, the latest by parseable timestamp wins (position is NOT
 *    chronology: both folds append a child's series after the root's own);
 *  - and when several models remain with no parseable timestamp between them,
 *    there is no honest answer, so the expected value is `null`.
 */
export function expectedSessionModel(input: NormalizedSession): string | null {
  if (input.model) {
    return input.model;
  }
  const modelKeys = admissibleModels(input);
  if (modelKeys.length <= 1) {
    return modelKeys[0] ?? null;
  }
  const admissible = new Set(modelKeys);
  const usable = (input.tokenSeries ?? []).filter((entry) =>
    admissible.has(entry.model?.trim() ?? "")
  );
  const parentOwned = usable.filter((entry) => entry.subagentId === undefined);
  const candidates = parentOwned.length > 0 ? parentOwned : usable;
  const distinct = new Set(candidates.map((entry) => entry.model.trim()));
  if (distinct.size === 1) {
    return candidates[0]?.model.trim() ?? null;
  }
  return latestByTimestamp(candidates);
}

/** The nonblank, de-duplicated `tokensByModel` keys, in declaration order. */
function admissibleModels(input: NormalizedSession): string[] {
  return [
    ...new Set(
      Object.keys(input.tokensByModel ?? {})
        .map((key) => key.trim())
        .filter((key) => key.length > 0)
    ),
  ];
}

/** The model of the record with the greatest parseable timestamp, else `null`. */
function latestByTimestamp(
  candidates: readonly { timestamp: string; model: string }[]
): string | null {
  let expected: string | null = null;
  let latest = Number.NEGATIVE_INFINITY;
  for (const entry of candidates) {
    const at = Date.parse(entry.timestamp);
    if (!Number.isNaN(at) && at >= latest) {
      latest = at;
      expected = entry.model.trim();
    }
  }
  return expected;
}
