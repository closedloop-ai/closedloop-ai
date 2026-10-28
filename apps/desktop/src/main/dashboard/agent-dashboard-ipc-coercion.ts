/**
 * @file agent-dashboard-ipc-coercion.ts
 * @description ISS-4771: the renderer-payload coercers the Agent Dashboard DB
 * IPC handlers validate their untrusted arguments with, plus the one read-source
 * narrowing (`toBranchSyncSource`) the branch handlers and the runtime both use.
 * Extracted out of
 * `agent-dashboard-design-system-runtime.ts` so the handler-group modules and the
 * runtime share one definition of each; every coercion rule is unchanged.
 */

import {
  INSIGHTS_PERIOD_OPTIONS,
  INSIGHTS_SECTION_OPTIONS,
  type InsightsPeriod,
  InsightsPeriod as InsightsPeriodValues,
  type InsightsSection,
  InsightsSection as InsightsSectionValues,
} from "@closedloop-ai/loops-api/insights";
import { branchSelectedPullRequestQuerySchema } from "@repo/api/src/types/branch-associated-pull-request";
import { BranchListPageMode } from "@repo/api/src/types/branch-list-contract";
import {
  branchServerPageQuerySchema,
  branchServerPageQueryShape,
} from "@repo/api/src/types/branch-list-contract-schema";
import { z } from "zod";
import type {
  DashboardListWindow,
  SessionPageRequest,
} from "../../shared/agent-db-contract.js";
import type { DiagnosticsRequest } from "../../shared/diagnostics-contract.js";
import type {
  SharedAgentSessionsListRequest,
  SharedAgentSessionsQuery,
} from "../../shared/shared-agent-sessions-contract.js";
import {
  sharedAgentSessionsListRequestSchema,
  sharedAgentSessionsQuerySchema,
} from "../../shared/shared-agent-sessions-contract-schema.js";
import type {
  SharedBranchesDetailRequest,
  SharedBranchesListRequest,
} from "../../shared/shared-branches-contract.js";
import { compileBranchListQueryRequest } from "../branch/branch-list-query-compiler.js";
import type { BranchSyncSource } from "../branch/shared-branches-api.js";
import type { DbHostAgentDatabase } from "../database/sqlite.js";
import { compileSessionListQueryRequest } from "../session/session-list-query-compiler.js";

export function coerceSharedQuery(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

const desktopBranchServerPageRequestSchema = z
  .object({
    ...branchServerPageQueryShape,
    forceRefresh: z.boolean().optional(),
    skipCloudHydration: z.boolean().optional(),
  })
  .strict()
  .refine(
    (query) =>
      query.locMin === undefined ||
      query.locMax === undefined ||
      query.locMin <= query.locMax,
    { message: "locMin must be less than or equal to locMax", path: ["locMin"] }
  );

/**
 * Strictly validate new server-page IPC while preserving legacy coercion. A
 * `listQuery` expression (PRD-721) is lowered into the legacy params first
 * (`compileBranchListQueryRequest`), so the schema judges what it lowered to;
 * an expression this host cannot serve rejects the read, because dropping it
 * would answer with every row.
 */
export function coerceSharedBranchesQuery(
  value: unknown
): SharedBranchesListRequest {
  const raw = coerceSharedQuery(compileBranchListQueryRequest(value));
  if (raw.pageMode !== BranchListPageMode.Server) {
    return raw;
  }
  const parsed = desktopBranchServerPageRequestSchema.parse(raw);
  branchServerPageQuerySchema.parse(withoutDesktopReadHints(parsed));
  return parsed;
}

function withoutDesktopReadHints(
  value: z.infer<typeof desktopBranchServerPageRequestSchema>
) {
  const {
    forceRefresh: _forceRefresh,
    skipCloudHydration: _skipCloudHydration,
    ...query
  } = value;
  return query;
}

/**
 * Validate the untrusted Branch detail IPC payload while retaining the legacy
 * string request accepted by older renderers. Known selection fields are strict,
 * while unknown additive fields from newer renderers are ignored safely.
 */
export function coerceSharedBranchDetailRequest(
  value: unknown
): SharedBranchesDetailRequest | null {
  if (typeof value === "string") {
    return value.length > 0 ? { id: value } : null;
  }
  if (!(typeof value === "object" && value !== null && !Array.isArray(value))) {
    return null;
  }
  const request = value as Record<string, unknown>;
  if (typeof request.id !== "string" || request.id.length === 0) {
    return null;
  }
  const selection = branchSelectedPullRequestQuerySchema.parse({
    ...(Object.hasOwn(request, "repositoryFullName")
      ? { repositoryFullName: request.repositoryFullName }
      : {}),
    ...(Object.hasOwn(request, "pullRequestNumber")
      ? { pullRequestNumber: request.pullRequestNumber }
      : {}),
  });
  if (
    request.forceRefresh !== undefined &&
    typeof request.forceRefresh !== "boolean"
  ) {
    throw new TypeError("Invalid Branch detail forceRefresh value.");
  }
  if (
    request.skipCloudHydration !== undefined &&
    typeof request.skipCloudHydration !== "boolean"
  ) {
    throw new TypeError("Invalid Branch detail skipCloudHydration value.");
  }
  return {
    id: request.id,
    ...(request.forceRefresh === true ? { forceRefresh: true } : {}),
    ...selection,
  };
}

/**
 * Narrow the full SQLite handle to the `BranchSyncSource` the branch serving
 * needs: `prisma` and canonical activity evidence for the list/usage/analytics
 * reads, plus the shared
 * `syncSource` loader the DETAIL op (D1) uses to hydrate each linked session's
 * real per-session usage + the cross-session merged trace (the same loader the
 * Sessions handlers pass). Downstream branch reads still cannot reach
 * `.sessions`/`.agents`/`.events` directly — only through that loader.
 */
export function toBranchSyncSource(
  agentDatabase: DbHostAgentDatabase
): BranchSyncSource {
  return {
    prisma: agentDatabase.prisma,
    readBranchCanonicalActivityRows:
      agentDatabase.readBranchCanonicalActivityRows,
    readBranchMetricEventEvidence: agentDatabase.readBranchMetricEventEvidence,
    syncSource: agentDatabase.syncSource,
  };
}

export function coerceSessionPageRequest(
  value: unknown
): SessionPageRequest | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  return {
    limit: typeof raw.limit === "number" ? raw.limit : undefined,
    offset: typeof raw.offset === "number" ? raw.offset : undefined,
    status: typeof raw.status === "string" ? raw.status : undefined,
    q: typeof raw.q === "string" ? raw.q : undefined,
  };
}

export function coerceInsightsSection(value: unknown): InsightsSection {
  return INSIGHTS_SECTION_OPTIONS.includes(value as InsightsSection)
    ? (value as InsightsSection)
    : InsightsSectionValues.Delivery;
}

export function coerceInsightsPeriod(value: unknown): InsightsPeriod {
  return INSIGHTS_PERIOD_OPTIONS.includes(value as InsightsPeriod)
    ? (value as InsightsPeriod)
    : InsightsPeriodValues.Quarter;
}

// FEA-3722: the analytics lookback arrives over IPC as a number (rolling
// window), `null` (all-time), or `undefined` (default). Preserve the three-way
// distinction; treat any other/invalid value as `undefined` so the query keeps
// its historical 30-day default rather than a bogus window.
export function coerceLookbackDays(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

// The optimization-analytics trailing window: a positive day count in [1, 365],
// defaulting to 30 for anything out of range or non-numeric (matches the prior
// inline clamp the three handlers shared before the ISS-4403 extraction).
export function coerceWindowDays(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 365
    ? value
    : 30;
}

// ISS-4403: the optional content-scope fingerprint threaded from the renderer's
// `AgentComponentDetail.versionId` (the FULL content hash). A non-empty string
// narrows the read to exactly that content version; anything else (absent, empty,
// non-string — a legacy name-level route or a version-skewed renderer) degrades
// to `null` so the read stays name-level, byte-identical to pre-ISS-4403.
export function coerceFingerprint(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ISS-5631 / ISS-6451: the paged-dashboard window (`desktop:db:get-plans`,
// `desktop:db:get-pull-requests`) as it arrives from the renderer. Only the two
// numeric bounds are carried through; anything else — a non-object payload, a
// string bound, a missing field — degrades to `undefined`, which the query's
// `coerceDashboardListWindow` clamp reads as "use the default window". The
// numeric RANGE is clamped there, not here, so both channels and every
// in-process caller share one ceiling.
export function coerceDashboardWindowRequest(
  value: unknown
): DashboardListWindow {
  const request = coerceSharedQuery(value);
  return {
    limit: typeof request.limit === "number" ? request.limit : undefined,
    offset: typeof request.offset === "number" ? request.offset : undefined,
  };
}

/**
 * ISS-6758: the diagnostics read's opt-in flags.
 *
 * Deliberately NOT `.strict()`. Zod's default object strips unknown keys, so a
 * renderer that starts sending a second, newer request field still gets its
 * `includeActivityCoverage` honored; `.strict()` would reject the whole payload
 * and silently turn the coverage read back off — a capability disappearing
 * because an unrelated field was added. A malformed payload (a string, an array)
 * still falls back to the empty request, so the expensive read stays OFF unless
 * the renderer actually asked for it.
 */
const diagnosticsRequestSchema = z.object({
  includeActivityCoverage: z.boolean().optional(),
});

export function coerceDiagnosticsRequest(value: unknown): DiagnosticsRequest {
  const parsed = diagnosticsRequestSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * ISS-9428: the Sessions read request, for the four
 * `desktop:shared-agent-sessions:*` read channels.
 *
 * `coerceSharedQuery` above is a CAST, not a validation — it proves the payload
 * is a non-null object and then asserts a type onto it, so every field
 * downstream was `unknown` wearing a `string`. These two replace it at the
 * Sessions channels with the real shape, and the schema module states why it
 * strips rather than rejects.
 *
 * Downstream semantics are deliberately UNCHANGED, which is the whole design:
 *
 * - A malformed modelled field degrades to `undefined`, which is exactly what
 *   `sanitizeQuery` already saw for a missing one — `clampLimit` still floors a
 *   bad `limit` to the default, `coerceSessionQuality` still resolves an
 *   unrecognized quality to `all`. Nothing here newly throws or newly clamps.
 *   A malformed ARRAY entry degrades only ITSELF: a mixed `userIds`/`ids` keeps
 *   its valid entries, the same fold `coerceStringArray`/`sanitizeIds` apply, so
 *   one bad entry can neither widen an owner-scoped read nor empty an id-scoped
 *   one.
 * - An unknown key is dropped instead of riding along in the request object.
 *   Nothing in desktop main reads one: `viewerScope` is a response-side literal
 *   in the folds, and neither `projectIds` nor `comparison` is read off a
 *   request anywhere in `src/main`. So stripping removes no capability.
 * - `ids` keeps its THREE-way distinction, which is the subtle one.
 *   `explicitIdsFromRequest` discriminates on `Object.hasOwn(request, "ids")`:
 *   absent means "no id narrowing", present-but-not-an-array means "narrow to
 *   nothing". Zod omits a missing optional key entirely and keeps a present
 *   malformed one (as `undefined`), so both branches survive the schema. A
 *   `.default([])` here would have collapsed the first into the second and
 *   silently emptied every unfiltered list.
 * - ISS-9479: a `listQuery` expression is lowered into the legacy params first
 *   (`compileSessionListQueryRequest`), so the schema judges what it lowered
 *   to. It is the one input that throws here: an expression this host cannot
 *   serve rejects the read, because dropping it would answer with every row.
 */
export function coerceSharedAgentSessionsQuery(
  value: unknown
): SharedAgentSessionsQuery {
  const parsed = sharedAgentSessionsQuerySchema.safeParse(
    compileSessionListQueryRequest(value ?? {})
  );
  return parsed.success ? parsed.data : {};
}

/** The list/pageData/analytics request: {@link coerceSharedAgentSessionsQuery} plus `ids`. */
export function coerceSharedAgentSessionsListRequest(
  value: unknown
): SharedAgentSessionsListRequest {
  const parsed = sharedAgentSessionsListRequestSchema.safeParse(
    compileSessionListQueryRequest(value ?? {})
  );
  return parsed.success ? parsed.data : {};
}
