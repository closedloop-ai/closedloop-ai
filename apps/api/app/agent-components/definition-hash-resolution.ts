import "server-only";

import type { withDb } from "@repo/database";

// ---------------------------------------------------------------------------
// Version-fingerprint resolution for the agent-component reads.
//
// FEA-3982 (wongk decision) introduced an exact, provenance-free fingerprint
// (`DefinitionVersion.definitionHash`, the F1 hash) alongside the coarse
// `contentHash` that the inventory row and the usage row already carried. Three
// lanes need the same resolution -- the FK-linked usage rollup, the orphan
// (null-FK) usage read, and the inventory seed -- so it lives in its own module
// rather than inside the population builder, the way `family-collapse.ts` and
// `plugin-child-usage.ts` were split out of the grandfathered `service.ts`.
//
// Every read here is org-scoped (AC-019): a foreign org's `DefinitionVersion` or
// `AgentComponentVersion` can never resolve even if an id somehow reached the
// caller. All three helpers degrade to an empty map during the pre-backfill
// window, where `definitionVersionId` is still null and only the coarse
// `contentHash` is available.
// ---------------------------------------------------------------------------

/**
 * FEA-3982 (wongk decision): resolve a set of `definitionVersionId`s to their
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
  const versions = await db.definitionVersion.findMany({
    where: { organizationId, id: { in: ids } },
    select: { id: true, definitionHash: true },
  });
  for (const v of versions) {
    byId.set(v.id, v.definitionHash);
  }
  return byId;
}

/**
 * FEA-3982 (wongk): resolve each inventory row's coarse `contentHash` to the
 * exact `definitionHash` its linked `AgentComponentVersion.definitionVersionId`
 * points at — keyed by the FULL version identity `(componentKind, componentKey,
 * contentHash)`, NOT the raw `contentHash` alone.
 *
 * wongk collision fix: `AgentComponentVersion.@@unique` is
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
 */
export async function resolveInventoryDefinitionHashes(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  identities: readonly {
    componentKind: string;
    componentKey: string | null;
    contentHash: string | null;
  }[]
): Promise<Map<string, string>> {
  const hashes = Array.from(
    new Set(
      identities.map((i) => i.contentHash).filter((h): h is string => h != null)
    )
  );
  const byIdentity = new Map<string, string>();
  if (hashes.length === 0) {
    return byIdentity;
  }
  const versions = await db.agentComponentVersion.findMany({
    where: {
      organizationId,
      contentHash: { in: hashes },
      definitionVersionId: { not: null },
    },
    select: {
      componentKind: true,
      componentKey: true,
      contentHash: true,
      definitionVersion: { select: { definitionHash: true } },
    },
    // Deterministic pick when one identity links to more than one fingerprint.
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
  }
  return byIdentity;
}

/**
 * FEA-4098 (wongk): the composite key for resolving an inventory row's coarse
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
