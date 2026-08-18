/**
 * FEA-2650: golden-mode walkthrough encoding slot.
 *
 * Findings come ONLY from a human walking `just desktop-golden` against the
 * dossiers. The walkthrough itself is explicitly OUT of scope for automated
 * builds — this file exists to give findings a typed, version-controlled home
 * the moment the first human walkthrough generates one.
 *
 * Triage flow per finding:
 *   bug       → file a FEA ticket under PRD-516, encode the test, add a
 *               divergence registry entry citing the ticket.
 *   defined   → the semantic was undefined; a human defines the correct
 *               behavior, then encode the test (hard assertion, no registry).
 *   pinned    → behavior is correct; encode the test as a pin (hard assertion)
 *               documenting the intentional contract.
 *
 * Each finding becomes a test in golden-layer4.ts (or a sibling file) plus,
 * if divergent, a golden-layer4-divergences.ts entry citing its ticket.
 * Agents must NEVER populate this file — only humans author findings.
 */

export type WalkthroughFinding = {
  screen: "dashboard" | "sessions" | "branches";
  surface: string;
  observation: string;
  triage: "bug" | "defined" | "pinned";
  ticket?: string;
  encodedIn?: string;
  note: string;
};

export const WALKTHROUGH_FINDINGS: WalkthroughFinding[] = [];
