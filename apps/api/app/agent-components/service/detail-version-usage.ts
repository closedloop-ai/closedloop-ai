import "server-only";

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { decodeComponentHashKey } from "@repo/api/src/types/agent-component-analytics";
import type {
  AgentComponentUsageAttribution,
  AgentComponentVersionUsage,
  AgentComponentVersionUsageResponse,
} from "@repo/api/src/types/agent-component-version-usage";
import {
  type CohortDeliveryMetrics,
  EMPTY_COHORT_DELIVERY_METRICS,
} from "@repo/api/src/types/analytics";
import {
  EMPTY_VERSION_SPEND,
  foldVersionSpend,
  type VersionSpend,
  type VersionSpendMember,
} from "@repo/api/src/utils/version-spend";
import { withDb } from "@repo/database";
import { computeCohortPerformance } from "../cohort-performance";
import {
  resolveDetailIdentityScope,
  type UsageContentScope,
} from "../content-hash-identity";
import {
  loadSessionLocCost,
  locPerDollarForKind,
  type SessionLocCost,
} from "../loc-per-dollar";
import { foldOrphanUsageIntoTotals } from "./detail-invocation-counts";
import {
  aggregateDetailUsage,
  type DetailUsageLanes,
  loadDetailUsageGroups,
} from "./detail-usage-identity";
import { resolveComponentIdentity } from "./version-usage-identity";

/**
 * @file detail-version-usage.ts
 * @description ISS-10467/ISS-10468 — the agent-component detail's per-CONTENT-
 * VERSION drill-down, and the side-by-side compare that reads through it.
 *
 * ONE DERIVATION OF "THIS VERSION'S USAGE". Every entry here is produced by
 * handing `loadDetailUsageGroups` a {@link UsageContentScope} — the same
 * `usageContentScopeWhere` narrowing the token-trend read already uses and
 * FEA-4335 introduced. Nothing in this module re-implements that predicate, in
 * SQL or in JS, because two derivations of a version's population is precisely
 * the drift class that produced ISS-10341.
 *
 * WHAT IT DOES NOT DO. It never touches the family aggregates. `getDetailForOrg`
 * stays `contentScope: null` (one population per page), and this read is a
 * strictly additional, on-demand answer to a narrower question the user asked
 * for explicitly.
 */

/**
 * The only JS predicate over a usage row's version identity in this module, and
 * deliberately not the version-scope predicate.
 *
 * It asks a DIFFERENT question from `usageContentScopeWhere`: not "does this row
 * belong to version V" but "does this row name any version at all". The answer
 * partitions the family's population into the part per-version entries can
 * describe and the part none of them can, which is what
 * {@link AgentComponentUsageAttribution} reports. Both columns are already
 * selected by the family read, so this costs no query and cannot drift from the
 * scope predicate — it never evaluates a fingerprint.
 */
function carriesNoVersion(row: {
  componentVersionHash: string | null;
  definitionHash?: string | null;
  definitionVersionId?: string | null;
}): boolean {
  return (
    row.componentVersionHash == null &&
    row.definitionHash == null &&
    row.definitionVersionId == null
  );
}

/**
 * Fold one lane set's rows into the version's published totals.
 *
 * TWO SESSION FIGURES, AND THEY ARE NOT INTERCHANGEABLE. `sessions` is the
 * POPULATION count (`totalSessions`) and is what the wire carries beside
 * `invocations`, which is also a population figure; `sessionIds` is the BOUNDED
 * SAMPLE `foldOrphanUsageIntoTotals` deliberately leaves on the caller's set,
 * because it fans out into the LOC/cost and cohort reads whose statement count
 * follows its size. Publishing `sessionIds.size` as `sessions` put a sample
 * beside a population in two adjacent rows of one panel, so an
 * invocations-per-session a reader divides out of them read high with nothing
 * saying why.
 */
function foldLanes(lanes: DetailUsageLanes): {
  invocations: number;
  sessions: number;
  sessionIds: Set<string>;
} {
  const { totalInvocations: linked, sessionIdSet } = aggregateDetailUsage(
    lanes.usageGroups
  );
  const folded = foldOrphanUsageIntoTotals(
    linked,
    sessionIdSet,
    lanes.orphanUsages,
    lanes.orphanTotals
  );
  return {
    invocations: folded.totalInvocations,
    sessions: folded.totalSessions,
    sessionIds: sessionIdSet,
  };
}

/**
 * The versioned/unversioned PARTITION of the family, folded from the FAMILY
 * lane set already in hand.
 *
 * ISS-9852: the orphan lane is `take`-bounded, so when it reported its bound
 * both slices are FLOORS over the rows it could see. That is disclosed rather
 * than rounded away — a floor labelled as a floor is usable; an unlabelled one
 * is the same lie the nullable contract exists to prevent.
 */
function foldAttribution(
  familyLanes: DetailUsageLanes,
  kind: string
): AgentComponentUsageAttribution {
  // A plugin's detail has NO direct usage rows — its headline is a pack-id
  // rollup over child components (`buildPluginChildInvocationCounts`), a step
  // this fold does not apply. Folding its empty lane set would publish `0
  // invocations recorded no version` as a MEASURED zero underneath a headline of
  // thousands, which is the fabricated-measurement shape rather than a
  // partition. Same reason `loadOneVersionEntry` short-circuits a plugin.
  if (kind === AgentComponentKind.Plugin) {
    return {
      unversioned: { invocations: null, sessions: null },
      versioned: { invocations: null, sessions: null },
      truncated: false,
    };
  }
  let unversionedInvocations = 0;
  let versionedInvocations = 0;
  const unversionedSessions = new Set<string>();
  const versionedSessions = new Set<string>();
  const add = (
    row: { componentVersionHash: string | null },
    sessionId: string,
    invocations: number,
    rest: {
      definitionHash?: string | null;
      definitionVersionId?: string | null;
    }
  ) => {
    if (
      carriesNoVersion({
        ...rest,
        componentVersionHash: row.componentVersionHash,
      })
    ) {
      unversionedInvocations += invocations;
      unversionedSessions.add(sessionId);
      return;
    }
    versionedInvocations += invocations;
    versionedSessions.add(sessionId);
  };
  for (const group of familyLanes.usageGroups) {
    add(group, group.agentSessionId, group._sum.invocationCount ?? 0, {
      definitionHash: group.definitionHash,
    });
  }
  for (const usage of familyLanes.orphanUsages) {
    add(usage, usage.agentSessionId, usage.invocationCount, {
      definitionVersionId: usage.definitionVersionId,
    });
  }
  return {
    unversioned: {
      invocations: unversionedInvocations,
      sessions: unversionedSessions.size,
    },
    versioned: {
      invocations: versionedInvocations,
      sessions: versionedSessions.size,
    },
    truncated: familyLanes.orphanTruncated,
  };
}

/** The "nothing could be computed for this version" entry (ISS-5363 `null`s). */
function notComputedEntry(
  hash: string,
  definitionHash: string | undefined
): AgentComponentVersionUsage {
  return {
    hash,
    ...(definitionHash ? { definitionHash } : {}),
    invocations: null,
    sessions: null,
    locPerDollar: null,
    truncated: false,
    ...EMPTY_COHORT_DELIVERY_METRICS,
    ...EMPTY_VERSION_SPEND,
  };
}

/**
 * ISS-10467 (operator ruling 2026-09-26): one version's token/cost aggregates,
 * folded from the LOC/cost map the LOC/$ ratio above them already read.
 *
 * ONE MEMBER PER SESSION IN THE VERSION'S SET, including the sessions the read
 * holds no row for. That is what makes the coverage verdict describe the
 * revision's whole population rather than only the rows that loaded — and
 * `loadSessionLocCost` FAILS OPEN with an empty map, so without those members a
 * failed enrichment read would publish a confident `$0.00` instead of the dash
 * the ISS-5363 contract owes. `sessionIds` is the caller's `Set`, so no dedup
 * pass is needed here; the fold counts each session exactly once because the set
 * does.
 */
function versionSpend(
  sessionIds: ReadonlySet<string>,
  locCostBySession: Map<string, SessionLocCost>
): VersionSpend {
  const members: VersionSpendMember[] = [];
  for (const sessionId of sessionIds) {
    const entry = locCostBySession.get(sessionId);
    members.push({
      // ABSENCE is the unmeasured signal, not a zero — see `SessionLocCost.tokens`
      // for why a present row's `0` has to stay a measurement.
      tokens: entry ? entry.tokens : null,
      // `costMeasured` is the stored-cost coverage verdict its own owner already
      // resolved (`storedSessionCostCoverage`); handing the raw `cost` through
      // would send this fold the `0` that stands in for an absent price.
      costUsd: entry?.costMeasured ? entry.cost : null,
    });
  }
  return foldVersionSpend(members);
}

/**
 * ISS-10467: read one or more CONTENT VERSIONS' own usage for a component
 * detail, plus the family usage no version can claim.
 *
 * Returns `null` when the slug resolves to no component this org can see, so the
 * route can 404 rather than answer with an empty drill-down for a component the
 * caller cannot read.
 */
export function loadVersionUsageForOrg(
  organizationId: string,
  slug: string,
  requestedHashes: readonly string[]
): Promise<AgentComponentVersionUsageResponse | null> {
  return withDb(async (db) => {
    const decoded = decodeComponentHashKey(slug);
    if (!decoded) {
      return null;
    }
    const { kind, fingerprint, key: legacyKey } = decoded;
    const scope = await resolveDetailIdentityScope(
      db,
      organizationId,
      kind,
      fingerprint,
      legacyKey
    );
    const identity = await resolveComponentIdentity(
      db,
      organizationId,
      kind,
      scope
    );
    if (!identity) {
      return null;
    }

    // The FAMILY lane set — the SAME `contentScope: null` read the detail page
    // issues, so the unversioned remainder is folded from the very population
    // the headline counts rather than from a second, differently-scoped read.
    const familyLanes = await loadDetailUsageGroups({
      organizationId,
      identity: identity.usageIdentity,
      liveInventoryWhere: identity.liveInventoryWhere,
      contentScope: null,
    });

    const entries: AgentComponentVersionUsage[] = [];
    // NO `.slice` here. Truncating to the cap would answer a DIFFERENT question
    // than the one asked and say nothing about the versions it dropped, which on
    // a side-by-side compare is a silently missing column. The cap is enforced
    // ONCE, at the request boundary (`versionUsageQuerySchema`), where exceeding
    // it is a 400 that names the ceiling.
    for (const hash of requestedHashes) {
      entries.push(
        await loadOneVersionEntry(db, {
          organizationId,
          kind,
          hash,
          definitionHash: identity.definitionHashByContentHash.get(hash),
          known: identity.knownContentHashes.has(hash),
          identity,
        })
      );
    }

    return { entries, attribution: foldAttribution(familyLanes, kind) };
  });
}

type VersionEntryRequest = {
  organizationId: string;
  kind: string;
  hash: string;
  definitionHash: string | undefined;
  known: boolean;
  identity: Awaited<ReturnType<typeof resolveComponentIdentity>>;
};

/**
 * One version's entry.
 *
 * The scope is the EXACT shape `resolveDetailIdentityScope` builds for a
 * content-hash route, handed to the same `usageContentScopeWhere` through the
 * same `loadDetailUsageGroups` parameter.
 *
 * BOTH DIGEST SPACES ARE NAMED, and that is what makes this read measure
 * anything. `usageContentScopeWhere`'s first arm matches
 * `componentVersionHash IN contentHashes`, and that column is stamped at
 * invocation with `computeDefinitionHash(content, kind)` — NOT with the raw
 * `sha256Hex(content)` the revision's own `contentHash` (and the selector, and
 * the slug) carries. Listing only the coarse hash matched no row, and every
 * revision came back a measured-looking `0` beneath a partition sentence saying
 * some invocations DID name a version. The usage-space digest is therefore
 * listed beside it (`usageScopeHashByContentHash`, derived once per family in
 * `resolveComponentIdentity`), and the coarse hash is kept for a legacy row
 * stamped before that contract. The fingerprint — the second arm, over the F1
 * `definitionVersion` link — prefers the revision's exact `definitionHash`,
 * falling back to the usage-space digest it equals when linked.
 */
async function loadOneVersionEntry(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  request: VersionEntryRequest
): Promise<AgentComponentVersionUsage> {
  const { hash, definitionHash, identity } = request;
  if (!identity) {
    return notComputedEntry(hash, definitionHash);
  }
  // A version the family's history does not carry, and a plugin — whose detail
  // has no direct usage rows at all (its counts are a pack-id rollup over child
  // components, which carry no revision of the PLUGIN) — are both genuinely NOT
  // COMPUTED, not measured zeroes. Emitting `0` here would assert this revision
  // ran nothing, which is a measurement nobody took.
  if (!request.known || request.kind === AgentComponentKind.Plugin) {
    return notComputedEntry(hash, definitionHash);
  }
  const usageScopeHash = identity.usageScopeHashByContentHash.get(hash);
  const contentScope: UsageContentScope = {
    fingerprint: definitionHash ?? usageScopeHash ?? hash,
    contentHashes: usageScopeHash ? [hash, usageScopeHash] : [hash],
  };
  const lanes = await loadDetailUsageGroups({
    organizationId: request.organizationId,
    identity: identity.usageIdentity,
    liveInventoryWhere: identity.liveInventoryWhere,
    contentScope,
  });
  const { invocations, sessions, sessionIds } = foldLanes(lanes);
  const sessionIdList = [...sessionIds];
  const [locCostBySession, cohortMetrics] = await Promise.all([
    loadSessionLocCost(db, request.organizationId, sessionIdList),
    computeCohortPerformance(db, request.organizationId, sessionIdList, {
      cohortSampled: lanes.orphanTruncated,
    }),
  ]);
  return {
    hash,
    ...(definitionHash ? { definitionHash } : {}),
    invocations,
    sessions,
    locPerDollar: locPerDollarForKind(
      request.kind,
      sessionIds,
      locCostBySession
    ),
    // NOT `orphanTruncated`. That flag says the LANE was bounded; this one says
    // THESE COUNTS are floors, and after ISS-10467 moved `invocations`/`sessions`
    // onto `totalSessions`/`totalInvocations` the two stopped agreeing. When the
    // lane hit its cap AND the whole-population aggregate resolved, the counts
    // above are EXACT and `orphanTruncated` would have the surface stamp a floor
    // marker on them — a number discounted as "at least N" that is really N, sat
    // under a family card rendering the same population bare. The counts are
    // floors in exactly one case: the lane was bounded and the aggregate could
    // not stand in for it. The cohort keeps its own `cohortSampled` below, which
    // correctly follows the LANE, because its figures are sample-derived.
    truncated: lanes.orphanTruncated && lanes.orphanTotals === null,
    ...(cohortMetrics satisfies CohortDeliveryMetrics),
    ...versionSpend(sessionIds, locCostBySession),
  };
}
