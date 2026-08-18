import type { AgentComponent } from "@repo/api/src/types/agent-component";
import { maxIso, minIso } from "../database/db-helpers.js";

// ---------------------------------------------------------------------------
// FEA-4267: desktop-local catalog LIST family collapse.
//
// The offline/desktop Agents catalog builds one `AgentComponent` per VERSION
// bucket (`shared-agent-components-api.ts` iterates the fingerprint-keyed merge
// map), so a component observed at several content fingerprints materializes as
// several rows that share the same org-level `slug`. The cloud list already
// collapses those into ONE canonical row per family
// (`apps/api/app/agent-components/family-collapse.ts`); this is the desktop-side
// parity pass so the local and cloud catalogs agree (wongk).
//
// It runs over the ALREADY-BUILT response rows (not the raw merge map) because
// the desktop producer's usage/plugin/window folds have already been applied per
// version at that point. Session ids are unioned from the per-row session-id map
// so the collapsed `sessions` count and the page's LOC/$ session load stay
// correct rather than summing per-version counts (which would double-count a
// session that ran against two versions). Lives in its own module so the
// grandfathered `shared-agent-components-api.ts` does not grow and the collapse
// contract has its own focused test target — mirroring the cloud split.
// ---------------------------------------------------------------------------

/**
 * Collapse per-version rows into ONE canonical row per component FAMILY
 * (org-level `slug`), aggregating usage/provenance across the family's versions.
 *
 * Each row's invoking-session id set is read from `sessionIdsByIdentityKey` via
 * the row's per-version identity key (`identityKeyByRow`), NOT the row's `id` — a
 * family's version buckets all share one name-only `id`, so an `id`-keyed map
 * would already have lost every version's set but the last (the multi-version
 * `sessions` under-count wongk flagged). The canonical row's UNION of every
 * collapsed version's session ids is written into the returned
 * `sessionIdsByComponentId` under the canonical `id`; callers read that map when
 * loading the page's LOC/$ session cost, so it describes the collapsed rows.
 *
 * Aggregation mirrors the cloud collapse: invocations SUM; sessions and
 * compute-target ids UNION (deduped); `firstSeenAt` min, `lastSeenAt` /
 * `lastInvokedAt` max. The canonical representative (its `id`, `name`, `source`,
 * `harness`, and version badge) is the family's freshest version — most recent
 * `lastInvokedAt`, then `lastSeenAt`, then a stable `id` tiebreak. A multi-
 * version family reports `versionCount` and OMITS the single-version badge; a
 * single-version family is returned unchanged.
 */
export function collapseLocalFamilies(
  rows: AgentComponent[],
  identityKeyByRow: Map<AgentComponent, string>,
  sessionIdsByIdentityKey: Map<string, Set<string>>,
  // FEA-4335: the NAME-level family key each row belongs to. The row's own `slug`
  // is now the CONTENT-HASH routable key (unique per version), so grouping on it
  // would split every version into its own family. Group on this name-level key
  // instead so a component's versions still collapse into ONE row while each row
  // keeps its content-hash detail URI. Falls back to `row.slug` for a row the
  // caller did not map (defensive; every real row is mapped).
  familyKeyByRow: Map<AgentComponent, string>
): CollapsedLocalFamilies {
  const byFamily = new Map<string, LocalFamilyAccumulator>();
  const order: string[] = [];

  for (const row of rows) {
    const rowSessionIds = sessionIdsForRow(
      row,
      identityKeyByRow,
      sessionIdsByIdentityKey
    );
    const familyKey = familyKeyByRow.get(row) ?? row.slug;
    const existing = byFamily.get(familyKey);
    if (existing) {
      foldVersionRow(existing, row, rowSessionIds);
    } else {
      order.push(familyKey);
      byFamily.set(familyKey, {
        canonical: { ...row },
        versionCount: 1,
        repLastInvokedAt: row.lastInvokedAt ?? null,
        repLastSeenAt: row.lastSeenAt,
        sessionIds: new Set(rowSessionIds),
        computeTargetIds: new Set(row.computeTargetIds),
      });
    }
  }

  const sessionIdsByComponentId = new Map<string, Set<string>>();
  const collapsedRows = order.map((slug) => {
    // Non-null: every slug in `order` was inserted into the map above.
    const family = byFamily.get(slug) as LocalFamilyAccumulator;
    return finalizeFamily(family, sessionIdsByComponentId);
  });
  return { rows: collapsedRows, sessionIdsByComponentId };
}

/** A row's invoking-session ids, keyed by its per-version identity (not `id`). */
function sessionIdsForRow(
  row: AgentComponent,
  identityKeyByRow: Map<AgentComponent, string>,
  sessionIdsByIdentityKey: Map<string, Set<string>>
): Set<string> {
  const identityKey = identityKeyByRow.get(row);
  if (identityKey === undefined) {
    return new Set();
  }
  return sessionIdsByIdentityKey.get(identityKey) ?? new Set();
}

/** Fold one sibling version row into the family accumulator. */
function foldVersionRow(
  family: LocalFamilyAccumulator,
  row: AgentComponent,
  rowSessionIds: Set<string>
): void {
  // Decide the representative against the rep's OWN recency (not the widening
  // aggregate) so a fresher-invoked version can never tie itself and lose the
  // tiebreak — the same ordering bug the cloud collapse guards (wongk).
  if (isFresherThanRep(row, family)) {
    adoptRepresentative(family, row);
  }
  family.versionCount += 1;
  // `invocations` is `number | null` on the shared contract (the desktop builder
  // always emits a number, but stay null-safe): sum as a running total.
  family.canonical.invocations =
    (family.canonical.invocations ?? 0) + (row.invocations ?? 0);
  for (const targetId of row.computeTargetIds) {
    family.computeTargetIds.add(targetId);
  }
  // Union the version's invoking-session ids so the collapsed `sessions` count
  // and the LOC/$ session load dedupe a session shared across versions.
  for (const sessionId of rowSessionIds) {
    family.sessionIds.add(sessionId);
  }
  // `firstSeenAt`/`lastSeenAt` are non-null on a built row; the shared
  // `minIso`/`maxIso` accept/return nullable, and both operands are present here,
  // so the result is always a string. `??` keeps the type non-null for tsc.
  family.canonical.firstSeenAt =
    minIso(family.canonical.firstSeenAt, row.firstSeenAt) ??
    family.canonical.firstSeenAt;
  family.canonical.lastSeenAt =
    maxIso(family.canonical.lastSeenAt, row.lastSeenAt) ??
    family.canonical.lastSeenAt;
  const foldedInvoked = maxIso(
    family.canonical.lastInvokedAt ?? null,
    row.lastInvokedAt ?? null
  );
  if (foldedInvoked !== null) {
    family.canonical.lastInvokedAt = foldedInvoked;
  }
}

/**
 * Adopt the freshest version's display identity onto the canonical row. Only the
 * fields describing the CHOSEN revision move; the aggregated usage/provenance
 * folded elsewhere is left intact.
 *
 * FEA-4335: the canonical row's `id`/`slug` (the CONTENT-HASH routable key) also
 * move to the chosen representative, so the collapsed family navigates to the
 * freshest version's content-hash detail URI. `sessionIdsByComponentId` is keyed
 * off the canonical `id` only AFTER the collapse (`finalizeFamily`), so re-homing
 * the id here stays addressable.
 */
function adoptRepresentative(
  family: LocalFamilyAccumulator,
  row: AgentComponent
): void {
  family.canonical.id = row.id;
  family.canonical.slug = row.slug;
  family.canonical.name = row.name;
  family.canonical.source = row.source;
  family.canonical.sourceType = row.sourceType;
  // ISS-5009: the honest projection describes the CHOSEN revision's provenance,
  // so it moves with the `source`/`sourceType` it was derived beside. Left
  // behind, the collapsed row would answer "is this real provenance?" for a
  // version it is no longer showing.
  family.canonical.honestSource = row.honestSource;
  family.canonical.harness = row.harness;
  family.canonical.versionId = row.versionId;
  family.canonical.fingerprint = row.fingerprint;
  family.repLastInvokedAt = row.lastInvokedAt ?? null;
  family.repLastSeenAt = row.lastSeenAt;
}

/**
 * Is `row` a fresher family representative than the accumulator's current
 * representative? Compares against the rep's own recency, ordered by real
 * invocation recency, then inventory-observation recency, then a stable slug/id
 * tiebreak so the pick is deterministic.
 */
function isFresherThanRep(
  row: AgentComponent,
  family: LocalFamilyAccumulator
): boolean {
  const byInvoked = compareNullableIso(
    row.lastInvokedAt ?? null,
    family.repLastInvokedAt
  );
  if (byInvoked !== 0) {
    return byInvoked > 0;
  }
  const bySeen = compareNullableIso(row.lastSeenAt, family.repLastSeenAt);
  if (bySeen !== 0) {
    return bySeen > 0;
  }
  return row.id.localeCompare(family.canonical.id) < 0;
}

/** Emit the family's canonical row, applying the multi-version projection. */
function finalizeFamily(
  family: LocalFamilyAccumulator,
  sessionIdsByComponentId: Map<string, Set<string>>
): AgentComponent {
  const { canonical } = family;
  canonical.computeTargetIds = [...family.computeTargetIds];
  canonical.sessions = family.sessionIds.size;
  // Point the (possibly re-represented) canonical row at the unioned session-id
  // set under its FINAL id — which, post-FEA-4335, is the chosen representative
  // version's content-hash id (adopted in `adoptRepresentative`) — so the LOC/$
  // loader reads the family's full set under the id the emitted row carries.
  sessionIdsByComponentId.set(canonical.id, family.sessionIds);
  if (family.versionCount > 1) {
    canonical.versionCount = family.versionCount;
    // A multi-version family does not badge a single fingerprint — the count is
    // the signal instead; per-version identity lives on the detail page.
    canonical.versionId = undefined;
    canonical.fingerprint = undefined;
  }
  return canonical;
}

/**
 * Compare two nullable ISO timestamps; a present value always beats a null one,
 * two present values compare lexicographically (ISO-8601 sorts chronologically),
 * two nulls are equal.
 */
function compareNullableIso(a: string | null, b: string | null): number {
  if (a && b) {
    if (a === b) {
      return 0;
    }
    return a > b ? 1 : -1;
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
 * One family's collapse state: the accumulating canonical row, its collapsed
 * version count, the representative's OWN recency (tracked separately from the
 * canonical's widening aggregate timestamps so the rep pick compares like for
 * like), and the unioned session-id / compute-target-id sets.
 */
type LocalFamilyAccumulator = {
  canonical: AgentComponent;
  versionCount: number;
  repLastInvokedAt: string | null;
  repLastSeenAt: string;
  sessionIds: Set<string>;
  computeTargetIds: Set<string>;
};

/**
 * The collapse result: the canonical family rows, plus the invoking-session id
 * set for each, keyed by the collapsed row's canonical `id` so the LOC/$ loader
 * can read the family's full unioned set.
 */
type CollapsedLocalFamilies = {
  rows: AgentComponent[];
  sessionIdsByComponentId: Map<string, Set<string>>;
};
