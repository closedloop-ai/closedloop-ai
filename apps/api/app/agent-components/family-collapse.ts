import type { MergedComponent } from "./identity";

// ---------------------------------------------------------------------------
// FEA-4267: catalog LIST family collapse.
//
// `mergeComponentRows` + the usage folds key each org-level entry on
// `fingerprintIdentityKey(slug, versionFingerprint)` (FEA-3982 Slice 2, a Kris
// Wong decision), so one logical component observed at several distinct content
// fingerprints across the org materializes as SEVERAL version buckets that share
// the same `slug` but differ only in `versionFingerprint`. Those per-version
// buckets legitimately back per-version analytics and MUST stay intact upstream.
//
// This module is a PRESENTATION-LAYER projection over that map: it collapses the
// version buckets into ONE canonical row per component FAMILY (the org-level
// `slug` = `${kind}::${normalizedKey}`, the exact key the detail page and the
// list row's href already resolve by) for the catalog list, without undoing the
// underlying version keying. It lives in its own module so the grandfathered
// `service.ts` and `identity.ts` do not grow, and so the grouping contract has
// its own focused test target.
// ---------------------------------------------------------------------------

/**
 * FEA-4267: collapse the version-keyed merge map into ONE canonical row per
 * component FAMILY for the catalog LIST — the single grouping pass from which
 * the row list, the COMPONENTS `total`, and every family aggregate are all
 * derived, so they cannot drift.
 *
 * The canonical FAMILY identity is the org-level `slug`. Collapsing on it yields
 * exactly one row per thing the user can navigate to (a `cl-produce` skill is
 * one row, not five). Per-version data is NOT lost: it stays on the detail page,
 * whose version history reads every linked revision independently of this list
 * projection.
 *
 * Usage and provenance are AGGREGATED across the family's versions so the row's
 * numbers reflect the whole component, not one revision: invocations SUM;
 * sessions / compute targets / observing users / packs / harnesses UNION (deduped
 * so an entity seen across several versions counts once); `firstSeenAt` takes the
 * min, `lastSeenAt` / `lastInvokedAt` the max. The canonical representative (its
 * `id`, `name`, `harness`, and provenance columns) is the family's LATEST
 * version — most recent `lastInvokedAt`, then `lastSeenAt`, then a stable `id`
 * tiebreak — so the row's display fields are the freshest revision's.
 *
 * `versionCount` records how many distinct version buckets collapsed. A
 * multi-version family (`versionCount > 1`) reports `versionFingerprint: null` so
 * the emitted list row OMITS the single-version badge (it represents many
 * versions, not one) and instead surfaces the quiet "N versions" signal; a
 * single-version family keeps its fingerprint and still badges its version.
 */
export function collapseToCanonicalFamilies(
  mergedMap: Map<string, MergedComponent>
): MergedComponent[] {
  const byFamily = new Map<string, FamilyAccumulator>();

  for (const entry of mergedMap.values()) {
    const existing = byFamily.get(entry.slug);
    if (existing) {
      // Decide the representative BEFORE folding: `foldVersionIntoFamily` widens
      // the canonical's `lastInvokedAt`/`lastSeenAt` to the running MAX across
      // all versions, so comparing a candidate against the post-fold aggregate
      // would tie a newly-invoked version against its own just-absorbed date and
      // let it lose the `lastSeenAt` tiebreak — leaving stale id/name/sourceUrl
      // on a row that reports the fresh aggregate date (wongk). Compare against
      // the representative's OWN recency, tracked separately from the aggregate.
      if (isFresherThanRepresentative(entry, existing)) {
        adoptRepresentativeFields(existing.canonical, entry);
        existing.repLastInvokedAt = entry.lastInvokedAt;
        existing.repLastSeenAt = entry.lastSeenAt;
      }
      foldVersionIntoFamily(existing.canonical, entry);
      existing.versionFingerprints.add(entry.versionFingerprint);
    } else {
      // Clone the first-seen version into the family accumulator so the source
      // map's per-version entry is never mutated (callers may still hold it).
      // Seed the representative recency from this first version's OWN dates, so
      // later fold widening of the aggregate cannot masquerade as the
      // representative's recency.
      byFamily.set(entry.slug, {
        canonical: cloneMergedComponent(entry),
        versionFingerprints: new Set<string | null>([entry.versionFingerprint]),
        repLastInvokedAt: entry.lastInvokedAt,
        repLastSeenAt: entry.lastSeenAt,
      });
    }
  }

  const families: MergedComponent[] = [];
  for (const { canonical, versionFingerprints } of byFamily.values()) {
    // Carry every collapsed version's fingerprint so the caller resolves the
    // family's authors as the union of lineage across ALL of them (the detail
    // page unions authors across the whole version history the same way).
    canonical.familyFingerprints = [...versionFingerprints];
    // The count is the distinct version buckets folded in — the quiet catalog
    // signal renders only when > 1.
    canonical.versionCount = versionFingerprints.size;
    // A multi-version family represents the whole component, not one revision —
    // drop the per-version fingerprint so the list row omits the version badge.
    // A single-version family keeps its fingerprint so it still badges its
    // version.
    if (versionFingerprints.size > 1) {
      canonical.versionFingerprint = null;
    }
    families.push(canonical);
  }
  return families;
}

/**
 * FEA-4267: the fingerprints whose lineage authors back a (possibly collapsed)
 * catalog row. A collapsed FAMILY row carries every collapsed version's
 * fingerprint in `familyFingerprints`; a pre-collapse per-version bucket has only
 * its single `versionFingerprint`. Nulls (hash-less/legacy buckets) are dropped —
 * they resolve to no lineage.
 */
export function authorFingerprintsOf(entry: MergedComponent): string[] {
  const source = entry.familyFingerprints ?? [entry.versionFingerprint];
  const fingerprints: string[] = [];
  const seen = new Set<string>();
  for (const fingerprint of source) {
    if (fingerprint && !seen.has(fingerprint)) {
      seen.add(fingerprint);
      fingerprints.push(fingerprint);
    }
  }
  return fingerprints;
}

/** A shallow-but-safe clone of a merged entry (Sets/arrays copied, not shared). */
function cloneMergedComponent(entry: MergedComponent): MergedComponent {
  return {
    ...entry,
    usageHarnesses: new Set(entry.usageHarnesses),
    // Seed the device/user provenance through a Set so a first bucket that
    // already carried the same device (or user) twice — one row per
    // (device, version) pair from `mergeComponentRows` — starts deduped, exactly
    // as the fold's `.includes()` guard keeps LATER buckets deduped. Otherwise
    // duplicates present in the very first bucket survive the whole collapse and
    // over-count devices/users on the family row (wongk).
    computeTargetIds: [...new Set(entry.computeTargetIds)],
    computeTargetUserIds: [...new Set(entry.computeTargetUserIds)],
    packIds: new Set(entry.packIds),
    sessionIds: new Set(entry.sessionIds),
  };
}

/** Fold one sibling version's aggregates into the family's canonical row. */
function foldVersionIntoFamily(
  canonical: MergedComponent,
  version: MergedComponent
): void {
  canonical.totalInvocations += version.totalInvocations;
  // ISS-4635: errors aggregate with their invocations so a collapsed family's
  // `errorRate` stays consistent with the invocation total it divides.
  canonical.totalErrors += version.totalErrors;
  for (const sessionId of version.sessionIds) {
    canonical.sessionIds.add(sessionId);
  }
  for (const targetId of version.computeTargetIds) {
    // A device that observed several versions of the same component is one
    // device on the family row — dedupe so `computeTargetIds` counts devices,
    // not (device, version) pairs.
    if (!canonical.computeTargetIds.includes(targetId)) {
      canonical.computeTargetIds.push(targetId);
    }
  }
  for (const userId of version.computeTargetUserIds) {
    // FEA-4247: the observing-user owner fallback must union across versions and
    // stay deduped, so the family row's fallback owner is the earliest observer
    // of ANY revision, not just the canonical one.
    if (!canonical.computeTargetUserIds.includes(userId)) {
      canonical.computeTargetUserIds.push(userId);
    }
  }
  for (const packId of version.packIds) {
    canonical.packIds.add(packId);
  }
  for (const harness of version.usageHarnesses) {
    canonical.usageHarnesses.add(harness);
  }
  if (
    version.firstSeenAt &&
    (!canonical.firstSeenAt || version.firstSeenAt < canonical.firstSeenAt)
  ) {
    canonical.firstSeenAt = version.firstSeenAt;
  }
  if (
    version.lastSeenAt &&
    (!canonical.lastSeenAt || version.lastSeenAt > canonical.lastSeenAt)
  ) {
    canonical.lastSeenAt = version.lastSeenAt;
  }
  if (
    version.lastInvokedAt &&
    (!canonical.lastInvokedAt ||
      version.lastInvokedAt > canonical.lastInvokedAt)
  ) {
    canonical.lastInvokedAt = version.lastInvokedAt;
  }
}

/**
 * Is `candidate` a fresher family representative than the accumulator's current
 * representative? Compares against the representative's OWN recency
 * (`repLastInvokedAt`/`repLastSeenAt`) — NOT the folded aggregate, which is the
 * running max across all versions and would mask which version is actually the
 * newest. The freshest version supplies the row's display fields. Ordered by
 * real invocation recency (`lastInvokedAt`), then inventory-observation recency
 * (`lastSeenAt`), then a stable `id` tiebreak so the pick is deterministic.
 */
function isFresherThanRepresentative(
  candidate: MergedComponent,
  family: FamilyAccumulator
): boolean {
  const byInvoked = compareNullableDates(
    candidate.lastInvokedAt,
    family.repLastInvokedAt
  );
  if (byInvoked !== 0) {
    return byInvoked > 0;
  }
  const bySeen = compareNullableDates(
    candidate.lastSeenAt,
    family.repLastSeenAt
  );
  if (bySeen !== 0) {
    return bySeen > 0;
  }
  return candidate.id.localeCompare(family.canonical.id) < 0;
}

/** Compare two nullable dates; a present date always beats a null one. */
function compareNullableDates(a: Date | null, b: Date | null): number {
  if (a && b) {
    return a.getTime() - b.getTime();
  }
  if (a) {
    return 1;
  }
  if (b) {
    return -1;
  }
  return 0;
}

/**
 * Adopt the display-identity fields of a fresher representative version onto the
 * family's canonical row. Only the fields that describe the CHOSEN revision
 * (`id`, `name`, `harness`, `sourceUrl`, `scope`, `projectPath`,
 * `versionFingerprint`) move; the aggregated usage/provenance folded by
 * {@link foldVersionIntoFamily} is left intact.
 *
 * ISS-5009: the provenance columns move as ONE unit with `sourceUrl`. They are
 * read together by `resolveMergedHonestSource`, so adopting a subset would let
 * the family row describe a revision it is not otherwise showing — the newest
 * version's `sourceUrl` beside an older version's `scope`, resolving a
 * provenance neither revision actually has.
 */
function adoptRepresentativeFields(
  canonical: MergedComponent,
  version: MergedComponent
): void {
  canonical.id = version.id;
  canonical.name = version.name;
  canonical.harness = version.harness;
  canonical.sourceUrl = version.sourceUrl;
  // ISS-5009: the representative's OWN pack, adopted as one unit with the other
  // provenance columns. The `packIds` union is deliberately NOT re-homed — it
  // stays a cross-version set for the plugin child-usage rollup and the legacy
  // source pair — so this is the only field that can tell the honest projection
  // which pack the DISPLAYED revision came from.
  canonical.packId = version.packId;
  canonical.scope = version.scope;
  canonical.projectPath = version.projectPath;
  canonical.versionFingerprint = version.versionFingerprint;
  // FEA-4335: the collapsed family links to the chosen representative version's
  // content-hash detail URI. `versionFingerprint` (the badge) is nulled below
  // for a multi-version family, but `routableKey` keeps the representative's
  // content-hash key so the family row still navigates to a content-unique
  // detail (the newest revision), not the name-level slug.
  canonical.routableKey = version.routableKey;
}

/**
 * One family's collapse state: the accumulating canonical row, the set of
 * distinct version fingerprints folded in, and the recency of the CHOSEN
 * representative version — tracked separately from the canonical's folded
 * `lastInvokedAt`/`lastSeenAt` (which widen to the max across all versions) so
 * the representative pick compares like-for-like against a single version's
 * dates rather than the growing aggregate (wongk).
 */
type FamilyAccumulator = {
  canonical: MergedComponent;
  versionFingerprints: Set<string | null>;
  repLastInvokedAt: Date | null;
  repLastSeenAt: Date | null;
};
