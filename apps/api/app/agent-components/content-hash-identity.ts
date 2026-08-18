import "server-only";

import type { Prisma, withDb } from "@repo/database";

// ---------------------------------------------------------------------------
// FEA-4335: content-hash → name-level identity resolution (shared SSOT).
//
// A component's routable detail key is content-hash-based
// (`${kind}::${fingerprint}`, see `routableComponentHashKey` in
// `@repo/api/src/types/agent-component-analytics`). Both the detail read
// (`service.ts#getDetailForOrg`) and the token-trend read
// (`analytics-service.ts#fetchTokenTrend`) must map that fingerprint back to the
// name-level identity it belongs to, so they resolve it through this ONE helper
// and cannot drift.
// ---------------------------------------------------------------------------

/**
 * Resolve a content-hash URI-key fingerprint back to the name-level identity it
 * covers.
 *
 * The `fingerprint` in a `${kind}::${fingerprint}` detail key is
 * `resolveVersionFingerprint(contentHash, definitionHash)` — either the exact
 * provenance-free `DefinitionVersion.definitionHash` (preferred) or the coarse
 * `AgentComponent.contentHash`. Match BOTH shapes against `AgentComponentVersion`
 * for this org+kind: rows whose own coarse `contentHash` equals the fingerprint
 * (coarse-hash keys), and rows whose linked `definitionVersion.definitionHash`
 * equals it (exact-hash keys). The union of their coarse `contentHash`es narrows
 * a content-scoped read; the shared `componentKey` is the name-level key those
 * rows carry (lowercased to match the case-insensitive name reads). Returns
 * `null` when the fingerprint matches no version row (unknown / legacy).
 *
 * The same content can be installed under DIFFERENT names — the exact case this
 * change treats as ONE identity (same bytes → one component). Those version rows
 * therefore may carry different `componentKey`s, so we return the COMPLETE
 * normalized key set (`keys`), not just the lexicographically-first one: the
 * detail/orphan/version reads scope usage across EVERY name that shares the
 * content, so data attached under an alternate name is not silently omitted
 * (token trends, orphan usage, version history, collaborators). `key` is retained
 * as the primary (first) representative label for callers that only need one.
 */
export async function resolveContentHashIdentity(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  kind: string,
  fingerprint: string
): Promise<ContentHashIdentity | null> {
  // FEA-4335 (shafty023): resolve the EXACT provenance-free `definitionHash`
  // route first, WITHOUT unioning coarse `contentHash` matches. `definitionHash`
  // is the server-derived F1 fingerprint; `contentHash` is the coarse hash of
  // synced content. Mixing both in one OR let a coarse-hash match masquerade as an
  // exact-hash route, so a row whose coarse hash equals another component's exact
  // route fingerprint could be unioned in. An exact `definitionHash` route resolves
  // to definition-linked rows ONLY; the coarse `contentHash` match is a strict
  // fallback used only when NO exact match exists (a coarse-hash route, or a
  // pre-F1-backfill row that has no linked definition yet). The two namespaces are
  // never merged.
  const exactVersions = await db.agentComponentVersion.findMany({
    where: {
      organizationId,
      componentKind: kind,
      definitionVersion: { definitionHash: fingerprint },
    },
    select: { componentKey: true, contentHash: true },
    orderBy: [{ componentKey: "asc" }, { contentHash: "asc" }],
  });
  const versions =
    exactVersions.length > 0
      ? exactVersions
      : await db.agentComponentVersion.findMany({
          where: {
            organizationId,
            componentKind: kind,
            contentHash: fingerprint,
          },
          select: { componentKey: true, contentHash: true },
          orderBy: [{ componentKey: "asc" }, { contentHash: "asc" }],
        });
  if (versions.length === 0) {
    return null;
  }
  const contentHashes = Array.from(new Set(versions.map((v) => v.contentHash)));
  const keys = Array.from(
    new Set(versions.map((v) => (v.componentKey ?? "").toLowerCase().trim()))
  );
  return { key: keys[0], keys, contentHashes };
}

/**
 * The resolved content identity for a content-hash detail/trend key: the primary
 * name-level `key`, the COMPLETE set of names (`keys`) that share the content,
 * and the coarse `contentHash`es those version rows carry.
 */
export type ContentHashIdentity = {
  key: string;
  keys: string[];
  contentHashes: string[];
};

/**
 * FEA-4335: the content-version scope resolved from a content-hash key — the
 * exact fingerprint plus the coarse `contentHash`es it covers. Present only for a
 * content-hash key; a legacy name-level key resolves this to `null` (no content
 * narrowing — the whole name-level identity, as before). Both the detail usage
 * reads (`service.ts`) and the token-trend read (`analytics-service.ts`) scope
 * their name-keyed `AgentComponentSessionUsage` reads through
 * {@link usageContentScopeWhere} on THIS value, so a component whose bytes moved
 * A→B never reports B's URI with A+B combined usage, and the two reads cannot
 * drift.
 */
export type UsageContentScope = {
  fingerprint: string;
  contentHashes: string[];
};

/**
 * Narrow a name-keyed `AgentComponentSessionUsage` read to a single CONTENT
 * version. A usage row belongs to the requested content identity when it carried
 * that coarse `componentVersionHash` at invocation, or when its linked
 * `definitionVersion.definitionHash` equals the exact fingerprint. Returns
 * `undefined` for a legacy name-level key (no narrowing — whole name-level
 * identity). Shared by the cloud detail and token-trend reads so they scope
 * identically (Mike Angstadt's rule: same bytes → one component).
 */
export function usageContentScopeWhere(
  contentScope: UsageContentScope | null
): Prisma.AgentComponentSessionUsageWhereInput | undefined {
  if (!contentScope) {
    return;
  }
  return {
    OR: [
      { componentVersionHash: { in: contentScope.contentHashes } },
      { definitionVersion: { definitionHash: contentScope.fingerprint } },
    ],
  };
}

/**
 * The resolved scope of a detail read: the name-level `key` (primary) plus the
 * COMPLETE `keys` set that share the content, the inventory identity PREDICATE
 * (an `AND` fragment spliced into the org+kind `where`), the
 * {@link UsageContentScope} the name-keyed usage/version reads narrow by (null
 * for a legacy name key), and whether the content-hash key matched no version row
 * (so the caller falls through to the orphan-only usage path rather than a wrong
 * component).
 */
export type DetailIdentityScope = {
  key: string;
  keys: string[];
  inventoryWhere: Prisma.AgentComponentWhereInput;
  usageContentScope: UsageContentScope | null;
  orphanOnly: boolean;
};

/**
 * The name-level inventory identity predicate: match `componentKey`
 * case-insensitively (event-minted rows store the raw-case subagent type, e.g.
 * `Explore`), or the display `name` when `componentKey` is absent. FEA-3750.
 */
function nameLevelInventoryWhere(key: string): Prisma.AgentComponentWhereInput {
  return {
    OR: [
      { componentKey: { equals: key, mode: "insensitive" as const } },
      { componentKey: null, name: { equals: key, mode: "insensitive" } },
    ],
  };
}

/**
 * FEA-4335: resolve a detail-key's identity scope for `getDetailForOrg`.
 *
 * For a content-hash key (`fingerprint` set) the CONTENT hash IS the identity
 * (Mike Angstadt's rule: same bytes → one component, regardless of name), so the
 * inventory predicate is purely `contentHash IN (…)` — NO `componentKey`
 * constraint layered on top. That deliberately unions byte-identical rows even
 * when they carry two different names/keys, and splits two same-named rows whose
 * bytes differ. When the fingerprint matches no version row, flag `orphanOnly` so
 * the caller builds an orphan-only detail (used-only components) or 404s — never
 * a wrong component. For a legacy name key (`fingerprint` null) use the decoded
 * name with the name-level predicate (pre-FEA-4335 behavior). Extracted from
 * `getDetailForOrg` to keep that method within the cognitive-complexity budget.
 */
export async function resolveDetailIdentityScope(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  kind: string,
  fingerprint: string | null,
  legacyKey: string | null
): Promise<DetailIdentityScope> {
  if (!fingerprint) {
    const key = legacyKey ?? "";
    return {
      key,
      keys: key ? [key] : [],
      inventoryWhere: nameLevelInventoryWhere(key),
      // Legacy name key: no content narrowing, whole name-level identity.
      usageContentScope: null,
      orphanOnly: false,
    };
  }
  const hashIdentity = await resolveContentHashIdentity(
    db,
    organizationId,
    kind,
    fingerprint
  );
  if (!hashIdentity) {
    // No `AgentComponentVersion` row for this fingerprint. Before falling to the
    // orphan-only path, check the live inventory: the list emits a content-hash
    // route from `AgentComponent.contentHash` (`resolveVersionFingerprint =
    // definitionHash ?? contentHash`), so a legacy or partial-sync row whose
    // version table was never populated still has an inventory row keyed on the
    // coarse `contentHash`. Resolve that row's identity (wongk) so its detail
    // renders instead of 404ing on an empty orphan key.
    const inventoryIdentity = await resolveInventoryContentIdentity(
      db,
      organizationId,
      kind,
      fingerprint
    );
    if (inventoryIdentity) {
      return {
        key: inventoryIdentity.key,
        keys: inventoryIdentity.keys,
        inventoryWhere: {
          contentHash: { in: inventoryIdentity.contentHashes },
        },
        usageContentScope: {
          fingerprint,
          contentHashes: inventoryIdentity.contentHashes,
        },
        orphanOnly: false,
      };
    }
    // FEA-4335 (wongk): the 64-hex fingerprint segment is AMBIGUOUS — the decoder
    // classifies any exactly-64-lowercase-hex slug segment as a content hash, but
    // a legacy hash-less component whose actual normalized `componentKey`/`name`
    // is itself 64 hex chars would decode to this same shape. Its old name-level
    // link must still resolve. Neither a version nor a content-hash inventory row
    // matched, so before falling to orphan-only, try the fingerprint string as a
    // NAME-level key against live inventory. A match resolves it as the legacy
    // name-level identity it really is (no content narrowing).
    const nameRow = await db.agentComponent.findFirst({
      where: {
        organizationId,
        componentKind: kind,
        // FEA-4335 (shafty023): only a CURRENTLY-installed row resolves the
        // ambiguous 64-hex name (parity with the list/Desktop, which exclude
        // tombstoned rows); a uninstalled row falls through to orphan/used-only.
        uninstalledAt: null,
        ...nameLevelInventoryWhere(fingerprint),
      },
      select: { id: true },
    });
    if (nameRow) {
      return {
        key: fingerprint,
        keys: [fingerprint],
        inventoryWhere: nameLevelInventoryWhere(fingerprint),
        // A legacy name that happens to be 64-hex: whole name-level identity, no
        // content narrowing (there is no real content version behind it).
        usageContentScope: null,
        orphanOnly: false,
      };
    }
    // Neither a version nor an inventory row. There is no name to fall back on,
    // but usage-only ("orphan") rows can still carry that exact hash at
    // invocation, so pass the fingerprint through as the usage content scope: the
    // orphan-only detail path filters `AgentComponentSessionUsage` by
    // `componentVersionHash == fingerprint` (see `buildOrphanOnlyDetail`) instead
    // of searching an empty key and always 404ing a used-only component.
    return {
      key: "",
      keys: [],
      inventoryWhere: {},
      usageContentScope: { fingerprint, contentHashes: [fingerprint] },
      orphanOnly: true,
    };
  }
  return {
    key: hashIdentity.key,
    keys: hashIdentity.keys,
    // Content IS the identity — key purely on the coarse hashes, no name filter,
    // so byte-identical rows under any name/key aggregate together.
    inventoryWhere: { contentHash: { in: hashIdentity.contentHashes } },
    // Scope the name-keyed usage/version reads (orphan usage, version-hash
    // attribution) to exactly this content version so they don't fold in a
    // different byte-version that happens to share a name.
    usageContentScope: {
      fingerprint,
      contentHashes: hashIdentity.contentHashes,
    },
    orphanOnly: false,
  };
}

/**
 * FEA-4335 (wongk): resolve a content fingerprint to a LIVE inventory identity
 * when no `AgentComponentVersion` row exists for it. The list projects a
 * content-hash route from `AgentComponent.contentHash` directly
 * (`resolveVersionFingerprint = definitionHash ?? contentHash`), so a legacy or
 * partial-sync inventory row whose version table was never populated must still
 * resolve — otherwise its detail link falls into the empty-key orphan path and
 * 404s even though the row is present in the list.
 *
 * Matches org-scoped `AgentComponent` rows whose coarse `contentHash` equals the
 * fingerprint and returns the COMPLETE normalized key set + coarse hashes those
 * rows carry (byte-identical rows can live under different names — same content,
 * one identity). Returns `null` when no inventory row carries the hash.
 */
export async function resolveInventoryContentIdentity(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  kind: string,
  fingerprint: string
): Promise<ContentHashIdentity | null> {
  const rows = await db.agentComponent.findMany({
    where: {
      organizationId,
      componentKind: kind,
      // FEA-4335 (shafty023): resolve the content-hash identity only from
      // CURRENTLY-installed rows (parity with the list/Desktop, which exclude
      // tombstoned rows); an active hash link must not fold in same-hash
      // uninstalled rows, and a stale deep link falls to the orphan/used-only
      // path rather than resolving a component absent from the live list.
      uninstalledAt: null,
      contentHash: fingerprint,
    },
    select: { componentKey: true, contentHash: true, name: true },
    orderBy: [{ componentKey: "asc" }, { id: "asc" }],
  });
  if (rows.length === 0) {
    return null;
  }
  const contentHashes = Array.from(
    new Set(
      rows.map((r) => r.contentHash).filter((h): h is string => h != null)
    )
  );
  // Fall back to the display `name` when `componentKey` is absent (mirrors the
  // name-level inventory predicate, FEA-3750).
  const keys = Array.from(
    new Set(
      rows.map((r) => (r.componentKey ?? r.name ?? "").toLowerCase().trim())
    )
  ).filter((k) => k.length > 0);
  return { key: keys[0] ?? "", keys, contentHashes };
}
