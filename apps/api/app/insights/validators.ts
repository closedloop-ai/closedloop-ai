import {
  INSIGHTS_PERIOD_OPTIONS,
  INSIGHTS_SCOPE_OPTIONS,
  InsightsPeriod,
  InsightsScope,
} from "@repo/api/src/types/insights";
import { z } from "zod";
import { canonicalizeTimeZone } from "@/lib/date-only";

// FEA-2745: the caller's IANA timezone used to label the daily buckets in the
// requester's local calendar (matching the desktop shell, which buckets in
// local time via localDay()). Unknown or malformed zones are silently dropped
// so the server falls back to UTC bucketing rather than 400-ing a chart
// request.
//
// FEA-2881 (review): `Intl` also accepts offset-style zones like `+01:00`, but
// PostgreSQL's `AT TIME ZONE 'text'` operator interprets bare offsets with an
// inverted sign, so an un-normalized offset buckets SQL rows onto the wrong
// local day (misaligned with the `Intl`-labeled response keys). Canonicalize
// here — the single seam every downstream consumer (SQL `date_trunc` bucketing
// and JS day-key labeling) reads from — so offsets become their equivalent
// `Etc/GMT±N` IANA name (which PG and `Intl` interpret identically) and any zone
// that can't be safely canonicalized falls back to UTC.
const timeZoneValidator = z
  .string()
  .optional()
  .transform((timeZone) =>
    timeZone ? (canonicalizeTimeZone(timeZone) ?? undefined) : undefined
  );

const rawInsightsQueryValidator = z.object({
  period: z.enum(INSIGHTS_PERIOD_OPTIONS).default(InsightsPeriod.Quarter),
  scope: z.enum(INSIGHTS_SCOPE_OPTIONS).default(InsightsScope.Me),
  teamId: z.string().uuid("Must be a valid UUID").optional(),
  timeZone: timeZoneValidator,
});
const rawInsightsQueryPreprocessor = z.object({
  period: z.enum(INSIGHTS_PERIOD_OPTIONS).optional(),
  scope: z.enum(INSIGHTS_SCOPE_OPTIONS).optional(),
  teamId: z.string().uuid("Must be a valid UUID").optional(),
  timeZone: z.string().optional(),
});

export const insightsQueryValidator = z
  .preprocess((value) => {
    const parsed = rawInsightsQueryPreprocessor.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.teamId === undefined ||
      parsed.data.scope !== undefined
    ) {
      return value;
    }
    return { ...parsed.data, scope: InsightsScope.Team };
  }, rawInsightsQueryValidator)
  .superRefine((params, ctx) => {
    if (params.scope === InsightsScope.Team && params.teamId === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "teamId is required when scope is team",
        path: ["teamId"],
      });
    }
    if (params.scope !== InsightsScope.Team && params.teamId !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "teamId requires scope team",
        path: ["teamId"],
      });
    }
  });

export type InsightsQuery = z.infer<typeof insightsQueryValidator>;
