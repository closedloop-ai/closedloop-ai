import { z } from "zod";
import {
  type BranchListMetricBundle,
  type BranchListMetricValue,
  type BranchListWindowScopedMetrics,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricDisclosure,
  BranchMetricPeriod,
  type BranchMetricResult,
} from "./branch-metrics.ts";

/** Maximum serialized UTF-8 request size for one exact Branch cohort read. */
export const BRANCH_ANALYTICS_COHORT_MAX_REQUEST_BYTES = 64 * 1024;

const BRANCH_ANALYTICS_COHORT_ID_MAX_CHARS = 512;
const textEncoder = new TextEncoder();
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FIXED_WINDOW_DURATIONS_MS = new Set(
  [7, 30, 60, 90].flatMap((days) => [days * MS_PER_DAY, days * MS_PER_DAY - 1])
);
const cohortBranchIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(BRANCH_ANALYTICS_COHORT_ID_MAX_CHARS);
const optionalInstantSchema = z.iso.datetime().optional();
const requiredInstantSchema = z.iso.datetime();
// The shared web API client revives ISO strings before response validation;
// normalize that client-only representation back to the wire contract's ISO.
const responseInstantSchema = z
  .union([requiredInstantSchema, z.date()])
  .transform((instant) =>
    instant instanceof Date ? instant.toISOString() : instant
  );

const rawBranchAnalyticsCohortRequestSchema = z
  .object({
    branchIds: z
      .array(z.string().min(1).max(BRANCH_ANALYTICS_COHORT_ID_MAX_CHARS))
      .min(1),
    startDate: optionalInstantSchema,
    endDate: optionalInstantSchema,
  })
  .strict();

const normalizedBranchAnalyticsCohortRequestSchema = z
  .object({
    branchIds: z.array(cohortBranchIdSchema).min(1),
    startDate: optionalInstantSchema,
    endDate: optionalInstantSchema,
  })
  .strict()
  .superRefine((request, context) => {
    const uniqueIds = new Set(request.branchIds);
    if (uniqueIds.size !== request.branchIds.length) {
      context.addIssue({
        code: "custom",
        message: "branchIds must contain unique canonical identities",
        path: ["branchIds"],
      });
    }
    const hasStart = request.startDate !== undefined;
    const hasEnd = request.endDate !== undefined;
    if (hasStart !== hasEnd) {
      context.addIssue({
        code: "custom",
        message: "startDate and endDate must be provided together",
        path: hasStart ? ["endDate"] : ["startDate"],
      });
      return;
    }
    if (!(request.startDate && request.endDate)) {
      return;
    }
    const durationMs =
      Date.parse(request.endDate) - Date.parse(request.startDate);
    if (!FIXED_WINDOW_DURATIONS_MS.has(durationMs)) {
      context.addIssue({
        code: "custom",
        message: "window must span a supported rolling or inclusive day range",
        path: ["endDate"],
      });
    }
  });

/** Strict additive request for exact canonical Branch-cohort analytics. */
export const branchAnalyticsCohortRequestSchema = z
  .unknown()
  .superRefine((request, context) => {
    if (
      serializedRequestByteLength(request) >
      BRANCH_ANALYTICS_COHORT_MAX_REQUEST_BYTES
    ) {
      context.addIssue({
        code: "custom",
        message: "serialized cohort request exceeds the 64 KiB limit",
      });
    }
  })
  .pipe(rawBranchAnalyticsCohortRequestSchema)
  .pipe(normalizedBranchAnalyticsCohortRequestSchema);

export type BranchAnalyticsCohortRequest = z.infer<
  typeof branchAnalyticsCohortRequestSchema
>;

/** Cloud specialization: persisted canonical Branch artifact IDs are UUIDs. */
export const cloudBranchAnalyticsCohortRequestSchema =
  branchAnalyticsCohortRequestSchema.refine(
    (request) =>
      request.branchIds.every(
        (branchId) => z.uuid().safeParse(branchId).success
      ),
    { message: "cloud branchIds must be canonical UUIDs", path: ["branchIds"] }
  );

const branchMetricCoverageSchema = z
  .object({
    included: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .refine((coverage) => coverage.included <= coverage.total, {
    message: "included metric coverage cannot exceed total coverage",
  });
const absentMetricResultSchema = z.object({
  state: z.enum([
    BranchMetricAvailability.Unavailable,
    BranchMetricAvailability.NotApplicable,
    BranchMetricAvailability.NoData,
  ]),
  value: z.null(),
});
const branchMetricWindowSchema = z
  .object({
    startAt: responseInstantSchema.nullable(),
    endAt: responseInstantSchema,
  })
  .refine(
    (window) =>
      window.startAt === null ||
      Date.parse(window.startAt) < Date.parse(window.endAt),
    { message: "metric window start must precede its end" }
  );
const strictInstantMetricResultSchema = metricResultSchema(
  responseInstantSchema
);
const strictNumericMetricResultSchema = metricResultSchema(z.number());
const consumerInstantMetricResultSchema = consumerMetricResultSchema(
  responseInstantSchema
);
const consumerNumericMetricResultSchema = consumerMetricResultSchema(
  z.number()
);
const strictBranchListMetricBundleSchema = branchListMetricBundleSchema(
  strictInstantMetricResultSchema,
  strictNumericMetricResultSchema
);
const consumerBranchListMetricBundleSchema = branchListMetricBundleSchema(
  consumerInstantMetricResultSchema,
  consumerNumericMetricResultSchema
);

export type BranchAnalyticsCohortResponse = {
  matchedBranchIds: string[];
  canonicalMetrics: BranchListMetricBundle;
};

/** Strict producer response; unknown additive fields are stripped for version skew. */
export const branchAnalyticsCohortResponseSchema: z.ZodType<BranchAnalyticsCohortResponse> =
  responseSchema(strictBranchListMetricBundleSchema);

/**
 * Version-skew-tolerant response parser for installed clients.
 *
 * A newer producer's unknown availability degrades only that metric to typed
 * Unavailable. An unknown partial-disclosure literal retains the understood
 * value and coverage under the existing generic incomplete disclosure.
 */
export const branchAnalyticsCohortConsumerResponseSchema: z.ZodType<BranchAnalyticsCohortResponse> =
  responseSchema(consumerBranchListMetricBundleSchema);

function metricResultSchema<Value extends string | number>(
  valueSchema: z.ZodType<Value>
) {
  const complete = z.object({
    state: z.literal(BranchMetricAvailability.Complete),
    value: valueSchema,
    coverage: branchMetricCoverageSchema.optional(),
  });
  const partial = z.object({
    state: z.literal(BranchMetricAvailability.Partial),
    value: valueSchema,
    coverage: branchMetricCoverageSchema.optional(),
    disclosure: z.enum(BranchMetricDisclosure),
  });
  return z.union([complete, partial, absentMetricResultSchema]);
}

function consumerMetricResultSchema<Value extends string | number>(
  valueSchema: z.ZodType<Value>
) {
  const unknownDisclosurePartial = z
    .object({
      state: z.literal(BranchMetricAvailability.Partial),
      value: valueSchema,
      coverage: branchMetricCoverageSchema.optional(),
      disclosure: z.string().refine(isUnknownMetricDisclosure),
    })
    .transform((result) => ({
      ...result,
      disclosure: BranchMetricDisclosure.DefaultIncomplete,
    }));
  const unknownAvailability = z
    .object({ state: z.string().refine(isUnknownMetricAvailability) })
    .transform(() => ({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    }));
  return z.union([
    metricResultSchema(valueSchema),
    unknownDisclosurePartial,
    unknownAvailability,
  ]);
}

function branchListMetricBundleSchema(
  instantMetricResultSchema: z.ZodType<BranchMetricResult<string>>,
  numericMetricResultSchema: z.ZodType<BranchMetricResult<number>>
) {
  // ISS-10363 (whitlockk, tamsinb review on #7448): the INNER value shape carries
  // the same keys-covered guard the bundle shape below has carried since
  // ISS-9732, and for the same reason — `series` was added to
  // `BranchListMetricValue` and not here, so the exact-cohort read stripped it
  // and the mark vanished on exactly the filtered request that re-fetches.
  const numericMetricValueShape = {
    current: numericMetricResultSchema,
    comparison: z
      .object({
        label: z.enum([
          BranchMetricComparisonLabel.WeekOverWeek,
          BranchMetricComparisonLabel.MonthOverMonth,
          BranchMetricComparisonLabel.PriorSixtyDays,
          BranchMetricComparisonLabel.QuarterOverQuarter,
        ]),
        priorWindow: branchMetricWindowSchema,
        deltaPct: numericMetricResultSchema,
      })
      .optional(),
    series: z.array(z.number().nullable()).optional(),
  } satisfies Record<keyof BranchListMetricValue, z.ZodType>;
  const numericMetricValueSchema = z.object(numericMetricValueShape);
  // `z.object` strips what it does not declare, so an undeclared additive field
  // would survive the plain `/branches/analytics` read and vanish only on the
  // exact-cohort read — the tile would then silently fall back to the lifetime
  // value exactly when a facet is narrowing the list.
  //
  // ISS-9732 (whitlockk, tamsinb review on #6838): that comment was here and the
  // next additive field was still added to the TYPE and not to this shape, so
  // the warning is now a compile-time obligation. `satisfies Record<keyof T,
  // …>` demands a key per bundle field — optional ones included, because a
  // missing OPTIONAL key is exactly this bug — and rejects a key the type does
  // not have, so a rename fails `tsc` on both sides at once.
  const windowScopedShape = {
    activeBranches: numericMetricValueSchema,
    aiSpendUsd: numericMetricValueSchema,
  } satisfies Record<keyof BranchListWindowScopedMetrics, z.ZodType>;
  const bundleShape = {
    period: z.enum(BranchMetricPeriod),
    label: z.enum(BranchMetricComparisonLabel),
    window: branchMetricWindowSchema,
    cohortSize: z.number().int().nonnegative(),
    lastActiveAt: instantMetricResultSchema,
    activeBranches: numericMetricValueSchema,
    locPerDollar: numericMetricValueSchema,
    medianPrSize: numericMetricValueSchema,
    aiSpendUsd: numericMetricValueSchema,
    mergeRatePct: numericMetricValueSchema,
    canonicalLocPerDollar: numericMetricValueSchema.optional(),
    totalLocPushed: numericMetricValueSchema.optional(),
    pushedLocPerDollar: numericMetricValueSchema.optional(),
    penseroPointsPerDollar: numericMetricValueSchema.optional(),
    windowScoped: z.object(windowScopedShape).optional(),
  } satisfies Record<keyof BranchListMetricBundle, z.ZodType>;
  return z.object(bundleShape);
}

function responseSchema(
  metricBundleSchema: z.ZodType<BranchListMetricBundle>
): z.ZodType<BranchAnalyticsCohortResponse> {
  return z
    .object({
      matchedBranchIds: z.array(cohortBranchIdSchema),
      canonicalMetrics: metricBundleSchema,
    })
    .superRefine((response, context) => {
      if (
        new Set(response.matchedBranchIds).size !==
        response.matchedBranchIds.length
      ) {
        context.addIssue({
          code: "custom",
          message: "matchedBranchIds must contain unique canonical identities",
          path: ["matchedBranchIds"],
        });
      }
      if (
        response.canonicalMetrics.cohortSize !==
        response.matchedBranchIds.length
      ) {
        context.addIssue({
          code: "custom",
          message: "canonical cohortSize must equal matchedBranchIds length",
          path: ["canonicalMetrics", "cohortSize"],
        });
      }
    });
}

function isUnknownMetricAvailability(value: string): boolean {
  return !Object.values(BranchMetricAvailability).some(
    (availability) => availability === value
  );
}

function isUnknownMetricDisclosure(value: string): boolean {
  return !Object.values(BranchMetricDisclosure).some(
    (disclosure) => disclosure === value
  );
}

function serializedRequestByteLength(request: unknown): number {
  try {
    return textEncoder.encode(JSON.stringify(request)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
