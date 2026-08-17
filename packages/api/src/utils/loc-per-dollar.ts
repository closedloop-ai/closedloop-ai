/**
 * ISS-4667: the canonical LOC/$ ("lines per dollar") code-efficiency metric,
 * shared by the cloud session/component projections (`apps/api`), the desktop
 * local readers (`apps/desktop`), and the app-core surfaces (`packages/app`).
 *
 *   locPerDollar = totalLines / cost      // NO divide-by-1000
 *
 * Higher is better. This is the ONLY unit and orientation for the metric on
 * every surface — never KLOC/$ (which floored a real 4,004-line / $4,574.72
 * session to a misleading `0.00`), and never the inverted $/LOC or $/KLOC.
 *
 * `totalLines` is added + removed (lines *changed*), matching the org-level
 * definition in `apps/api/app/agent-components/loc-per-dollar.ts` and the
 * insights rollup — NOT additions only — so a single session's efficiency reads
 * on the same basis as the aggregates it rolls into, and its numerator/
 * denominator reconcile with the same card's "Lines changed" and "Cost".
 */

/**
 * The canonical user-facing label for the metric. Every surface that names the
 * metric — table column, metric card, view-menu option, KPI tile — reads this
 * constant so the label cannot drift back to "KLOC / $" or "$ / KLOC" in one
 * place while the rest say something else.
 */
export const LOC_PER_DOLLAR_LABEL = "LOC / $";

/**
 * Lines in one KLOC — the legacy unit's scale factor. Only used to convert a
 * version-skewed producer's legacy `klocPerDollar` wire value into the
 * canonical unit; nothing in the current math divides by it.
 */
const LINES_PER_KLOC = 1000;

/**
 * LOC/$ efficiency. Returns `null` when the ratio is genuinely undefined rather
 * than emitting `NaN`/`Infinity` or a misleading `0`:
 *   - no cost to divide by (`cost <= 0` — unpriced / $0), or
 *   - no lines delivered (`totalLines <= 0`), or
 *   - either input is non-finite.
 *
 * A `null` is the honest "not applicable" the UI renders as a placeholder; it is
 * never collapsed to `0`.
 */
export function locPerDollarFromLines(
  totalLines: number,
  cost: number
): number | null {
  if (!(Number.isFinite(totalLines) && totalLines > 0)) {
    return null;
  }
  if (!(Number.isFinite(cost) && cost > 0)) {
    return null;
  }
  return totalLines / cost;
}

/**
 * Cross-version compatibility: convert a legacy `klocPerDollar` wire value
 * (thousand-lines per dollar) emitted by a producer that predates ISS-4667 into
 * the canonical LOC/$ unit. A missing/null/non-finite legacy value stays `null`
 * — an old producer's "unavailable" must not become a fabricated number.
 */
export function locPerDollarFromLegacyKlocPerDollar(
  legacyValue: number | null | undefined
): number | null {
  if (!(typeof legacyValue === "number" && Number.isFinite(legacyValue))) {
    return null;
  }
  // A nonpositive legacy value is not a real efficiency score — reject it rather
  // than scaling it into a fabricated number (ISS-4667 malformed-input guard).
  if (legacyValue <= 0) {
    return null;
  }
  return legacyValue * LINES_PER_KLOC;
}

/**
 * Read the canonical LOC/$ off a wire payload, tolerating version skew. A
 * present canonical value is authoritative (including an explicit `null`, which
 * is the producer's honest "unavailable"); only a payload that OMITS the
 * canonical field (`undefined`) falls back to the producer's legacy KLOC/$
 * value, scaled into LOC/$.
 *
 * A canonical value that is present but not a positive finite number — a
 * negative, zero, `NaN`, or `Infinity` reaching us from a malformed/version-
 * skewed producer — is not a real efficiency score and must not render as one;
 * it is normalized to `null` ("unavailable") here rather than dropping the
 * enclosing payload, so the malformed metric degrades to a placeholder while
 * the rest of the record survives.
 *
 * Every consumer of a `locPerDollar`-carrying payload — session detail,
 * component inventory row, pack analytics, the Sessions delivery summary —
 * reads through this one resolver so the skew rule cannot drift per surface.
 */
export function resolveLocPerDollar(
  canonical: number | null | undefined,
  legacyKlocPerDollar: number | null | undefined
): number | null {
  if (canonical !== undefined) {
    return canonical !== null && Number.isFinite(canonical) && canonical > 0
      ? canonical
      : null;
  }
  return locPerDollarFromLegacyKlocPerDollar(legacyKlocPerDollar);
}

/**
 * Cross-version compatibility (EMIT side): scale a canonical LOC/$ value back
 * DOWN into the legacy KLOC/$ unit for the deprecated `klocPerDollar` /
 * `mergedKlocPerDollar` wire alias.
 *
 * The cloud API deploys ahead of the installed Desktop builds already on
 * people's machines. A pre-ISS-4667 Desktop still reads `usage.mergedKlocPerDollar`
 * (and its `packAnalyticsSchema` REQUIRED `klocPerDollar` before it was made
 * optional), so if the cloud stops emitting those fields the old client's Zod
 * parse fails or its render falls to a neutral dash even though the server has
 * the data. Per AGENTS.md Cross-Repo Compatibility, keep emitting the renamed
 * field as a compatibility alias until a human approves removing the shim.
 *
 * A `null`/non-finite canonical value stays `null` — an "unavailable" LOC/$
 * must not become a fabricated legacy number. This is the exact inverse of
 * {@link locPerDollarFromLegacyKlocPerDollar}.
 */
export function legacyKlocPerDollarFromLoc(
  locPerDollar: number | null | undefined
): number | null {
  if (!(typeof locPerDollar === "number" && Number.isFinite(locPerDollar))) {
    return null;
  }
  if (locPerDollar <= 0) {
    return null;
  }
  return locPerDollar / LINES_PER_KLOC;
}

/**
 * Emit-side helper for a payload that carries the canonical `locPerDollar` plus
 * its deprecated `klocPerDollar` compatibility alias. Spread into the wire object
 * so every producer emits BOTH fields identically for the version-skew window —
 * see {@link legacyKlocPerDollarFromLoc}. One helper so the two fields cannot
 * drift apart per emit site.
 */
export function emitLocPerDollarWithLegacy(locPerDollar: number | null): {
  locPerDollar: number | null;
  klocPerDollar: number | null;
} {
  return {
    locPerDollar,
    klocPerDollar: legacyKlocPerDollarFromLoc(locPerDollar),
  };
}

/**
 * ISS-4866: the merged-scope variant of {@link LOC_PER_DOLLAR_LABEL}.
 *
 * `LOC_PER_DOLLAR_LABEL` names the UNIT, and sharing it is what stops the unit
 * drifting back to "KLOC / $" on one surface. But at least five differently
 * SCOPED metrics now carry that one label — a session's own efficiency, a
 * branch's, an inventory component's, and the Sessions bar's MERGED-only figure
 * — so on a card sitting beside other whole-cohort numbers the bare unit reads
 * as "the efficiency of everything here", which is not what that card computes.
 *
 * Built FROM the shared constant rather than spelled out, so the qualifier can
 * be added without the unit becoming a second place someone could change it.
 */
export const LOC_PER_DOLLAR_MERGED_LABEL =
  `${LOC_PER_DOLLAR_LABEL} (Merged)` as const;
