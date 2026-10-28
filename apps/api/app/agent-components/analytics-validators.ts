import { MAX_VERSION_USAGE_ENTRIES } from "@repo/api/src/types/agent-component-version-usage";
import { z } from "zod";
import { repeatedQueryArray } from "@/lib/repeated-query-array";
import { decodeTokenTrendCursor } from "./token-trend-cursor";

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
 *   `cursor`  — a prior response's `nextCursor` (ISS-9851).
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

// ISS-9851: the position a prior response's `nextCursor` names, decoded HERE so
// a token this endpoint did not mint is a clean 400. Left as a string it would
// reach the read as a uuid comparison against garbage, which is a 500.
const tokenTrendCursorParam = z
  .string()
  .trim()
  .min(1)
  .transform((value, ctx) => {
    const cursor = decodeTokenTrendCursor(value);
    if (cursor) {
      return cursor;
    }
    ctx.addIssue({
      code: "custom",
      message: "must be a nextCursor returned by this endpoint",
    });
    return z.NEVER;
  });

export const tokenTrendQuerySchema = z.object({
  userId: z.string().trim().min(1).optional(),
  since: isoDateString.optional(),
  until: isoDateString.optional(),
  cursor: tokenTrendCursorParam.optional(),
});

export type TokenTrendQueryParams = z.infer<typeof tokenTrendQuerySchema>;

// FEA-3590: `since`/`until` stay optional on the wire (the shipped clients send
// neither), but a param-less request must not fan the whole usage corpus into
// the API heap. When no lower bound is supplied the service defaults `since` to
// this many days before the window's upper bound (or now), so a param-less read
// over a hot component (e.g. the `general-purpose` subagent) fetches a bounded
// recent window instead of the component's entire history + nested token arrays.
export const DEFAULT_TOKEN_TREND_LOOKBACK_DAYS = 90;

// Hard cap on the number of `agentComponentSessionUsage` rows ONE token-trend
// read materializes, mirroring `MAX_ORG_ORPHAN_USAGE_ROWS` in `./service` so
// every org-scoped usage read shares one bound. A backstop below the defaulted
// date window: an org hot enough to exceed this within the window answers with
// the most recent sessions (the read orders `sessionStartedAt desc`) rather than
// OOMing the request. ISS-9851: it bounds the REQUEST, not what the caller can
// reach — such a response carries a `nextCursor` for the sessions after it.
export const MAX_TOKEN_TREND_USAGE_ROWS = 20_000;

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

// ---------------------------------------------------------------------------
// Per-version usage drill-down (ISS-10467) / side-by-side compare (ISS-10468)
// ---------------------------------------------------------------------------

/**
 * Query-param schema for GET /agent-components/{slug}/version-usage.
 *
 * `version` is REPEATED, one per content version to answer for — one for the
 * drill-down, two or more for the compare — and is deduped and capped by the
 * shared `repeatedQueryArray` primitive (ISS-9073). The cap REJECTS rather than
 * clamps: silently dropping a version the caller named would answer a different
 * question than the one asked, which is the whole failure mode a compare
 * surfaces.
 *
 * The element is the coarse content hash the detail's version selector keys on
 * (`ComponentVersion.hash`), matched as lowercase hex so a malformed value is a
 * clean 400 rather than a wildcard reaching the usage predicate.
 */
export const versionUsageQuerySchema = z.object({
  version: repeatedQueryArray(
    z
      .string()
      .trim()
      .regex(/^[0-9a-f]{8,128}$/, {
        message: "must be a lowercase-hex content hash",
      }),
    MAX_VERSION_USAGE_ENTRIES
  ).default([]),
});

export type VersionUsageQueryParams = z.infer<typeof versionUsageQuerySchema>;
