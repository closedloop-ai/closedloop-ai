/** Shared numeric helpers for desktop session marker derivation. */

export function parseIsoMs(value: string | null | undefined): number {
  if (!value) {
    return Number.NaN;
  }
  return Date.parse(value);
}

export function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}
