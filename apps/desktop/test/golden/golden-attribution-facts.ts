/**
 * ISS-12552: the `attribution` block of expectations schema
 * version 3, validated strictly. Each list is a list or the literal
 * `asserted_empty`; a missing key means not annotated. Only version 3 may carry
 * the block, and an unknown `schema_version` is rejected.
 *
 * PRD-800 version 28 "Proving usage" (version id
 * 01a15b24-f666-747b-8411-3c903c77793b, updatedAt 2026-10-20T21:08:31.475Z):
 * the block signs per-request facts (each usage row's and each operation's
 * request, each usage row's tokens, and the write-to-commit implementation
 * joins) and never a proven total, so a `proven_allocations` key is rejected.
 */
import {
  AttributionRelationshipKind,
  OperationKind,
  UsageTokenCategory,
} from "@repo/api/src/types/attribution-evidence";
import { z } from "zod";

export const ASSERTED_EMPTY = "asserted_empty";
export const ATTRIBUTION_SCHEMA_VERSION = 3;
const KNOWN_SCHEMA_VERSIONS = [1, 2, ATTRIBUTION_SCHEMA_VERSION] as const;

export const NonContributionReason = {
  Read: "read",
  Reference: "reference",
  Failed: "failed",
  NoOp: "no_op",
} as const;
export type NonContributionReason =
  (typeof NonContributionReason)[keyof typeof NonContributionReason];

function listOrAssertedEmpty<T extends z.ZodTypeAny>(item: T) {
  return z.union([z.array(item).min(1), z.literal(ASSERTED_EMPTY)]);
}

const targetIdentitySchema = z
  .object({
    slug: z.string().min(1).optional(),
    uuid: z.uuid().optional(),
    artifact_type: z.string().min(1).optional(),
  })
  .strict()
  .refine((target) => target.slug !== undefined || target.uuid !== undefined, {
    message: "a target names a slug or a UUID",
  });

/** Raw transcript line numbers, and the receipts that prove a commit. */
const anchorsSchema = z
  .object({
    lines: z.array(z.number().int().positive()).min(1),
    receipt_ids: z.array(z.string().min(1)).optional(),
  })
  .strict();

const operationSchema = z
  .object({
    operation_id: z.string().startsWith("clop_").optional(),
    provider_id: z.string().min(1),
    target: targetIdentitySchema.optional(),
    kind: z.enum(OperationKind),
    committed: z.boolean(),
    relationship: z.enum(AttributionRelationshipKind),
    anchors: anchorsSchema,
    /** The model request that issued the call (PRD-800). */
    request_id: z.string().min(1),
  })
  .strict();

const nonContributionSchema = z
  .object({
    provider_id: z.string().min(1).optional(),
    target: targetIdentitySchema,
    reason: z.enum(NonContributionReason),
    anchors: anchorsSchema,
  })
  .strict();

/**
 * `owning_agent` is `parent` for the main agent, else the subagent id. The
 * request this usage is, and its tokens summed from the raw record, are the
 * facts proven totals are derived from (PRD-800 "Proving usage").
 */
const usageSchema = z
  .object({
    source_usage_ids: z.array(z.string().min(1)).min(1),
    categories: z.array(z.enum(UsageTokenCategory)).min(1),
    owning_agent: z.string().min(1),
    request_id: z.string().min(1),
    tokens: z.number().int().nonnegative(),
  })
  .strict();

/**
 * ISS-12552, the write-to-commit join (Daveth Oakhurst, 2026-10-20): the requests
 * whose file writes a branch's successful commit captured, and the commit's own request, read from raw.
 */
const implementationJoinSchema = z
  .object({
    recipient: targetIdentitySchema,
    request_ids: z.array(z.string().min(1)).min(1),
    anchors: anchorsSchema,
  })
  .strict();

const unresolvedUsageSchema = z
  .object({
    source_usage_ids: z.array(z.string().min(1)).min(1),
    reason: z.string().min(1),
  })
  .strict();

const coverageLimitationSchema = z
  .object({
    limitation: z.string().min(1),
    anchors: anchorsSchema.optional(),
  })
  .strict();

export const attributionBlockSchema = z
  .object({
    /** How the block was derived and what authorized each restatement. */
    derived_by: z.string().min(1).optional(),
    candidate_artifacts: listOrAssertedEmpty(targetIdentitySchema).optional(),
    operations: listOrAssertedEmpty(operationSchema).optional(),
    implementation_joins: listOrAssertedEmpty(
      implementationJoinSchema
    ).optional(),
    non_contributions: listOrAssertedEmpty(nonContributionSchema).optional(),
    usage: listOrAssertedEmpty(usageSchema).optional(),
    unresolved_usage: listOrAssertedEmpty(unresolvedUsageSchema).optional(),
    coverage_limitations: listOrAssertedEmpty(
      coverageLimitationSchema
    ).optional(),
  })
  .strict();
export type AttributionBlock = z.infer<typeof attributionBlockSchema>;

const expectationsAttributionSchema = z
  .object({
    schema_version: z.union(
      KNOWN_SCHEMA_VERSIONS.map((version) => z.literal(version))
    ),
    attribution: attributionBlockSchema.optional(),
  })
  .loose()
  .refine(
    (expectations) =>
      expectations.attribution === undefined ||
      expectations.schema_version === ATTRIBUTION_SCHEMA_VERSION,
    { message: "only schema_version 3 carries an attribution block" }
  );

/** A dossier's attribution block, or undefined when it is not annotated. */
export function parseAttributionExpectations(
  expectations: unknown
):
  | { ok: true; attribution: AttributionBlock | undefined }
  | { ok: false; error: string } {
  const parsed = expectationsAttributionSchema.safeParse(expectations);
  return parsed.success
    ? { ok: true, attribution: parsed.data.attribution }
    : { ok: false, error: z.prettifyError(parsed.error) };
}
