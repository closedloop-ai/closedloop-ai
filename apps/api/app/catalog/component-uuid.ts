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
