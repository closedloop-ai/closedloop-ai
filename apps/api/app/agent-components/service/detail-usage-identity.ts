import "server-only";

import { Prisma, withDb } from "@repo/database";
import type { UsageContentScope } from "../content-hash-identity";
import {
  type DetailOrphanUsageRow,
  detailUsageNameKeys,
  fetchDetailOrphanUsage,
} from "../detail-usage-reads";
import {
  createHarnessAccumulator,
  foldUsageHarness,
  type HarnessAccumulator,
} from "../harness-attribution";
import {
  familyIdentitySlug,
  type UsageGroupRow,
  usageIdentitySlug,
} from "../identity";
import {
  loadUsageGroupsForInventory,
  loadUsageGroupsLinkedElsewhere,
} from "../org-population";
import { readOrgInventoryIds } from "../org-population-reads";

// ---------------------------------------------------------------------------
// Detail-side usage identity + folds (ISS-4660 item 1, extracted from
// service/detail-read.ts).
//
// The detail read loads FK-linked usage by the selected family's INVENTORY IDS.
// That answers "which usage rows point at these rows", which is not the same
// question the list asks. Since ISS-4630 the list attributes a usage group by
// the group's OWN `(componentKind, componentKey)` (`usageIdentitySlug`), so a
// usage row installed as Y but FK-linked to an inventory row of X is credited to
// Y in the list — and, until this module existed, to X in the detail. Two
// screens, two numbers, same data.
//
// The fix is a filter, not a different query: keep loading by inventory id (that
// bound is what keeps the read cheap), then drop the groups whose own identity
// says they belong to some other family. The filter is applied ONCE at the load
// site so every downstream consumer of `usageGroups` — the totals fold, the
// harness fold, the per-session and per-branch maps — sees the same set and
// cannot drift apart from each other either.
//
// A filter can only subtract, so on its own it closed ONE direction. ISS-5363
// closed the other: a group whose own identity IS this family but which is
// FK-linked to some OTHER family's inventory row used to be absent from the
// detail's read entirely (the FK lane is bounded by this family's inventory ids;
// the orphan lane matches only usage no LIVE inventory row owns), so the list credited it
// here while the detail reported a hard `0`. `loadUsageGroupsLinkedElsewhere`
// now reads exactly those rows and the call site concatenates both lanes before
// filtering, which is why this filter runs over the UNION rather than over the
// inventory-bounded read alone.
// ---------------------------------------------------------------------------

/** Every name the detail being rendered legitimately answers for. */
export type DetailUsageIdentity = {
  /** The detail's component kind. */
  kind: string;
  /** The detail's primary name-level key. */
  key: string;
  /**
   * Other names the same CONTENT is installed under, from the version table.
   * Empty on a plain name-level route.
   */
  keys: readonly string[];
  /**
   * The inventory rows this detail actually resolved and renders. Required, and
   * NOT redundant with `keys`: a content-hash route selects inventory rows by
   * `contentHash` alone, while `keys` is derived from `AgentComponentVersion`
   * rows — so a row whose version row is missing or not definition-linked is
   * rendered by this detail while its name never appears in `keys`. Deriving the
   * name set from the rendered rows as well is what stops the filter dropping
   * usage that belongs to this very page.
   */
  inventoryRows: readonly {
    componentKind: string;
    componentKey: string | null;
    name: string | null;
  }[];
};

/**
 * Drop usage groups whose OWN identity belongs to a different family than the
 * detail being rendered.
 *
 * The accepted set is the union of every name this detail answers for — the
 * primary key, the other names sharing its content, and the names its rendered
 * inventory rows carry. Anything narrower risks dropping usage the page is
 * responsible for, which would be the same list⇄detail divergence pointed the
 * other way.
 *
 * A group carrying no own identity is KEPT: that is the legacy group shape that
 * predates the key dimensions, and the list's fold falls back to the FK'd row's
 * slug for exactly those. Dropping them would make the detail undercount the
 * very rows the list still counts.
 */
export function filterUsageGroupsToDetailIdentity(
  usageGroups: UsageGroupRow[],
  identity: DetailUsageIdentity
): UsageGroupRow[] {
  const detailSlugs = collectDetailSlugs(identity);
  // No derivable slug for this detail at all (a malformed or empty key): there
  // is nothing to compare against, so keep today's behavior rather than silently
  // emptying the detail's usage.
  if (detailSlugs.size === 0) {
    return usageGroups;
  }
  return usageGroups.filter((group) => {
    const ownSlug = usageIdentitySlug(group);
    return ownSlug === undefined || detailSlugs.has(ownSlug);
  });
}

function collectDetailSlugs(identity: DetailUsageIdentity): Set<string> {
  const detailSlugs = new Set<string>();
  const add = (kind: string, candidate: string | null | undefined) => {
    const slug = familyIdentitySlug(kind, candidate);
    if (slug !== undefined) {
      detailSlugs.add(slug);
    }
  };
  add(identity.kind, identity.key);
  for (const candidate of identity.keys) {
    add(identity.kind, candidate);
  }
  for (const row of identity.inventoryRows) {
    // `name` is the fallback the rest of the read uses when `componentKey` is
    // null, so honor the same fallback here.
    add(row.componentKind, row.componentKey ?? row.name);
  }
  return detailSlugs;
}

export function aggregateDetailUsage(usageGroups: UsageGroupRow[]): {
  totalInvocations: number;
  sessionIdSet: Set<string>;
} {
  let totalInvocations = 0;
  const sessionIdSet = new Set<string>();

  // Grouped rows are already org-scoped by the `groupBy`'s `where`. Summing
  // folds a session's per-branch rows into its total and dedupes the session id.
  // FEA-4098 (Slice 3): the detail's people-set is no longer derived from
  // inventory compute-target users here — it is the `DefinitionVersionEditor`
  // authors lineage (`resolveDetailCollaborators`), so this fold is usage-only.
  for (const group of usageGroups) {
    totalInvocations += group._sum.invocationCount ?? 0;
    sessionIdSet.add(group.agentSessionId);
  }

  return { totalInvocations, sessionIdSet };
}

/**
 * FEA-3758: fold the distinct session harnesses from a detail's usage lanes
 * (FK-linked groups + orphan rows) into one accumulator so the detail's harness
 * is attributed from the sessions the component actually ran in — mirroring the
 * list view (`aggregateUsageIntoMerged`/`foldOrphanUsageIntoMerged`) so both
 * surfaces report the same harness. The inventory-row harness is used only as
 * the fallback when no usage carried one (`resolveComponentHarness`).
 */
export function accumulateDetailHarnesses(
  usageGroups: UsageGroupRow[],
  orphanUsages: readonly DetailOrphanUsageRow[]
): HarnessAccumulator {
  const acc = createHarnessAccumulator();
  for (const group of usageGroups) {
    foldUsageHarness(acc, group.harness);
  }
  for (const usage of orphanUsages) {
    foldUsageHarness(acc, usage.harness);
  }
  return acc;
}

/**
 * ISS-5363: load ALL THREE of the detail's usage lanes and hand back one
 * filtered FK set plus the orphan rows, read under ONE snapshot.
 *
 * The list and the detail never disagreed about attribution — since ISS-4630
 * both credit a usage group by its own `(componentKind, componentKey)`. They
 * disagreed about what gets LOADED. The list's FK read is bounded by every
 * inventory id in the org, so a row installed as Y but FK-linked to X is read
 * and folded onto Y; the detail's FK read is bounded by ONE family's inventory
 * ids, so that row was never read here, and the orphan lane could not recover it
 * (`fetchDetailOrphanUsage` matches only usage no LIVE inventory row owns). The
 * detail
 * reported a hard `0` against a list row showing real usage.
 *
 * The three lanes partition the org's usage by `agentComponentId`: `in` this
 * family's LIVE inventory ids, `in` the REST of the list's live inventory ids,
 * and owned by no live inventory row at all (null, or a tombstoned FK —
 * ISS-6180). wongk (ISS-5363 review): that partition holds only WITHIN ONE DATABASE
 * SNAPSHOT. Read on the pool, a concurrent `agentComponentId` relink committing
 * between two lanes is visible to both (double-count) or to neither (drop), and
 * the orphan lane — issued later still — was a third snapshot. So all three run
 * inside one `RepeatableRead` interactive transaction, exactly as the list's own
 * FK+orphan pair has since ISS-4669. Reads only, so there is nothing to
 * catch-and-continue past (AGENTS.md tx rule).
 *
 * shafty023 (ISS-6180 review on #5039): the LIVE-INVENTORY BOUND
 * (`readOrgInventoryIds`) is inside that transaction too. It used to be pooled,
 * on the reasoning that the snapshot guards the usage table's FK column and not
 * which inventory rows exist — true until the orphan lane began partitioning on
 * `agentComponent.uninstalledAt`. That predicate IS the boundary between the FK
 * lanes and the orphan lane, so splitting it across two snapshots reopens the
 * same hole from the other side: a tombstone committing in between keeps the id
 * in the elsewhere-linked bound while the orphan lane also claims the row, and a
 * restore drops it from both.
 *
 * shafty023 again, on the first fix: the partition has TWO live-inventory bounds,
 * and only one of them moved. This family's OWN ids were still the caller's
 * pooled `inventoryRows`, feeding both `ownIds` and the inventory lane, so the
 * identical race survived on the near half — a row tombstoned between the two
 * reads kept its usage in the FK lane while the orphan lane claimed it again. So
 * the own half is re-derived here too, from the caller's identity PREDICATE
 * rather than its resolved ids, leaving nothing that partitions the lanes outside
 * the snapshot.
 *
 * The identity filter then runs ONCE over the FK union, so the totals fold, the
 * harness fold, and the per-session/per-branch maps all share one set.
 */
export async function loadDetailUsageGroups(params: {
  organizationId: string;
  identity: DetailUsageIdentity;
  /**
   * The identity predicate selecting this family's LIVE inventory rows — the
   * inventory lane's bound, re-derived inside the snapshot rather than passed in
   * as ids resolved on the pool.
   */
  liveInventoryWhere: Prisma.AgentComponentWhereInput;
  contentScope: UsageContentScope | null;
}): Promise<DetailUsageLanes> {
  const { identity, liveInventoryWhere, organizationId, contentScope } = params;
  const nameKeys = detailUsageNameKeys(identity.key, identity.keys);
  const { inventoryLinked, elsewhereLinked, orphanUsages } = await withDb.tx(
    async (tx) => {
      // ISS-6180 (shafty023 re-review on #5039): this family's OWN live ids are
      // derived HERE, not handed in from the caller's pooled read. They are the
      // other half of the same partition `readOrgInventoryIds` bounds below, and
      // leaving them on the pool left one live-inventory bound outside the
      // snapshot: a row tombstoned in between stayed in the FK lane's `in` list
      // (its usage counted there) while the orphan lane saw the tombstone and
      // claimed the same row again — the double-count, reached through the id
      // bound instead of the predicate. Re-deriving is not an intersection with
      // `orgInventoryIds`: that read is capped and identity-spine-scoped, so
      // intersecting would drop this family's own rows on a large org.
      const ownInventoryIds = (
        await tx.agentComponent.findMany({
          where: liveInventoryWhere,
          select: { id: true },
        })
      ).map((row) => row.id);
      const ownIds = new Set(ownInventoryIds);
      // ISS-6180 (shafty023 review on #5039): the list's population is resolved
      // INSIDE the snapshot, not pooled ahead of it — mirroring
      // `buildOrgComponentPopulation`'s `readUsageSnapshot`. This read was
      // deliberately outside while the only race the snapshot guarded was on the
      // usage table's FK column. It no longer is: the orphan lane now partitions
      // on `agentComponent.uninstalledAt`, so "which inventory rows are live" IS
      // the lane boundary, and evaluating it on a second snapshot lets a
      // concurrent tombstone admit a row to both lanes (double-count) or a
      // restore drop it from both (undercount).
      const orgInventoryIds = await readOrgInventoryIds(tx, organizationId);
      const otherInventoryIds = orgInventoryIds.filter((id) => !ownIds.has(id));
      const inventoryLane = await loadUsageGroupsForInventory(
        tx,
        organizationId,
        ownInventoryIds,
        // The detail read has no time window.
        {},
        // FEA-4335: narrow FK-linked usage to the requested content version so a
        // device that moved A→B does not report A+B combined on B's URI.
        contentScope
      );
      const elsewhereLane = await loadUsageGroupsLinkedElsewhere(
        tx,
        organizationId,
        identity.kind,
        // The SAME name derivation the orphan lane matches on, so the two
        // identity-scoped lanes cannot ask different questions.
        nameKeys,
        otherInventoryIds,
        contentScope
      );
      const orphanLane = await fetchDetailOrphanUsage(
        tx,
        organizationId,
        identity.kind,
        identity.key,
        // FEA-4335: match orphan usage under every name that shares the content,
        // narrowed to the requested content version for a content-hash route.
        [...identity.keys],
        contentScope
      );
      return {
        inventoryLinked: inventoryLane,
        elsewhereLinked: elsewhereLane,
        orphanUsages: orphanLane,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: DETAIL_USAGE_SNAPSHOT_TX_TIMEOUT_MS,
    }
  );
  return {
    usageGroups: filterUsageGroupsToDetailIdentity(
      [...inventoryLinked, ...elsewhereLinked],
      identity
    ),
    orphanUsages,
  };
}

/** The detail's three usage lanes, read under one snapshot. */
export type DetailUsageLanes = {
  /** The FK union (inventory-linked + elsewhere-linked), identity-filtered. */
  usageGroups: UsageGroupRow[];
  /** The no-live-inventory-owner lane (ISS-6180), read in the same snapshot. */
  orphanUsages: DetailOrphanUsageRow[];
};

/**
 * ISS-4669/ISS-5363: interactive-transaction timeout for the detail's three-lane
 * usage snapshot, and (ISS-5577) for the orphan-only path's own two-lane +
 * seen-bounds snapshot, which shares this value rather than re-declaring it.
 * Same reasoning and same value as the list's
 * `USAGE_SNAPSHOT_TX_TIMEOUT_MS`: these reads previously ran on the pool with no
 * transaction timeout, and wrapping them in one transaction would otherwise
 * inherit Prisma's 5s default, so a large-but-capped org that used to return
 * slowly could start erroring. The row caps keep the real cost far below this.
 */
export const DETAIL_USAGE_SNAPSHOT_TX_TIMEOUT_MS = 30_000;
