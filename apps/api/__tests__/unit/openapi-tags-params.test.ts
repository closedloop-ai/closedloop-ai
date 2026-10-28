/**
 * Drift guard (ISS-7461) for the published `GET /tags` parameter list.
 *
 * `apps/web/content/docs/api-reference/openapi.json` documents this endpoint by
 * hand, and `content/docs/api-reference/tags/listTags.mdx` is generated from it,
 * so the spec IS the public contract a generated client compiles against. Before
 * ISS-7461 the endpoint took no query params at all; it now takes six, one of
 * which (`projectId`) is accepted and then ignored purely so an already-deployed
 * client is not rejected. Lint and typecheck only prove the spec parses.
 *
 * Every expectation here comes from the validator module, never from the
 * document under test — `openapi-agent-sessions-params.test.ts` records what
 * happens otherwise: a guard that reads its own expectation out of the file it
 * is checking goes green on exactly the drift it exists to catch.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  TAG_LIST_MAX_LIMIT,
  TAG_LIST_MAX_OFFSET,
} from "@repo/api/src/types/tag";
import { describe, expect, it } from "vitest";
import { TAG_LIST_QUERY_PARAM_NAMES } from "@/app/tags/validators";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const openApiPath = path.join(
  repoRoot,
  "apps/web/content/docs/api-reference/openapi.json"
);

type DocumentedParameter = {
  name: string;
  in: string;
  deprecated?: boolean;
  description?: string;
  schema?: { type?: string; minimum?: number; maximum?: number };
};

const IGNORED_PATTERN = /IGNORED/;
const OFFSET_REQUIRES_LIMIT_PATTERN = /without a limit is rejected/i;
const SEARCH_REQUIRES_LIMIT_PATTERN = /search without a limit is rejected/i;
// Both halves, deliberately. The refine is `includeTotal` requires limit OR
// name, and `?name=…&includeTotal=true` is the exact call the MCP mutation path
// makes — a pattern that matched only the `limit` half let the spec document
// that call as a 400 while the server answered it (caught in review).
const INCLUDE_TOTAL_REQUIRES_LIMIT_PATTERN = /requires `limit` OR `name`/;
const NAME_EXCLUSIVE_PATTERN = /[Cc]annot be combined/;

function readTagsGetOperation() {
  const spec = JSON.parse(readFileSync(openApiPath, "utf8")) as {
    paths: Record<
      string,
      Record<
        string,
        {
          parameters?: DocumentedParameter[];
          responses?: Record<string, unknown>;
        }
      >
    >;
    components: { schemas: Record<string, unknown> };
  };
  return { spec, operation: spec.paths["/tags"].get };
}

function documentedParameter(name: string): DocumentedParameter {
  const { operation } = readTagsGetOperation();
  const parameter = operation.parameters?.find((p) => p.name === name);
  if (!parameter) {
    throw new Error(`GET /tags does not document a "${name}" query parameter`);
  }
  return parameter;
}

describe("openapi GET /tags parameters", () => {
  it("documents exactly the query params the validator accepts", () => {
    const { operation } = readTagsGetOperation();
    const documented = (operation.parameters ?? [])
      .filter((parameter) => parameter.in === "query")
      .map((parameter) => parameter.name);

    expect([...documented].sort()).toEqual(
      [...TAG_LIST_QUERY_PARAM_NAMES].sort()
    );
  });

  it("pins the documented limit and offset bounds to the shared constants", () => {
    // A spec that advertises a wider bound than the route enforces compiles a
    // client that 400s at runtime.
    expect(documentedParameter("limit").schema?.maximum).toBe(
      TAG_LIST_MAX_LIMIT
    );
    expect(documentedParameter("limit").schema?.minimum).toBe(1);
    expect(documentedParameter("offset").schema?.maximum).toBe(
      TAG_LIST_MAX_OFFSET
    );
    expect(documentedParameter("offset").schema?.minimum).toBe(0);
  });

  it("marks projectId deprecated and says it is ignored", () => {
    // apps/web/AGENTS.md: a public input the runtime accepts must appear in the
    // schema even when it normalizes to something else internally. It is
    // accepted only so installed pre-PRD-797 Desktop builds (whose Audit Bot
    // filed through crewd's client) keep working; presenting it as a live
    // filter would be a lie.
    const projectId = documentedParameter("projectId");
    expect(projectId.deprecated).toBe(true);
    expect(projectId.description).toMatch(IGNORED_PATTERN);
  });

  it("documents the pairing rules the validator enforces", () => {
    // These are refine-level 400s, which JSON Schema cannot express, so the
    // /documents precedent encodes them in the parameter prose. If the prose
    // drops them a client author cannot learn the rule from the spec at all.
    expect(documentedParameter("offset").description).toMatch(
      OFFSET_REQUIRES_LIMIT_PATTERN
    );
    // `search` is unindexed, so an unbounded one is the org-wide scan this
    // ticket exists to kill. A spec that still advertises it as optional-with-
    // limit compiles a client that 400s on its first search.
    expect(documentedParameter("search").description).toMatch(
      SEARCH_REQUIRES_LIMIT_PATTERN
    );
    expect(documentedParameter("includeTotal").description).toMatch(
      INCLUDE_TOTAL_REQUIRES_LIMIT_PATTERN
    );
    expect(documentedParameter("name").description).toMatch(
      NAME_EXCLUSIVE_PATTERN
    );
  });

  it("documents both response shapes and the 400", () => {
    const { spec, operation } = readTagsGetOperation();
    const okResponse = operation.responses?.["200"];
    expect(okResponse).toBeDefined();
    const data = (
      okResponse as {
        content: {
          "application/json": {
            schema: { properties: { data: { oneOf?: unknown[] } } };
          };
        };
      }
    ).content["application/json"].schema.properties.data;

    // The bare array is the default and the envelope is opt-in; a spec that
    // showed only one of them would generate a client that mishandles the other.
    expect(data.oneOf).toHaveLength(2);
    expect(spec.components.schemas.TagListPage).toBeDefined();
    expect(operation.responses?.["400"]).toBeDefined();
  });
});
