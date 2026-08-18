import { createOpenAPI } from "fumadocs-openapi/server";

/**
 * Web-owned OpenAPI schema powering the `/docs/api-reference` section.
 *
 * The spec is committed under `content/docs/api-reference/openapi.json` so that
 * both page generation (`generateFiles`) and the runtime `APIPage` component
 * read the same web-owned source and do not depend on the retired Mintlify
 * `apps/docs/` tree (deleted in FEA-3886/FEA-3891).
 */
export const openapi = createOpenAPI({
  input: ["./content/docs/api-reference/openapi.json"],
});
