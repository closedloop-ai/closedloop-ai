import {
  type BranchListResponse,
  BranchStatus,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import { branchLastActiveCohortSchema } from "@repo/api/src/types/branch-list-cohort";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE_MAX,
  BranchListCapability,
  BranchListFacetAvailability,
  isBranchListServerPageSize,
} from "@repo/api/src/types/branch-list-contract";
import { protoSafeRecord } from "@repo/lib/security/proto-safe-record";
import { z } from "zod";

const finiteNumberSchema = z.number().finite();
const nullableFiniteNumberSchema = finiteNumberSchema.nullable();
const nullableIntegerSchema = z.number().int().nullable();
/**
 * The row's cloud Branch artifact id, absent for local and legacy producers.
 * ISS-9456: an artifact-keyed read (Related Sessions) drops this straight into
 * a POST body the server validates as a uuid, so a non-string here would 400
 * the page's whole batch. It folds to absent instead of rejecting the row, the
 * same degrade `lastActiveCohort` makes below: one skewed optional field must
 * not take the list down, and absent already means "cannot ask".
 */
const optionalArtifactIdSchema = z
  .unknown()
  .optional()
  .transform((value) =>
    typeof value === "string" && value.length > 0 ? value : undefined
  );
const branchServerPageRowSchema = z
  .object({
    id: z.string().min(1),
    artifactId: optionalArtifactIdSchema,
    branchName: z.string().min(1),
    baseBranch: z.string().nullable(),
    repoFullName: z.string().nullable(),
    owner: z.string().nullable(),
    status: z.enum(Object.values(BranchStatus)),
    prNumber: nullableIntegerSchema,
    prTitle: z.string().nullable(),
    prState: z.string().nullable(),
    prUrl: z.string().nullable(),
    multiPrWarning: z.boolean(),
    checksStatus: z.string().nullable(),
    checksPassed: nullableIntegerSchema,
    checksTotal: nullableIntegerSchema,
    reviewDecision: z.string().nullable(),
    ahead: nullableIntegerSchema,
    behind: nullableIntegerSchema,
    additions: nullableIntegerSchema,
    deletions: nullableIntegerSchema,
    filesChanged: nullableIntegerSchema,
    lastActivityAt: z.string(),
    sessionIds: z.array(z.string()),
    estimatedCostUsd: nullableFiniteNumberSchema,
    attributedCostUsd: nullableFiniteNumberSchema.optional(),
  })
  .passthrough();
const branchListFacetResultSchema = z
  .object({
    availability: z.enum(Object.values(BranchListFacetAvailability)),
    options: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          count: z.number().int().min(0),
        })
        .passthrough()
    ),
  })
  .passthrough();
const branchListFacetsSchema = z
  .object({
    names: branchListFacetResultSchema,
    owners: branchListFacetResultSchema,
    collaborators: branchListFacetResultSchema,
    statuses: branchListFacetResultSchema,
    pullRequests: branchListFacetResultSchema,
    lastActiveRanges: branchListFacetResultSchema,
    repositories: branchListFacetResultSchema,
    tags: branchListFacetResultSchema,
  })
  .passthrough();
// ISS-8565: NOT `z.record` — these are keyed by session id, and
// `sessionIdFromRolloutPath` falls through to the bare filename, so a rollout
// named `__proto__.jsonl` yields the id `__proto__`. `z.record` drops that key
// on the way out, which is how a session's cost went missing from the
// server-paginated page after the producer-side fold was fixed.
const numericMapSchema = protoSafeRecord(z.string(), finiteNumberSchema);
const countMapSchema = protoSafeRecord(z.string(), z.number().int().min(1));
const branchServerPageSizeSchema = z
  .number()
  .int()
  .refine(isBranchListServerPageSize, {
    message: "unsupported Branches server page size",
  });
const branchServerPageInfoSchema = z
  .object({
    capability: z.literal(BranchListCapability.ServerPaginationV1),
    limit: branchServerPageSizeSchema,
    offset: z.number().int().min(0),
    requestedOffset: z.number().int().min(0),
    now: z.string().datetime(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.offset % value.limit !== 0) {
      context.addIssue({
        code: "custom",
        message: "offset must align to the page limit",
        path: ["offset"],
      });
    }
    if (value.requestedOffset % value.limit !== 0) {
      context.addIssue({
        code: "custom",
        message: "requestedOffset must align to the page limit",
        path: ["requestedOffset"],
      });
    }
  });

/**
 * Additive cohort metadata that degrades to absent rather than rejecting.
 *
 * `lastActiveCohort` only refines a notice, but it is embedded in a strict
 * schema, so a present-but-invalid one used to fail the WHOLE envelope and
 * error the Branches page — discarding `pageInfo.now`, the very clock the
 * notice falls back to. A version-skewed producer must not be able to take the
 * page down with one optional field. Absent and invalid both resolve to
 * `undefined` so the clock precedence chain falls through identically.
 */
const optionalLastActiveCohortSchema = z
  .unknown()
  .optional()
  .transform((value) => {
    if (value === undefined) {
      return undefined;
    }
    const parsed = branchLastActiveCohortSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  });

/** Complete current-producer page envelope; top-level additions remain compatible. */
export const branchServerPageResponseSchema = z
  .object({
    items: z
      .array(branchServerPageRowSchema)
      .max(BRANCH_LIST_SERVER_PAGE_SIZE_MAX),
    total: z.number().int().min(0),
    viewerScope: z.enum(Object.values(BranchViewerScope)),
    hasMore: z.boolean().optional(),
    readSource: z.string().optional(),
    pageInfo: branchServerPageInfoSchema,
    facets: branchListFacetsSchema,
    sessionCostUsd: numericMapSchema.optional(),
    lifetimeSessionCostUsd: numericMapSchema.optional(),
    sessionBranchCount: countMapSchema.optional(),
    lastActiveCohort: optionalLastActiveCohortSchema,
  })
  .passthrough()
  .superRefine((value, context) => {
    const { limit, offset } = value.pageInfo;
    // Rows this page has accounted for by its own end. ISS-9668 is about the
    // gap between this and `total`: that gap is the part of the population the
    // page did not deliver, and every check below is about the page telling the
    // truth about it.
    const reached = offset + value.items.length;
    if (value.items.length > limit) {
      context.addIssue({
        code: "custom",
        message: "items must not exceed the page limit",
        path: ["items"],
      });
    }
    if (reached > value.total) {
      context.addIssue({
        code: "custom",
        message: "items must not reach past the reported total",
        path: ["items"],
      });
    }
    if (value.hasMore === false && reached < value.total) {
      context.addIssue({
        code: "custom",
        message:
          "a truncated page: hasMore is false while rows counted in total were never delivered",
        path: ["hasMore"],
      });
    }
    if (value.hasMore === true && reached >= value.total) {
      context.addIssue({
        code: "custom",
        message: "hasMore is true while the page already reached the total",
        path: ["hasMore"],
      });
    }
  });

const branchServerPageCapabilitySchema = z
  .object({
    pageInfo: z
      .object({
        capability: z.literal(BranchListCapability.ServerPaginationV1),
      })
      .passthrough(),
  })
  .passthrough();

/** Detect an advertised current producer before choosing parse or legacy fallback. */
export function hasBranchServerPageCapability(value: unknown): boolean {
  return branchServerPageCapabilitySchema.safeParse(value).success;
}

/** Validate all fields consumed by the current Branches page. */
export function parseBranchServerPageResponse(
  value: unknown
): BranchListResponse {
  return branchServerPageResponseSchema.parse(value) as BranchListResponse;
}

/** Narrow an already-boundary-validated value for renderer state selection. */
export function isValidBranchServerPageResponse(
  value: unknown
): value is BranchListResponse {
  return branchServerPageResponseSchema.safeParse(value).success;
}
