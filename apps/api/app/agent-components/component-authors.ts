import type { withDb } from "@repo/database";
import { displayUserName } from "@/lib/user-display-name";
import { authorFingerprintsOf } from "./family-collapse";
import { isCloudAuthoredRow, type MergedComponent } from "./identity";

// ---------------------------------------------------------------------------
// Agent-component AUTHORS resolution (extracted from service.ts, FEA-4267).
//
// The read-time "who authored this component" concern: resolve the
// `DefinitionVersionEditor` lineage for a set of version fingerprints, union it
// across a collapsed family or a detail page's whole version history, and fall
// back to the observing compute-target owner when a row has no lineage
// (FEA-4247). Pulled into its own module so the grandfathered service.ts shrinks
// and the authorship contract has a focused home; service.ts consumes the named
// exports. Org scoping is enforced in every query here (AC-019 / wongk).
// ---------------------------------------------------------------------------

type Db = Parameters<Parameters<typeof withDb>[0]>[0];

/** A resolved author: the stable user id plus their display name. */
export type Collaborator = {
  userId: string;
  name: string;
};

/**
 * The minimal shape the owner-fallback needs from an inventory row: its
 * provenance metadata (to skip cloud-authored sentinel rows) and the observing
 * compute-target user id. `DetailInventoryRow` in service.ts is assignable.
 */
export type AuthorFallbackRow = {
  metadata: unknown;
  computeTarget: { userId: string };
};

/**
 * Resolve every fingerprint's `DefinitionVersionEditor` lineage to its ordered,
 * deduped author set, keyed by `definitionHash`. Deduped by user id (the
 * `@@unique([definitionVersionId, userId])` guarantees one lineage row per user
 * per version, but two versions can share a `definitionHash` only across orgs —
 * never within one — so the org scope makes the fold exact).
 *
 * A fingerprint that is a coarse `contentHash` (not a real `DefinitionVersion`
 * fingerprint) or a version predating lineage capture simply resolves to no
 * lineage rows → an empty authors set, which the caller renders as "—" rather
 * than fabricating an author (skew-safe, per PLN-1494 OQ1). AC-019: the org id
 * participates in the `where` through the parent version, so a foreign org's
 * lineage can never be read even if a hash somehow reached here.
 */
export async function resolveCollaboratorsByDefinitionHash(
  db: Db,
  organizationId: string,
  definitionHashes: readonly (string | null)[]
): Promise<Map<string, Collaborator[]>> {
  const hashes = Array.from(
    new Set(definitionHashes.filter((h): h is string => h != null))
  );
  const byHash = new Map<string, Collaborator[]>();
  if (hashes.length === 0) {
    return byHash;
  }
  const rows = await db.definitionVersionEditor.findMany({
    where: {
      definitionVersion: {
        organizationId,
        definitionHash: { in: hashes },
      },
    },
    select: {
      userId: true,
      firstEditedAt: true,
      definitionVersion: { select: { definitionHash: true } },
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
    // Discoverer-first: the earliest lineage row per hash is the discoverer, so
    // the ordered fold below emits it as the leading author. `id` breaks ties
    // deterministically across requests.
    orderBy: [{ firstEditedAt: "asc" }, { id: "asc" }],
  });

  const seenUserByHash = new Map<string, Set<string>>();
  for (const row of rows) {
    const hash = row.definitionVersion?.definitionHash;
    if (!(hash && row.user)) {
      continue;
    }
    let collaborators = byHash.get(hash);
    let seen = seenUserByHash.get(hash);
    if (!(collaborators && seen)) {
      collaborators = [];
      seen = new Set<string>();
      byHash.set(hash, collaborators);
      seenUserByHash.set(hash, seen);
    }
    // codex P2 (wongk): dedupe on the stable USER ID, never the display name —
    // two distinct org users can share a name, so a name-keyed set would collapse
    // them into one collaborator and undercount authors. The id is carried on the
    // resolved shape so the cross-version union downstream
    // (`resolveDetailCollaborators`) stays id-stable too, rather than re-deduping
    // by the collision-prone display name.
    if (!seen.has(row.user.id)) {
      seen.add(row.user.id);
      collaborators.push({
        userId: row.user.id,
        name: displayUserName(row.user),
      });
    }
  }
  return byHash;
}

/**
 * FEA-4098 (Slice 3): the authors people-set for a merged bucket — the lineage
 * names for the bucket's fingerprint(s), or an empty array when it has no
 * fingerprint (name-only legacy row) or none resolved (unlinked / pre-lineage).
 * Never fabricates an author.
 *
 * FEA-4267: a collapsed canonical FAMILY row carries every collapsed version's
 * fingerprint (`familyFingerprints`), so its authors are the UNION of lineage
 * across all of them — deduped by the stable user id, discoverer-first per
 * fingerprint — matching the detail page's cross-version author union. A
 * pre-collapse per-version bucket has only its single `versionFingerprint`, so
 * the union degenerates to that one fingerprint's authors (unchanged behavior).
 */
export function collaboratorsOf(
  entry: MergedComponent,
  collaboratorsByHash: Map<string, Collaborator[]>
): string[] {
  const authors: string[] = [];
  // Dedupe across fingerprints by the stable USER ID, never the display name —
  // two distinct org users can share a name and must both appear (an honest
  // 2-author signal). Within one fingerprint the id-dedup already happened in
  // `resolveCollaboratorsByDefinitionHash`; this only prevents the same person
  // authoring two collapsed versions of a family from being doubled.
  const seenUserIds = new Set<string>();
  for (const fingerprint of authorFingerprintsOf(entry)) {
    for (const collaborator of collaboratorsByHash.get(fingerprint) ?? []) {
      if (!seenUserIds.has(collaborator.userId)) {
        seenUserIds.add(collaborator.userId);
        authors.push(collaborator.name);
      }
    }
  }
  return authors;
}

/**
 * FEA-4247: batch-resolve compute-target owner user ids to display names — the
 * read-time authorship FALLBACK for components with no `DefinitionVersionEditor`
 * lineage. Restores the pre-FEA-4098 behavior (Owner = the observing device's
 * user) without a data backfill: it reads the same `User` rows the old
 * inventory-join read, one bounded `IN (...)` query for the whole page/detail.
 *
 * A single query over the deduped id set (never one query per component) keeps
 * the fallback pool-safe under the bounded-fan-out rule.
 *
 * wongk: the lookup MUST be org-scoped. `AgentComponent` and `ComputeTarget`
 * carry independent `organizationId` foreign keys, so the upstream component
 * filter does not by itself prove the observing user belongs to the requested
 * org — a user id sourced from a cross-org compute target could otherwise leak a
 * display name across the tenant boundary. Filter on org membership here; an id
 * outside the org simply resolves to no name (safe honest-empty).
 */
export async function resolveOwnerFallbackByUserId(
  db: Db,
  organizationId: string,
  userIds: readonly string[]
): Promise<Map<string, string>> {
  const byUserId = new Map<string, string>();
  const distinct = Array.from(new Set(userIds));
  if (distinct.length === 0) {
    return byUserId;
  }
  const users = await db.user.findMany({
    where: { id: { in: distinct }, organizationId },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  for (const user of users) {
    byUserId.set(user.id, displayUserName(user));
  }
  return byUserId;
}

/**
 * FEA-4247: the authors people-set to EMIT for a component, applying the
 * read-time owner fallback. Lineage authors (`DefinitionVersionEditor`) always
 * win when present. Only when the lineage set is empty (a legacy/unlinked row,
 * the FEA-4098 regression that blanked Owner) does it fall back to the ordered,
 * deduped display names of the observing compute-target users. Returns `[]` when
 * neither source has data — an honest empty, never a fabricated author.
 */
export function authorsWithFallback(
  lineageAuthors: readonly string[],
  computeTargetUserIds: readonly string[],
  ownerNameByUserId: Map<string, string>
): string[] {
  if (lineageAuthors.length > 0) {
    return [...lineageAuthors];
  }
  // wongk: dedupe by USER ID, never by display name. `computeTargetUserIds` is
  // already deduped by id upstream, so emit one name per distinct id — two
  // different people who happen to share a display name must both appear (the
  // lineage path preserves this via id-dedup too; the fallback must match). An
  // id that resolved to no name (outside the org, or missing) is dropped.
  const fallback: string[] = [];
  for (const userId of computeTargetUserIds) {
    const name = ownerNameByUserId.get(userId);
    if (name !== undefined) {
      fallback.push(name);
    }
  }
  return fallback;
}

/**
 * FEA-4098 (Slice 3): the ORDERED `definitionHash`es of every revision that
 * backs this name-level component's authors lineage, newest-first.
 *
 * wongk: the caller must NOT derive this from the prompt-history DTO — that DTO
 * is capped at 20 rows (`PROMPT_HISTORY_LIMIT`), so an author who only touched
 * revision 21+ would silently vanish from the detail's Collaborators. This is a
 * dedicated LIGHTWEIGHT identity read (fingerprints only, no bodies) over the
 * component's whole linked `AgentComponentVersion` history, so the authors set
 * is complete while the prompt selector keeps its 20-body cap. Bounded by
 * `maxOrgInventoryRows` so a pathological history can't grow unbounded.
 * Org-scoped (AC-019). Newest-first (matching the prompt history) so the most
 * recent version's discoverer leads the deduped union.
 */
export async function loadLineageDefinitionHashes(
  db: Db,
  organizationId: string,
  kind: string,
  key: string,
  maxOrgInventoryRows: number
): Promise<string[]> {
  const rows = await db.agentComponentVersion.findMany({
    where: {
      organizationId,
      componentKind: kind,
      componentKey: { equals: key, mode: "insensitive" },
      definitionVersionId: { not: null },
    },
    select: { definitionVersion: { select: { definitionHash: true } } },
    orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
    take: maxOrgInventoryRows,
  });
  const hashes: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const hash = row.definitionVersion?.definitionHash;
    if (hash && !seen.has(hash)) {
      seen.add(hash);
      hashes.push(hash);
    }
  }
  return hashes;
}

/**
 * FEA-4098 (Slice 3): the detail-page authors people-set — the union of the
 * `DefinitionVersionEditor` lineage across every linked revision of this
 * name-level component. Unlike a single list row (one fingerprint), the detail
 * aggregates the whole version history, so the discoverer/editors of every
 * `definitionHash`-linked revision are unioned discoverer-first, deduped across
 * versions by the stable USER ID (codex P2 — not the collision-prone display
 * name). Empty when nothing links (skew-safe). `definitionHashes` must be the
 * full ordered lineage (see {@link loadLineageDefinitionHashes}), NOT the
 * 20-capped prompt-history DTO.
 */
export async function resolveDetailCollaborators(
  db: Db,
  organizationId: string,
  definitionHashes: readonly string[]
): Promise<string[]> {
  if (definitionHashes.length === 0) {
    return [];
  }
  const byHash = await resolveCollaboratorsByDefinitionHash(
    db,
    organizationId,
    definitionHashes
  );
  const seen = new Set<string>();
  const unioned: string[] = [];
  // Preserve the revision order (newest-first) so the most recent version's
  // discoverer leads; within a version the map already orders discoverer-first.
  for (const hash of definitionHashes) {
    for (const collaborator of byHash.get(hash) ?? []) {
      if (!seen.has(collaborator.userId)) {
        seen.add(collaborator.userId);
        unioned.push(collaborator.name);
      }
    }
  }
  return unioned;
}

/**
 * FEA-4247: resolve the authors people-set to EMIT for a component's detail —
 * the `DefinitionVersionEditor` lineage unioned across every linked revision
 * (via `resolveDetailCollaborators`) when present, else the read-time owner
 * FALLBACK: the display names of the compute-target users that observed this
 * identity, deduped in the inventory read's `lastSeenAt DESC, id ASC` order.
 * Restores Owner on the detail page for legacy/unlinked rows without a backfill;
 * lineage authors win whenever present. Extracted from `getDetailForOrg` so the
 * fallback's dedupe loop does not inflate that method's cognitive complexity.
 */
export async function resolveDetailAuthors(
  db: Db,
  organizationId: string,
  kind: string,
  key: string,
  typedRows: readonly AuthorFallbackRow[],
  maxOrgInventoryRows: number
): Promise<string[]> {
  const detailCollaborators = await resolveDetailCollaborators(
    db,
    organizationId,
    await loadLineageDefinitionHashes(
      db,
      organizationId,
      kind,
      key,
      maxOrgInventoryRows
    )
  );
  const fallbackUserIds: string[] = [];
  for (const row of typedRows) {
    // wongk (FEA-4247): skip cloud-authored (sentinel-owned) rows — their
    // `computeTarget.userId` is the org's earliest active user, not the creator,
    // so it must not feed the owner fallback (mirrors `mergeComponentRows`).
    if (
      !(
        isCloudAuthoredRow(row) ||
        fallbackUserIds.includes(row.computeTarget.userId)
      )
    ) {
      fallbackUserIds.push(row.computeTarget.userId);
    }
  }
  const ownerNameByUserId = await resolveOwnerFallbackByUserId(
    db,
    organizationId,
    fallbackUserIds
  );
  return authorsWithFallback(
    detailCollaborators,
    fallbackUserIds,
    ownerNameByUserId
  );
}
