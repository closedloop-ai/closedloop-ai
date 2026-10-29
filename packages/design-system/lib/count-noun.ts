/**
 * The `{count} {noun}` vocabulary, in a module with NO component imports.
 *
 * It lived on `count-cell.tsx` until ISS-9574 gave `TableSelectionAnnouncer` the
 * same sentence, at which point importing it from there made every bundle that
 * renders a bulk rail drag in the count cell plus `Chip`, `GridEmptyValue`,
 * `Skeleton` and radix `Slot` behind them — for a five-line function and a type
 * (marisolashgrove, PR #7320). Single-sourcing the noun was right; the module was
 * not. This package's rule is that constants a broad client surface imports live
 * in a lightweight module the heavy consumers import in turn, not the reverse.
 */

/**
 * What the count is of. A plain string is used verbatim for every count, which
 * ships "1 linked sessions" — pass the pair whenever the singular differs.
 */
export type CountNoun = Readonly<{ one: string; other: string }> | string;

export function pluralize(noun: CountNoun, count: number): string {
  if (typeof noun === "string") {
    return noun;
  }
  return count === 1 ? noun.one : noun.other;
}
