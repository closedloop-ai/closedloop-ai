import type { AgentComponentHonestSource } from "@repo/api/src/types/agent-component";
import {
  AgentComponentKind,
  SourceType,
} from "@repo/api/src/types/agent-component";
import {
  encodeComponentSlug,
  fingerprintIdentityKey,
  normalizeComponentKey,
  resolveVersionFingerprint,
  routableComponentHashKey,
  usageVersionIdentityKey,
} from "@repo/api/src/types/agent-component-analytics";
import { ComponentScope } from "@repo/api/src/types/component-scope";
import {
  createHarnessAccumulator,
  foldUsageHarness,
  type HarnessAccumulator,
} from "./harness-attribution";
import { normalizeSubagentIdentity } from "./subagent-identity";

// ---------------------------------------------------------------------------
// Org-level component identity, dedup, and usage fold (extracted from
// service.ts, FEA-3982 Slice 2). This module owns HOW the org-level list rows
// are keyed and merged: the fingerprint-aware identity key, the merge/fold
// accumulators, and the derived Source label. Keeping it separate shrinks the
// grandfathered service.ts and gives the identity contract its own test target.
// ---------------------------------------------------------------------------

export type MergedComponent = {
  id: string; // first encountered row id (canonical representative)
  slug: string; // org-identity slug (`kind::key`) — the LIST dedup / family key
  // FEA-4335: the routable content-hash key for the detail-page URI —
  // `${kind}::${versionFingerprint}` when a content fingerprint exists, else the
  // name-level `slug` (legacy fallback). This — NOT `slug` — is the value the
  // href builders emit and the detail/token-trend routes resolve by, so two
  // materially-different components that normalize to the same name get DISTINCT
  // URIs while byte-identical installs (any name/path) share one. Survives the
  // `collapseToCanonicalFamilies` fold (the collapsed family keeps its chosen
  // representative version's routable key even though its badge `fingerprint` is
  // nulled), so the family row still links to a content-hash-unique detail.
  routableKey: string;
  kind: string;
  key: string;
  name: string | null;
  // FEA-3982 (Slice 2): the exact-version fingerprint this row was bucketed on
  // (definitionHash ?? contentHash), or null for a hash-less legacy row. Backs
  // the `versionId` + short `fingerprint` badge on the emitted row so two
  // same-named-different-bytes components are distinguishable.
  versionFingerprint: string | null;
  // Harness recorded on the INVENTORY row (installed-component provenance). Only
  // the fallback when the component has no usage rows carrying a harness — the
  // authoritative source is `usageHarnesses` (FEA-3758).
  harness: string | null;
  // FEA-3758: distinct, non-empty harnesses observed across this identity's
  // usage rows (folded from FK-linked + orphan usage). The component's reported
  // harness is derived from this per-session set via `resolveComponentHarness`,
  // so a component used only in Codex sessions attributes `codex` (not the
  // inventory row's stale/defaulted `claude`) and one used across harnesses
  // attributes `both`.
  usageHarnesses: HarnessAccumulator;
  sourceUrl: string | null;
  // ISS-5009: the provenance columns the canonical representative inventory row
  // carried. FIRST-ROW-WINS, exactly like `sourceUrl` directly above — and
  // exactly like `resolveDetailSourceProjection`, whose `canonical` is `rows[0]`
  // — so the LIST row and the DETAIL page describe the SAME revision instead of
  // resolving provenance from two different rows of the same identity.
  //
  // Carried as one unit with `sourceUrl` (the family collapse adopts all three
  // together, see `adoptRepresentativeFields`) so the fold can never emit the
  // newest version's `sourceUrl` beside an older version's `scope`. Null on the
  // two synthetic usage-only seeds below: no inventory row means no provenance.
  //
  // `installPath` is deliberately NOT carried here. It is not part of the honest
  // provenance chain (see {@link resolveHonestSource}), so folding it would add a
  // field no reader consumes.
  //
  // `packId` is the REPRESENTATIVE's own pack, and is NOT interchangeable with
  // the `packIds` union below: the union is a cross-version set that stays
  // load-bearing for the plugin child-usage rollup and for the legacy
  // `resolveMergedSource`/`resolveMergedSourceType`. Reading the union's first
  // member for the honest projection would let a family report a pack belonging
  // to a revision it is not displaying — a pack dot naming a superseded version.
  packId: string | null;
  scope: string | null;
  projectPath: string | null;
  computeTargetIds: string[];
  // FEA-4247: the distinct user ids of the compute targets that OBSERVED this
  // identity, in first-seen order. This is the read-time fallback authorship
  // source restored after FEA-4098 removed the git-attributed `owner`: when a
  // row has no `DefinitionVersionEditor` lineage (a legacy/unlinked row), the
  // list/detail readers resolve these ids to display names so Owner is derived
  // from the observing user instead of rendering blank. Lineage authors always
  // take precedence; this is used ONLY when the lineage set is empty. Ordered +
  // deduped so the first entry is the earliest observer (the closest available
  // proxy for the original discoverer). Empty for usage-only synthetic buckets
  // (no inventory row, hence no observing compute target).
  computeTargetUserIds: string[];
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  // Max `AgentComponentSessionUsage.lastInvokedAt` across every usage row folded
  // into this identity — the component's real last-invocation time (a genuine
  // usage-recency signal), as opposed to `lastSeenAt` (inventory-observation
  // time the pack scanner refreshes to now() every sync). Null when the identity
  // has no usage rows at all. Powers the "active in the last hour" dot (FEA-3179)
  // and is the honest counterpart to the FEA-3160 usage windowing.
  lastInvokedAt: Date | null;
  // Every distinct `pack_id` folded into this identity across inventory rows.
  // For plugin-kind entries this is the set of packs whose CHILD usage rolls up
  // into the plugin's invocations/sessions (see `applyPluginChildUsageRollup`).
  packIds: Set<string>;
  // Org-wide usage aggregation across all inventory rows
  totalInvocations: number;
  // ISS-4635: org-wide error count folded from the SAME usage rows as
  // `totalInvocations` (FK-linked + orphan, or a plugin's child rollup), so the
  // ranking leaderboard's `errorRate` (`totalErrors / totalInvocations`) can
  // never be derived from a differently-scoped read than its denominator. The
  // catalog list does not surface an error rate and simply ignores it.
  totalErrors: number;
  sessionIds: Set<string>;
  // FEA-4267: the number of distinct version buckets (distinct
  // `versionFingerprint`s) collapsed into this row. Set ONLY on a canonical
  // FAMILY row produced by `collapseToCanonicalFamilies`; a pre-collapse
  // per-version bucket leaves it undefined. Backs the quiet "N versions" muted
  // catalog signal (rendered only when > 1) and lets the list emit a per-family
  // version count without re-deriving it from the pre-collapse map.
  versionCount?: number;
  // FEA-4267: set ONLY on a canonical FAMILY row produced by
  // `collapseToCanonicalFamilies` — the distinct `versionFingerprint`s of every
  // version bucket collapsed into this family. The catalog list resolves the
  // family row's authors as the UNION of lineage across ALL these fingerprints
  // (matching the detail page's cross-version author union), because a collapsed
  // multi-version row no longer carries a single fingerprint on the wire. Absent
  // on a per-version bucket (pre-collapse); consumers fall back to the single
  // `versionFingerprint` when this is undefined.
  familyFingerprints?: (string | null)[];
};

export type InventoryRow = {
  id: string;
  organizationId: string;
  computeTargetId: string;
  componentKind: string;
  externalComponentId: string;
  harness: string | null;
  name: string | null;
  componentKey: string | null;
  // FEA-3982 (Slice 2): the coarse raw-sha256 fingerprint of this row's captured
  // definition (null for event-minted / definition-less rows). Widens the org
  // dedup granularity so same-name/different-bytes rows split.
  contentHash: string | null;
  // FEA-3982 (wongk decision): the exact provenance-free `definitionHash` this
  // row's `contentHash` links to via `AgentComponentVersion.definitionVersionId`
  // (null until the F1 backfill lands, and for a hash-less row). Resolved by the
  // caller and preferred over `contentHash` when seeding the version bucket, so
  // an inventory row and the usage recorded against it bucket on the SAME exact
  // fingerprint once linked. `contentHash` stays the legacy fallback.
  definitionHash: string | null;
  sourceUrl: string | null;
  installPath: string | null;
  packId: string | null;
  scope: string | null;
  projectPath: string | null;
  // FEA-4247: the row's provenance metadata. A cloud-authored (sentinel-owned)
  // row carries `{ cloudAuthored: true, ... }` here; such a row's
  // `computeTarget.userId` is the org's earliest active user (the sentinel
  // owner), NOT the creator, so it is excluded from the owner fallback below.
  metadata: unknown;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  // FEA-4098 (Slice 3): the compute-target `user` is no longer selected here —
  // the authors people-set now comes from the `DefinitionVersionEditor` lineage
  // (see `resolveCollaboratorsByDefinitionHash`), not the inventory row's owner.
  computeTarget: {
    id: string;
    userId: string;
  };
};

/**
 * A usage row that has no `agentComponentId` FK yet (usage synced before the
 * inventory row existed, or the component-sync lane hasn't linked it). These
 * rows are invisible to the FK-based `sessionUsages` relation walk, so they are
 * fetched separately and folded into the matching org-identity merge entry by
 * `(componentKind, componentKey)` — otherwise invocation/session totals would
 * silently undercount depending on sync ordering.
 *
 * When no inventory row shares the identity, the orphan usage is the ONLY
 * cloud-side evidence that the org used the component (Gap B: session-sync
 * already delivers `AgentComponentSessionUsage`, but no inventory row exists
 * because the component was never collected as installed). Such rows now
 * SEED a synthetic merged entry so the component still surfaces in the list.
 */
export type OrphanUsageRow = {
  agentSessionId: string;
  componentKind: string;
  componentKey: string;
  // `AgentComponentSessionUsage` carries no display `name`; synthetic entries
  // fall back to `componentKey` for their label.
  harness: string | null;
  invocationCount: number;
  // ISS-4635: orphan usage carries errors too; folding them keeps a component
  // whose usage is entirely orphaned from reporting an `errorRate` of 0 over a
  // real invocation count.
  errorCount: number;
  firstInvokedAt: Date | null;
  lastInvokedAt: Date | null;
  // FEA-3982 (wongk decision): the version identity the orphan usage was recorded
  // against. An orphan row already carries `componentVersionHash` +
  // `definitionVersionId`, so it is NOT version-agnostic — it folds into the
  // MATCHING version bucket (reversing the earlier "always the name-level
  // unversioned bucket" behavior). `definitionHash` is resolved from
  // `definitionVersionId` (null until the F1 backfill lands). Both null ⇒ the
  // usage stays on the name-level bucket (skew-safe).
  componentVersionHash: string | null;
  definitionHash: string | null;
};

/**
 * One grouped-usage row as returned by the sibling
 * `agentComponentSessionUsage.groupBy(['agentComponentId','agentSessionId',
 * 'gitBranch','harness'])` the service issues instead of eagerly loading each
 * inventory row's nested `sessionUsages` collection.
 */
export type UsageGroupRow = {
  agentComponentId: string | null;
  agentSessionId: string;
  gitBranch: string;
  harness: string | null;
  // ISS-4630: the usage row's OWN `(componentKind, componentKey)` identity — the
  // same identity the DETAIL read (`fetchDetailOrphanUsage`) and the orphan fold
  // attribute by. `foldFkUsageIntoMerged` folds by THIS identity, not the FK'd
  // inventory row's slug, so FK-linked usage whose own key differs from (or whose
  // inventory row is outside) the list working set still lands on the right family
  // — reconciling the list totals with the detail totals (the FEA-4337/ISS-4456
  // recurrence). Null only for the legacy shape where the caller did not select
  // them; then the fold falls back to the FK'd inventory row's slug.
  componentKind: string | null;
  componentKey: string | null;
  // FEA-3982 (wongk decision): the version identity this usage was recorded
  // against, so the fold attributes it to the MATCHING version bucket rather
  // than to whatever inventory row currently holds the FK. `componentVersionHash`
  // is the coarse hash-at-invocation; `definitionHash` is the exact
  // provenance-free fingerprint resolved from the row's `definitionVersionId`
  // link (null until the F1 backfill lands, and the legacy fallback the contract
  // promises). Both null ⇒ the usage stays on the name-level bucket (skew-safe).
  componentVersionHash: string | null;
  definitionHash: string | null;
  _sum: { invocationCount: number | null; errorCount: number | null };
  _max: { lastInvokedAt: Date | null };
};

// The Claude parser names every typeless subagent spawn with an
// instance-unique label ("Claude subagent <8 hex>"), so pre-rollup installs
// synced one inventory row per spawn. `normalizeSubagentIdentity` (shared with
// the token-trend drill-down via `./subagent-identity`) collapses those to a
// single 'general-purpose' identity at read time so the listing rolls them up
// regardless of what was synced.
//
// FEA-3982 (Slice 2): the dedup map is keyed by `fingerprintIdentityKey(slug,
// fingerprint)` rather than the bare `slug`, so two same-named components with
// different bytes fold into two distinct entries. `maxOrgInventoryRows` bounds
// the total working set the same way the caller's inventory read does.
//
// FEA-3982 (wongk decision): usage is NOT folded here anymore. Seeding the
// version buckets from inventory is a SEPARATE pass from attributing usage,
// because a usage row's version bucket is decided by the hash the usage row
// itself carried at invocation time — which may be a DIFFERENT bucket than the
// inventory row currently holding its FK (a device that moved from hash A to
// hash B). The caller runs `mergeComponentRows` first to seed every version
// bucket, then `foldFkUsageIntoMerged` + `foldOrphanUsageIntoMerged` to route
// each usage row into the bucket matching its carried hash.
export function mergeComponentRows(
  inventoryRows: InventoryRow[]
): Map<string, MergedComponent> {
  const mergedMap = new Map<string, MergedComponent>();

  for (const row of inventoryRows) {
    const { key: normKey, name: normName } = normalizeSubagentIdentity(
      row.componentKind,
      row.componentKey,
      row.name
    );
    const slug = encodeComponentSlug(row.componentKind, normKey, normName);
    const fingerprint = resolveVersionFingerprint(
      row.contentHash,
      row.definitionHash
    );
    const identityKey = fingerprintIdentityKey(slug, fingerprint);

    let merged = mergedMap.get(identityKey);
    if (!merged) {
      merged = {
        id: row.id,
        slug,
        routableKey: routableComponentHashKey(
          row.componentKind,
          fingerprint,
          normKey,
          normName
        ),
        kind: row.componentKind,
        key: (normKey ?? normName ?? "").toLowerCase().trim(),
        name: normName,
        versionFingerprint: fingerprint,
        harness: row.harness,
        usageHarnesses: createHarnessAccumulator(),
        sourceUrl: row.sourceUrl,
        // ISS-5009: first-row-wins, matching `sourceUrl` on the line above and
        // the detail read's `rows[0]` canonical — see `MergedComponent`.
        packId: row.packId,
        scope: row.scope,
        projectPath: row.projectPath,
        computeTargetIds: [],
        computeTargetUserIds: [],
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
        // Seeded from usage rows in the fold passes below, not from the
        // inventory row's observation timestamps.
        lastInvokedAt: null,
        packIds: new Set(),
        totalInvocations: 0,
        totalErrors: 0,
        sessionIds: new Set(),
      };
      mergedMap.set(identityKey, merged);
    }

    // Per-device provenance
    merged.computeTargetIds.push(row.computeTargetId);
    // FEA-4247: track the observing user (deduped, first-seen order) as the
    // read-time authorship fallback for rows with no `DefinitionVersionEditor`
    // lineage. `inventoryRows` is ordered `lastSeenAt DESC, id ASC` by the
    // caller, so the first user pushed is the most-recently-observed device's
    // owner — a stable, deterministic proxy for the author when no lineage
    // exists. Deduped by id so one user observing many devices counts once.
    //
    // wongk: a cloud-authored (sentinel-owned) row is EXCLUDED. Its
    // `computeTarget.userId` is the org's earliest active user (the synthetic
    // sentinel's owner), not the creator, so using it would attribute a
    // lineage-less cloud agent to an unrelated person. The real creator lives on
    // `CatalogItem.createdById` (not on this row), so we omit the fallback here
    // rather than show a wrong owner — the row falls back to an honest empty
    // until the lineage or a creator read lands (follow-up FEA-4266).
    if (
      !(
        isCloudAuthoredRow(row) ||
        merged.computeTargetUserIds.includes(row.computeTarget.userId)
      )
    ) {
      merged.computeTargetUserIds.push(row.computeTarget.userId);
    }
    if (row.packId) {
      merged.packIds.add(row.packId);
    }

    // Timestamps: min firstSeenAt, max lastSeenAt
    if (
      row.firstSeenAt &&
      (!merged.firstSeenAt || row.firstSeenAt < merged.firstSeenAt)
    ) {
      merged.firstSeenAt = row.firstSeenAt;
    }
    if (
      row.lastSeenAt &&
      (!merged.lastSeenAt || row.lastSeenAt > merged.lastSeenAt)
    ) {
      merged.lastSeenAt = row.lastSeenAt;
    }
  }

  return mergedMap;
}

/**
 * FEA-3982 (wongk decision): the name-level slug each seeded inventory version
 * bucket carries, indexed by the inventory-row `id` its usage rows FK to. The
 * FK usage fold needs the SLUG (not the current inventory fingerprint) so it can
 * re-derive the usage row's OWN version bucket from the hash the usage row
 * carried — see {@link foldFkUsageIntoMerged}.
 */
export function buildInventorySlugById(
  inventoryRows: InventoryRow[]
): Map<string, string> {
  const slugById = new Map<string, string>();
  for (const row of inventoryRows) {
    const { key: normKey, name: normName } = normalizeSubagentIdentity(
      row.componentKind,
      row.componentKey,
      row.name
    );
    slugById.set(
      row.id,
      encodeComponentSlug(row.componentKind, normKey, normName)
    );
  }
  return slugById;
}

/**
 * FEA-3982 (wongk decision): fold FK-linked usage into the version bucket the
 * usage row's OWN hash points at, not the inventory row that currently holds its
 * FK. Each usage group carries the `componentVersionHash`/`definitionHash` the
 * component was at when the session ran, so a device that moved from hash A to
 * hash B keeps its historical A sessions on the A bucket even though the shared
 * inventory row now reads B (the exact mis-attribution wongk flagged). Usage with
 * no resolvable version hash folds into the name-level bucket (skew-safe). A
 * usage row whose version bucket was never seeded by inventory (its inventory row
 * was tombstoned, or the hash predates the current inventory row) creates the
 * bucket on demand from the usage row alone, subject to `maxOrgInventoryRows`.
 */
export function foldFkUsageIntoMerged(
  mergedMap: Map<string, MergedComponent>,
  slugById: Map<string, string>,
  usageByComponentId: Map<string, UsageGroupRow[]>,
  maxOrgInventoryRows: number
): void {
  for (const [componentId, groups] of usageByComponentId) {
    const fkRowSlug = slugById.get(componentId);
    for (const group of groups) {
      // ISS-4630: attribute FK-linked usage by the usage row's OWN
      // `(componentKind, componentKey)` identity — the SAME identity the detail
      // read (`fetchDetailOrphanUsage`) and the orphan fold use — rather than the
      // FK'd inventory row's slug. This reconciles the list totals with the
      // detail totals in two cases the FK'd-slug attribution got wrong (the
      // FEA-4337/ISS-4456 recurrence): a usage row whose own key differs from the
      // inventory row it is FK-linked to, and a usage row whose FK'd inventory row
      // fell outside the capped list working set (uninstalled or dropped tail) so
      // `slugById` has no entry for it — detail still counts those via its
      // uncapped, identity-scoped read. The FK'd inventory row's slug is the
      // fallback ONLY when the usage row carries no own key (legacy group shape).
      const slug = usageIdentitySlug(group) ?? fkRowSlug;
      // No own identity AND no FK'd inventory row slug (outside the working set):
      // nothing to attribute to, so skip rather than guess.
      if (slug === undefined) {
        continue;
      }
      const identityKey = usageVersionIdentityKey(
        slug,
        group.componentVersionHash,
        group.definitionHash
      );
      const merged = resolveUsageBucket(
        mergedMap,
        identityKey,
        slug,
        group,
        maxOrgInventoryRows
      );
      if (!merged) {
        continue;
      }
      foldUsageGroup(merged, group);
    }
  }
}

/**
 * ISS-4630: the name-level family slug a usage GROUP belongs to, derived from the
 * usage row's OWN `(componentKind, componentKey)` — the SAME normalization the
 * orphan fold (`foldOrphanUsageIntoMerged`) and the detail read use, so FK-linked
 * and orphan usage attribute to one identity and the list/detail totals reconcile.
 * Returns `undefined` when the group carries no own identity (a legacy group shape
 * that predates the key dimensions), so the caller falls back to the FK'd
 * inventory row's slug.
 */
export function usageIdentitySlug(group: UsageGroupRow): string | undefined {
  return familyIdentitySlug(group.componentKind, group.componentKey);
}

/**
 * The name-level family slug for a raw `(kind, key)` pair, under the one
 * normalization every usage lane uses.
 *
 * Exported (ISS-4660 item 1) so the DETAIL read can derive the slugs of the
 * identity it is rendering and compare them against `usageIdentitySlug` of each
 * usage group, instead of trusting the FK the group happens to carry. Without a
 * shared derivation the two surfaces normalize independently and drift — which
 * is the whole class of bug this module exists to close.
 *
 * Returns `undefined` for a falsy kind or key: `componentKey` may be an empty
 * string on a malformed row, and an empty slug is never a real family.
 */
export function familyIdentitySlug(
  kind: string | null | undefined,
  key: string | null | undefined
): string | undefined {
  if (!(kind && key)) {
    return;
  }
  const { key: normKey } = normalizeSubagentIdentity(kind, key, null);
  return encodeComponentSlug(kind, normKey, null);
}

/**
 * Resolve (or lazily create) the version bucket a usage row attributes to.
 * Returns the existing seeded bucket when the usage row's version was already
 * observed as inventory; otherwise synthesizes a usage-only bucket from the
 * usage row's fields (its inventory row is gone or the hash predates it),
 * respecting the working-set cap. Returns null only when the cap is hit and no
 * bucket exists, so the caller drops that usage rather than growing unbounded.
 */
function resolveUsageBucket(
  mergedMap: Map<string, MergedComponent>,
  identityKey: string,
  slug: string,
  group: UsageGroupRow,
  maxOrgInventoryRows: number
): MergedComponent | null {
  const existing = mergedMap.get(identityKey);
  if (existing) {
    return existing;
  }
  if (mergedMap.size >= maxOrgInventoryRows) {
    return null;
  }
  const { key: normKey } = normalizeSubagentIdentity(
    slugKind(slug),
    slugKey(slug),
    null
  );
  const fingerprint = resolveVersionFingerprint(
    group.componentVersionHash,
    group.definitionHash
  );
  const merged: MergedComponent = {
    id: identityKey,
    slug,
    routableKey: routableComponentHashKey(
      slugKind(slug),
      fingerprint,
      normKey,
      null
    ),
    kind: slugKind(slug),
    key: (normKey ?? "").toLowerCase().trim(),
    name: null,
    versionFingerprint: fingerprint,
    harness: group.harness,
    usageHarnesses: createHarnessAccumulator(),
    sourceUrl: null,
    // ISS-5009: no inventory row backs a usage-only bucket, so it carries no
    // provenance at all.
    packId: null,
    scope: null,
    projectPath: null,
    computeTargetIds: [],
    // FEA-4247: a usage-only synthetic bucket has no inventory row and therefore
    // no observing compute target, so there is no fallback owner to resolve.
    computeTargetUserIds: [],
    firstSeenAt: null,
    lastSeenAt: null,
    lastInvokedAt: null,
    packIds: new Set(),
    totalInvocations: 0,
    totalErrors: 0,
    sessionIds: new Set(),
  };
  mergedMap.set(identityKey, merged);
  return merged;
}

/** The kind half of a `${kind}::${key}` identity slug. */
function slugKind(slug: string): string {
  const sep = slug.indexOf("::");
  return sep === -1 ? slug : slug.slice(0, sep);
}

/** The key half of a `${kind}::${key}` identity slug. */
function slugKey(slug: string): string {
  const sep = slug.indexOf("::");
  return sep === -1 ? "" : slug.slice(sep + 2);
}

/** Fold one grouped-usage row's totals into a resolved version bucket. */
function foldUsageGroup(merged: MergedComponent, group: UsageGroupRow): void {
  merged.totalInvocations += group._sum.invocationCount ?? 0;
  // ISS-4635: errors ride the same fold as invocations so `errorRate` shares its
  // denominator's scope.
  merged.totalErrors += group._sum.errorCount ?? 0;
  merged.sessionIds.add(group.agentSessionId);
  bumpLastInvokedAt(merged, group._max.lastInvokedAt);
  // FEA-3758: attribute the component's harness from the sessions it actually
  // ran in. `harness` is part of the groupBy key, so a component used in both
  // harnesses yields distinct-harness groups and resolves to `both`.
  foldUsageHarness(merged.usageHarnesses, group.harness);
}

/**
 * Widen `merged.lastInvokedAt` to the later of its current value and `candidate`
 * — the running max real-invocation time across every usage row folded into the
 * identity (see MergedComponent.lastInvokedAt). No-op when `candidate` is null.
 */
function bumpLastInvokedAt(
  merged: MergedComponent,
  candidate: Date | null
): void {
  if (
    candidate &&
    (!merged.lastInvokedAt || candidate > merged.lastInvokedAt)
  ) {
    merged.lastInvokedAt = candidate;
  }
}

/**
 * Fold orphaned (null-FK) usage rows into merged entries by identity slug.
 * Because `AgentComponentSessionUsage` is unique on
 * `(agentSessionId, componentKind, componentKey)`, a given usage row is either
 * FK-linked (already counted via `foldFkUsageIntoMerged`) or orphaned (counted
 * here) — never both, so there is no double count.
 *
 * When an orphan's version bucket has no inventory row, a synthetic merged entry
 * is created from the usage row's own fields (Gap B fast fix) so components a
 * user only USED (never had collected as installed inventory) still surface. The
 * synthetic entry is keyed by the same version identity, so if a real inventory
 * row for that version later appears it MERGES into the same entry rather than
 * duplicating. Synthetic-entry creation respects `maxOrgInventoryRows` so the
 * total working set (inventory + synthetic) stays bounded.
 *
 * FEA-3982 (wongk decision): an orphan usage row is NOT version-agnostic — it
 * carries the `componentVersionHash` (and, once the F1 backfill lands, a
 * `definitionVersionId` resolved to `definitionHash`) the component was at when
 * the session ran. It therefore folds into the MATCHING version bucket
 * (`usageVersionIdentityKey`), reversing the earlier behavior that dumped every
 * orphan into the name-level unversioned bucket. This keeps a device's historical
 * hash-A sessions attributed to the A version even after it moved to B. Only a
 * usage row that carries NO resolvable version hash stays on the name-level
 * bucket — which is still deterministic (all such rows share one bucket) and
 * independent of inventory ordering.
 */
export function foldOrphanUsageIntoMerged(
  mergedMap: Map<string, MergedComponent>,
  orphanUsages: OrphanUsageRow[],
  maxOrgInventoryRows: number
): void {
  for (const usage of orphanUsages) {
    // Roll up instance-unique subagent usage the same way inventory rows are
    // normalized (see normalizeSubagentIdentity), so orphan (usage-only)
    // subagent rows collapse into the single 'general-purpose' entry too.
    const { key: normKey } = normalizeSubagentIdentity(
      usage.componentKind,
      usage.componentKey,
      null
    );
    const slug = encodeComponentSlug(usage.componentKind, normKey, null);
    // FEA-3982 (wongk decision): attribute by the usage row's OWN carried version
    // hash, so its counts land in the matching version bucket rather than an
    // arbitrary or a catch-all unversioned one.
    const fingerprint = resolveVersionFingerprint(
      usage.componentVersionHash,
      usage.definitionHash
    );
    const identityKey = fingerprintIdentityKey(slug, fingerprint);
    let merged = mergedMap.get(identityKey);
    if (!merged) {
      // No inventory row for this identity's version — surface it as a synthetic
      // usage-only entry seeded from the usage row, subject to the working-set
      // cap.
      if (mergedMap.size >= maxOrgInventoryRows) {
        continue;
      }
      merged = {
        // No canonical inventory row id exists; use the identity key as a stable,
        // deterministic id. Detail lookups re-resolve by slug, not id, so this
        // synthetic id never needs to match a real row.
        id: identityKey,
        slug,
        routableKey: routableComponentHashKey(
          usage.componentKind,
          fingerprint,
          normKey,
          null
        ),
        kind: usage.componentKind,
        key: (normKey ?? "").toLowerCase().trim(),
        // No display name on the usage row; the response falls back to `key`.
        name: null,
        // The usage row's carried version fingerprint (null when hash-less), so
        // the synthetic row badges the same version the usage attributed to.
        versionFingerprint: fingerprint,
        harness: usage.harness,
        usageHarnesses: createHarnessAccumulator(),
        sourceUrl: null,
        // ISS-5009: no inventory row backs a usage-only bucket, so it carries no
        // provenance at all.
        packId: null,
        scope: null,
        projectPath: null,
        // No installed inventory ⇒ no compute-target provenance to attribute.
        computeTargetIds: [],
        // FEA-4247: no inventory row ⇒ no observing compute target ⇒ no
        // fallback owner to resolve.
        computeTargetUserIds: [],
        firstSeenAt: usage.firstInvokedAt,
        lastSeenAt: usage.lastInvokedAt,
        lastInvokedAt: null,
        packIds: new Set(),
        totalInvocations: 0,
        totalErrors: 0,
        sessionIds: new Set(),
      };
      mergedMap.set(identityKey, merged);
    }
    // Timestamps: widen to min firstSeen / max lastSeen using invocation times.
    if (
      usage.firstInvokedAt &&
      (!merged.firstSeenAt || usage.firstInvokedAt < merged.firstSeenAt)
    ) {
      merged.firstSeenAt = usage.firstInvokedAt;
    }
    if (
      usage.lastInvokedAt &&
      (!merged.lastSeenAt || usage.lastInvokedAt > merged.lastSeenAt)
    ) {
      merged.lastSeenAt = usage.lastInvokedAt;
    }
    bumpLastInvokedAt(merged, usage.lastInvokedAt);
    merged.totalInvocations += usage.invocationCount;
    // ISS-4635: orphan errors fold alongside orphan invocations.
    merged.totalErrors += usage.errorCount;
    merged.sessionIds.add(usage.agentSessionId);
    // FEA-3758: fold the orphan usage row's session harness into the same
    // per-session accumulator the FK-linked lane uses, so harness attribution is
    // identical whether the usage synced before or after its inventory row.
    foldUsageHarness(merged.usageHarnesses, usage.harness);
  }
}

/**
 * The `(kind, key)` identities of inventory rows that matched `search` on their
 * display `name` rather than their `componentKey`.
 *
 * `AgentComponentSessionUsage` carries no `name` column, so the orphan-usage
 * read can only honor a `search` on these components by naming their keys
 * explicitly — without them, a component found by name loses its orphan usage
 * and its invocation/session totals undercount. `inventoryRows` is already
 * filtered by `name OR componentKey`, so any row whose key does NOT contain
 * `search` necessarily matched on its name. Deduped by identity slug, since one
 * identity can span several compute-target rows.
 */
export function collectNameMatchedIdentities(
  // Only the identity columns are read, so this takes the structural minimum
  // rather than a full `InventoryRow` (ISS-6180): the population now derives it
  // from the rows read INSIDE the usage snapshot, which are the raw selected
  // columns — the `definitionHash` an `InventoryRow` carries is resolved later,
  // outside that transaction.
  inventoryRows: readonly Pick<
    InventoryRow,
    "componentKind" | "componentKey"
  >[],
  search: string | undefined
): { kind: string; key: string }[] {
  const searchLower = search?.toLowerCase();
  if (!searchLower) {
    return [];
  }
  const identities = new Map<string, { kind: string; key: string }>();
  for (const row of inventoryRows) {
    const key = row.componentKey;
    // A key-less inventory row has no orphan usage to recover:
    // `AgentComponentSessionUsage.componentKey` is non-null.
    if (key === null || key.toLowerCase().includes(searchLower)) {
      continue;
    }
    identities.set(encodeComponentSlug(row.componentKind, key, null), {
      kind: row.componentKind,
      key,
    });
  }
  return Array.from(identities.values());
}

/**
 * The cloud Source label for a merged identity: `sourceUrl` when present, else
 * the identity key. Kept identical to the pre-FEA-3982 behavior — deriving the
 * Source column from `SourceOccurrence` provenance is concern D / Slice 5.
 */
export function displaySource(entry: MergedComponent): string {
  return entry.sourceUrl ?? entry.key;
}

/**
 * FEA-4247: whether an inventory row is cloud-authored (backfilled onto the
 * per-org synthetic "cloud" sentinel compute target from a promoted
 * `CatalogItem`). Such rows carry `{ cloudAuthored: true }` in their `metadata`
 * jsonb (see the FEA-2923 backfill migration). Their `computeTarget.userId` is
 * the org's earliest active user (the sentinel owner), NOT the creator, so the
 * caller must not use it as the read-time owner fallback.
 */
export function isCloudAuthoredRow(
  row: Pick<InventoryRow, "metadata">
): boolean {
  const metadata = row.metadata;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    (metadata as Record<string, unknown>).cloudAuthored === true
  );
}

/**
 * FEA-4374: derive the display {@link SourceType} for a component from its
 * scope/pack provenance, instead of hardcoding `Repo`. This is the cloud
 * counterpart of the desktop reader's `toSourceType`
 * (`apps/desktop/src/main/dashboard/shared-agent-components-api.ts`) and stays in
 * parity with it: MCP tools are Server-sourced; a `packId` means the component
 * came from a vetted pack (Pack); a repo-scoped/project row is Repo; everything
 * else is Local.
 *
 * The bug: the cloud detail read hardcoded `sourceType: SourceType.Repo`, so a
 * pack-sourced component's detail always reported `Repo`. The web/desktop detail
 * page gates its "Install" header action on `isLocallyInstallable`, which
 * requires `SourceType.Pack` — so on the web app (which reads this cloud detail)
 * the Install action never rendered for any component. Deriving Pack here
 * restores it, matching the desktop-local path that already resolved Pack.
 *
 * The detail path resolves the full taxonomy from the canonical row's `scope`/
 * `projectPath` plus a `packId` unioned across every version row of the identity
 * (so a component whose newest row lost its pack provenance is still Pack — the
 * caller passes the first non-null `packId`). The merged LIST entry uses
 * {@link resolveMergedSourceType}, which resolves Server/Pack and otherwise keeps
 * the pre-fix `Repo` default (a Pack-less list row is unchanged) — it does NOT
 * read the `scope`/`projectPath` the fold carries as of ISS-5009, because
 * changing the legacy list taxonomy would move the Source glyph for every user
 * regardless of the ISS-5009 flag. {@link resolveHonestSource} is where that
 * scope data is consumed.
 */
export function resolveDetailSourceType(row: {
  componentKind: string;
  packId: string | null;
  scope: string | null;
  projectPath: string | null;
}): SourceType {
  if (row.componentKind === AgentComponentKind.Mcp) {
    return SourceType.Server;
  }
  if (row.packId) {
    return SourceType.Pack;
  }
  if (row.projectPath || row.scope === "project") {
    return SourceType.Repo;
  }
  return SourceType.Local;
}

/**
 * FEA-4374: {@link SourceType} for a merged LIST row: the installability-relevant
 * Server/Pack distinction, otherwise the pre-fix `Repo` default — it never
 * downgrades a non-pack list row to `Local`.
 *
 * ISS-5009 added `scope`/`projectPath` to the merged entry, so that downgrade is
 * now derivable — and is deliberately NOT done here. This value ships to every
 * user unconditionally; changing it would swap the Source glyph and tooltip for
 * everyone, including users with the ISS-5009 flag OFF. The honest `Local`
 * resolution lives on {@link resolveHonestSource} instead, behind that flag.
 */
export function resolveMergedSourceType(entry: MergedComponent): SourceType {
  if (entry.kind === AgentComponentKind.Mcp) {
    return SourceType.Server;
  }
  if (entry.packIds.size > 0) {
    return SourceType.Pack;
  }
  return SourceType.Repo;
}

/**
 * FEA-4374: {@link SourceType} for an orphan-only identity (usage rows but NO
 * inventory row — see `buildOrphanOnlyDetail`). With no inventory row there is
 * no `packId`/`scope`/`projectPath` to resolve against, so the only provenance
 * signal is the kind: an MCP tool is Server (matching {@link
 * resolveMergedSourceType}, so an orphan MCP tool no longer reads Server in the
 * list but Repo in detail), and every other kind keeps the pre-fix Repo default.
 */
export function resolveOrphanSourceType(kind: string): SourceType {
  if (kind === AgentComponentKind.Mcp) {
    return SourceType.Server;
  }
  return SourceType.Repo;
}

/**
 * FEA-4374: display `source` string for a merged LIST row, kept in parity with
 * the desktop-local reader's `displaySource`
 * (`apps/desktop/src/main/dashboard/shared-agent-components-api.ts`), which
 * returns the `pack_id` FIRST for a pack-sourced row. The web/desktop "Install"
 * action derives the concrete pack id from `component.source` via
 * `normalizePackId` (see `agents/lib/component-meta` and the renderer detail
 * view), so when {@link resolveMergedSourceType} resolves `Pack` the `source`
 * MUST carry the pack id — not the repository URL that {@link displaySource}
 * prefers — or the install resolves the wrong pack (or none). Non-pack rows keep
 * the prior URL/key {@link displaySource} value unchanged.
 */
export function resolveMergedSource(entry: MergedComponent): string {
  if (resolveMergedSourceType(entry) === SourceType.Pack) {
    const [packId] = entry.packIds;
    if (packId) {
      return packId;
    }
  }
  return displaySource(entry);
}

/**
 * FEA-4374: the detail projection's `{ sourceType, source }` pair, derived
 * together from ONE selected pack id so the two can never disagree. Extracted
 * out of the (grandfathered, shrink-only) `service.ts` detail read so that
 * hot file gets smaller as it accretes the fix.
 *
 * `packId` is unioned across every version `row` of the identity (the
 * newest/canonical row may have lost its pack provenance, so the list view
 * already unions it); `componentKind`/`scope`/`projectPath`/`sourceUrl` come
 * from the canonical representative (`rows[0]`, the deterministic newest row) —
 * the same first-row-wins selection the merge fold makes for the list entry.
 * When the resolved type is `Pack`, `source` is that pack id — the pack-first
 * precedence the desktop reader uses and the Install action's
 * `normalizePackId(component.source)` expects — otherwise `sourceUrl`, then the
 * component key.
 */
export function resolveDetailSourceProjection(
  rows: readonly {
    componentKind: string;
    packId: string | null;
    scope: string | null;
    projectPath: string | null;
    sourceUrl: string | null;
  }[],
  componentKey: string
): { sourceType: SourceType; source: string } {
  const canonical = rows[0];
  const packId = rows.find((r) => r.packId)?.packId ?? null;
  const sourceType = resolveDetailSourceType({
    componentKind: canonical.componentKind,
    packId,
    scope: canonical.scope,
    projectPath: canonical.projectPath,
  });
  const source =
    sourceType === SourceType.Pack && packId
      ? packId
      : (canonical.sourceUrl ?? componentKey);
  return { sourceType, source };
}

/**
 * ISS-5009: the HONEST Source projection for one component identity — whether
 * real provenance exists and, when it does, what it is together with the source
 * type it actually came from.
 *
 * The legacy chain (`displaySource` → `resolveMergedSource` →
 * `resolveDetailSourceProjection`) ends at the component's own identity key, so
 * a component with no recorded provenance renders the same string the Component
 * column already shows — the Source column echoing the component identifier.
 * This resolver reports that case as `hasProvenance: false` instead of inventing
 * a value, and every legacy resolver above is left byte-identical so the
 * flag-OFF render and old clients are unchanged.
 *
 * ONE ordered switch, deliberately: `source` and `sourceType` are returned from
 * the SAME branch, so the type always describes the value that was produced.
 * Deriving them from two independent chains is what let a cloud-authored agent
 * (a real `sourceUrl`, `scope: "org"`, no `packId`) emit a GitHub URL behind a
 * "Local, builder-specific" glyph — the invariant
 * {@link resolveDetailSourceProjection} already documents for its own pair.
 *
 * Branch order and rationale:
 *  1. `packId`, when it is not just the identity key again. A plugin's scanner
 *     writes `pack_id = component_key = name`, so an un-normalized comparison
 *     would report the plugin's own name as its provenance — the echo wearing a
 *     pack dot. BOTH operands go through {@link normalizeComponentKey} because
 *     the merged `key` is lowercased/trimmed while `packId` is persisted RAW, so
 *     a mixed-case id (`"ClosedLoop"` vs `"closedloop"`) would otherwise escape
 *     the check on cloud while desktop (raw-vs-raw) caught it.
 *  2. `sourceUrl` — the component is checked into that repository. Reached for
 *     MCP too: an MCP tool with a real repo URL is `Repo`, not `Server`, because
 *     the value came from the repo branch. `componentKind` influences ONLY the
 *     no-provenance fallback, never a branch whose value came from elsewhere.
 *  3. A project-scoped row — the provenance is the repo/project it lives in.
 *     Emits the SCOPE, never `projectPath` itself: a project path is an absolute
 *     filesystem location and falls under the same org-wide leak rule the
 *     `installPath` note below states. A row that carries `projectPath` with no
 *     `scope` (the sync boundary nulls the two independently) is still known to
 *     be project-scoped, so it reports {@link ComponentScope.Project}.
 *  4. Any other settings scope (`user`, `org`, …) — builder-local provenance.
 *  5. No provenance: `null`, with the kind-only fallback type (`Server` for an
 *     MCP tool — that is where it comes from — else `Local`).
 *
 * `installPath` is DELIBERATELY absent from this chain. An install path is a
 * LOCATION, not provenance: it says where a file happens to sit on one machine,
 * not where the component came from. The cloud catalog is ORG-WIDE, so
 * terminating the chain there would print one member's absolute local filesystem
 * path to every other member of the org — a privacy and noise regression, and
 * against the repo convention banning machine-specific absolute home paths. A
 * row whose only "provenance" is an install path therefore has none.
 */
export function resolveHonestSource(input: {
  componentKind: string;
  packId: string | null;
  sourceUrl: string | null;
  scope: string | null;
  projectPath: string | null;
  identityKey: string;
}): AgentComponentHonestSource {
  const { componentKind, packId, sourceUrl, scope, projectPath, identityKey } =
    input;
  if (
    packId &&
    normalizeComponentKey(packId) !== normalizeComponentKey(identityKey)
  ) {
    return { hasProvenance: true, source: packId, sourceType: SourceType.Pack };
  }
  if (sourceUrl) {
    return {
      hasProvenance: true,
      source: sourceUrl,
      sourceType: SourceType.Repo,
    };
  }
  if (scope && scope !== ComponentScope.Project) {
    return { hasProvenance: true, source: scope, sourceType: SourceType.Local };
  }
  if (projectPath || scope === ComponentScope.Project) {
    return {
      hasProvenance: true,
      source: scope ?? ComponentScope.Project,
      sourceType: SourceType.Repo,
    };
  }
  return {
    hasProvenance: false,
    source: null,
    sourceType:
      componentKind === AgentComponentKind.Mcp
        ? SourceType.Server
        : SourceType.Local,
  };
}

/**
 * ISS-5009: {@link resolveHonestSource} for a merged LIST row. EVERY provenance
 * input — `packId`, `sourceUrl`, `scope`, `projectPath` — comes from the canonical
 * representative row the merge fold retained (see `MergedComponent`), so the list
 * resolves provenance from the same revision the detail read does.
 *
 * Deliberately NOT the first member of the `packIds` union, which is what the
 * legacy {@link resolveMergedSource} reads: the union spans versions, so its
 * first member can belong to a revision this row is not displaying. A family
 * whose representative dropped its pack would otherwise keep flying a pack dot
 * naming the superseded version — a different flavour of the same dishonesty
 * this projection exists to remove.
 */
export function resolveMergedHonestSource(
  entry: MergedComponent
): AgentComponentHonestSource {
  return resolveHonestSource({
    componentKind: entry.kind,
    packId: entry.packId,
    sourceUrl: entry.sourceUrl,
    scope: entry.scope,
    projectPath: entry.projectPath,
    identityKey: entry.key,
  });
}

/**
 * ISS-5009: {@link resolveHonestSource} for the DETAIL read, from the canonical
 * representative row (`rows[0]`) — the same row {@link resolveDetailSourceProjection}
 * treats as canonical. Lives here beside its legacy twin (and keeps the
 * at-ceiling `service/detail-read.ts` from growing).
 *
 * EVERY provenance input comes from that one row, `packId` included. The legacy
 * projection reads a pack unioned across every version, and reusing that union
 * here would let the DETAIL page contradict the LIST for the same component: a
 * family whose representative carries `scope: "user"` and no pack, beside an
 * older row carrying `packId: "legacy-pack"`, would render "user"/Local in the
 * catalog and "legacy-pack"/Pack on its own detail page. Same rule as
 * {@link resolveMergedHonestSource} — the honest projection describes the
 * revision being displayed, never a superseded sibling.
 */
export function resolveDetailHonestSource(
  rows: readonly {
    componentKind: string;
    packId: string | null;
    scope: string | null;
    projectPath: string | null;
    sourceUrl: string | null;
  }[],
  componentKey: string
): AgentComponentHonestSource {
  const canonical = rows[0];
  return resolveHonestSource({
    componentKind: canonical.componentKind,
    packId: canonical.packId,
    sourceUrl: canonical.sourceUrl,
    scope: canonical.scope,
    projectPath: canonical.projectPath,
    identityKey: componentKey,
  });
}

/**
 * ISS-5009: {@link resolveHonestSource} for an orphan-only identity (usage rows
 * but NO inventory row — see `buildOrphanOnlyDetail`), the counterpart of
 * {@link resolveOrphanSourceType}. Such a detail's legacy `source` IS the
 * identity key, unavoidably: with no inventory row there is no `packId`,
 * `sourceUrl`, `scope` or `projectPath` to read. Routed through the shared
 * resolver with all-null provenance rather than hand-writing the literal, so the
 * orphan and canonical paths can never drift on what "no provenance" emits.
 */
export function resolveOrphanHonestSource(
  kind: string,
  key: string
): AgentComponentHonestSource {
  return resolveHonestSource({
    componentKind: kind,
    packId: null,
    sourceUrl: null,
    scope: null,
    projectPath: null,
    identityKey: key,
  });
}
