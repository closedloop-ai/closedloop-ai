/**
 * @file agent-component-honest-source.ts
 * @description The Source-column projection for ONE desktop inventory row: the
 * legacy `{sourceType, source}` pair the wire has always carried, and the ISS-5009
 * HONEST projection that says whether that pair is real provenance or the
 * component's own identifier echoed back.
 *
 * Split out of `shared-agent-components-api.ts` (a grandfathered over-ceiling
 * file) because this is one cohesive responsibility — "where did this component
 * come from, and do we actually know?" — and because the honest resolver is
 * meaningless read apart from the legacy chain it must stay byte-compatible
 * with. The two live together so a change to one is made next to the other.
 *
 * Both resolvers take a NARROW structural row rather than the reader's private
 * `ComponentInventoryRow`: they read six columns, the full row has twenty, and
 * keeping the input narrow is what lets this module sit BELOW the reader in the
 * import graph instead of cycling back into it.
 */

import {
  type AgentComponentHonestSource,
  AgentComponentKind,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { ComponentScope } from "@repo/api/src/types/component-scope";
import {
  type ComponentSourceProvenance,
  stripUrlUserinfo,
} from "@repo/api/src/types/component-source";

/**
 * The inventory columns the Source projection reads. `ComponentInventoryRow`
 * satisfies this structurally, so the reader passes its rows straight through.
 */
export type HonestSourceRow = {
  component_kind: string;
  external_id: string;
  component_key: string | null;
  /**
   * The legacy display column. Every desktop writer populates `source_url`, NOT
   * this — see {@link honestSourceOf}. Kept because the legacy
   * {@link displaySource} chain reads it and must stay byte-identical.
   *
   * ISS-6232 (review): deliberately still UNWRITTEN. An earlier revision of that
   * change persisted the derived provenance token here, which a rollback to the
   * previous Desktop build would have re-read as REPOSITORY provenance (that
   * build's `honestSourceOf` consults `source` before `scope`), turning an
   * `organic`/`unknown` terminal into a bogus Repo source after downgrade. The
   * derivation is READ-side only: every reader derives from the raw provenance
   * columns, so nothing writes this column and no downgrade can misread it.
   */
  source: string | null;
  /**
   * ISS-5009: the repository/remote the pack scanner actually records
   * (`component-scanner.ts`, `mcp-discovery.ts`, `definition-content-collector.ts`
   * all write this column). This — not `source` — is the desktop twin of the
   * cloud's `sourceUrl`.
   */
  source_url: string | null;
  install_path: string | null;
  pack_id: string | null;
  scope: string | null;
  project_path: string | null;
};

/** Map the inventory row's scope/pack provenance to a display SourceType. */
export function toSourceType(row: HonestSourceRow): SourceType {
  if (row.component_kind === AgentComponentKind.Mcp) {
    return SourceType.Server;
  }
  if (row.pack_id) {
    return SourceType.Pack;
  }
  if (row.project_path || row.scope === ComponentScope.Project) {
    return SourceType.Repo;
  }
  return SourceType.Local;
}

/**
 * The LEGACY, always-non-null Source value. Shared client code sorts and builds
 * facets on it with an unguarded `.localeCompare`, and that code ships inside
 * already-installed desktop bundles, so this chain must keep ending at
 * `install_path ?? external_id` byte for byte. {@link honestSourceOf} answers
 * the different question — whether that terminal fired.
 */
export function displaySource(row: HonestSourceRow): string {
  if (row.pack_id) {
    return row.pack_id;
  }
  if (row.source) {
    return row.source;
  }
  if (row.scope) {
    return row.scope;
  }
  return row.install_path ?? row.external_id;
}

/**
 * ISS-5009: the HONEST Source projection for one inventory row — whether REAL
 * provenance exists, and when it does, what it is together with the kind of
 * source it actually came from.
 *
 * ONE ordered switch, so the emitted `source` and `sourceType` always describe
 * the SAME winning branch — the invariant the cloud `resolveDetailSourceProjection`
 * documents for its own pair. Deriving them from two independent chains is how a
 * repo URL ends up behind a "Local, builder-specific" glyph.
 *
 * BOTH operands of the echo comparison are normalized. The plugin scanner writes
 * `pack_id = component_key = name` RAW while the cross-surface identity key is
 * lowercased and trimmed, so a mixed-case plugin id (`"ClosedLoop"`) would
 * otherwise compare unequal on one surface and equal on the other — reintroducing
 * exactly the web/desktop skew this change exists to close.
 *
 * `install_path` is deliberately NOT in this chain even though
 * {@link displaySource} ends there: a filesystem location is a place, not a
 * provenance, and the same projection feeds the ORG-WIDE cloud catalog, where
 * surfacing one would print another member's local paths to the whole org. It
 * stays excluded on both surfaces so the two agree. `project_path` is excluded
 * as a VALUE for the same reason — it is consulted only as a signal that the row
 * is project-scoped, and the branch emits the scope, never the path.
 *
 * `kind` is passed in already narrowed rather than re-derived from
 * `row.component_kind`, so this module never needs the reader's `toKind` and the
 * emitted fallback type cannot disagree with the `kind` the caller emits.
 */
export function honestSourceOf(
  row: HonestSourceRow,
  kind: AgentComponentKind
): AgentComponentHonestSource {
  if (row.pack_id && !isIdentityEcho(row, row.pack_id)) {
    return {
      hasProvenance: true,
      source: row.pack_id,
      sourceType: SourceType.Pack,
    };
  }
  // ISS-5009: `source_url` FIRST, because that is the column the desktop writers
  // actually populate — `component-scanner.ts:202`/`:466`, `mcp-discovery.ts:354`
  // and `definition-content-collector.ts:770` all write `source_url`, and NOTHING
  // writes the bare `source` column. Reading only `source` (as the legacy
  // `displaySource` chain does) made this branch dead, dropped real repo
  // provenance, and made desktop answer `{false, null, Local}` where cloud
  // answers `{true, sourceUrl, Repo}` for the SAME component — precisely the
  // web/desktop divergence this projection exists to prevent. `source` is kept as
  // a trailing fallback so a row that does carry it is still honoured.
  const repoProvenance = row.source_url ?? row.source;
  if (repoProvenance) {
    return {
      hasProvenance: true,
      source: stripUrlUserinfo(repoProvenance),
      sourceType: SourceType.Repo,
    };
  }
  if (row.scope && row.scope !== ComponentScope.Project) {
    return {
      hasProvenance: true,
      source: row.scope,
      sourceType: SourceType.Local,
    };
  }
  if (row.project_path || row.scope === ComponentScope.Project) {
    return {
      hasProvenance: true,
      source: row.scope ?? ComponentScope.Project,
      sourceType: SourceType.Repo,
    };
  }
  return noProvenanceHonestSource(kind);
}

/**
 * ISS-5009: the no-provenance terminal of {@link honestSourceOf}, shared with
 * the reader's unresolved-usage builder — a usage identity with no inventory row
 * at all knows even less than a row that fell through the chain, so both must
 * emit the same "nothing known" shape rather than two hand-written literals that
 * can drift. `Server` for an MCP tool mirrors {@link toSourceType}'s mcp branch
 * (an MCP invocation IS server-provenance even when the server was never
 * inventoried); every other kind is `Local` == builder-specific / unresolvable.
 */
export function noProvenanceHonestSource(
  kind: AgentComponentKind
): AgentComponentHonestSource {
  return {
    hasProvenance: false,
    source: null,
    sourceType:
      kind === AgentComponentKind.Mcp ? SourceType.Server : SourceType.Local,
  };
}

/** Lowercase + trim one side of the identity-echo comparison (ISS-5009). */
function normalizeSourceCandidate(value: string | null): string {
  return (value ?? "").toLowerCase().trim();
}

/**
 * ISS-5009: is `value` just the row's own identity restated? Compared against
 * BOTH identity columns — `component_key` (the normalized org-identity key) and
 * `external_id` (the legacy {@link displaySource} terminal) — because either one
 * showing up in the Source column is the echo this change removes.
 */
function isIdentityEcho(row: HonestSourceRow, value: string): boolean {
  const normalized = normalizeSourceCandidate(value);
  return (
    normalized === normalizeSourceCandidate(row.component_key) ||
    normalized === normalizeSourceCandidate(row.external_id)
  );
}

/**
 * ISS-6232: adapt one inventory row into the shared
 * {@link ComponentSourceProvenance} the cross-surface `deriveComponentSource`
 * reads. The row's own `source` column is NOT carried: nothing writes it, and
 * the legacy chain above is its only reader.
 *
 * BOTH identity columns are carried, matching {@link isIdentityEcho}. A legacy
 * row can hold a `component_key` and a DIFFERENT `external_id` with `pack_id`
 * echoing the latter; passing one alias would let that echo through the shared
 * derivation as real provenance while this module's own resolver rejects it, so
 * the reconciled version history would report the external identifier as
 * provenance.
 */
export function sourceProvenanceOf(
  row: HonestSourceRow
): ComponentSourceProvenance {
  return {
    packId: row.pack_id,
    sourceUrl: row.source_url,
    scope: row.scope,
    projectPath: row.project_path,
    installPath: row.install_path,
    identityKeys: [row.component_key, row.external_id],
  };
}
