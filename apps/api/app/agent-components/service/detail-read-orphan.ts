import "server-only";

import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import {
  type AgentComponentKind,
  ComponentResolvedState,
} from "@repo/api/src/types/agent-component";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics";
import { buildComponentProperties } from "@repo/api/src/types/agent-component-properties";
import { emitLocPerDollarWithLegacy } from "@repo/api/src/utils/loc-per-dollar";
import { Prisma, withDb } from "@repo/database";
import { computeCohortPerformance } from "../cohort-performance";
import { resolveDetailCollaborators } from "../component-authors";
import type { UsageContentScope } from "../content-hash-identity";
import { resolveDefinitionHashes } from "../definition-hash-resolution";
import {
  type DetailOrphanUsageLanes,
  type DetailOrphanUsageRow,
  type DetailUsageSeenBounds,
  fetchDetailOrphanUsageLanes,
  fetchDetailUsageSeenBounds,
  foldUsageSeenBounds,
} from "../detail-usage-reads";
import {
  createHarnessAccumulator,
  foldUsageHarness,
  resolveComponentHarness,
} from "../harness-attribution";
import {
  resolveOrphanHonestSource,
  resolveOrphanSourceType,
} from "../identity";
import { loadSessionLocCost, locPerDollarForKind } from "../loc-per-dollar";
import { resolveDetailSessionTabs } from "./detail-session-tabs";
import { DETAIL_USAGE_SNAPSHOT_TX_TIMEOUT_MS } from "./detail-usage-identity";
import { loadAgentComponentInvocationReadPage } from "./invocation-read";
import { ownerCompat } from "./owner-compat";

/**
 * @file detail-read-orphan.ts
 * @description The used-only ("orphan-only") synthetic detail, split out of
 * `detail-read.ts` (ISS-5577) when that file crossed the 1,000-line ceiling.
 * It is a distinct responsibility: `detail-read.ts` builds the detail for an
 * identity that HAS inventory rows, while this builds one for an identity that
 * exists only because of its usage rows.
 */

/**
 * Derive the harness for an orphan-only synthetic detail from the actual usage
 * rows rather than hardcoding `"claude"` (FEA-3758). Delegates to the shared
 * per-session harness attribution so the orphan-only path, the inventory-present
 * detail, and the list view all attribute harness identically: one distinct
 * harness wins, more than one collapses to `both`, and `claude` is the fallback
 * only when every row left the harness unset. There is no inventory row on this
 * path, so the inventory fallback is null.
 */
function deriveOrphanHarness(
  rows: readonly DetailOrphanUsageRow[]
): AgentComponentDetail["harness"] {
  const acc = createHarnessAccumulator();
  for (const row of rows) {
    foldUsageHarness(acc, row.harness);
  }
  return resolveComponentHarness(acc, null);
}

/**
 * Build a synthetic detail for a component that has usage but no inventory row
 * (#2613): a "used-only" component (e.g. usage synced before the inventory lane
 * linked it, or a built-in with no inventory row). Returning null here 404s a
 * component that legitimately shows up in the list via the orphan-usage fold, so
 * we assemble the detail directly from the orphan usage rows instead. Returns
 * null only when there is genuinely no usage either — a true not-found.
 */
export async function buildOrphanOnlyDetail(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  kind: string,
  key: string,
  // FEA-4335: the routable key the client navigated with, echoed back as the
  // detail `slug` so a content-hash link round-trips. Defaults to the name-level
  // orphan slug when omitted (legacy callers).
  echoSlug?: string,
  // FEA-4335: every name that shares the content (for a content-hash route) and
  // the content-version scope. For the orphan-only content-hash case `key` is ""
  // and `keys` is empty, so `contentScope` (fingerprint) is what selects the
  // used-only rows — filtering `componentKey == ""` would find nothing.
  keys: string[] = [],
  contentScope: UsageContentScope | null = null
): Promise<AgentComponentDetail | null> {
  // ISS-5577 (wongk review): the two lanes AND the seen-bounds aggregate read
  // under ONE snapshot — see `loadOrphanUsageSnapshot`. The lane read still
  // reports its own `take` bound; this path never re-derives truncation from a
  // row count and a cap.
  const { orphanUsages, seenBounds } = await loadOrphanUsageSnapshot({
    organizationId,
    kind,
    key,
    keys,
    contentScope,
  });
  if (orphanUsages.length === 0) {
    return null;
  }

  const invCountBySession = new Map<string, number>();
  let totalInvocations = 0;
  for (const usage of orphanUsages) {
    totalInvocations += usage.invocationCount;
    const prev = invCountBySession.get(usage.agentSessionId) ?? 0;
    invCountBySession.set(usage.agentSessionId, prev + usage.invocationCount);
  }

  const {
    usageSessions,
    branchesTab,
    branchesTabTruncated,
    sessionsTab,
    sessionsTabTruncated,
  } = await resolveDetailSessionTabs(db, organizationId, invCountBySession);

  const sessionIds = [...invCountBySession.keys()];

  // ISS-4886: these four reads are mutually independent, so run them as one
  // CONCURRENT BATCH rather than four serial waits. This is not one round trip:
  // each read issues its own queries (the invocation page always issues two,
  // cohort performance can issue several), so the win is overlapping their
  // latency, not collapsing them into a single query. A fixed handful of
  // concurrent queries is pool-safe (unlike a fan-out over a variable-length
  // array — see "Bounded fan-out" in apps/api/AGENTS.md). Only
  // `resolveDetailCollaborators` below has to stay sequential: it consumes the
  // resolved definition hashes.
  const [
    locCostBySession,
    cohortMetrics,
    invocationRows,
    orphanDefinitionHashById,
  ] = await Promise.all([
    // LOC/$ from local-git session LOC + cost (FEA-2923 follow-up; ISS-4667
    // unit reconciliation); deduped by session id. Orphan-only components have
    // no inventory row but do carry sessions, so their LOC/$ is still honest
    // when those sessions produced lines.
    loadSessionLocCost(db, organizationId, sessionIds),
    computeCohortPerformance(db, organizationId, sessionIds),
    loadAgentComponentInvocationReadPage(db, {
      organizationId,
      kind,
      key,
      inventoryIds: [],
    }),
    // FEA-4098 (wongk): an orphan-only identity still carries the F1
    // `definitionVersionId` its usage ran against — the list-view row already
    // shows authors from it — so resolve the authors lineage here too instead
    // of hardcoding an empty set. Resolve the version links to their exact
    // `definitionHash`es; the discoverer/editor lineage is then unioned
    // (deduped by stable user id) below. Empty only when no usage row links a
    // version (skew-safe).
    resolveDefinitionHashes(
      db,
      organizationId,
      orphanUsages.map((u) => u.definitionVersionId)
    ),
  ]);

  const orphanDefinitionHashes = orphanUsages
    .map((u) =>
      u.definitionVersionId
        ? (orphanDefinitionHashById.get(u.definitionVersionId) ?? null)
        : null
    )
    .filter((h): h is string => h != null);
  const collaborators = await resolveDetailCollaborators(
    db,
    organizationId,
    orphanDefinitionHashes
  );

  const orphanSlug = encodeComponentSlug(kind, key, null);
  // FEA-4335: echo the routable key the client navigated with (a content-hash
  // key for a new link) so the detail round-trips; fall back to the name-level
  // orphan slug for legacy callers.
  const echoedSlug = echoSlug ?? orphanSlug;
  return {
    // Orphan-only path has no cloud UUID, so identity `id` IS the slug itself
    // (per the `AgentComponent` doc); both use the `encodeComponentSlug` SSOT.
    id: echoedSlug,
    slug: echoedSlug,
    name: key,
    kind: kind as AgentComponentKind,
    // FEA-4374: taxonomy parity with the list — an orphan MCP tool is Server.
    sourceType: resolveOrphanSourceType(kind),
    source: key,
    // ISS-5009: `source` above IS the identity key — the echo, unavoidable for an
    // orphan-only identity, which has no inventory row and so no provenance.
    honestSource: resolveOrphanHonestSource(kind, key),
    harness: deriveOrphanHarness(orphanUsages),
    invocations: totalInvocations,
    sessions: invCountBySession.size,
    ...emitLocPerDollarWithLegacy(
      locPerDollarForKind(kind, invCountBySession.keys(), locCostBySession)
    ),
    trend: [],
    // FEA-4098 (wongk): authors resolved from the orphan usage's own
    // `definitionVersionId` lineage — parity with the list-view row, which
    // already shows these — rather than a hardcoded empty set. Empty only when
    // no usage row links a `DefinitionVersion` (skew-safe). `owner` is an
    // additive skew-compat alias (the discoverer), omitted when empty.
    collaborators,
    ...ownerCompat(collaborators),
    computeTargetIds: [],
    // ISS-5577: derived from the usage rows that MADE this an orphan-only
    // identity, never `new Date()` — a request-clock stamp made every used-only
    // component claim it was first seen the instant the page loaded, which is a
    // fact about the response, not an observation about the component. Empty
    // string when no row in the population recorded the timestamp at all: the
    // same honest-absent sentinel the desktop mirror emits, and one every
    // consumer of these fields already treats as unknown (`isNewlyDiscovered`
    // reads an unparseable value as not-new).
    firstSeenAt: seenBounds.firstSeenAt?.toISOString() ?? "",
    lastSeenAt: seenBounds.lastSeenAt?.toISOString() ?? "",
    properties: buildComponentProperties({ kind, path: key }),
    prompt: null,
    versions: [],
    // F1 (FEA-3290 · AC-020): an orphan-only (usage-but-no-inventory) identity is
    // name-only from the read surface — it demonstrably ran but has no honest
    // definition backing it, so it is `unresolved`, never `resolved`/`missing`.
    resolvedState: ComponentResolvedState.Unresolved,
    invocationRows,
    sessionsTab,
    sessionsTabTruncated,
    branchesTab,
    branchesTabTruncated,
    provenance: [],
    usageSessions,
    ...cohortMetrics,
  };
}

/**
 * ISS-5577: the observation window an orphan-only identity actually has evidence
 * for. `buildOrphanOnlyDetail` previously stamped `new Date()` here, so every
 * used-only component claimed it was first seen the instant the request was
 * served — a fact about the response, not about the component.
 *
 * The lane reads are ordered `lastInvokedAt desc`, so a lane bound by its own
 * `take` dropped precisely the OLDEST rows. `truncated` is REPORTED by
 * {@link fetchDetailOrphanUsageLanes}, never re-derived here from a row count
 * and a cap (the ISS-4797/4799 lesson in `detail-version-history.ts`). When it
 * is false the fetched rows ARE the whole population and folding them is exact
 * and free; when it is true a fold would skew `firstSeenAt` systematically
 * recent — the same fabricated-but-plausible failure in a smaller costume — so
 * the uncapped aggregate runs instead. That keeps the extra query off every
 * ordinary request while never trading accuracy for it:
 * `AgentComponentSessionUsage.firstInvokedAt` carries no index, so the aggregate
 * is the expensive path and belongs on the rare branch.
 */
function resolveOrphanSeenWindow(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  scope: OrphanUsageScope,
  lanes: DetailOrphanUsageLanes
): Promise<DetailUsageSeenBounds> {
  if (lanes.truncated) {
    return fetchDetailUsageSeenBounds(
      db,
      scope.organizationId,
      scope.kind,
      scope.key,
      scope.keys,
      scope.contentScope
    );
  }
  return Promise.resolve(foldUsageSeenBounds(lanes.rows));
}

/** The identity an orphan-only usage snapshot is scoped to. */
type OrphanUsageScope = {
  organizationId: string;
  kind: string;
  key: string;
  keys: string[];
  contentScope: UsageContentScope | null;
};

/**
 * ISS-5577 (wongk review): the two orphan lanes and the capped-lane seen-bounds
 * aggregate, read under ONE short `RepeatableRead` snapshot — the same isolation
 * and timeout the inventory-present path's three-lane read already uses
 * (`loadDetailUsageGroups`).
 *
 * These statements are not independent observations of a static table:
 * `AgentComponentSessionUsage.agentComponentId` is rewritten by concurrent usage
 * upserts, and the two lanes split on precisely that column (`IS NULL` vs
 * `IS NOT NULL`). Issued outside a shared snapshot, a row relinked BETWEEN them
 * is missed by both — it was still null-FK when the linked lane passed it, and
 * FK-linked by the time the orphan lane read. The population then silently loses
 * rows: an untruncated fold trusts that incomplete slice for the window, and in
 * the only-row case `orphanUsages` comes back empty and the detail 404s a
 * component that exists. One snapshot makes every statement here see the same
 * committed state, so a concurrent relink lands wholly inside or wholly outside
 * the read. Reads only, so there is nothing to catch-and-continue past
 * (AGENTS.md tx rule).
 */
function loadOrphanUsageSnapshot(scope: OrphanUsageScope): Promise<{
  orphanUsages: DetailOrphanUsageRow[];
  seenBounds: DetailUsageSeenBounds;
}> {
  return withDb.tx(
    async (tx) => {
      const lanes = await fetchDetailOrphanUsageLanes(
        tx,
        scope.organizationId,
        scope.kind,
        scope.key,
        scope.keys,
        scope.contentScope
      );
      // ISS-5577: the identity's REAL observation window, from the rows that
      // made it an orphan-only identity — never the request clock. Inside the
      // snapshot so the aggregate describes the same population the lanes read,
      // and free (no query) unless the lane read reported its `take` bound.
      const seenBounds = await resolveOrphanSeenWindow(tx, scope, lanes);
      return { orphanUsages: lanes.rows, seenBounds };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: DETAIL_USAGE_SNAPSHOT_TX_TIMEOUT_MS,
    }
  );
}
