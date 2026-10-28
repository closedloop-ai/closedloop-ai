/**
 * Drift guard (ISS-9857) for the published `GET /agent-sessions/{id}/events`
 * contract — the keyset page past the detail's bounded `events` prefix.
 *
 * The route is `withAnyAuth`, so API-key clients reach it, and a generated or
 * discovery client can only learn the path, its two query params, and the
 * `events`-required / `nextCursor`-optional page shape from the spec. Same
 * guard shape as `openapi-agent-sessions-status-counts.test.ts`.
 *
 * Every expectation is taken from the validator and the shared page bounds,
 * never from the document under test, so a param or bound missing from the
 * spec cannot drop out of its own expectation.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { SESSION_EVENTS_PAGE_LIMIT_BOUNDS } from "@repo/api/src/types/agent-session-events-page";
import { describe, expect, it } from "vitest";
import { agentSessionEventsPageQuerySchema } from "@/app/agent-sessions/validators";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const openApiPath = path.join(
  repoRoot,
  "apps/web/content/docs/api-reference/openapi.json"
);

const EVENTS_PATH = "/agent-sessions/{id}/events";
const PAGE_SCHEMA = "AgentSessionEventsPage";

type OpenApiParameter = {
  $ref?: string;
  name?: string;
  in?: string;
  schema?: {
    type?: string;
    minimum?: number;
    maximum?: number;
    default?: number;
  };
};

type OpenApiSchema = {
  required?: string[];
  properties?: Record<string, { $ref?: string; type?: string }>;
};

type OpenApiDoc = {
  paths: Record<
    string,
    Record<
      string,
      {
        operationId?: string;
        parameters?: OpenApiParameter[];
        responses?: Record<
          string,
          {
            content?: {
              "application/json"?: { schema?: OpenApiSchema };
            };
          }
        >;
      }
    >
  >;
  components?: {
    parameters?: Record<string, OpenApiParameter>;
    schemas?: Record<string, OpenApiSchema>;
  };
};

const openApi = JSON.parse(readFileSync(openApiPath, "utf8")) as OpenApiDoc;
const operation = openApi.paths[EVENTS_PATH]?.get;

/** A `$ref`'d parameter resolved to the object a client would actually read. */
function resolveParameter(parameter: OpenApiParameter): OpenApiParameter {
  if (parameter.$ref === undefined) {
    return parameter;
  }
  const key = parameter.$ref.split("/").at(-1) ?? "";
  return openApi.components?.parameters?.[key] ?? parameter;
}

function queryParameters(): OpenApiParameter[] {
  return (operation?.parameters ?? [])
    .map(resolveParameter)
    .filter((parameter) => parameter.in === "query");
}

describe("openapi: GET /agent-sessions/{id}/events", () => {
  it("is published at all", () => {
    expect(operation?.operationId).toBe("getAgentSessionEvents");
  });

  it("documents exactly the query params the validator accepts", () => {
    const documented = queryParameters()
      .map((parameter) => parameter.name)
      .sort();

    expect(documented).toEqual(
      Object.keys(agentSessionEventsPageQuerySchema.shape).sort()
    );
  });

  it("documents the limit bounds the service clamps to", () => {
    const limit = queryParameters().find(
      (parameter) => parameter.name === "limit"
    );

    expect(limit?.schema?.maximum).toBe(
      SESSION_EVENTS_PAGE_LIMIT_BOUNDS.maxLimit
    );
    expect(limit?.schema?.default).toBe(
      SESSION_EVENTS_PAGE_LIMIT_BOUNDS.defaultLimit
    );
    expect(limit?.schema?.minimum).toBe(1);
  });

  it("serves the page schema with events required and nextCursor optional", () => {
    const envelope =
      operation?.responses?.["200"]?.content?.["application/json"]?.schema;
    expect(envelope?.properties?.data?.$ref).toBe(
      `#/components/schemas/${PAGE_SCHEMA}`
    );

    const page = openApi.components?.schemas?.[PAGE_SCHEMA];
    expect(page?.required).toEqual(["events"]);
    expect(Object.keys(page?.properties ?? {}).sort()).toEqual([
      "events",
      "nextCursor",
    ]);
    expect(page?.properties?.nextCursor?.type).toBe("string");
  });

  it("publishes the 400 for a foreign cursor and the 404 for a foreign session", () => {
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
      "200",
      "400",
      "401",
      "403",
      "404",
    ]);
  });
});
