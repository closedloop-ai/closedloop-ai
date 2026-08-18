// Explicit `.ts` specifiers (see `packages/api/AGENTS.md`, "Relative Imports in
// Emitted Helpers"). Both are VALUE imports that survive into the emitted JS,
// and this module is now on the desktop main process's runtime path via
// `./artifact-slug-parse.ts`, which loads from `packages/api/dist` over plain
// Node ESM — where an extensionless specifier does not resolve.
import { DocumentType } from "./document.ts";
import { SlugPrefix } from "./slug-prefix.ts";

/**
 * The DocumentType → CANONICAL slug-prefix map used by the server-side slug
 * generator and the GitHub artifact-reference parser. Split out of
 * `./slug-prefix.ts` so that dependency-free module (imported by the
 * browser-facing search query parser) does not pull in `./document`
 * (→ `@closedloop-ai/loops-api/document` + Zod).
 *
 * FEA-4137: `DocumentType.Feature` maps to the canonical `ISS-` prefix — new
 * Issue slugs mint as `ISS-###`. `FEA-` remains an accepted alias everywhere
 * slugs are resolved/parsed (see SLUG_PREFIX_ALIASES / expandSlugAliases and the
 * GitHub parser's alias expansion); this map is only the single canonical prefix
 * per type, not the accepted-alias set.
 */
export const ARTIFACT_SLUG_PREFIXES: Partial<Record<DocumentType, SlugPrefix>> =
  {
    [DocumentType.Prd]: SlugPrefix.Prd,
    [DocumentType.ImplementationPlan]: SlugPrefix.Plan,
    [DocumentType.Feature]: SlugPrefix.Issue,
    [DocumentType.Doc]: SlugPrefix.Doc,
  };
