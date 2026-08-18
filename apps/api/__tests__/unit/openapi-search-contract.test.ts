/**
 * Drift guard (ISS-6044) for the published `GET /search` REST reference.
 *
 * The route returns `GlobalSearchResponse | UnifiedSearchResponse` and picks
 * between them on params the spec used to omit entirely, so a spec-generated
 * client could be handed a payload its documented schema does not describe.
 * The spec now documents every param the route reads and models the 200 as a
 * `oneOf` of both shapes — nothing else compares the two, so this test pins the
 * documented surface to the route's own SSOT constants.
 *
 * Parsed as data (an allowed config/data comparison, not a raw-source scan),
 * mirroring `openapi-status-contract.test.ts`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MAX_UNIFIED_SEARCH_LIMIT,
  SearchMode,
  searchHitSchema,
  UNIFIED_SEARCH_OPT_IN_PARAMS,
  unifiedSearchResponseSchema,
} from "@repo/api/src/types/search";
import {
  PHASE_1_SEARCH_ENTITY_TYPES,
  SEARCH_ENTITY_TYPE_VALUES,
} from "@repo/api/src/types/search-entity-kind";
import { SearchFilterKey } from "@repo/api/src/types/search-query";
import { describe, expect, it } from "vitest";
import { clampSearchLimit } from "@/app/search/search-fts-service";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const openApiPath = path.join(
  repoRoot,
  "apps/web/content/docs/api-reference/openapi.json"
);

type Schema = {
  $ref?: string;
  type?: string | string[];
  enum?: string[];
  maximum?: number;
  items?: Schema;
  oneOf?: Schema[];
  required?: string[];
  properties?: Record<string, Schema>;
};
type Parameter = {
  name: string;
  in: string;
  description?: string;
  explode?: boolean;
  schema?: Schema & { minimum?: number; default?: number };
};
type OpenApiDoc = {
  components: { schemas: Record<string, Schema> };
  paths: Record<
    string,
    Record<
      string,
      {
        parameters?: Parameter[];
        responses: Record<
          string,
          { content?: { "application/json": { schema: Schema } } }
        >;
      }
    >
  >;
};

const openApi = JSON.parse(readFileSync(openApiPath, "utf8")) as OpenApiDoc;
const searchGet = openApi.paths["/search"].get;
const parameters = searchGet.parameters ?? [];

function parameterNamed(name: string): Parameter | undefined {
  return parameters.find((parameter) => parameter.name === name);
}

describe("openapi.json GET /search contract (ISS-6044)", () => {
  it("documents every param the route reads, including the unified opt-ins", () => {
    // `q`/`tagId` select the legacy search; the opt-ins switch the response
    // shape; `limit` only tunes an already-unified request. Only the opt-ins
    // come from a constant — they are the set that decides which of the two
    // response shapes a caller gets, and so the set ISS-6044 was about. The
    // other three are spelled out here because a route file cannot export a
    // non-route symbol for the test to read.
    const expected = [
      "q",
      "tagId",
      ...UNIFIED_SEARCH_OPT_IN_PARAMS,
      "limit",
    ].sort();

    expect(parameters.map((parameter) => parameter.name).sort()).toEqual(
      expected
    );
    expect(parameters.every((parameter) => parameter.in === "query")).toBe(
      true
    );
  });

  it("documents `types` as a repeated param over the queryable corpus", () => {
    const types = parameterNamed("types");

    // Repeated (`?types=a&types=b`), not comma-joined — an `explode: false`
    // array would generate clients that serialize a form the route ignores.
    expect(types?.explode).toBe(true);
    expect(types?.schema?.type).toBe("array");
    expect(types?.schema?.items?.$ref).toBe(
      "#/components/schemas/SearchEntityType"
    );
    // The route 400s any value outside this set, so the documented vocabulary
    // must be exactly it.
    const documented = openApi.components.schemas.SearchEntityType.enum
      ?.slice()
      .sort();
    expect(documented).toEqual([...PHASE_1_SEARCH_ENTITY_TYPES].sort());
    // One schema serves both the `types` request vocabulary and a hit's
    // `entityType`, which is only sound while the queryable corpus and the
    // emittable corpus are the same set. If they ever diverge, that single
    // schema is wrong for one of its two uses — fail here so it gets split
    // rather than silently mis-documenting the response.
    expect(documented).toEqual([...SEARCH_ENTITY_TYPE_VALUES].sort());
  });

  it("documents the exact `mode` vocabulary the route enforces", () => {
    expect(parameterNamed("mode")?.schema?.$ref).toBe(
      "#/components/schemas/SearchMode"
    );
    expect(openApi.components.schemas.SearchMode.enum).toEqual(
      Object.values(SearchMode)
    );
  });

  it("documents the `limit` bounds and default the route actually applies", () => {
    const limit = parameterNamed("limit")?.schema;

    // Pinned through the clamp itself, not a re-copied literal: the spec's
    // three numbers are exactly what an absent, under-, and over-range request
    // resolves to.
    expect(limit?.maximum).toBe(MAX_UNIFIED_SEARCH_LIMIT);
    expect(limit?.default).toBe(clampSearchLimit(null));
    expect(limit?.minimum).toBe(clampSearchLimit(0));
    expect(limit?.maximum).toBe(clampSearchLimit(Number.MAX_SAFE_INTEGER));
  });

  it("names every inline filter key that can divert `q` to the unified shape", () => {
    // The `q` prose enumerates the query-language keys; a key added to the
    // parser leaves that list — and so the documented switch condition —
    // incomplete.
    const description = parameterNamed("q")?.description ?? "";

    for (const key of Object.values(SearchFilterKey)) {
      expect(description).toContain(`\`${key}\``);
    }
  });

  it("models the 200 as a oneOf of both response shapes the route can return", () => {
    const data =
      searchGet.responses["200"].content?.["application/json"].schema.properties
        ?.data;

    expect(data?.$ref).toBeUndefined();
    expect(data?.oneOf?.map((entry) => entry.$ref)).toEqual([
      "#/components/schemas/GlobalSearchResponse",
      "#/components/schemas/UnifiedSearchResponse",
    ]);
  });

  // The `oneOf` above only proves the response points at two schema NAMES. These
  // two pin what those names CONTAIN against the runtime Zod schemas the wire
  // payload is actually validated by, so a field added, renamed, or re-marked in
  // `packages/api/src/types/search.ts` fails here instead of silently shipping a
  // generated client whose types no longer match the payload.
  it("pins `SearchHit` to the runtime hit schema's properties and required set", () => {
    const documented = openApi.components.schemas.SearchHit;
    const runtime = zodObjectKeys(searchHitSchema.shape);

    expect(Object.keys(documented.properties ?? {}).sort()).toEqual(
      runtime.all
    );
    // The route fields are optional so a version-skewed API that omits them
    // still satisfies the contract; documenting one as required would generate a
    // client that demands a value the API legitimately never sends.
    expect([...(documented.required ?? [])].sort()).toEqual(runtime.required);
    // Nullability compared in BOTH directions: a runtime-nullable field
    // documented as non-nullable makes a client dereference null, and the
    // reverse forces callers to handle a null the API never sends.
    expect(documentedNullability(documented, searchHitSchema.shape)).toEqual(
      runtimeNullability(searchHitSchema.shape)
    );
  });

  it("pins `UnifiedSearchResponse` to the runtime response schema, `nextCursor` nullability included", () => {
    const documented = openApi.components.schemas.UnifiedSearchResponse;
    const runtime = zodObjectKeys(unifiedSearchResponseSchema.shape);

    expect(Object.keys(documented.properties ?? {}).sort()).toEqual(
      runtime.all
    );
    expect([...(documented.required ?? [])].sort()).toEqual(runtime.required);
    // `nextCursor` is `string | null` at runtime — it is REQUIRED but null on the
    // drained page. Documenting it as a bare `string` generates a client that
    // types the last page's cursor non-nullable and dereferences null.
    expect(
      documentedNullability(documented, unifiedSearchResponseSchema.shape)
    ).toEqual(runtimeNullability(unifiedSearchResponseSchema.shape));
    expect(isDocumentedNullable(documented.properties?.nextCursor)).toBe(true);
  });
});

/**
 * The slice of a Zod schema this contract needs to introspect. Structural so the
 * helpers below accept any `.shape` member without naming a Zod internal type.
 */
type ZodIntrospectable = {
  isOptional(): boolean;
  isNullable(): boolean;
};

/**
 * Split a Zod object's shape into the two key sets an OpenAPI object schema must
 * mirror: every key is a documented `property`, and the non-optional keys are
 * exactly its `required` array. Both sorted, so the comparison is order-free.
 */
function zodObjectKeys(shape: Record<string, ZodIntrospectable>): {
  all: string[];
  required: string[];
} {
  const all = Object.keys(shape).sort();
  return {
    all,
    required: all.filter((key) => !shape[key].isOptional()),
  };
}

/**
 * OpenAPI 3.1 spells a nullable field as a type UNION (`["string", "null"]`),
 * not the 3.0 `nullable: true`. Absent or scalar `type` means non-nullable.
 */
function isDocumentedNullable(schema: Schema | undefined): boolean {
  const type = schema?.type;
  return Array.isArray(type) && type.includes("null");
}

/**
 * Per-key nullability as the SPEC declares it, over the runtime shape's keys, so
 * it lines up 1:1 with {@link runtimeNullability} for a single comparison.
 */
function documentedNullability(
  documented: Schema,
  shape: Record<string, ZodIntrospectable>
): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const key of Object.keys(shape)) {
    map[key] = isDocumentedNullable(documented.properties?.[key]);
  }
  return map;
}

/** Per-key nullability as the RUNTIME Zod schema declares it. */
function runtimeNullability(
  shape: Record<string, ZodIntrospectable>
): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const [key, member] of Object.entries(shape)) {
    map[key] = member.isNullable();
  }
  return map;
}
