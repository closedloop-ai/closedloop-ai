/**
 * FEA-2650: ticket-keyed registry of known DISPLAY/SEMANTIC divergences from
 * the chart semantic contracts (Layer 4).
 *
 * An entry here means: "the query or render surface currently produces a value
 * that disagrees with the SPECIFIED semantic contract, and <ticket> tracks the
 * fix." The Layer 4 runner pins the current (wrong) value and reports these as
 * expected-fails so CI stays green — and FAILS LOUDLY when the divergence stops
 * reproducing, forcing a human to delete the entry and promote the assertion.
 *
 * Key namespace: `render.*` — display/semantic scope, disjoint from Layer 1's
 * expectations.yaml paths and Layer 2's `store.*` scope.
 *
 * Rules (same governance as L1/L2):
 * - Every entry MUST cite a real ticket (FEA-*).
 * - `actual` pins the current (wrong) value: drift to a THIRD value fails hard.
 * - Entries are added ONLY for reds observed in an actual run — never
 *   pre-registered from prediction.
 * - Only humans adjudicate additions: agents PROPOSE entries in a PR, the
 *   reviewer owns accepting them (packages/golden-sessions/AGENTS.md).
 */
import { InsightsTileAvailabilityState } from "@closedloop-ai/loops-api/insights";
import type { KnownDivergence } from "./golden-divergences.js";

export const LAYER4_CORPUS_SENTINEL = "golden-l4-corpus";

export const LAYER4_KNOWN_DIVERGENCES: KnownDivergence[] = [
  {
    sessionId: LAYER4_CORPUS_SENTINEL,
    key: "render.delivery.charts.branchesWithoutPr",
    ticket: "ISS-5828",
    actual: [],
    note: "Offline Desktop lacks account-scoped repository-default authority.",
  },
  {
    sessionId: LAYER4_CORPUS_SENTINEL,
    key: "render.delivery.tileAvailability.chart:branchesWithoutPr",
    ticket: "ISS-5828",
    actual: InsightsTileAvailabilityState.Unavailable,
    note: "The chart fails closed when repository authority is unavailable.",
  },
  {
    sessionId: LAYER4_CORPUS_SENTINEL,
    key: "render.delivery.tileAvailability.chart:branchesWithoutPr:donut",
    ticket: "ISS-5828",
    actual: InsightsTileAvailabilityState.Unavailable,
    note: "The donut fails closed when repository authority is unavailable.",
  },
];

export function findLayer4Divergence(
  sessionId: string,
  key: string
): KnownDivergence | undefined {
  return LAYER4_KNOWN_DIVERGENCES.find(
    (d) => d.sessionId === sessionId && d.key === key
  );
}
