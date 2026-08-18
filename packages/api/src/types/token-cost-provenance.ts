import { z } from "zod";

/** Availability states for provider/source-record identity evidence. */
export const TokenSourceIdentityAvailability = {
  Available: "available",
  Unavailable: "unavailable",
} as const;
export type TokenSourceIdentityAvailability =
  (typeof TokenSourceIdentityAvailability)[keyof typeof TokenSourceIdentityAvailability];

/** Truthful reasons why a producer cannot attach source-record identity. */
export const TokenSourceIdentityUnavailableReason = {
  LegacyRecord: "legacy_record",
  UnsupportedSource: "unsupported_source",
  MissingSourceRecordId: "missing_source_record_id",
  Malformed: "malformed",
  Unknown: "unknown",
} as const;
export type TokenSourceIdentityUnavailableReason =
  (typeof TokenSourceIdentityUnavailableReason)[keyof typeof TokenSourceIdentityUnavailableReason];

/** Completeness states for a token event's cost evidence. */
export const TokenCostCompleteness = {
  Complete: "complete",
  Partial: "partial",
  Unavailable: "unavailable",
} as const;
export type TokenCostCompleteness =
  (typeof TokenCostCompleteness)[keyof typeof TokenCostCompleteness];

/** Reasons carried by non-complete token-cost evidence. */
export const TokenCostCompletenessReason = {
  LegacyRecord: "legacy_record",
  UnsupportedSource: "unsupported_source",
  SourceIdentityUnavailable: "source_identity_unavailable",
  PricingIncomplete: "pricing_incomplete",
  ClassificationIncomplete: "classification_incomplete",
  Malformed: "malformed",
  Unknown: "unknown",
} as const;
export type TokenCostCompletenessReason =
  (typeof TokenCostCompletenessReason)[keyof typeof TokenCostCompletenessReason];

/**
 * Additive cost contributions, not alternative valuations of the same amount;
 * neither lane suppresses the other when a producer classifies both.
 */
export const TokenCostBasis = {
  SubscriptionEquivalent: "subscription_equivalent",
  ApiEstimated: "api_estimated",
} as const;
export type TokenCostBasis =
  (typeof TokenCostBasis)[keyof typeof TokenCostBasis];

/** Maximum byte-adjacent text length accepted for internal transport ids. */
export const TOKEN_EVENT_TRANSPORT_ID_MAX_LENGTH = 8192;

/** Runtime schema for the stable internal identity, separate from provenance. */
export const tokenEventTransportIdSchema = z
  .string()
  .min(1)
  .max(TOKEN_EVENT_TRANSPORT_ID_MAX_LENGTH)
  .refine((value) => value === value.trim(), {
    message: "transport identity must already be trimmed",
  })
  .refine((value) => !value.includes(NUL_CHAR), {
    message: "transport identity must not contain NUL characters",
  })
  .refine((value) => !LONE_SURROGATE_RE.test(value), {
    message: "transport identity must not contain lone UTF-16 surrogates",
  });

const TOKEN_SOURCE_IDENTITY_MAX_IDENTIFIERS = 64;
const TOKEN_SOURCE_IDENTITY_MAX_SCHEME_LENGTH = 256;
const TOKEN_SOURCE_IDENTITY_MAX_IDENTIFIER_LENGTH = 2048;
const COST_SUM_EPSILON = 1e-12;
const NUL_CHAR = String.fromCharCode(0);
const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const availableTokenSourceIdentitySchema = z
  .object({
    availability: z.literal(TokenSourceIdentityAvailability.Available),
    scheme: z
      .string()
      .min(1)
      .max(TOKEN_SOURCE_IDENTITY_MAX_SCHEME_LENGTH)
      .refine((value) => value.trim().length > 0, {
        message:
          "source identity scheme must contain a non-whitespace character",
      }),
    sourceRecordIds: z
      .array(
        z
          .string()
          .min(1)
          .max(TOKEN_SOURCE_IDENTITY_MAX_IDENTIFIER_LENGTH)
          .refine((value) => value.trim().length > 0, {
            message:
              "source record identity must contain a non-whitespace character",
          })
      )
      .min(1)
      .max(TOKEN_SOURCE_IDENTITY_MAX_IDENTIFIERS),
  })
  .strict();

const unavailableTokenSourceIdentitySchema = z
  .object({
    availability: z.literal(TokenSourceIdentityAvailability.Unavailable),
    reason: z.enum(TokenSourceIdentityUnavailableReason),
  })
  .strict();

/** Runtime schema for ordered source-record identity evidence. */
export const tokenSourceIdentitySchema = z.discriminatedUnion("availability", [
  availableTokenSourceIdentitySchema,
  unavailableTokenSourceIdentitySchema,
]);
export type TokenSourceIdentity = z.infer<typeof tokenSourceIdentitySchema>;

const tokenCostSubtotalSchema = z.number().finite().nonnegative();

/** Runtime schema for one additive cost-basis lane. */
export const tokenCostLaneSchema = z
  .object({
    basis: z.enum(TokenCostBasis),
    subtotalUsd: tokenCostSubtotalSchema,
  })
  .strict();
export type TokenCostLane = z.infer<typeof tokenCostLaneSchema>;

const tokenCostLanesSchema = z
  .array(tokenCostLaneSchema)
  .min(1)
  .max(2)
  .optional();

const completeTokenCostSummarySchema = z
  .object({
    completeness: z.literal(TokenCostCompleteness.Complete),
    subtotalUsd: tokenCostSubtotalSchema,
    lanes: tokenCostLanesSchema,
  })
  .strict();

const partialTokenCostSummarySchema = z
  .object({
    completeness: z.literal(TokenCostCompleteness.Partial),
    reason: z.enum(TokenCostCompletenessReason),
    subtotalUsd: tokenCostSubtotalSchema,
    lanes: tokenCostLanesSchema,
  })
  .strict();

const unavailableTokenCostSummarySchema = z
  .object({
    completeness: z.literal(TokenCostCompleteness.Unavailable),
    reason: z.enum(TokenCostCompletenessReason),
  })
  .strict();

/**
 * Runtime schema for cost completeness and additive basis lanes. Present lanes
 * are disjoint contributions that reconcile to the summary subtotal. A summary
 * without lanes has a proven subtotal but no finer producer-provided basis split.
 */
export const tokenCostSummarySchema = z
  .discriminatedUnion("completeness", [
    completeTokenCostSummarySchema,
    partialTokenCostSummarySchema,
    unavailableTokenCostSummarySchema,
  ])
  .superRefine((summary, context) => {
    if (!("lanes" in summary) || summary.lanes === undefined) {
      return;
    }
    const distinctBases = new Set(summary.lanes.map((lane) => lane.basis));
    if (distinctBases.size !== summary.lanes.length) {
      context.addIssue({
        code: "custom",
        message: "cost lanes must use distinct bases",
        path: ["lanes"],
      });
    }
    const laneSubtotal = summary.lanes.reduce(
      (total, lane) => total + lane.subtotalUsd,
      0
    );
    const tolerance =
      COST_SUM_EPSILON *
      Math.max(1, Math.abs(laneSubtotal), Math.abs(summary.subtotalUsd));
    if (Math.abs(laneSubtotal - summary.subtotalUsd) > tolerance) {
      context.addIssue({
        code: "custom",
        message: "cost lanes must add up to subtotalUsd",
        path: ["lanes"],
      });
    }
  });
export type TokenCostSummary = z.infer<typeof tokenCostSummarySchema>;

/** Additive provenance carried by token-event wire records when available. */
export type TokenEventProvenanceFields = {
  sourceIdentity?: TokenSourceIdentity;
  costSummary?: TokenCostSummary;
};
