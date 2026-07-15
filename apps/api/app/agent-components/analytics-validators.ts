import { z } from "zod";

// ---------------------------------------------------------------------------
// Token trend (slug route)
// ---------------------------------------------------------------------------

/**
 * Query-param schema for GET /agent-components/{slug}/token-trend.
 *
 * All params are optional:
 *   `userId`  — scope to a specific user (personal view).
 *   `since`   — ISO date string, earliest session to include (inclusive).
 *   `until`   — ISO date string, latest session to include (inclusive).
 */
// A permissive ISO date/datetime string. `z.string().datetime()` alone rejects
// date-only values like "2026-07-11"; allow either an RFC 3339 datetime or a
// bare calendar date so a valid `since=2026-07-11` is accepted while garbage
// ("not-a-date") is a clean 400 instead of an Invalid Date that reaches Prisma
// and throws a 500.
const isoDateString = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(new Date(value).getTime()), {
    message: "must be a valid ISO date or datetime string",
  });

export const tokenTrendQuerySchema = z.object({
  userId: z.string().trim().min(1).optional(),
  since: isoDateString.optional(),
  until: isoDateString.optional(),
});

export type TokenTrendQueryParams = z.infer<typeof tokenTrendQuerySchema>;

// ---------------------------------------------------------------------------
// Ranking / compliance leaderboard limit
// ---------------------------------------------------------------------------

// Shared max for the org-analytics leaderboards (ranking + compliance).
export const ANALYTICS_LIMIT_MAX = 200;
export const ANALYTICS_LIMIT_DEFAULT = 50;

// Coerce + validate the `limit` query param: a positive integer, capped at
// ANALYTICS_LIMIT_MAX, defaulting to ANALYTICS_LIMIT_DEFAULT when omitted.
// `Number("abc")` → NaN and negative values previously slipped through to
// `slice(0, NaN)` (silent empty leaderboard) or a from-the-end slice.
const analyticsLimit = z.coerce
  .number()
  .int()
  .positive()
  .max(ANALYTICS_LIMIT_MAX)
  .default(ANALYTICS_LIMIT_DEFAULT);

export const rankingQuerySchema = z.object({
  kind: z.string().trim().min(1).optional(),
  limit: analyticsLimit,
});

export type RankingQueryParams = z.infer<typeof rankingQuerySchema>;

export const complianceQuerySchema = z.object({
  limit: analyticsLimit,
});

export type ComplianceQueryParams = z.infer<typeof complianceQuerySchema>;
