/**
 * Parse a wire or stored NUMBER input into a finite number.
 *
 * A blank or whitespace-only string is rejected rather than converted:
 * `Number("")` and `Number(" ")` are both `0`, a fabricated measurement that
 * the repo's "never persist a bad value" rule forbids reaching a column. The
 * finiteness check is the other half — `"1e400"`, `"Infinity"` and `"NaN"` all
 * survive `Number.isNaN`, so it alone does not bound the domain.
 */
export function parseFiniteNumberInput(value: string | number): number | null {
  if (typeof value === "string" && value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
