/**
 * Drift guard (davetho, PR #6485) for the published
 * `GET /agent-sessions/status-counts` contract.
 *
 * The endpoint shipped without a spec entry, so a generated or discovery client
 * could not learn that the path exists, what it answers, or that `status` and
 * `statuses` are REFUSED there rather than accepted — three things it cannot
 * infer from the sibling reads, whose spec entries all document those params as
 * accepted. This is the same guard shape
 * `openapi-agent-sessions-params.test.ts` applies to the list.
 *
 * Every expectation is taken from the validator, never from the document under
 * test. Reading the accepted set back out of openapi.json would let a param that
 * is missing from the spec drop out of its own expectation and pass vacuously on
 * exactly the defect this exists to catch.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { AGENT_SESSION_COUNTED_STATUSES } from "@repo/api/src/types/agent-session-status-counts";
import { describe, expect, it } from "vitest";
import {
  AGENT_SESSION_STATUS_COUNTS_QUERY_PARAM_NAMES,
  AGENT_SESSION_STATUS_COUNTS_REJECTED_QUERY_PARAM_NAMES,
} from "@/app/agent-sessions/validators";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const openApiPath = path.join(
  repoRoot,
  "apps/web/content/docs/api-reference/openapi.json"
);

const COUNTS_PATH = "/agent-sessions/status-counts";

type OpenApiParameter = { $ref?: string; name?: string };

type OpenApiDoc = {
  paths: Record<
    string,
    Record<
      string,
      {
        operationId?: string;
        parameters?: OpenApiParameter[];
        responses?: Record<string, unknown>;
      }
    >
  >;
  components?: {
    parameters?: Record<string, OpenApiParameter>;
    schemas?: Record<string, unknown>;
  };
};

const openApi = JSON.parse(readFileSync(openApiPath, "utf8")) as OpenApiDoc;
const operation = openApi.paths[COUNTS_PATH]?.get;

/** A `$ref`'d parameter resolved to the name a client would actually send. */
function resolveParameterName(parameter: OpenApiParameter): string {
  if (parameter.name !== undefined) {
    return parameter.name;
  }
  const key = parameter.$ref?.split("/").at(-1) ?? "";
  return openApi.components?.parameters?.[key]?.name ?? key;
}

describe("openapi: GET /agent-sessions/status-counts", () => {
  it("is published at all", () => {
    expect(operation?.operationId).toBe("getAgentSessionStatusCounts");
  });

  it("documents exactly the query params the route accepts", () => {
    const documented = (operation?.parameters ?? [])
      .map(resolveParameterName)
      .sort();

    expect(documented).toEqual(
      [...AGENT_SESSION_STATUS_COUNTS_QUERY_PARAM_NAMES].sort()
    );
  });

  it("does not advertise the status params the route refuses", () => {
    const documented = new Set(
      (operation?.parameters ?? []).map(resolveParameterName)
    );

    // Stated as its own case rather than left implicit in the equality above:
    // documenting a REFUSED param is the specific defect that teaches a client
    // to send something the route answers with a 400.
    for (const name of AGENT_SESSION_STATUS_COUNTS_REJECTED_QUERY_PARAM_NAMES) {
      expect(documented.has(name)).toBe(false);
    }
    // The rejected set must be non-empty, or the loop asserts nothing.
    expect(
      AGENT_SESSION_STATUS_COUNTS_REJECTED_QUERY_PARAM_NAMES.length
    ).toBeGreaterThan(0);
  });

  it("publishes a 400 for the refused params alongside the auth failures", () => {
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
      "200",
      "400",
      "401",
      "403",
    ]);
  });

  it("documents one response bucket per displayed status, plus the total", () => {
    const schema = openApi.components?.schemas?.AgentSessionStatusCounts as
      | {
          required?: string[];
          properties?: {
            countsByStatus?: {
              required?: string[];
              properties?: Record<string, { type?: unknown }>;
            };
          };
        }
      | undefined;

    expect(schema?.required?.sort()).toEqual(["countsByStatus", "total"]);
    // EVERY displayed status is documented and required, counted or not, so a
    // status added to `DISPLAYED_SESSION_STATUS` fails here until the spec names
    // it — a client generated from a spec missing a key would type the bucket as
    // absent rather than as a value it must handle.
    expect(schema?.properties?.countsByStatus?.required?.sort()).toEqual(
      [...AGENT_SESSION_COUNTED_STATUSES].sort()
    );
  });

  it("documents every bucket as a non-nullable integer", () => {
    const properties = (
      openApi.components?.schemas?.AgentSessionStatusCounts as {
        properties?: {
          countsByStatus?: {
            properties?: Record<string, { type?: unknown }>;
          };
        };
      }
    )?.properties?.countsByStatus?.properties;

    // ISS-10629 documented three uncounted buckets as `["integer","null"]`.
    // ISS-10364 retired those three from the displayed vocabulary, so there is
    // no nullable arm left: every documented bucket is counted, and a `null`
    // reappearing in the spec would hand clients a type the server never sends.
    expect(Object.keys(properties ?? {}).sort()).toEqual(
      [...AGENT_SESSION_COUNTED_STATUSES].sort()
    );
    for (const status of AGENT_SESSION_COUNTED_STATUSES) {
      expect(properties?.[status]?.type).toBe("integer");
    }
  });
});
