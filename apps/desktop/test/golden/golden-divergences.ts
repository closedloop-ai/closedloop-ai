/**
 * FEA-2646: ticket-keyed registry of known collector-side divergences from the
 * signed golden dossiers (packages/golden-sessions).
 *
 * A entry here means: "the parser currently disagrees with the oracle on this
 * dossier key, the oracle was confirmed right, and <ticket> tracks the
 * collector fix." The Layer 1 runner reports these as expected-fails so CI stays
 * green — and FAILS LOUDLY if the divergence stops reproducing, forcing
 * deletion of the entry and promotion of the key to a hard assertion.
 *
 * Rules:
 * - Every entry MUST cite a real ticket (FEA-* or ISS-* — the platform renamed
 *   FEA → ISS; both prefixes resolve).
 * - `actual` pins the parser's current (wrong) value: if the parser drifts to a
 *   THIRD value, that is a new regression and the runner fails hard.
 * - Entries for sessions not present in the corpus are inert (allows pre-seeding
 *   an entry for a dossier that arrives via a separate PR).
 * - Adjudication: agents may PROPOSE an entry in a PR; the reviewer owns
 *   accepting it (packages/golden-sessions/AGENTS.md).
 */

export type KnownDivergence = {
  /** Dossier directory name under packages/golden-sessions/ */
  sessionId: string;
  /** expectations.yaml key path the parser diverges on (e.g. "turns.user") */
  key: string;
  /** Tracking ticket for the collector fix */
  ticket: string;
  /** The parser's current (wrong) value, pinned so further drift fails hard */
  actual: unknown;
  /** One-line human-readable description of the divergence */
  note: string;
};

export const KNOWN_DIVERGENCES: KnownDivergence[] = [
  // FEA-3124 (turns.user) entries resolved 2026-07-17: the mechanical-count
  // ruling amended four oracles to the parser's values and the /exit parser
  // fix matched the fifth — all five keys are hard assertions now.
  // FEA-3125 (turns.assistant) entries resolved 2026-07-17: assistantMessages
  // now counts event_msg token_count records (billable API round-trips) per
  // the 2026-07-14 ruling. All six keys are hard assertions now.
  // FEA-3126 resolved: reasoning_output_tokens is a SUBSET of output_tokens
  // (input+output==total). Parser fix removes the double-add — all 9 entries
  // (3 unit-wide + 6 per-child) are now hard assertions.
  // FEA-3127 (session.lifecycle.compacted) entries resolved 2026-07-17: the
  // codex parser now maps `compacted` records / `context_compacted` events
  // into compactions (a paired record+echo counts once). Both keys are hard
  // assertions now.
];

export function findDivergence(
  sessionId: string,
  key: string
): KnownDivergence | undefined {
  return KNOWN_DIVERGENCES.find(
    (d) => d.sessionId === sessionId && d.key === key
  );
}
