/**
 * ISS-8184: the single cross-surface flag key gating LOC terminology on the
 * Insights volume metrics.
 *
 * ONE key for both shells: the Insights tiles and the AI-Impact card mount from
 * `@repo/app` on the web shell and the desktop renderer alike, and the desktop
 * resolves the signed-in account's PostHog assignment from the same key space
 * the web reads.
 *
 * What the ON shape changes is a NUMBER as well as a word. The operator ruled on
 * 2026-09-18 that the thousand-line scale factor is deleted rather than
 * disclosed, so `Tokens per KLOC` becomes `Tokens per LOC` (ruling 5) and the rendered
 * value falls by 1000x. Both shapes therefore need their own operand — which is
 * why the producers emit the raw-LOC KPIs and the `locTrend` series alongside
 * the KLOC ones rather than converting at the consumer.
 *
 * Default OFF.
 */
export const INSIGHTS_LOC_TERMINOLOGY_FLAG_KEY =
  "insights-loc-terminology" as const;

/**
 * The rendered volume labels, canonical because a PRODUCER and the CATALOG must
 * agree on them and nothing else makes them.
 *
 * The catalog supplies the card heading and the metric picker's option text, so
 * a producer spelling these differently puts two names on one metric.
 *
 * The two labels are DELIBERATELY different: cloud sums merged PRs and desktop
 * sums every captured PR (FEA-2947), so one label would assert a population
 * match nobody measured. Tests pin them as literals on purpose — a fixture
 * importing these constants agrees with any future edit to them.
 */
export const MERGED_LOC_LABEL = "Merged LOC" as const;
export const CAPTURED_LOC_LABEL = "Captured LOC" as const;
/**
 * ISS-8184 ruling 5 harmonised the unit noun: the ratio reads `Tokens per LOC`,
 * not `Tokens per line`, which ruling 1 had chosen. That wording is superseded; the VALUE is
 * unchanged, still tokens over raw lines.
 */
export const TOKENS_PER_LOC_LABEL = "Tokens per LOC" as const;
