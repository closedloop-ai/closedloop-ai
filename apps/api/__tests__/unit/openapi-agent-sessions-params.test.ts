/**
 * Drift guard (ISS-6039) for the published `GET /agent-sessions` parameter list.
 *
 * `apps/web/content/docs/api-reference/openapi.json` documents this endpoint by
 * hand. Every multi-select facet the route accepts and applies — `statuses`,
 * `userIds`, `repositories`, `harnesses`, `models`, `autonomyTiers`,
 * `costBuckets`, `changePresence`, `prAssociation`, `projectIds` — plus
 * `completedAfter` was absent from it, so a client generated from the spec could
 * reach only the single-value back-compat spellings while the product UI used
 * the array forms. Lint and typecheck only prove the spec parses; nothing
 * otherwise compares the hand-written parameter list against the schema that
 * actually gates the request.
 *
 * This test parses openapi.json as data (an allowed config/data comparison, not
 * a raw-source scan), resolves `$ref`'d parameters against `components`, and
 * asserts the documented parameter names equal the accepted ones. It also pins the
 * `sortBy` enum to `AGENT_SESSION_SORT_COLUMNS`, because a name-only comparison
 * would not have caught the same defect one level down: `updated` (ISS-6005) was
 * accepted and implemented but missing from the documented enum.
 *
 * Every expectation here is taken from the validator, never from the document
 * under test. Multiplicity in particular used to be read back out of
 * openapi.json (`schema.type === "array"`), which let a facet documented as a
 * scalar drop out of its own expectation: the name check still passed, the
 * multiplicity filter no longer saw it, and the guard went green on exactly the
 * defect it exists to catch. It now compares against
 * `AGENT_SESSION_REPEATABLE_QUERY_PARAM_NAMES` in both directions.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_SESSION_LIST_QUERY_PARAM_NAMES,
  AGENT_SESSION_REPEATABLE_QUERY_PARAM_NAMES,
  AGENT_SESSION_SORT_COLUMNS,
} from "@/app/agent-sessions/validators";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const openApiPath = path.join(
  repoRoot,
  "apps/web/content/docs/api-reference/openapi.json"
);

/**
 * `search` is accepted for version-skewed Desktop clients but is NOT implemented
 * server-side (see the validator comment and root `AGENTS.md` L87-96). It is
 * published, but ONLY as `deprecated` with a description that disclaims any
 * filtering — the contract this guard holds is that the spec never presents it
 * as a working filter, not that it is absent. An undocumented-but-accepted param
 * teaches a skewed client nothing; a deprecated one tells it to stop sending it.
 */
const ACCEPTED_BUT_UNIMPLEMENTED_PARAMS = ["search"];

/** The disclaimer every accepted-but-unimplemented param's description must carry. */
const IGNORED_DISCLAIMER_PATTERN = /IGNORED/;

type OpenApiParameter = {
  $ref?: string;
  name?: string;
  in?: string;
  style?: string;
  explode?: boolean;
  deprecated?: boolean;
  description?: string;
  schema?: { type?: string; enum?: string[] };
};

type OpenApiDoc = {
  paths: Record<string, Record<string, { parameters?: OpenApiParameter[] }>>;
  components?: { parameters?: Record<string, OpenApiParameter> };
};

const openApi = JSON.parse(readFileSync(openApiPath, "utf8")) as OpenApiDoc;

const componentParameters = openApi.components?.parameters ?? {};

/**
 * Parameters may be written inline or hoisted into `components/parameters` and
 * `$ref`'d (ISS-6042). Both spell the same published contract, so resolve before
 * reading any field: a `$ref` entry carries no `name`/`in`/`schema` of its own,
 * and reading those off it unresolved silently drops the parameter from every
 * expectation below — the guard would go green on the defect it exists to catch.
 */
function resolveParameter(parameter: OpenApiParameter): OpenApiParameter {
  if (!parameter.$ref) {
    return parameter;
  }
  const key = parameter.$ref.split("/").at(-1) ?? "";
  const resolved = componentParameters[key];
  if (!resolved) {
    throw new Error(
      `openapi.json: unresolvable parameter $ref ${parameter.$ref}`
    );
  }
  return resolved;
}

const documentedParameters = (
  openApi.paths["/agent-sessions"].get.parameters ?? []
).map(resolveParameter);
const documentedQueryParams = documentedParameters
  .filter((parameter) => parameter.in === "query")
  .map((parameter) => parameter.name);

describe("openapi.json GET /agent-sessions parameter contract (ISS-6039)", () => {
  it("documents every query param the route accepts", () => {
    expect([...documentedQueryParams].sort()).toEqual(
      [...AGENT_SESSION_LIST_QUERY_PARAM_NAMES].sort()
    );
  });

  it("publishes each accepted-but-unimplemented param as deprecated and non-filtering", () => {
    const documentedByName = new Map(
      documentedParameters.map((parameter) => [parameter.name, parameter])
    );

    for (const name of ACCEPTED_BUT_UNIMPLEMENTED_PARAMS) {
      expect(AGENT_SESSION_LIST_QUERY_PARAM_NAMES).toContain(name);
      const parameter = documentedByName.get(name);
      // Deprecated alone is not enough: the prose is what stops a client author
      // from wiring it up as a filter, so pin both.
      expect({
        name,
        deprecated: parameter?.deprecated,
        disclaimsFiltering: IGNORED_DISCLAIMER_PATTERN.test(
          parameter?.description ?? ""
        ),
      }).toEqual({ name, deprecated: true, disclaimsFiltering: true });
    }
  });

  it("documents the exact sortBy vocabulary from the SSOT", () => {
    const sortBy = documentedParameters.find(
      (parameter) => parameter.name === "sortBy"
    );

    expect(sortBy?.schema?.enum).toEqual([...AGENT_SESSION_SORT_COLUMNS]);
  });

  it("declares each repeatable facet as a repeatable (exploded form) array", () => {
    const documentedByName = new Map(
      documentedParameters.map((parameter) => [parameter.name, parameter])
    );

    // A `style`/`explode` pair other than exploded form would generate clients
    // that serialize `statuses=a,b`, which `parseQueryParams` reads as one value.
    for (const name of AGENT_SESSION_REPEATABLE_QUERY_PARAM_NAMES) {
      const parameter = documentedByName.get(name);
      expect({
        name,
        type: parameter?.schema?.type,
        style: parameter?.style,
        explode: parameter?.explode,
      }).toEqual({ name, type: "array", style: "form", explode: true });
    }
  });

  it("declares no param the route reads as a scalar as an array", () => {
    const documentedArrays = documentedParameters
      .filter((parameter) => parameter.schema?.type === "array")
      .map((parameter) => parameter.name);

    expect([...documentedArrays].sort()).toEqual(
      [...AGENT_SESSION_REPEATABLE_QUERY_PARAM_NAMES].sort()
    );
  });
});
