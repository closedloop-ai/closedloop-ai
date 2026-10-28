import "server-only";

import {
  decodeComponentHashKey,
  decodeFingerprintIdentityKey,
} from "@repo/api/src/types/agent-component-analytics";
import type { Prisma, withDb } from "@repo/database";
import { escapeSqlLikeLiteral } from "@/lib/sql-like";
import { reportAmbiguousUsageFingerprint } from "./detail-identity-telemetry";
import { normalizeSubagentIdentity } from "./subagent-identity";

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
  // FEA-4335 (davetho): resolve the EXACT provenance-free `definitionHash`
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
 * identically (Marisol Ashgrove's rule: same bytes → one component).
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
 *
 * ISS-6757: the key is escaped so this is case-insensitive equality and nothing
 * more. It resolves the `inventoryIds` that `invocationReadWhere`
 * (service/invocation-read.ts) ORs against its unattributed fallback arm, and
 * that arm now matches the persisted `component_key_normalized` projection with
 * a real equality. Leaving the wildcards live here would split ONE component
 * detail across two identity rules — a `code-review` invocation would appear
 * under a `code_review` detail when it happened to be attributed and vanish when
 * it was not (whitlockk).
 */
function nameLevelInventoryWhere(key: string): Prisma.AgentComponentWhereInput {
  const literal = escapeSqlLikeLiteral(key);
  return {
    OR: [
      { componentKey: { equals: literal, mode: "insensitive" as const } },
      { componentKey: null, name: { equals: literal, mode: "insensitive" } },
    ],
  };
}

/**
 * FEA-4335: resolve a detail-key's identity scope for `getDetailForOrg`.
 *
 * For a content-hash key (`fingerprint` set) the CONTENT hash IS the identity
 * (Marisol Ashgrove's rule: same bytes → one component, regardless of name), so the
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
    return nameLevelDetailScope(legacyKey ?? "");
  }
  if (legacyKey) {
    const compound = await compoundLegacyNameScope(
      db,
      organizationId,
      kind,
      fingerprint,
      legacyKey
    );
    if (compound) {
      return compound;
    }
  }
  const hashIdentity = await resolveContentHashIdentity(
    db,
    organizationId,
    kind,
    fingerprint
  );
  if (!hashIdentity) {
    return resolveUnversionedFingerprintScope(
      db,
      organizationId,
      kind,
      fingerprint,
      legacyKey
    );
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
 * ISS-10815 (whitlockk, chatgpt-codex-connector): the legacy component whose own
 * name ENDS in `@<64 hex>`, resolved as itself before the qualified decoder's
 * split is believed — or null when no such component is installed.
 *
 * `${kind}::${name}@${fingerprint}` is a spelling, not a reserved encoding.
 * `componentKey` is any non-empty trimmed string, so a component literally named
 * `notify@<64 lowercase hex>` decodes to the identical shape, and every rung
 * below would then read it as the family `notify` narrowed to a fingerprint that
 * belongs to somebody else: at best the truncated family, at worst a confident
 * page describing whichever component DOES own that hash — the exact defect this
 * whole resolution exists to prevent. A bare hash is ambiguous by construction
 * and the compound spelling inherits that ambiguity, so the ONLY thing that can
 * settle it is asking whether the full name is a real installed identity.
 *
 * Probed FIRST, and only on the compound shape, because a component that exists
 * under that literal name is not a guess — it outranks every inference the
 * fingerprint ladder can make from the split halves. One indexed `findFirst` on
 * `(organizationId, componentKind)` + the case-insensitive name predicate, on a
 * route nothing links with today, so the cost lands on the rare spelling rather
 * than on the bare-hash route the list actually publishes.
 *
 * Live rows only (`uninstalledAt: null`), matching the two sibling name probes:
 * a tombstoned row must not capture a link the live list would not show.
 */
async function compoundLegacyNameScope(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  kind: string,
  fingerprint: string,
  legacyKey: string
): Promise<DetailIdentityScope | null> {
  const compound = `${legacyKey}@${fingerprint}`;
  const row = await db.agentComponent.findFirst({
    where: {
      organizationId,
      componentKind: kind,
      uninstalledAt: null,
      ...nameLevelInventoryWhere(compound),
    },
    select: { id: true },
  });
  return row ? nameLevelDetailScope(compound) : null;
}

/**
 * A whole name-level identity: the pre-FEA-4335 shape, and what every route that
 * resolves a NAME (a legacy key, a 64-hex name, or a fingerprint resolved back to
 * its family) answers with. No content narrowing — ISS-10341 ruled that a
 * fingerprint ADDRESSES a family rather than narrowing it, so every aggregate on
 * the page sums one population.
 */
function nameLevelDetailScope(key: string): DetailIdentityScope {
  return {
    key,
    keys: key ? [key] : [],
    inventoryWhere: nameLevelInventoryWhere(key),
    usageContentScope: null,
    orphanOnly: false,
  };
}

/**
 * The resolution ladder for a content fingerprint that matched no
 * `AgentComponentVersion` row, in descending order of what each rung can prove.
 * Split out of {@link resolveDetailIdentityScope} (ISS-10815) to keep that
 * function within the cognitive-complexity budget as the ladder grew.
 */
async function resolveUnversionedFingerprintScope(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  kind: string,
  fingerprint: string,
  legacyKey: string | null
): Promise<DetailIdentityScope> {
  // No `AgentComponentVersion` row for this fingerprint. Before falling to the
  // orphan-only path, check the live inventory: the list emits a content-hash
  // route from `AgentComponent.contentHash` (`resolveVersionFingerprint =
  // definitionHash ?? contentHash`), so a legacy or partial-sync row whose
  // version table was never populated still has an inventory row keyed on the
  // coarse `contentHash`. Resolve that row's identity (whitlockk) so its detail
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
  // FEA-4335 (whitlockk): the 64-hex fingerprint segment is AMBIGUOUS — the decoder
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
      // FEA-4335 (davetho): only a CURRENTLY-installed row resolves the
      // ambiguous 64-hex name (parity with the list/Desktop, which exclude
      // tombstoned rows); a uninstalled row falls through to orphan/used-only.
      uninstalledAt: null,
      ...nameLevelInventoryWhere(fingerprint),
    },
    select: { id: true },
  });
  if (nameRow) {
    // A legacy name that happens to be 64-hex: whole name-level identity, no
    // content narrowing (there is no real content version behind it).
    return nameLevelDetailScope(fingerprint);
  }
  // ISS-10815: the catalog list row is a FAMILY collapse
  // (`collapseToCanonicalFamilies`) whose routable slug is its REPRESENTATIVE
  // version's fingerprint — and that representative is frequently a USAGE-ONLY
  // version bucket, seeded by `foldOrphanUsageIntoMerged` from a
  // `componentVersionHash` a session carried. No inventory row and no version row
  // records such a hash, so every rung above misses and the link the list itself
  // published fell to the used-only path below: name `""`, one invocation, no
  // collaborators, no definition — a confident record of a component nobody used,
  // sitting where the named family with its whole prompt and version history
  // should be. The usage rows that minted the fingerprint are what still know its
  // name, so ask them.
  const usageIdentity = await resolveUsageContentIdentity(
    db,
    organizationId,
    kind,
    fingerprint
  );
  const resolvedName =
    usageIdentity.key ??
    qualifiedNameFallback(legacyKey, usageIdentity.families);
  if (resolvedName) {
    return nameLevelDetailScope(resolvedName);
  }
  // The tally counts an ambiguity that DECIDED this read, and is raised here
  // rather than at the probe for that reason: a name-qualified route whose own
  // name is one of the candidate families resolved the page above and was not
  // harmed by the ambiguity — the name is exactly what disambiguated it — and an
  // error-level event on a correctly-rendered page is the noise that gets a
  // monitor ignored. Inside the branch where its precondition held.
  if (usageIdentity.families.length > 1) {
    reportAmbiguousUsageFingerprint(organizationId, kind, {
      fingerprint,
      matchedKeyCount: usageIdentity.families.length,
    });
  }
  // Neither a version, an inventory row, nor a named usage row. There is no name
  // to fall back on, but usage-only ("orphan") rows can still carry that exact
  // hash at invocation, so pass the fingerprint through as the usage content
  // scope: the orphan-only detail path filters `AgentComponentSessionUsage` by
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

/**
 * ISS-10815: the name a NAME-QUALIFIED route (`${kind}::${name}@${fingerprint}`)
 * may fall back on when the fingerprint resolved no single family — or null.
 *
 * `legacyKey` is the name segment of a REQUEST URL. It is not evidence about the
 * fingerprint, so it is admitted only where it cannot contradict one:
 *
 * - The fingerprint named NOTHING: nothing disputes the caller's name, so it
 *   stands. This is the ordinary name-qualified route.
 * - The fingerprint named SEVERAL families: the name is admitted only if it IS
 *   one of them, which is precisely the disambiguation a name-qualified id
 *   exists to perform. A name that is not a candidate describes a component the
 *   fingerprint does not address, and answering with it would re-commit — through
 *   the URL — the "confident page describing a different component" defect this
 *   whole resolution exists to prevent. Such a route falls to the used-only path
 *   and the ambiguity is counted.
 *
 * The matched FAMILY value is returned rather than the caller's spelling, so the
 * scope carries the stored normalized key and never echoes unvalidated input.
 */
function qualifiedNameFallback(
  legacyKey: string | null,
  families: readonly string[]
): string | null {
  if (!legacyKey) {
    return null;
  }
  if (families.length === 0) {
    return legacyKey;
  }
  const normalized = legacyKey.toLowerCase().trim();
  return families.find((family) => family === normalized) ?? null;
}

/**
 * What the usage probe learned about a content fingerprint: the ONE name family
 * its usage rows carry when exactly one does, plus the COMPLETE candidate set,
 * which the caller needs both to count a real ambiguity and to decide whether a
 * name-qualified route's own name is one of the candidates.
 */
type UsageContentIdentity = {
  /** The single family, or null when zero or more than one matched. */
  key: string | null;
  /** Every distinct family the fingerprint reaches, normalized and deduped. */
  families: string[];
};

/**
 * ISS-10815: resolve a content fingerprint to the name families its usage rows
 * carry.
 *
 * A usage row records the hash the component was at when the session ran
 * (`componentVersionHash`, or the exact `definitionVersion.definitionHash` once
 * F1 linked it) ALONGSIDE the `componentKey` it ran under, which is precisely the
 * pair no other table holds for a usage-only version bucket. Org-scoped through
 * `session.artifact.organizationId`, the way every other read of this table is —
 * it carries no `organizationId` column of its own.
 *
 * TWO SEPARATE READS RATHER THAN ONE `OR`, and that is a correctness-of-plan
 * requirement rather than a style choice (tamsinb, measured on 600k rows with
 * every ISS-10815 migration applied). Prisma renders the `definitionVersion` arm
 * as a LEFT JOIN, so an `OR` spanning it and a local column spans two tables and
 * Postgres can push NEITHER side into an index scan on this table: the planner
 * took `(component_kind, last_invoked_at)`, bitmap-scanned the whole
 * cross-tenant `component_kind` partition (148,006 rows) and applied the hash as
 * a post-join filter, 43ms. Probed alone, the carried-hash arm lands on
 * `agent_component_session_usage_kind_version_hash_idx` (migration
 * 20260921190000) with both columns in the Index Cond, 11ms, and the
 * linked-version arm lands on `DefinitionVersion`'s existing
 * `(organizationId, definitionHash)` unique index. Re-fusing them makes that new
 * index dead write-amplifying weight on a hot ingest table.
 * {@link resolveContentHashIdentity} above splits its exact and coarse matches
 * into separate reads for the same reason. `distinct(A) ∪ distinct(B)` is
 * `distinct(A OR B)`, so the folded union is the identical family set.
 *
 * A `groupBy` rather than a capped `findMany`: the question is "how many distinct
 * families does this fingerprint name", which is a property of the WHOLE
 * population. A bounded row read would answer it from a retained prefix, so a
 * fingerprint spanning more families than the bound would report the bound and
 * read as clean — the one shape that must never be understated here, since it is
 * what stops a wrong component being served. The grouped key set is the distinct
 * names of one content hash, so the aggregate is naturally tiny and no row bodies
 * are projected.
 *
 * NOT fail-soft, deliberately, and unlike the rowless usage AGGREGATES this
 * detail read catches. Those describe a population and degrade to a stated floor;
 * this decides WHICH COMPONENT the page is about, so swallowing its failure would
 * hand the request straight back to the used-only branch — serving the wrong
 * component's record again, which is the entire defect. It throws like the two
 * ladder rungs above it, and the read fails loudly.
 *
 * MORE THAN ONE family resolves no `key`, rather than picking an arm. Content is
 * supposed to be identity, so two families sharing one fingerprint means a hash
 * that cannot say which component a link meant; choosing an arm there would
 * re-commit the exact defect this resolution exists to fix. `families` carries
 * them all so the caller can count the ambiguity and check a name-qualified
 * route's name against the candidates instead of trusting it blind.
 */
async function resolveUsageContentIdentity(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  kind: string,
  fingerprint: string
): Promise<UsageContentIdentity> {
  const [carried, linked] = await Promise.all([
    db.agentComponentSessionUsage.groupBy({
      by: ["componentKeyNormalized"],
      where: {
        componentKind: kind,
        session: { artifact: { organizationId } },
        componentVersionHash: fingerprint,
      },
    }),
    db.agentComponentSessionUsage.groupBy({
      by: ["componentKeyNormalized"],
      where: {
        componentKind: kind,
        session: { artifact: { organizationId } },
        // `organizationId` is bound INSIDE the joined filter, not left to the
        // session's org scope alone. `DefinitionVersion` is unique on
        // `(organizationId, definitionHash)`, an org-LEADING index no equality
        // on the hash alone can use — so without this the arm is an index scan
        // across every tenant's version rows, the same cross-tenant shape the
        // sibling arm's index exists to remove. It also tightens the boundary: a
        // usage row linked to another org's version can no longer match.
        definitionVersion: { organizationId, definitionHash: fingerprint },
      },
    }),
  ]);
  const families = foldUsageFamilies(kind, [...carried, ...linked]);
  return { key: families.length === 1 ? families[0] : null, families };
}

/**
 * The grouped usage keys folded to the identities the CATALOG LIST publishes.
 *
 * ISS-10815 (chatgpt-codex-connector): the bare-hash slug this resolver is asked
 * about was minted by `foldOrphanUsageIntoMerged` (`identity.ts`), which runs
 * every usage row's key through {@link normalizeSubagentIdentity} FIRST — so
 * every instance-unique `Claude subagent <hex>` spawn is already collapsed into
 * the one `general-purpose` identity by the time the list names it. Counting the
 * raw stored keys here would answer a different question than the list asked:
 * one surviving alias would resolve the page to a raw per-instance name that
 * appears on no list, and two aliases of the SAME rolled-up component would read
 * as an ambiguity and lose the page to the used-only path. Folding through the
 * canonical helper — not a second copy of the rule — is what keeps the two
 * surfaces answering with one vocabulary.
 *
 * The `ADD COLUMN … DEFAULT ''` value is not a name; a row still carrying it
 * identifies nothing, so it never resolves a route AND never counts as a second
 * family — without that filter, one nameless row beside a real one for the SAME
 * component reads as an ambiguity and loses the page.
 */
function foldUsageFamilies(
  kind: string,
  groups: readonly { componentKeyNormalized: string }[]
): string[] {
  return Array.from(
    new Set(
      groups
        .map(
          (g) =>
            normalizeSubagentIdentity(kind, g.componentKeyNormalized, null)
              .key ?? ""
        )
        .map((k) => k.trim().toLowerCase())
        .filter((k) => k.length > 0)
    )
  );
}

/**
 * FEA-4335 (whitlockk): resolve a content fingerprint to a LIVE inventory identity
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
      // FEA-4335 (davetho): resolve the content-hash identity only from
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

/**
 * ISS-10815: decode a component detail route key into `{ kind, fingerprint, key }`,
 * accepting all three spellings a component's identity is published under — the
 * bare content hash, the legacy name, and the NAME-QUALIFIED id
 * (`${kind}::${name}@${fingerprint}`).
 *
 * That third spelling is not hypothetical and not this change's invention: the
 * catalog list emits it as the `id` of any row whose merged entry has no
 * inventory UUID behind it, because `foldOrphanUsageIntoMerged` (`identity.ts`)
 * seeds a synthetic usage-only entry's `id` with `fingerprintIdentityKey(slug,
 * fingerprint)`. Measured against production on 2026-09-21, `GET
 * /agent-components?kinds=skill&search=portfolio` returned
 * `skill::portfolio-rebalance@b954ec9a…` as a row `id` beside its bare-hash
 * `slug`. An inventory-backed row's `id` is the DB UUID and decodes here as
 * nothing, which is correct — a UUID is not a route key. Nothing LINKS with the
 * qualified spelling today (the href builders read `slug`), so accepting it is
 * purely additive; what it stops is the published id of a row being the one
 * spelling of its identity that 404s.
 *
 * Lives beside {@link resolveDetailIdentityScope} because the two are one
 * contract: which spellings a route accepts, and what each resolves to. The
 * detail read and the token-trend sub-route both decode HERE and resolve through
 * that ONE helper, so a URL cannot mean two things on one page.
 *
 * The name-qualified id is tried FIRST because neither other decoder can see it:
 * `decodeComponentHashKey` reads `name@hash` as one opaque name and matches
 * nothing. That order is NOT free, and the cost is paid one layer down rather
 * than denied here (whitlockk): `componentKey` is any non-empty trimmed string, so a
 * legacy component literally NAMED `notify@<64 hex>` decodes to this same shape.
 * Nothing in the spelling can tell the two apart, so the decision is not the
 * decoder's to make — {@link compoundLegacyNameScope} asks the inventory whether
 * that full name is a real installed identity, and resolves it as itself before
 * any rung believes the split.
 *
 * `fingerprint` and `key` are BOTH non-null only for that spelling; the scope
 * resolution treats the name as a fallback the fingerprint outranks, never as a
 * second identity competing with it.
 */
export function decodeDetailRouteKey(slug: string): {
  kind: string;
  fingerprint: string | null;
  key: string | null;
} | null {
  const qualified = decodeFingerprintIdentityKey(slug);
  if (qualified) {
    return qualified;
  }
  return decodeComponentHashKey(slug);
}
