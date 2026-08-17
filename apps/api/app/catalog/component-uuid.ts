import {
  type ComponentIdentityInput,
  computeComponentUuid,
} from "@repo/api/src/component-identity";

/**
 * Single derivation of a CatalogItem's content-addressed identity, shared by
 * every content-bearing writer (manual create/update, bulk bootstrap ingest,
 * zip import, and promotion) so the same file+provenance resolves to the same
 * `componentUuid` no matter which path persisted it.
 *
 * Content-less writers pass `null`/`undefined` content and get `null`
 * (asset-only items and the Pack container carry no component identity).
 * Provenance defaults: `sourceRepo`/`organizationId` fall back to the empty
 * string when absent (curated seed / promotion without an upstream repo), which
 * is exactly what {@link computeComponentUuid} expects.
 *
 * Lives in its own module (no `server-only` / AWS deps) so it can be imported
 * by any writer without dragging in the full catalog-service module graph, and
 * so there is exactly ONE place identity is derived.
 */
export function deriveComponentUuid(params: {
  content: string | null | undefined;
  sourceRepo: string | null | undefined;
  organizationId: string | null | undefined;
}): string | null {
  if (params.content == null) {
    return null;
  }
  const identity: ComponentIdentityInput = {
    source: params.sourceRepo ?? "",
    owner: params.organizationId ?? "",
    content: params.content,
  };
  return computeComponentUuid(identity);
}

/**
 * The identity a reader should key a pack member on (FEA-3909 / PRD-527 F4/PD5).
 * `definition_version` is the provenance-FREE exact-version identity; `component_uuid`
 * is the legacy provenance-tainted compatibility identity — {@link resolvePackMemberIdentity}
 * discriminates which one a resolved identity came from so callers can treat the
 * fallback honestly rather than conflating the two.
 */
export const PackMemberIdentityKind = {
  /** The provenance-free F1 `definitionVersionId` link (preferred). */
  DefinitionVersion: "definition_version",
  /** The legacy provenance-tainted `componentUuid` compatibility identity. */
  ComponentUuid: "component_uuid",
} as const;
export type PackMemberIdentityKind =
  (typeof PackMemberIdentityKind)[keyof typeof PackMemberIdentityKind];

/**
 * A pack member's resolved identity, or `null` when neither identity is present
 * (an asset-only / unlinked-and-unhashed member).
 */
export type ResolvedPackMemberIdentity = {
  id: string;
  kind: PackMemberIdentityKind;
} | null;

/**
 * Resolve which identity a pack-member reader *should* use, per PRD-527 F4/PD5:
 * **prefer the provenance-free `definitionVersionId` when present**, else fall
 * back to the legacy provenance-tainted `componentUuid` compatibility identity
 * (which this FEAT deliberately preserves — a later human-approved FEAT retires
 * it from the pack path). Returns `null` when the member carries neither.
 *
 * NOTE (reader integration is a follow-up slice): as of this FEAT the pack
 * writers and backfill populate `definitionVersionId`, but no live read path
 * calls this helper yet — the pack-member DTO does not select or surface the
 * resolved identity. This is the sanctioned precedence contract a later reader
 * slice will wire in; it is exported now so that reader can adopt it unchanged
 * rather than re-deriving the precedence. Tested standalone (`component-uuid.test.ts`).
 *
 * Pure and dependency-light — the same module the writers import, so a reader can
 * apply the exact precedence contract without pulling in the service graph.
 */
export function resolvePackMemberIdentity(member: {
  definitionVersionId: string | null | undefined;
  componentUuid: string | null | undefined;
}): ResolvedPackMemberIdentity {
  if (member.definitionVersionId != null) {
    return {
      id: member.definitionVersionId,
      kind: PackMemberIdentityKind.DefinitionVersion,
    };
  }
  if (member.componentUuid != null) {
    return {
      id: member.componentUuid,
      kind: PackMemberIdentityKind.ComponentUuid,
    };
  }
  return null;
}
