/**
 * @file agent-dashboard-ipc-coercion.ts
 * @description ISS-4771: the renderer-payload coercers the Agent Dashboard DB
 * IPC handlers validate their untrusted arguments with, plus the one read-source
 * narrowing (`toBranchSyncSource`) the branch handlers and the runtime both use.
 * Extracted out of the shrink-only grandfathered
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
import type {
  DashboardListWindow,
  SessionPageRequest,
} from "../../shared/agent-db-contract.js";
import type { SharedBranchesDetailRequest } from "../../shared/shared-branches-contract.js";
import type { BranchSyncSource } from "../branch/shared-branches-api.js";
import type { DbHostAgentDatabase } from "../database/sqlite.js";

export function coerceSharedQuery(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
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
  return typeof value === "number" && value > 0 && value <= 365 ? value : 30;
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
