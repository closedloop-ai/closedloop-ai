/**
 * Drift guard (ISS-4616) for the REST reference status vocabulary.
 *
 * `apps/web/content/docs/api-reference/openapi.json` hand-copies the
 * `DocumentStatus` / `IssueStatus` enums and widens the document status
 * surfaces to the union of both. Lint and typecheck only prove the spec
 * parses; nothing otherwise compares the manually copied enums — or the
 * widened surfaces — against the canonical SSOT, so the same drift shafty
 * flagged can silently return.
 *
 * This test parses openapi.json as data (an allowed config/data comparison,
 * not a raw-source scan) and asserts:
 *   1. the two documented status enums EXACTLY match `DOCUMENT_STATUS_OPTIONS`
 *      / `ISSUE_STATUS_OPTIONS` from the `@closedloop-ai/loops-api` SSOT, and
 *   2. the status surfaces this PR owns (the update request body and the
 *      Document response) stay pinned to those two schemas via `$ref` rather
 *      than re-inlining an enum that could drift.
 *
 * The create request surface is intentionally NOT asserted here: PR #4135
 * (ISS-4615) owns that schema and converts it to discriminated `oneOf`
 * branches, so a structural assertion on it would fight that PR. The enum
 * guards above still protect the canonical schemas the create surface refs.
 *
 * ISS-9559 adds a second, same-shaped guard below: the status-mutation
 * capability's `permissions` object is another hand-copy, of
 * `DocumentStatusMutationOperation`, and an external client can only discover
 * the read-vs-write capability the detail reads return if the reference keeps
 * naming every operation — and keeps the field OPTIONAL, since every producer
 * without a credential omits it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DOCUMENT_STATUS_OPTIONS,
  ISSUE_STATUS_OPTIONS,
} from "@closedloop-ai/loops-api/document";
import { DocumentStatusMutationOperation } from "@repo/api/src/types/document-status-mutation";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const openApiPath = path.join(
  repoRoot,
  "apps/web/content/docs/api-reference/openapi.json"
);

type RefEntry = { $ref?: string };
type StatusSurface = { enum?: string[]; anyOf?: RefEntry[] };
type OpenApiDoc = {
  components: {
    schemas: Record<
      string,
      {
        enum?: string[];
        required?: string[];
        properties?: Record<string, StatusSurface>;
      }
    >;
  };
  paths: Record<
    string,
    Record<
      string,
      {
        requestBody?: {
          content: {
            "application/json": {
              schema: { properties?: Record<string, StatusSurface> };
            };
          };
        };
      }
    >
  >;
};

const openApi = JSON.parse(readFileSync(openApiPath, "utf8")) as OpenApiDoc;

const DOCUMENT_STATUS_REF = "#/components/schemas/DocumentStatus";
const ISSUE_STATUS_REF = "#/components/schemas/IssueStatus";

function anyOfRefs(surface: StatusSurface | undefined): string[] {
  return (surface?.anyOf ?? [])
    .map((entry) => entry.$ref)
    .filter((ref): ref is string => typeof ref === "string")
    .sort();
}

describe("openapi.json status vocabulary contract (ISS-4616)", () => {
  it("documents the exact DocumentStatus vocabulary from the SSOT", () => {
    expect(openApi.components.schemas.DocumentStatus.enum).toEqual([
      ...DOCUMENT_STATUS_OPTIONS,
    ]);
  });

  it("documents the exact IssueStatus vocabulary from the SSOT", () => {
    expect(openApi.components.schemas.IssueStatus.enum).toEqual([
      ...ISSUE_STATUS_OPTIONS,
    ]);
  });

  it("keeps the update request and Document response status surfaces pinned to both status schemas", () => {
    const updateStatus =
      openApi.paths["/documents/{id}"].put.requestBody?.content[
        "application/json"
      ].schema.properties?.status;
    const responseStatus =
      openApi.components.schemas.Document.properties?.status;

    const expectedRefs = [DOCUMENT_STATUS_REF, ISSUE_STATUS_REF].sort();
    for (const surface of [updateStatus, responseStatus]) {
      // A pinned surface references the canonical schemas (which the enum
      // assertions above validate) instead of re-inlining a drift-prone enum.
      expect(surface?.enum).toBeUndefined();
      expect(anyOfRefs(surface)).toEqual(expectedRefs);
    }
  });
});

describe("openapi.json status-mutation permissions contract (ISS-9559)", () => {
  it("documents every status-mutation operation the SSOT defines", () => {
    const permissions =
      openApi.components.schemas.DocumentStatusMutationPermissions;
    const operations = [
      ...Object.values(DocumentStatusMutationOperation),
    ].sort();

    expect(Object.keys(permissions.properties ?? {}).sort()).toEqual(
      operations
    );
    expect([...(permissions.required ?? [])].sort()).toEqual(operations);
  });

  it("publishes permissions on the capability, and publishes it as optional", () => {
    const capability =
      openApi.components.schemas.DocumentStatusMutationCapability;

    expect(capability.properties?.permissions).toBeDefined();
    // Optional is the contract, not an oversight: only the detail reads hold a
    // credential to resolve it, and absence means "not resolved", not "denied".
    expect(capability.required ?? []).not.toContain("permissions");
  });
});
