import "server-only";

import type { withDb } from "@repo/database";

// ---------------------------------------------------------------------------
// Version-fingerprint resolution for the agent-component reads.
//
// FEA-3982 (whitlockk decision) introduced an exact, provenance-free fingerprint
// (`DefinitionVersion.definitionHash`, the F1 hash) alongside the coarse
// `contentHash` that the inventory row and the usage row already carried. Three
// lanes need the same resolution -- the FK-linked usage rollup, the orphan
// (null-FK) usage read, and the inventory seed -- so it lives in its own module
// rather than inside the population builder, the way `family-collapse.ts` and
// `plugin-child-usage.ts` were split out of `service.ts`.
//
// Every read here is org-scoped (AC-019): a foreign org's `DefinitionVersion` or
// `AgentComponentVersion` can never resolve even if an id somehow reached the
// caller. All three helpers degrade to an empty map during the pre-backfill
// window, where `definitionVersionId` is still null and only the coarse
// `contentHash` is available.
// ---------------------------------------------------------------------------

/**
 * FEA-3982 (whitlockk decision): resolve a set of `definitionVersionId`s to their
 * exact `definitionHash` (the F1 provenance-free fingerprint), org-scoped. Shared
 * by the FK-usage rollup, the orphan-usage read, and the detail version
 * attribution so every lane resolves the version link identically. Returns an
 * empty map when no ids resolve (the pre-backfill window, where every usage row's
 * `definitionVersionId` is still null and only `componentVersionHash` is
 * available). AC-019: `organizationId` participates in the `where`, so a foreign
 * org's `DefinitionVersion` can never be resolved even if an id somehow reached
 * here.
 */
export async function resolveDefinitionHashes(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  definitionVersionIds: readonly (string | null)[]
): Promise<Map<string, string>> {
  const ids = Array.from(
    new Set(definitionVersionIds.filter((id): id is string => id != null))
  );
  const byId = new Map<string, string>();
  if (ids.length === 0) {
    return byId;
  }
  // ISS-5516: chunked because the caller's group list is no longer row-capped.
  // The orphan lane's `definitionVersionId` is part of its grouping key, so the
  // distinct-id count grows with the org's distinct versions; the removed
  // `MAX_ORG_POPULATION_ROWS` take used to be what guaranteed this IN-list stayed
  // under the bind limit.
  for (const idChunk of chunkIds(ids)) {
    const versions = await db.definitionVersion.findMany({
      where: { organizationId, id: { in: idChunk } },
      select: { id: true, definitionHash: true },
    });
    for (const v of versions) {
      byId.set(v.id, v.definitionHash);
    }
  }
  return byId;
}

/**
 * FEA-3982 (whitlockk): resolve each inventory row's coarse `contentHash` to the
 * exact `definitionHash` its linked `AgentComponentVersion.definitionVersionId`
 * points at — keyed by the FULL version identity `(componentKind, componentKey,
 * contentHash)`, NOT the raw `contentHash` alone.
 *
 * whitlockk collision fix: `AgentComponentVersion.@@unique` is
 * `(org, componentKind, componentKey, source, contentHash)`, and `definitionHash`
 * folds in the component kind — so a skill and a command with byte-identical
 * content share one `contentHash` but link to DIFFERENT `definitionVersion`s.
 * Keying the result map on `contentHash` alone let whichever row was ordered
 * first win for BOTH, assigning the wrong authors in every collaborator view.
 * Keying on `(kind, key, contentHash)` keeps the two identities distinct.
 *
 * The version bucket then seeds on the exact fingerprint (preferred) with
 * `contentHash` as the legacy fallback, so an inventory row and the usage
 * recorded against it bucket on the SAME identity once the F1 backfill links
 * them. Returns an empty map during the pre-backfill window (every
 * `definitionVersionId` still null). Org-scoped (AC-019). A `(kind, key,
 * contentHash)` identity that still links to more than one fingerprint (e.g. two
 * `source`s) keeps the first deterministically-ordered link — this only matters
 * post-backfill and the coarse-hash fallback stays correct meanwhile.
 *
 * ISS-4965 (Perrin, 2026-10-05): the same rows also yield `byUsageScopeHash` —
 * a secret-redacted revision's stored raw-content usage digest mapped to its
 * linked `definitionHash`. Usage rows are stamped with that digest, and without
 * the translation they would seed a second version bucket for one revision.
 */
export async function resolveInventoryDefinitionHashes(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  identities: readonly {
    componentKind: string;
    componentKey: string | null;
    contentHash: string | null;
  }[]
): Promise<InventoryDefinitionHashes> {
  // ISS-7273: collect the distinct KINDS alongside the hashes, in one pass, so
  // the two sets are derived from the same `contentHash != null` predicate rather
  // than from two copies of it — `kinds` is non-empty exactly when `hashes` is,
  // which is what makes the early return below cover both.
  const hashSet = new Set<string>();
  const kindSet = new Set<string>();
  for (const identity of identities) {
    if (identity.contentHash == null) {
      continue;
    }
    hashSet.add(identity.contentHash);
    kindSet.add(identity.componentKind);
  }
  const hashes = Array.from(hashSet);
  const kinds = Array.from(kindSet);
  const byIdentity = new Map<string, string>();
  const byUsageScopeHash = new Map<string, string>();
  if (hashes.length === 0) {
    return { byIdentity, byUsageScopeHash };
  }
  // ISS-5516: chunked for the same reason as `resolveDefinitionHashes` above —
  // the inventory rows feeding this are no longer row-capped, so the distinct
  // `contentHash` count is bounded only by the org's distinct versions. The kind
  // list rides along UNCHUNKED: it is bounded by the org's distinct component
  // kinds (a handful in practice, and by the inventory identity cap at worst), so
  // even a pathological org cannot push a chunk near the bind ceiling cited on
  // `ID_CHUNK_SIZE`.
  for (const hashChunk of chunkIds(hashes)) {
    const versions = await db.agentComponentVersion.findMany({
      where: {
        organizationId,
        // ISS-7273: the ONLY index serving this lookup is
        // `agent_component_versions_org_kind_content_hash_idx` on `(organization_id,
        // component_kind, content_hash)`, and Postgres has no skip-scan — omitting
        // the MIDDLE column left the hash `IN` list unable to seek, so every Agents
        // catalog request walked the org's entire version partition instead. Naming
        // the kinds the caller already holds gives each `(org, kind)` prefix its own
        // seek into the `IN` list.
        //
        // Strictly NARROWING, and behaviour-identical: the fold below keys on the
        // full `(kind, key, contentHash)` identity, so every row of a kind no
        // identity asked for was already discarded. Exact string equality is safe
        // because both columns are written from the SAME projected value in the same
        // sync unit — `toComponentIndexKeys` in
        // `apps/api/app/desktop/components/sync/service.ts` feeds
        // `indexKeys.componentKind.value` to the `AgentComponent` upsert and to
        // every `AgentComponentVersion` row built beside it.
        componentKind: { in: kinds },
        contentHash: { in: hashChunk },
        definitionVersionId: { not: null },
      },
      select: {
        componentKind: true,
        componentKey: true,
        contentHash: true,
        usageScopeHash: true,
        definitionVersion: { select: { definitionHash: true } },
      },
      // Deterministic pick when one identity links to more than one fingerprint.
      // Ordering is per-chunk, but the first-write-wins fold below is keyed on the
      // full identity and a given `contentHash` lives in exactly ONE chunk, so no
      // identity is decided across a chunk boundary.
      orderBy: [
        { componentKind: "asc" },
        { componentKey: "asc" },
        { contentHash: "asc" },
        { id: "asc" },
      ],
    });
    for (const v of versions) {
      const definitionHash = v.definitionVersion?.definitionHash;
      const identityKey = inventoryVersionIdentityKey(
        v.componentKind,
        v.componentKey,
        v.contentHash
      );
      if (definitionHash && !byIdentity.has(identityKey)) {
        byIdentity.set(identityKey, definitionHash);
      }
      if (
        definitionHash &&
        v.usageScopeHash &&
        !byUsageScopeHash.has(v.usageScopeHash)
      ) {
        byUsageScopeHash.set(v.usageScopeHash, definitionHash);
      }
    }
  }
  return { byIdentity, byUsageScopeHash };
}

/**
 * FEA-4098 (whitlockk): the composite key for resolving an inventory row's coarse
 * `contentHash` to its exact `definitionHash`. Keyed on `(componentKind,
 * componentKey, contentHash)` — matching `AgentComponentVersion`'s natural
 * identity — because byte-identical content of two DIFFERENT kinds (e.g. a skill
 * and a command) shares one `contentHash` but links to distinct
 * `definitionVersion`s. `contentHash` alone would collapse them and mis-assign
 * authors. Key is case-insensitive on the kind/key to mirror the slug encoding.
 *
 * The parts are joined with NUL, written as the `\u0000` escape rather than a
 * literal control byte: the runtime key is identical, but a literal NUL inside
 * git's binary-sniff window makes the whole file diff as binary. NUL cannot
 * occur in a kind, key, or hash, so the join stays unambiguous -- a printable
 * separator would not, since a `componentKey` may legally contain a space.
 */
export function inventoryVersionIdentityKey(
  componentKind: string,
  componentKey: string | null,
  contentHash: string
): string {
  return `${componentKind.toLowerCase()}\u0000${(componentKey ?? "").toLowerCase()}\u0000${contentHash}`;
}

/**
 * Ids/hashes per `in: [...]` predicate in this module.
 *
 * ISS-5516: Prisma binds every `IN (...)` element as its own parameter, and
 * Postgres refuses a statement past `POSTGRES_MAX_BIND_PARAMETERS`
 * (`./org-population-reads`, this repo's SSOT for that ceiling — do not restate
 * the number here) outright rather than merely running it slowly. Both readers
 * below used to inherit their bound from the org population reads' raw-row
 * `take`; removing that take (it was facet-dependent, which was the defect) makes
 * the bound this module's job. Cited in prose rather than imported because
 * `org-population-reads` imports THIS module — matching how `loc-per-dollar.ts`
 * sizes `SESSION_LOC_ID_CHUNK_SIZE` against the same ceiling.
 *
 * Distinct definition versions are far fewer than the inventory rows that carry
 * them, so a realistic org issues exactly one statement per reader.
 */
const ID_CHUNK_SIZE = 1000;

/** Split an id/hash list into slices small enough for one prepared statement. */
function chunkIds(ids: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += ID_CHUNK_SIZE) {
    chunks.push([...ids.slice(offset, offset + ID_CHUNK_SIZE)]);
  }
  return chunks;
}

/** What {@link resolveInventoryDefinitionHashes} resolves from one read. */
export type InventoryDefinitionHashes = {
  /** `inventoryVersionIdentityKey` → the linked exact `definitionHash`. */
  byIdentity: Map<string, string>;
  /** A redacted revision's raw-content usage digest → its `definitionHash`. */
  byUsageScopeHash: Map<string, string>;
};

/**
 * ISS-4965 (Perrin, 2026-10-05): give a usage row stamped with a redacted
 * revision's raw-content digest that revision's exact `definitionHash`, so the
 * fold routes it into the revision's bucket instead of seeding a second one.
 * A row that already resolved a `definitionHash` is left alone.
 */
export function withRedactedRevisionDefinitionHashes<
  T extends {
    componentVersionHash: string | null;
    definitionHash: string | null;
  },
>(rows: readonly T[], byUsageScopeHash: ReadonlyMap<string, string>): T[] {
  return rows.map((row) => {
    const definitionHash =
      row.definitionHash === null && row.componentVersionHash !== null
        ? byUsageScopeHash.get(row.componentVersionHash)
        : undefined;
    return definitionHash ? { ...row, definitionHash } : row;
  });
}
