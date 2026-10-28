import {
  BRANCH_CONTRIBUTOR_USER_ID_PARAM,
  BRANCH_EVALUATION_NOW_PARAM,
  BRANCH_LOC_MAX_PARAM,
  BRANCH_LOC_MIN_PARAM,
  BRANCH_SESSION_PRESENCE_PARAM,
  BranchSessionPresence,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BRANCH_LIST_MAX_FILTER_VALUE_LENGTH,
  BRANCH_LIST_MAX_FILTER_VALUES,
  BRANCH_LIST_MAX_OFFSET,
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BRANCH_LIST_SERVER_PAGE_SIZE_MAX,
  BranchListLastActiveRange,
  BranchListPageMode,
  BranchListPullRequestPresence,
  BranchListSortDirection,
  BranchListSortKey,
  isBranchListServerPageSize,
} from "@repo/api/src/types/branch-list-contract";
import { CLOUD_BRANCH_LIST_QUERY_CAPABILITY } from "@repo/api/src/types/branch-list-query-capabilities";
import { lowerBranchListQueryExpression } from "@repo/api/src/types/branch-list-query-lowering";
import {
  BRANCH_LIST_FIELD_BY_LEGACY_PARAM,
  BRANCH_LIST_QUERY_VOCABULARY,
  BRANCH_LIST_SET_PARAMS,
} from "@repo/api/src/types/branch-list-query-registry";
import {
  BRANCH_LIST_BLANK_OPERAND_SEMANTICS,
  BRANCH_LIST_OPERAND_SEMANTICS,
  type BranchListBlankOperand,
} from "@repo/api/src/types/branch-list-value-semantics";
import {
  BRANCH_TRACE_CURSOR_PATTERN,
  BranchTracePageMode,
} from "@repo/api/src/types/branch-trace-paging";
import { isListQueryAxisParam } from "@repo/api/src/types/list-query-legacy-params";
import type { ListQueryLoweringTarget } from "@repo/api/src/types/list-query-lowering";
import { anchorListQueryWindowBound } from "@repo/api/src/types/list-query-ordering-semantics";
import {
  ListQueryOperandCase,
  ListQueryOperandDisposition,
} from "@repo/api/src/types/list-query-value-semantics";
import {
  PRIORITY_UNSET_VALUE,
  PRIORITY_VALUES,
} from "@repo/api/src/types/search-query";
import { z } from "zod";
import { createListQueryBoundaryPreprocess } from "@/lib/list-query-param";
import {
  BRANCH_TRACE_DEFAULT_LIMIT,
  BRANCH_TRACE_MAX_LIMIT,
} from "./branch-read-service/branch-trace-read";

export const BRANCH_LIST_DEFAULT_LIMIT = 50;
/**
 * ISS-9692 (codex review) — the `limit` bound this route enforces, DERIVED from
 * the set the Branches contract accepts rather than written out.
 *
 * It was a bare `100` while `BRANCH_LIST_SERVER_PAGE_SIZE_OPTIONS` grew to admit
 * 250 and 500, so `?pageMode=server&limit=250` passed the contract's own
 * `isBranchListServerPageSize` check below and was then rejected by THIS schema
 * with a 400 — a page size the grid offered and its own endpoint refused, which
 * is the precise defect the ticket exists to close. Deriving it means the two
 * cannot part again: adding a rung to the contract raises this bound with it.
 *
 * `branch-read-service.ts` clamps to this same constant, so the route boundary
 * and the service agree by import rather than by coincidence.
 */
export const BRANCH_LIST_MAX_LIMIT = BRANCH_LIST_SERVER_PAGE_SIZE_MAX;
const BRANCH_TRACE_MAX_OFFSET = 10_000;
const BRANCH_LOC_MAX_VALUE = 10_000_000;
const legacyOnlyFilterKeys = [
  "repo",
  "repository",
  "status",
  "projectId",
  BRANCH_CONTRIBUTOR_USER_ID_PARAM,
  BRANCH_SESSION_PRESENCE_PARAM,
] as const;
const serverOnlyFilterKeys = [
  "names",
  "owners",
  "collaborators",
  "statuses",
  "pullRequests",
  "lastActiveRanges",
  "repositories",
  "tags",
  "priorities",
  "sortKey",
  "sortDir",
] as const;

const branchFilterStatusValues = [
  BranchStatus.Open,
  BranchStatus.Merged,
  BranchStatus.Closed,
  BranchStatus.Draft,
] as const;
const branchServerFilterStatusValues = [
  ...branchFilterStatusValues,
  BranchStatus.Review,
  BranchStatus.Blocked,
] as const;
const branchPullRequestPresenceValues = [
  BranchListPullRequestPresence.Linked,
  BranchListPullRequestPresence.None,
] as const;
const branchLastActiveRangeValues = [
  BranchListLastActiveRange.WithinLastHour,
  BranchListLastActiveRange.OneToSixHours,
  BranchListLastActiveRange.SevenToTwentyFourHours,
  BranchListLastActiveRange.OneDayOrMore,
] as const;
// The unset token leads so the tuple is provably non-empty for `z.enum`.
const branchPriorityFilterValues = [
  PRIORITY_UNSET_VALUE,
  ...PRIORITY_VALUES,
] as const;

function locBoundSchema(operand: BranchListBlankOperand) {
  return z.preprocess(
    blankOperandValue(operand),
    z.coerce.number().int().min(0).max(BRANCH_LOC_MAX_VALUE).optional()
  );
}

const branchListQueryShapeSchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(BRANCH_LIST_MAX_LIMIT)
      .default(BRANCH_LIST_DEFAULT_LIMIT),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .max(BRANCH_LIST_MAX_OFFSET)
      .default(0),
    pageMode: z.enum(Object.values(BranchListPageMode)).optional(),
    names: repeatedStringSchema(BRANCH_LIST_MAX_FILTER_VALUES).optional(),
    owners: repeatedStringSchema(BRANCH_LIST_MAX_FILTER_VALUES).optional(),
    collaborators: repeatedStringSchema(
      BRANCH_LIST_MAX_FILTER_VALUES
    ).optional(),
    statuses: repeatedEnumSchema(
      branchServerFilterStatusValues,
      BRANCH_LIST_MAX_FILTER_VALUES
    ).optional(),
    pullRequests: repeatedEnumSchema(
      branchPullRequestPresenceValues,
      BRANCH_LIST_MAX_FILTER_VALUES
    ).optional(),
    lastActiveRanges: repeatedEnumSchema(
      branchLastActiveRangeValues,
      BRANCH_LIST_MAX_FILTER_VALUES
    ).optional(),
    repositories: repeatedStringSchema(
      BRANCH_LIST_MAX_FILTER_VALUES
    ).optional(),
    tags: repeatedStringSchema(BRANCH_LIST_MAX_FILTER_VALUES).optional(),
    priorities: repeatedEnumSchema(
      branchPriorityFilterValues,
      BRANCH_LIST_MAX_FILTER_VALUES
    ).optional(),
    sortKey: z.enum(Object.values(BranchListSortKey)).optional(),
    sortDir: z.enum(Object.values(BranchListSortDirection)).optional(),
    repo: repeatedStringSchema(BRANCH_LIST_MAX_FILTER_VALUES).optional(),
    repository: repeatedStringSchema(BRANCH_LIST_MAX_FILTER_VALUES).optional(),
    status: repeatedEnumSchema(
      branchFilterStatusValues,
      BRANCH_LIST_MAX_FILTER_VALUES
    ).optional(),
    search: z.string().trim().min(1).max(200).optional(),
    startDate: windowBoundSchema(),
    endDate: windowBoundSchema(),
    projectId: repeatedStringSchema(BRANCH_LIST_MAX_FILTER_VALUES).optional(),
    [BRANCH_CONTRIBUTOR_USER_ID_PARAM]: z.string().trim().uuid().optional(),
    [BRANCH_SESSION_PRESENCE_PARAM]: z
      .enum([BranchSessionPresence.Has, BranchSessionPresence.None])
      .optional(),
    [BRANCH_LOC_MIN_PARAM]: locBoundSchema(BRANCH_LOC_MIN_PARAM),
    [BRANCH_LOC_MAX_PARAM]: locBoundSchema(BRANCH_LOC_MAX_PARAM),
  })
  .strict();

/**
 * Every parameter this schema admits a value for, read off the schema itself.
 *
 * The blank-operand conformance test compares this against
 * `BRANCH_LIST_BLANK_OPERAND_SEMANTICS`, so a parameter added above without a
 * blank declaration fails that test rather than shipping undeclared.
 */
export const BRANCH_LIST_QUERY_PARAM_KEYS: readonly string[] = Object.keys(
  branchListQueryShapeSchema.shape
);

const branchListQueryObjectSchema = branchListQueryShapeSchema
  .refine(
    (query) =>
      query[BRANCH_LOC_MIN_PARAM] === undefined ||
      query[BRANCH_LOC_MAX_PARAM] === undefined ||
      query[BRANCH_LOC_MIN_PARAM] <= query[BRANCH_LOC_MAX_PARAM],
    {
      message: `${BRANCH_LOC_MIN_PARAM} must be less than or equal to ${BRANCH_LOC_MAX_PARAM}`,
      path: [BRANCH_LOC_MIN_PARAM],
    }
  )
  .refine(
    (query) =>
      query.pageMode !== BranchListPageMode.Server ||
      (isBranchListServerPageSize(query.limit) &&
        query.offset % query.limit === 0),
    {
      message: "server pages require a supported limit and aligned offset",
      path: ["limit"],
    }
  )
  .superRefine((query, context) => {
    const incompatibleKeys =
      query.pageMode === BranchListPageMode.Server
        ? legacyOnlyFilterKeys
        : serverOnlyFilterKeys;
    for (const key of incompatibleKeys) {
      if (query[key] !== undefined) {
        context.addIssue({
          code: "custom",
          message:
            query.pageMode === BranchListPageMode.Server
              ? `${key} is not supported in server page mode`
              : `${key} requires pageMode=${BranchListPageMode.Server}`,
          path: [key],
        });
      }
    }
  });

/**
 * ISS-10350 (whitlockk review) — drop a client-supplied `evaluationNow` before the
 * strict object sees it.
 *
 * The clock is server-internal now, so it must not be HONORED; that is not the
 * same as refusing the request that carries it. `BranchQueryFilters` still
 * declares the key and the shared HTTP/desktop data sources serialize that type
 * wholesale, so an older shipped caller — and anything that still reads the
 * `/branches/evaluation-clock` compatibility route — would otherwise get its
 * entire Branches list answered with a 400 on a parameter this release stopped
 * reading. Stripping it here keeps the key out of `BranchListQuery` entirely, so
 * no downstream consumer can pick it back up.
 */
function dropClientEvaluationClock(value: unknown): unknown {
  if (
    BRANCH_LIST_OPERAND_SEMANTICS[ListQueryOperandCase.Retired] !==
    ListQueryOperandDisposition.Ignore
  ) {
    return value;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (!(BRANCH_EVALUATION_NOW_PARAM in value)) {
    return value;
  }
  const { [BRANCH_EVALUATION_NOW_PARAM]: _ignored, ...rest } = value as Record<
    string,
    unknown
  >;
  return rest;
}

/**
 * Strict REST boundary for legacy and additive Branch List query shapes. A
 * `listQuery` expression (PRD-721) is lowered into the legacy params after the
 * retired clock is dropped and before the strict shape and its page-mode rules
 * run, so a value that arrives through the expression meets every rule a
 * legacy param meets.
 */
export const branchListQuerySchema = z.preprocess(
  (value, ctx) =>
    lowerBranchListQueryParam(dropClientEvaluationClock(value), ctx),
  branchListQueryObjectSchema
);

/** Analytics keeps the server filter vocabulary but carries no wire pagination. */
export const branchAnalyticsQuerySchema = z.preprocess(
  addServerPagingDefaults,
  branchListQuerySchema
);

const branchTracePagedQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(BRANCH_TRACE_MAX_LIMIT)
      .default(BRANCH_TRACE_DEFAULT_LIMIT),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .max(BRANCH_TRACE_MAX_OFFSET)
      .default(0),
  })
  .strict();

const branchTraceCompleteQuerySchema = z
  .object({
    complete: z.literal("true").transform(() => true as const),
  })
  .strict();

export const branchTraceQuerySchema = z.union([
  z
    .object({
      pageMode: z.literal(BranchTracePageMode.Cursor),
      cursor: z.string().regex(BRANCH_TRACE_CURSOR_PATTERN).optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(BRANCH_TRACE_MAX_LIMIT)
        .default(BRANCH_TRACE_DEFAULT_LIMIT),
    })
    .strict(),
  branchTraceCompleteQuerySchema,
  branchTracePagedQuerySchema,
]);

export type BranchListQuery = z.infer<typeof branchListQuerySchema>;

/**
 * A list query plus the instant the read is evaluated at.
 *
 * ISS-10350: `evaluationNow` is server-internal and is NEVER accepted from a
 * client. Every entry point captures its own (`new Date()`) and threads it down
 * so SQL membership, ordering, keyset pagination, and the counts in the
 * envelope all describe ONE instant. It used to also be a query parameter, and
 * a client that latched a previous response's value wedged the whole surface
 * once its copy aged past the producer's freshness bound.
 */
export type BranchListOperationQuery = BranchListQuery & {
  evaluationNow?: Date;
};
export type BranchTraceQuery = z.infer<typeof branchTraceQuerySchema>;

/**
 * ISS-9482 — what a blank value of THIS parameter means is declared by
 * `BRANCH_LIST_BLANK_OPERAND_SEMANTICS`, not decided here.
 *
 * Per parameter, because the answer is not uniform across this schema: only the
 * change bounds read blank as absent, and every other parameter's own bound,
 * enum or coercion refuses it.
 *
 * The refusing arm cannot hand the blank string on: `z.coerce.number()` reads
 * `""` as a measured `0`, which would pass every bound below. It has to be a
 * value the schema cannot accept.
 */
function blankOperandValue(
  operand: BranchListBlankOperand
): (value: unknown) => unknown {
  return (value: unknown): unknown => {
    if (!(typeof value === "string" && value.trim() === "")) {
      return value;
    }
    if (
      BRANCH_LIST_BLANK_OPERAND_SEMANTICS[operand] ===
      ListQueryOperandDisposition.TreatAsAbsent
    ) {
      return;
    }
    return Number.NaN;
  };
}

function addServerPagingDefaults(value: unknown): unknown {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success || parsed.data.pageMode !== BranchListPageMode.Server) {
    return value;
  }
  return {
    ...parsed.data,
    limit: parsed.data.limit ?? BRANCH_LIST_SERVER_PAGE_SIZE,
    offset: parsed.data.offset ?? 0,
  };
}

function repeatedStringSchema(maxValues: number) {
  return z
    .union([
      z.string().min(1).max(BRANCH_LIST_MAX_FILTER_VALUE_LENGTH),
      z.array(z.string().min(1).max(BRANCH_LIST_MAX_FILTER_VALUE_LENGTH)),
    ])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .refine((value) => value.length <= maxValues, {
      message: `Expected at most ${maxValues} values`,
    });
}

function repeatedEnumSchema<
  const Values extends readonly [string, ...string[]],
>(values: Values, maxValues: number) {
  const itemSchema = z.enum(values);
  return z
    .union([itemSchema, z.array(itemSchema)])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .refine((value) => value.length <= maxValues, {
      message: `Expected at most ${maxValues} values`,
    });
}

/**
 * A date-window bound, read against UTC rather than against whichever host
 * parsed it.
 *
 * `z.coerce.date()` is `new Date(value)`, which anchors a ZONE-LESS date-time to
 * the local clock — so `?startDate=2026-09-25T00:00:00` selected a different
 * population on a Chicago host than on a UTC one, from the same saved query.
 * ISS-9585 anchors the bound before the coercion sees it. What this accepts and
 * refuses is unchanged: the preprocessor rewrites only the zone-less form.
 */
function windowBoundSchema() {
  return z.preprocess(anchorListQueryWindowBound, z.coerce.date().optional());
}

/**
 * PRD-721: the params a lowered expression may write, by page mode. A clause
 * that lowers to a param this mode refuses (`names` without
 * `pageMode=server`) is a `list_query_field_unsupported` refusal naming the
 * field, instead of the code-less page-mode 400 a legacy request gets.
 */
function branchListQueryTarget(
  rest: Readonly<Record<string, unknown>>
): ListQueryLoweringTarget {
  const refused: readonly string[] =
    rest.pageMode === BranchListPageMode.Server
      ? legacyOnlyFilterKeys
      : serverOnlyFilterKeys;
  return {
    acceptedParams: new Set(
      BRANCH_LIST_QUERY_PARAM_KEYS.filter((name) => !refused.includes(name))
    ),
    repeatableParams: BRANCH_LIST_SET_PARAMS,
  };
}

const branchListQueryBoundary = createListQueryBoundaryPreprocess({
  fieldByLegacyParam: BRANCH_LIST_FIELD_BY_LEGACY_PARAM,
  isMixedParam: (name) =>
    isListQueryAxisParam(name, BRANCH_LIST_QUERY_VOCABULARY),
  targetFor: branchListQueryTarget,
  lower: (expression, target) =>
    lowerBranchListQueryExpression(
      expression,
      CLOUD_BRANCH_LIST_QUERY_CAPABILITY,
      target
    ),
});

function lowerBranchListQueryParam(
  value: unknown,
  ctx: z.RefinementCtx
): unknown {
  return branchListQueryBoundary(value, ctx);
}
