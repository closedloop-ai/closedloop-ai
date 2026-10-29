/**
 * Drift guard for the published Sessions WRITE operations (ISS-8648 / ISS-8649).
 *
 * The sibling `openapi-agent-sessions-params.test.ts` holds the same line for
 * `GET /agent-sessions`, and it exists because the hand-written spec had drifted
 * from the validator that actually gates the request. These three write
 * operations were added to `openapi.json` by hand for the same reason — the two
 * session paths advertised only `GET`, so a generated client had no POST/PATCH
 * contract at all (whitlockk, PR #6330) — and they can rot the same way.
 *
 * Every expectation is read off the Zod schema, never off the document under
 * test. A body field added to a validator without being documented fails here,
 * which is the direction that actually strands a generated client.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AgentSessionPatchField,
  ArtifactRowFieldMutationErrorCode,
} from "@repo/api/src/types/artifact-row-field-edit";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, expect, it } from "vitest";
import {
  agentSessionBulkAssignBodySchema,
  agentSessionCreateBodySchema,
  agentSessionUpdateBodySchema,
} from "@/app/agent-sessions/validators";
import {
  AGENT_SESSION_BULK_ASSIGN_MAX_IDS,
  AgentSessionBulkAssignField,
} from "@/app/agent-sessions/write-contract";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const openApiPath = path.join(
  repoRoot,
  "apps/web/content/docs/api-reference/openapi.json"
);

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  items?: JsonSchema;
  maxItems?: number;
  maxLength?: number;
  minLength?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  $ref?: string;
};

type Operation = {
  operationId?: string;
  requestBody?: {
    content: Record<string, { schema: JsonSchema }>;
  };
  responses?: Record<string, unknown>;
};

const spec = JSON.parse(readFileSync(openApiPath, "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, JsonSchema> };
};

function operation(route: string, method: string): Operation {
  const documented = spec.paths[route]?.[method];
  if (!documented) {
    throw new Error(
      `openapi.json documents no ${method.toUpperCase()} ${route}`
    );
  }
  return documented;
}

function bodySchema(op: Operation): JsonSchema {
  const schema = op.requestBody?.content["application/json"]?.schema;
  if (!schema) {
    throw new Error(`${op.operationId} documents no JSON request body`);
  }
  return schema;
}

function documentedProperties(op: Operation): string[] {
  return Object.keys(bodySchema(op).properties ?? {}).sort();
}

/** The keys a Zod object body actually accepts. */
function acceptedProperties(schema: {
  shape: Record<string, unknown>;
}): string[] {
  return Object.keys(schema.shape).sort();
}

const WRITE_OPERATIONS = [
  {
    method: "post",
    route: "/agent-sessions",
    operationId: "createAgentSession",
    schema: agentSessionCreateBodySchema,
  },
  {
    method: "patch",
    route: "/agent-sessions/{id}",
    operationId: "updateAgentSession",
    schema: agentSessionUpdateBodySchema,
  },
  {
    method: "post",
    route: "/agent-sessions/bulk-assign",
    operationId: "bulkAssignAgentSessions",
    schema: agentSessionBulkAssignBodySchema,
  },
] as const;

describe("published Sessions write operations (ISS-8648 / ISS-8649)", () => {
  it.each(WRITE_OPERATIONS)(
    "documents $operationId with exactly the body fields its validator accepts",
    ({ route, method, operationId, schema }) => {
      const op = operation(route, method);

      expect(op.operationId).toBe(operationId);
      expect(
        documentedProperties(op),
        `The documented body for ${method.toUpperCase()} ${route} no longer matches its Zod schema. A client generated from the spec cannot send a field the spec omits.`
      ).toEqual(acceptedProperties(schema));
    }
  );

  it.each(WRITE_OPERATIONS)(
    "gives $operationId a 401 and a 403, because every write needs the `write` scope",
    ({ route, method }) => {
      const responses = operation(route, method).responses ?? {};

      expect(Object.keys(responses)).toEqual(
        expect.arrayContaining(["200", "400", "401", "403"])
      );
    }
  );

  it("publishes only the three LIFECYCLE statuses on both status-bearing bodies", () => {
    // The display-only spellings (`waiting`, `unknown`, `stale`) are rejected by
    // the validator, so documenting one would advertise a write that 400s.
    for (const { route, method } of [
      { route: "/agent-sessions", method: "post" },
      { route: "/agent-sessions/{id}", method: "patch" },
    ]) {
      const status = bodySchema(operation(route, method)).properties?.status;

      expect(status?.enum?.slice().sort()).toEqual(
        Object.values(SESSION_STATUS).slice().sort()
      );
    }
  });

  // ISS-8733 moved `name` off `artifacts.name` and onto the rename column, and
  // narrowed it from 500 to the ceiling the desktop sync payload shares. Nothing
  // here read a length before, so the document's `maxLength` was free to drift
  // from the validator the moment either side moved — a generated client would
  // keep advertising a bound the API no longer enforces.
  it("pins the documented name length to the length the validator actually enforces", () => {
    const documented = bodySchema(operation("/agent-sessions/{id}", "patch"))
      .properties?.name;
    const enforced = agentSessionUpdateBodySchema.shape.name.unwrap();

    expect(documented?.maxLength).toBe(enforced.maxLength);
    expect(documented?.minLength).toBe(enforced.minLength);
  });

  it("pins the bulk cap and field vocabulary to the contract constants", () => {
    const body = bodySchema(operation("/agent-sessions/bulk-assign", "post"));

    expect(body.properties?.sessionIds?.maxItems).toBe(
      AGENT_SESSION_BULK_ASSIGN_MAX_IDS
    );
    expect(body.properties?.field?.enum?.slice().sort()).toEqual(
      Object.values(AgentSessionBulkAssignField).slice().sort()
    );
    expect(body.required?.slice().sort()).toEqual([
      "field",
      "sessionIds",
      "value",
    ]);
  });

  it("resolves every response schema the write operations reference", () => {
    for (const { route, method } of WRITE_OPERATIONS) {
      const responses = operation(route, method).responses ?? {};
      const refs = JSON.stringify(responses).match(
        /#\/components\/schemas\/[A-Za-z0-9_]+/g
      );

      expect(
        refs,
        `${method} ${route} declares no response schema`
      ).not.toBeNull();
      for (const ref of refs ?? []) {
        const name = ref.split("/").pop() as string;
        expect(
          spec.components.schemas[name],
          `${ref} is referenced by ${method.toUpperCase()} ${route} but not defined`
        ).toBeDefined();
      }
    }
  });

  // ISS-9485: the PATCH answers three structured codes. The document names each
  // in its status's description; reading the literals off the const is what
  // stops a renamed code from leaving the published contract behind.
  it("names each structured PATCH error code under the status that carries it", () => {
    const responses = (operation("/agent-sessions/{id}", "patch").responses ??
      {}) as Record<string, { description?: string }>;

    for (const [status, code] of [
      ["400", ArtifactRowFieldMutationErrorCode.UnsupportedField],
      ["403", ArtifactRowFieldMutationErrorCode.FieldForbidden],
      ["404", ArtifactRowFieldMutationErrorCode.ArtifactsNotFound],
    ] as const) {
      expect(responses[status]?.description, status).toContain(`\`${code}\``);
    }
    for (const bodyKey of [
      AgentSessionPatchField.ProjectId,
      AgentSessionPatchField.OwnerUserId,
    ]) {
      expect(responses["400"]?.description).toContain(`\`${bodyKey}\``);
    }
  });
});
