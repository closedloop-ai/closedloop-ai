/**
 * FEA-4250: canonical KLOC (thousand-lines-of-code) VOLUME math, shared by the
 * cloud session projection (`apps/api`) and the desktop local reader. Kept here
 * in the contract package so there is a single definition both sides import
 * instead of re-deriving it.
 *
 *   KLOC = totalLines / 1000
 *
 * `totalLines` is added + removed (lines *changed*), NOT additions only, so a
 * single session's volume reads on the same basis as the aggregates it rolls
 * into.
 *
 * ISS-4667: the cost-EFFICIENCY metric that used to live here no longer does.
 * It is LOC/$ (raw lines per dollar, NO divide-by-1000, higher is better) and
 * its SSOT is `./loc-per-dollar.ts`; never derive a per-dollar figure from KLOC.
 *
 * ISS-8184 retired KLOC from the rendered vocabulary — a reader sees raw lines
 * under "Merged LOC" / "Captured LOC". What survives is the WIRE spelling: the
 * `kloc` keys keep emitting alongside their raw-line twins so a version-skewed
 * client still resolves them, and the flag-off shape still renders them.
 */

/**
 * KLOC from a line count. Returns `null` when there is no measurable churn (or a
 * non-finite input) rather than a misleading `0`, so callers render a placeholder.
 */
export function klocFromLines(totalLines: number): number | null {
  if (!(Number.isFinite(totalLines) && totalLines > 0)) {
    return null;
  }
  return totalLines / 1000;
}
