/**
 * Count above which the Agents badge renders `9+` rather than the raw number, so
 * a long-idle surface never overflows the pill. The accessible name still
 * announces the true count.
 */
export const AGENTS_NAV_BADGE_MAX = 9;

/** What the Agents count counts, in both grammatical numbers. */
export const AGENTS_NAV_COUNT_NOUN = {
  one: "recently finished session",
  other: "recently finished sessions",
} as const;
