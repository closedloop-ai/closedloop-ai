// Categorical palette tokens defined in globals.css (--chart-1..10). Public
// package entry (registered in tsup.config.ts + package.json `exports`) so
// surface code can reuse the shared chart palette instead of redefining it.
export const CHART_COLOR_TOKENS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
  "var(--chart-9)",
  "var(--chart-10)",
] as const;

export function chartColor(index: number): string {
  const count = CHART_COLOR_TOKENS.length;
  if (!Number.isFinite(index)) {
    return CHART_COLOR_TOKENS[0];
  }
  // True modulo so negative/non-integer indexes still land in 0..count-1
  // (`%` alone yields a negative remainder → an out-of-bounds `undefined`).
  const slot = ((Math.trunc(index) % count) + count) % count;
  return CHART_COLOR_TOKENS[slot] ?? CHART_COLOR_TOKENS[0];
}
