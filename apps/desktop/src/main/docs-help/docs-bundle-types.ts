/**
 * Shape of the build-time docs bundle (FEA-3843 / PRD-555 M1).
 *
 * `scripts/generate-docs-bundle-manifest.mjs` snapshots `apps/web/content/docs/**\/*.mdx` +
 * `meta.json` into the gitignored `docs-bundle-manifest.ts` (mirrors the
 * `migrations-manifest.ts` / `build-info.ts` prebuild precedent), which exports a
 * `DOCS_BUNDLE` value of this type. Keeping the type in a committed module lets
 * the manifest consumer (`docs-bundle.ts`) and the generator agree on the shape
 * without the manifest itself being tracked.
 */
import type { DocsHelpPage } from "../../shared/docs-help-contract.js";

/** The full build-time snapshot: version stamp + the indexed pages. */
export type DocsBundle = {
  /** `apps/web/content/docs` commit the snapshot was taken from (from `git rev-parse HEAD`). */
  sourceCommit: string;
  /** ISO-8601 timestamp the bundle was generated. */
  generatedAt: string;
  /** Base URL of the live docs site, for the "view latest online" escape hatch. */
  docsSiteUrl: string;
  /** Every snapshotted page, in `meta.json` nav order followed by any un-navigated pages. */
  pages: readonly DocsHelpPage[];
};
