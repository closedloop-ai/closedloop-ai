import { z } from "zod";
import type { BranchQueryFilters } from "./branch.ts";
import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "./branch-metrics.ts";
import { listQueryWindowBoundMs } from "./list-query-ordering-semantics.ts";

/**
 * Which filters the producer applied before computing the full cohort counts.
 *
 * `RequestFilters` is what every producer emits today: counts over the whole
 * corpus the request's own filters select, before pagination — the population a
 * list's `total` reports, and the only scope a list consumer may read as its
 * own. `AllActiveFacets` describes a corpus taken across active facets rather
 * than the request's, so its counts belong to a different population and no
 * producer emits it yet.
 */
export const BranchListCohortScope = {
  RequestFilters: "request_filters",
  AllActiveFacets: "all_active_facets",
} as const;
export type BranchListCohortScope =
  (typeof BranchListCohortScope)[keyof typeof BranchListCohortScope];

/** Stable classification shared by cloud, Desktop, and list consumers. */
export const BranchLastActiveClassification = {
  KnownInWindow: "known_in_window",
  KnownOutOfWindow: "known_out_of_window",
  RetainedUnavailable: "retained_unavailable",
} as const;
export type BranchLastActiveClassification =
  (typeof BranchLastActiveClassification)[keyof typeof BranchLastActiveClassification];

export type BranchLastActiveEvidence = {
  canonical?: unknown;
  legacy?: string | null;
  conflicting?: boolean;
};

export type BranchLastActiveWindow = {
  evaluationNow: Date | number | string;
  startDate?: Date | number | string;
  endDate?: Date | number | string;
};

const completeCountSchema = z.object({
  state: z.literal(BranchMetricAvailability.Complete),
  value: z.number().int().nonnegative(),
});

const partialCountSchema = z.object({
  state: z.literal(BranchMetricAvailability.Partial),
  value: z.number().int().nonnegative(),
  disclosure: z.enum(BranchMetricDisclosure),
});

const unavailableCountSchema = z.object({
  state: z.enum([
    BranchMetricAvailability.Unavailable,
    BranchMetricAvailability.NotApplicable,
    BranchMetricAvailability.NoData,
  ]),
  value: z.null(),
});

const branchCohortCountSchema = z.discriminatedUnion("state", [
  completeCountSchema,
  partialCountSchema,
  unavailableCountSchema,
]);

const canonicalTimestampSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.enum([
      BranchMetricAvailability.Complete,
      BranchMetricAvailability.Partial,
    ]),
    value: z.string(),
  }),
  z.object({
    state: z.enum([
      BranchMetricAvailability.Unavailable,
      BranchMetricAvailability.NotApplicable,
      BranchMetricAvailability.NoData,
    ]),
    value: z.null(),
  }),
]);

/** Additive metadata on the existing Branch list pagination envelope. */
export const branchLastActiveCohortSchema = z
  .object({
    scope: z.enum(BranchListCohortScope),
    cohortKey: z.string().min(1).max(16_384),
    evaluationNow: z.string().datetime({ offset: true }),
    knownInWindow: branchCohortCountSchema,
    retainedUnavailable: branchCohortCountSchema,
    total: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.knownInWindow.state === BranchMetricAvailability.Complete &&
      value.retainedUnavailable.state === BranchMetricAvailability.Complete &&
      value.knownInWindow.value + value.retainedUnavailable.value !==
        value.total
    ) {
      context.addIssue({
        code: "custom",
        message: "complete Last-active cohort counts must sum to total",
        path: ["total"],
      });
    }
  });

export type BranchLastActiveCohort = z.infer<
  typeof branchLastActiveCohortSchema
>;

/**
 * Normalize the applied filter set, excluding pagination-only inputs.
 *
 * Producer and consumer must reduce the SAME request to the same string, and
 * they do not see the same bytes: the Desktop IPC boundary parses through
 * `branchServerPageQuerySchema`, whose `z.string().trim()` is a TRANSFORM, so
 * main keys a trimmed facet value while the renderer keys whatever the URL
 * carried. Whitespace is folded here so both sides canonicalize by
 * construction; a second normalization on either side would only add one more
 * thing that has to agree.
 */
export function branchListCohortKey(
  filters: Readonly<Record<string, unknown>>
): string {
  return JSON.stringify(normalizeFilterObject(filters));
}

/** Build a complete full-cohort result while enforcing the count equation. */
export function completeBranchLastActiveCohort(input: {
  scope: BranchListCohortScope;
  cohortKey: string;
  evaluationNow: Date;
  total: number;
  retainedUnavailable: number;
}): BranchLastActiveCohort {
  const retainedUnavailable = clampCount(
    input.retainedUnavailable,
    input.total
  );
  return {
    scope: input.scope,
    cohortKey: input.cohortKey,
    evaluationNow: input.evaluationNow.toISOString(),
    knownInWindow: {
      state: BranchMetricAvailability.Complete,
      value: input.total - retainedUnavailable,
    },
    retainedUnavailable: {
      state: BranchMetricAvailability.Complete,
      value: retainedUnavailable,
    },
    total: input.total,
  };
}

/**
 * Classify one selected Last-active value against one captured response clock.
 * Future or untrusted evidence becomes unavailable before date bounds apply.
 */
export function classifyBranchLastActive(
  evidence: BranchLastActiveEvidence,
  window: BranchLastActiveWindow
): BranchLastActiveClassification {
  if (evidence.conflicting) {
    return BranchLastActiveClassification.RetainedUnavailable;
  }
  const evaluationNow = instantMs(window.evaluationNow);
  if (evaluationNow === null) {
    return BranchLastActiveClassification.RetainedUnavailable;
  }
  const canonical = canonicalTimestampSchema.safeParse(evidence.canonical);
  if (evidence.canonical !== undefined && !canonical.success) {
    return BranchLastActiveClassification.RetainedUnavailable;
  }
  const selected = selectedTimestamp(evidence, canonical);
  const occurredAt = instantMs(selected);
  if (occurredAt === null || occurredAt > evaluationNow) {
    return BranchLastActiveClassification.RetainedUnavailable;
  }
  const start = optionalInstantMs(window.startDate);
  const end = optionalInstantMs(window.endDate);
  if (
    (start !== null && occurredAt < start) ||
    (end !== null && occurredAt > end)
  ) {
    return BranchLastActiveClassification.KnownOutOfWindow;
  }
  return BranchLastActiveClassification.KnownInWindow;
}

function normalizeFilterObject(
  filters: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const normalized: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(filters).sort()) {
    if (PAGINATION_KEYS.has(key) || filters[key] === undefined) {
      continue;
    }
    const value = normalizeFilterValue(filters[key]);
    normalized[key] =
      REPEATED_FILTER_KEYS.has(key) && !Array.isArray(value) ? [value] : value;
  }
  return normalized;
}

function normalizeFilterValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeFilterValue).sort(compareNormalizedValues);
  }
  if (value && typeof value === "object") {
    return normalizeFilterObject(value as Readonly<Record<string, unknown>>);
  }
  return value;
}

/**
 * Order two normalized values by their serialized form, by CODE UNIT.
 *
 * `cohortKey` is compared across runtimes — a Node producer builds it, a browser
 * consumer rebuilds it — so the order must not depend on either one's locale.
 * `localeCompare` does: the same two repository names order differently under
 * `en-US` and `sv-SE`, which would rewrite the key and make a cohort look like
 * it answered a different request.
 */
function compareNormalizedValues(left: unknown, right: unknown): number {
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  if (leftJson === rightJson) {
    return 0;
  }
  return leftJson < rightJson ? -1 : 1;
}

function clampCount(value: number, total: number): number {
  if (!(Number.isInteger(value) && value >= 0 && value <= total)) {
    throw new RangeError("retainedUnavailable must be an integer within total");
  }
  return value;
}

/**
 * A WINDOW BOUND as epoch ms — the only role `instantMs` is not enough for.
 *
 * A bound arrives from the request, so it can be written without a zone, and
 * then `Date.parse` reads it against whichever host classified the row: the
 * same saved query would select a different population on the API server than
 * on a desktop in Chicago. Anchoring is per ISS-9585 and only rewrites the
 * zone-less form, so a `Date`, a number, and an already-zoned string are read
 * exactly as before. Row timestamps keep plain {@link instantMs} — they are
 * stored absolute, and are not what the ruling anchors.
 */
function optionalInstantMs(
  value: Date | number | string | undefined
): number | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    const ms = listQueryWindowBoundMs(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return instantMs(value);
}

function instantMs(
  value: Date | number | string | null | undefined
): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  let parsed: number;
  if (value instanceof Date) {
    parsed = value.getTime();
  } else if (typeof value === "number") {
    parsed = value;
  } else {
    parsed = Date.parse(value);
  }
  return Number.isFinite(parsed) ? parsed : null;
}

function selectedTimestamp(
  evidence: BranchLastActiveEvidence,
  canonical: ReturnType<typeof canonicalTimestampSchema.safeParse>
): string | null | undefined {
  if (canonical.success) {
    return canonical.data.value;
  }
  if (evidence.canonical === undefined) {
    return evidence.legacy;
  }
  return null;
}

/** What one request key does when a request is reduced to its cohort key. */
const BranchCohortKeyRole = {
  /** Selects the page or names the response clock; never part of the cohort. */
  Pagination: "pagination",
  /** A facet that may arrive as one value or many; keyed as a list either way. */
  Repeated: "repeated",
  /** A single-valued filter, keyed as it arrives. */
  Scalar: "scalar",
} as const;
type BranchCohortKeyRole =
  (typeof BranchCohortKeyRole)[keyof typeof BranchCohortKeyRole];

/**
 * Every `BranchQueryFilters` key with the role that decides how it folds.
 *
 * The `satisfies` clause is the load-bearing part: the two sets below are
 * DERIVED from this map, so a filter added to the query type fails `tsc` here
 * rather than falling silently into the scalar default. That default rewrites
 * the key on one side of an equality gate that decides whether a producer's
 * cohort counts may be read at all, so a missing key is a silent undercount.
 */
const BRANCH_QUERY_FILTER_KEY_ROLES = {
  collaborators: BranchCohortKeyRole.Repeated,
  contributorUserId: BranchCohortKeyRole.Scalar,
  endDate: BranchCohortKeyRole.Scalar,
  evaluationNow: BranchCohortKeyRole.Pagination,
  lastActiveRanges: BranchCohortKeyRole.Repeated,
  limit: BranchCohortKeyRole.Pagination,
  locMax: BranchCohortKeyRole.Scalar,
  locMin: BranchCohortKeyRole.Scalar,
  names: BranchCohortKeyRole.Repeated,
  offset: BranchCohortKeyRole.Pagination,
  owner: BranchCohortKeyRole.Scalar,
  owners: BranchCohortKeyRole.Repeated,
  pageMode: BranchCohortKeyRole.Pagination,
  priorities: BranchCohortKeyRole.Repeated,
  projectId: BranchCohortKeyRole.Repeated,
  pullRequests: BranchCohortKeyRole.Repeated,
  repo: BranchCohortKeyRole.Repeated,
  repositories: BranchCohortKeyRole.Repeated,
  search: BranchCohortKeyRole.Scalar,
  sessionPresence: BranchCohortKeyRole.Scalar,
  sortDir: BranchCohortKeyRole.Pagination,
  sortKey: BranchCohortKeyRole.Pagination,
  startDate: BranchCohortKeyRole.Scalar,
  status: BranchCohortKeyRole.Repeated,
  statuses: BranchCohortKeyRole.Repeated,
  tags: BranchCohortKeyRole.Repeated,
  teamId: BranchCohortKeyRole.Scalar,
  userId: BranchCohortKeyRole.Scalar,
} satisfies Record<keyof BranchQueryFilters, BranchCohortKeyRole>;

/**
 * Keys a producer attaches to the request object it keys that are NOT part of
 * `BranchQueryFilters`: the Desktop list request's own fields, and the legacy
 * singular REST spellings older clients still send.
 */
const EXTRA_REQUEST_KEY_ROLES = {
  forceRefresh: BranchCohortKeyRole.Pagination,
  ids: BranchCohortKeyRole.Repeated,
  page: BranchCohortKeyRole.Pagination,
  repository: BranchCohortKeyRole.Repeated,
} satisfies Record<string, BranchCohortKeyRole>;

const REQUEST_KEY_ROLES: Readonly<Record<string, BranchCohortKeyRole>> = {
  ...BRANCH_QUERY_FILTER_KEY_ROLES,
  ...EXTRA_REQUEST_KEY_ROLES,
};

function keysWithCohortRole(role: BranchCohortKeyRole): ReadonlySet<string> {
  return new Set(
    Object.keys(REQUEST_KEY_ROLES).filter(
      (key) => REQUEST_KEY_ROLES[key] === role
    )
  );
}

const PAGINATION_KEYS = keysWithCohortRole(BranchCohortKeyRole.Pagination);
const REPEATED_FILTER_KEYS = keysWithCohortRole(BranchCohortKeyRole.Repeated);
