import { generateFiles } from "fumadocs-openapi";
import { openapi } from "@/lib/openapi";

/**
 * Regenerates the `/docs/api-reference` MDX pages from the web-owned OpenAPI
 * spec (`content/docs/api-reference/openapi.json`).
 *
 * The generated per-endpoint `.mdx` files are committed to the repo (they are
 * the Fumadocs page source), so a normal build does NOT run this script. Run it
 * whenever the OpenAPI spec changes:
 *
 *   pnpm --filter web generate:api-reference
 *
 * Each page emits an `<APIPage />` element that is resolved through the MDX
 * components map in `app/[locale]/docs/[[...slug]]/page.tsx`.
 */
async function main() {
  await generateFiles({
    input: openapi,
    output: "./content/docs/api-reference",
    // One page per API operation, foldered by OpenAPI tag (Documents,
    // Projects, ...). The hand-authored index.mdx + meta.json control the nav.
    per: "operation",
    groupBy: "tag",
    // Render endpoint descriptions in the page body. The Closedloop spec's
    // descriptions are plain Markdown-safe prose.
    includeDescription: true,
  });
}

main().catch((error: unknown) => {
  process.exitCode = 1;
  throw error;
});
