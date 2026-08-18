/**
 * FEA-2649: ticket-keyed registry of known AGGREGATION-layer divergences from
 * the golden corpus expectations — the Layer 3 sibling of
 * golden-divergences.ts (L1, parser) and golden-layer2-divergences.ts (L2,
 * storage).
 *
 * An entry here means: "a query module's output currently disagrees with the
 * corpus expectation (or with the store-derived fidelity twin) on this key, a
 * human confirmed the expectation is right, and <ticket> tracks the fix." The
 * Layer 3 runner reports these as expected-fails so CI stays green — and FAILS
 * LOUDLY when the divergence stops reproducing, forcing a human to delete the
 * entry and promote the key to a hard assertion.
 *
 * Layer-1-INHERITED divergences (the dossier INPUT disagrees with the oracle —
 * FEA-3124/3125/3126/3127/3153) and Layer-2 storage divergences (the store
 * disagrees with the input — FEA-3226..3229) are NOT registered here: the
 * runner resolves them against their own registries first and reports them as
 * inherited diagnostics that expire automatically when the upstream fix lands.
 *
 * Type note (PLN-1340 v3): L1/L2's `KnownDivergence` is keyed `(sessionId,
 * key)` and its sweep treats an unknown sessionId as an inert pre-seed. Layer 3
 * facts are often CORPUS-WIDE (a rollup no single dossier owns), so entries
 * here carry an explicit scope:
 *   - `{ scope: "corpus" }` — a corpus-level aggregate fact. Never inert: the
 *     sweep requires it to fire on every run.
 *   - `{ scope: { sessionId } }` — a per-dossier aggregation fact. Inert only
 *     while that dossier is absent from the corpus (same rule as L2).
 *
 * Rules (same as L1/L2):
 * - Every entry MUST cite a real ticket (FEA-*).
 * - `actual` pins the current (wrong) value: drift to a THIRD value fails hard.
 * - Entries are added ONLY for reds observed in an actual run — never
 *   pre-registered from prediction.
 * - Only humans adjudicate additions: agents PROPOSE entries in a PR (marked
 *   "PROPOSED" in the note), the reviewer owns accepting them
 *   (packages/golden-sessions/AGENTS.md; PLN-1340 v3).
 *
 * Key namespace: Layer 3 keys are aggregation-scoped — "agg.<surface>.<path>"
 * (e.g. "agg.token_analytics.cost_conservation",
 * "agg.insights.delivery.30.kpis.cost") — so they can never collide with
 * Layer 1's expectations.yaml key paths or Layer 2's "store.*" keys.
 */

export type Layer3Scope = "corpus" | { sessionId: string };

export type Layer3KnownDivergence = {
  /** Corpus-wide aggregate vs per-dossier aggregation fact (see header). */
  scope: Layer3Scope;
  /** Aggregation key path, "agg.*" namespace. */
  key: string;
  /** Tracking ticket for the fix. */
  ticket: string;
  /** The current (wrong) value, pinned so further drift fails hard. */
  actual: unknown;
  /** One-line human-readable description of the divergence. */
  note: string;
};

export const LAYER3_KNOWN_DIVERGENCES: Layer3KnownDivergence[] = [
  // (FEA-3232's agg.cost_conservation.events_equal_usage pin was removed when
  // the conservation fix landed — cost conservation is a hard assertion now.)
  // (FEA-4187's agg.workflow.success_rate_vs_signed pin was removed when the
  // corpus-expectations.yaml re-derivation absorbed the corrected 98% value.)
];

export function scopeSessionId(scope: Layer3Scope): string | null {
  return scope === "corpus" ? null : scope.sessionId;
}

export function findLayer3Divergence(
  scope: Layer3Scope,
  key: string
): Layer3KnownDivergence | undefined {
  const sid = scopeSessionId(scope);
  return LAYER3_KNOWN_DIVERGENCES.find(
    (d) => scopeSessionId(d.scope) === sid && d.key === key
  );
}
