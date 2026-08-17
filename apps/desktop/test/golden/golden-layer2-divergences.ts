/**
 * FEA-2647: ticket-keyed registry of known STORAGE-side divergences from the
 * signed golden dossiers (packages/golden-sessions) — the Layer 2 sibling
 * of golden-divergences.ts (which is parser-scoped, Layer 1).
 *
 * An entry here means: "the write path (write-core.ts) currently stores a value
 * that disagrees with the INPUT-derived value — even when it happens to match
 * the oracle by coincidence — or a named storage fixture (delete-orphans,
 * idempotency, conservation) currently fails, and <ticket> tracks the storage
 * fix." The
 * Layer 2 runner reports these as expected-fails so CI stays green — and FAILS
 * LOUDLY when the divergence stops reproducing, forcing deletion of the entry
 * and promotion of the key to a hard assertion.
 *
 * Layer-1-INHERITED divergences (the input itself disagrees with the oracle —
 * FEA-3124/3125/3126/3127...) are NOT registered here: the runner resolves them
 * directly against golden-divergences.ts (KNOWN_DIVERGENCES) and reports them as
 * inherited diagnostics. They expire automatically when the parser fix lands and
 * normalized.json is re-blessed per packages/golden-sessions/AGENTS.md.
 *
 * Rules (same as Layer 1, plus one):
 * - Every entry MUST cite a real ticket (FEA-*).
 * - `actual` pins the store's current (wrong) value: drift to a THIRD value
 *   fails hard.
 * - Entries are added ONLY for reds observed in an actual run — never
 *   pre-registered from prediction.
 * - Adjudication: agents PROPOSE entries in a PR (marked "PROPOSED" in the
 *   note); the PR reviewer owns accepting them
 *   (packages/golden-sessions/AGENTS.md; PLN-1337 v3 §2).
 *
 * Key namespace: Layer 2 keys are store-scoped —
 *   "store.session_analytics.<column>", "store.token_usage[<model>].<field>",
 *   "store.delete.orphans", "store.idempotency.<path>", ... — so they can never
 *   collide with Layer 1's expectations.yaml key paths.
 */
import type { KnownDivergence } from "./golden-divergences.js";

export const LAYER2_KNOWN_DIVERGENCES: KnownDivergence[] = [
  // FEA-2347 (FIXED) — deleteSessionRow now purges session_analytics,
  // session_tool_analytics, and agent_component_session_usage, so the
  // `store.delete.orphans` fixture is a hard assertion (oracle []) rather than a
  // registered divergence. Do not re-add these entries.
  // FEA-3228 (fixed by FEA-3294) — first-import component existence now lands
  // before the invocation-backed aggregate relink, so component linkage is a
  // hard assertion again.
  // FEA-3226 (fixed) — session_analytics.agent_turns is now counted
  // transcript-first from the importer's $.assistantMessages metadata count;
  // the 17 remaining store.session_analytics.agent_turns entries stopped
  // reproducing and were removed (the facts are hard assertions again).
  // FEA-3125 had already resolved the three zero-oracle Codex cancellation
  // entries (019e8ee8, 019f0041, 019f004a).
  // FEA-3232 (fixed) — the store.token_events.cost_conservation pin was removed
  // when the conservation fix landed (token_usage.cost := Σ per-request event
  // prices); cost conservation is a hard assertion now.
];

export function findLayer2Divergence(
  sessionId: string,
  key: string
): KnownDivergence | undefined {
  return LAYER2_KNOWN_DIVERGENCES.find(
    (d) => d.sessionId === sessionId && d.key === key
  );
}
