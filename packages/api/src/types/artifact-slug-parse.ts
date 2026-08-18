// Explicit `.ts` specifiers, NOT extensionless: this helper is loaded from
// `packages/api/dist` by the desktop MAIN process over plain Node ESM (the
// ISS-5617 local linked-artifact projection), and Node ESM does not do
// extension resolution. `rewriteRelativeImportExtensions` turns these into
// resolvable `.js` paths in the emitted output, while the Vercel/Turbopack
// source bundle still resolves the `.ts` source. See `packages/api/AGENTS.md`
// ("Relative Imports in Emitted Helpers"). Extensionless here emitted
// extensionless there, so `import("../dist/types/artifact-slug-parse.js")`
// threw ERR_MODULE_NOT_FOUND before the helper ever ran.
import { ARTIFACT_SLUG_PREFIXES } from "./artifact-slug-prefixes.ts";
import type { DocumentType } from "./document.ts";
import { SLUG_PREFIX_ALIASES, type SlugPrefix } from "./slug-prefix.ts";

/**
 * Reverse of {@link ARTIFACT_SLUG_PREFIXES}: the canonical DocumentType for a
 * slug prefix. Derived from the SSOT prefix map so a new subtype's prefix is
 * picked up automatically, then extended with every compat-alias prefix from
 * {@link SLUG_PREFIX_ALIASES} (the single alias SSOT) so an alias resolves to
 * the same DocumentType as its canonical prefix — e.g. `FEA-###` maps to
 * `Feature` alongside `ISS-###` (FEA-4137 Feature → Issue rename; existing rows
 * and branch-name slugs still carry `FEA-###`). Building the alias entries from
 * `SLUG_PREFIX_ALIASES` (rather than re-listing `FEA` here) keeps a second alias
 * registry from drifting: the next compat alias added to the SSOT is picked up
 * automatically.
 */
const DOCUMENT_TYPE_BY_SLUG_PREFIX: Partial<Record<SlugPrefix, DocumentType>> =
  (() => {
    const byPrefix: Partial<Record<SlugPrefix, DocumentType>> =
      Object.fromEntries(
        Object.entries(ARTIFACT_SLUG_PREFIXES).map(([documentType, prefix]) => [
          prefix,
          documentType as DocumentType,
        ])
      );
    // Fold in the compat aliases: an alias prefix resolves to the same
    // DocumentType as its canonical prefix (e.g. FEA → the Issue type).
    for (const [canonical, aliases] of Object.entries(SLUG_PREFIX_ALIASES)) {
      const documentType = byPrefix[canonical as SlugPrefix];
      if (!documentType) {
        continue;
      }
      for (const alias of aliases ?? []) {
        byPrefix[alias] = documentType;
      }
    }
    return byPrefix;
  })();

const TYPED_SLUG_PREFIX = /^([A-Za-z]+)-(\d+)$/;

/**
 * Parse a typed artifact slug into its canonical DocumentType and a
 * CASE-NORMALIZED slug. Branch-name slugs are lowercased (e.g. `fea-1952`), but
 * the by-slug record lookup is an exact, case-sensitive text match against the
 * stored canonical slug (`FEA-1952`/`ISS-1952`), so a lowercase slug must be
 * upper-cased before it is embedded in a route — otherwise the link 404s.
 * Returns the normalized slug (canonical-cased prefix + digits) so both the
 * route and the case-insensitive contract are honored. Null for a non-typed slug
 * or a prefix we can't type (e.g. `PRO-`/`WRK-`/`SES-`).
 *
 * `canonicalSlug` deliberately PRESERVES the input's own prefix — `FEA-1952`
 * stays `FEA-1952` — because stored rows carry either spelling and the by-slug
 * lookup is exact. `identitySlug` is the other question: which ENTITY is this,
 * so two spellings of one artifact can be folded. It re-prefixes the digits with
 * the DocumentType's single canonical prefix from {@link ARTIFACT_SLUG_PREFIXES},
 * so `FEA-1952` and `ISS-1952` share one identity (FEA-4137) while each keeps
 * its own addressable slug. Callers that ROUTE want `canonicalSlug`; callers
 * that DEDUPE want `identitySlug`.
 *
 * Lives in `packages/api/src/types` rather than beside its original web callers
 * in `@repo/app/documents/lib/document-navigation` because the desktop MAIN
 * process needs it too (ISS-5617's local linked-artifact projection) and
 * `@repo/app` is a bundler-resolution package with no build output — it is
 * unreachable under the Electron main runtime. Both slug SSOTs this derives from
 * already live here, so this is the reachable home for the derivation as well.
 */
export function parseTypedArtifactSlug(slug: string | null | undefined): {
  documentType: DocumentType;
  canonicalSlug: string;
  identitySlug: string;
} | null {
  if (!slug) {
    return null;
  }
  const match = TYPED_SLUG_PREFIX.exec(slug);
  if (!match) {
    return null;
  }
  const prefix = match[1].toUpperCase() as SlugPrefix;
  const documentType = DOCUMENT_TYPE_BY_SLUG_PREFIX[prefix];
  if (!documentType) {
    return null;
  }
  const digits = match[2];
  const identityPrefix = ARTIFACT_SLUG_PREFIXES[documentType] ?? prefix;
  return {
    documentType,
    canonicalSlug: `${prefix}-${digits}`,
    identitySlug: `${identityPrefix}-${digits}`,
  };
}
