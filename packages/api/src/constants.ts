/** Regex for YYYY-MM-DD date-only strings. */
export const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Score characterization cutoffs used by judge analytics. */
export const JUDGE_THRESHOLDS = {
  stubbornness: { stubborn: 0.1, openMinded: 0.3 },
  optimism: { optimistic: 0.65, critical: 0.35 },
  certainty: { decisive: 0.6, uncertain: 0.5 },
  polarity: { polarizing: 0.65 },
  minScoreCount: 10,
} as const;
