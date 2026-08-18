/**
 * FEA-2649 Layer 3 — the captured-PR LOC derivations.
 *
 * Split out of `golden-layer3-derive.ts` (ISS-5412) so the two derivations
 * TAKEN OVER the LOC rows live together, mirroring the production
 * `local-insights-loc.ts` split they are the independent oracle for. The row
 * projection itself (`deriveLocRows` / `LocRowTwin`) stays in the parent beside
 * the artifact-row helpers it is built from. Same reuse policy as the parent:
 * `median` is imported from `@repo/api` because the synthetic suite in
 * `test/golden-layer3-derive.test.ts` covers its edges, so reuse cannot
 * silently bless a broken median.
 */
import { median } from "@repo/api/src/utils/math";
import type { LocRowTwin } from "./golden-layer3-derive.js";

export function deriveMedianPrSize(locRows: LocRowTwin[]): number | null {
  const enriched = locRows
    .filter((r) => r.enriched)
    .map((r) => r.loc)
    .filter((v) => v >= 0);
  return enriched.length > 0 ? (median(enriched) ?? 0) : null;
}

// ISS-5412: `null` when NO captured PR in the window carries line counts —
// the window's KLOC is unknown, not zero. Mirrors the production gate in
// `computeDelivery` (local-insights-delivery.ts) and cloud's `mergedKloc`.
export function deriveKloc(locRows: LocRowTwin[]): number | null {
  if (!locRows.some((r) => r.sized)) {
    return null;
  }
  const total = locRows
    .map((r) => r.loc)
    .filter((v) => v >= 0)
    .reduce((s, v) => s + v, 0);
  return Math.round(total / 100) / 10;
}
