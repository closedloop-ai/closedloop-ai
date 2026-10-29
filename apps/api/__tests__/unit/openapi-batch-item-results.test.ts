/**
 * Drift guard for the published `/v2` batch mutation operations (ISS-9464).
 *
 * Same posture as `openapi-agent-sessions-write.test.ts`: every expectation is
 * read off CODE, never off the document under test, so the spec is the thing
 * that can be wrong. Nothing here is a hand-copied list, because a guard built
 * from one goes on passing for exactly the change it exists to catch — the set
 * of `/v2` routes this app ships comes off the filesystem, the failure-code
 * union and each body's accepted fields off their own modules, the published
 * array bounds and closed vocabularies off the Zod members that enforce them,
 * each documented key cap off the cap the validator itself reports, each
 * body's unknown-key behavior off a parse of its own published example, and
 * each operation's credential and 403 off the wrapper its route imports.
 *
 * The route inventory is the FILESYSTEM, which is what Next.js routes from: a
 * `v2/route.ts` folder is a shipped route whether or not anyone documented it.
 * `/v2` in this API means one thing — a batch mutation answering per-item
 * results — so a new one owes this table a row and the spec an operation.
 *
 * A published vocabulary is only pinned CLOSED where the validator refuses
 * everything outside it. Two of them are deliberately open on the wire, and an
 * enum over either would make a generated client refuse a request the route
 * accepts, so they are pinned open instead — see `OPEN_VOCABULARIES`.
 *
 * Reading the document, the App Router tree and the Zod members is
 * `@/__tests__/support/unit/openapi-batch-item-results.test-helpers`; reading a
 * route's credential is its sibling. What the spec OWES lives here.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { AuthErrorCode } from "@repo/api/src/types/auth-error";
import { BATCH_MUTATION_ENTITY_LIMIT } from "@repo/api/src/types/batch-mutation-limits";
import {
  BATCH_ITEM_APPLIED_STATUS,
  BatchItemAppliedOutcome,
  BatchItemFailureCode,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus } from "@repo/api/src/types/document";
import { ARTIFACT_PRIORITY_EDIT_SURFACE_VALUES } from "@repo/api/src/types/priority-contract";
import { describe, expect, it } from "vitest";
import {
  acceptedProperties,
  collectShippedV2Routes,
  enforcedArrayBound,
  enforcedVocabulary,
  type JsonSchema,
  type Operation,
  operationWithResolvedSchemas,
  reachableSchemaNames,
  reportedKeyCap,
  sharedAndUnionKeys,
} from "@/__tests__/support/unit/openapi-batch-item-results.test-helpers";
import {
  RouteAuthMode,
  routeAuth,
} from "@/__tests__/support/unit/openapi-v2-route-auth.test-helpers";
import { agentSessionBulkAssignBodySchema } from "@/app/agent-sessions/validators";
import { AgentSessionBulkAssignField } from "@/app/agent-sessions/write-contract";
import { batchFavoritesBodySchema } from "@/app/artifacts/favorites/batch/v2/route";
import { batchUpdateAssigneeValidator } from "@/app/documents/document-assignee-batch-validator";
import {
  batchDeleteValidator,
  batchMoveDocumentsValidator,
  batchUpdatePriorityValidator,
  batchUpdateStatusValidator,
} from "@/app/documents/validators";
import { batchEntityTagValidator } from "@/app/tags/validators";

const apiRoot = path.resolve(import.meta.dirname, "../..");
const repoRoot = path.resolve(apiRoot, "../..");
const openApiPath = path.join(
  repoRoot,
  "apps/web/content/docs/api-reference/openapi.json"
);

const SHARED_RESPONSE_REF = "#/components/schemas/BatchMutationResponse";
const APPLIED_BRANCH = "BatchItemApplied";
const FAILED_BRANCH = "BatchItemFailed";
const DEFAULT_SECURITY_SCHEME = "bearerAuth";
const SESSION_SECURITY_SCHEME = "sessionAuth";
const OPENAPI_3_1_VERSION = /^3\.1\./;

/**
 * What each auth wrapper owes its operations' `security`, as an exhaustive map
 * so a fourth {@link RouteAuthMode} fails typecheck here rather than falling
 * through to whichever branch happens to be last.
 *
 * `undefined` means "inherits the document default", which is right only for a
 * credential the default already names.
 */
const PUBLISHED_SECURITY: Readonly<
  Record<RouteAuthMode, readonly unknown[] | undefined>
> = {
  [RouteAuthMode.Session]: [{ [SESSION_SECURITY_SCHEME]: [] }],
  [RouteAuthMode.ApiKeyOrSession]: [
    { [DEFAULT_SECURITY_SCHEME]: [] },
    { [SESSION_SECURITY_SCHEME]: [] },
  ],
  [RouteAuthMode.ApiKey]: undefined,
};

/** Any id — the per-item constructors copy it through and never read it. */
const SAMPLE_ITEM_ID = "01a0a687-9baf-76d0-94d9-9430885eb648";

/** A key no `/v2` validator accepts, asserted against each one before use. */
const UNKNOWN_BODY_FIELD = "notAFieldAnyValidatorAccepts";

const spec = JSON.parse(readFileSync(openApiPath, "utf8")) as {
  openapi: string;
  security?: unknown[];
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, JsonSchema>;
    securitySchemes?: Record<string, unknown>;
  };
};

const SHIPPED_V2_ROUTES = collectShippedV2Routes(
  path.join(apiRoot, "app")
).sort();

const V2_OPERATIONS = [
  {
    route: "/documents/batch-update-status/v2",
    operationId: "batchUpdateDocumentStatusV2",
    schema: batchUpdateStatusValidator,
  },
  {
    route: "/documents/batch-update-priority/v2",
    operationId: "batchUpdateDocumentPriorityV2",
    schema: batchUpdatePriorityValidator,
  },
  {
    route: "/documents/batch-update-assignee/v2",
    operationId: "batchUpdateDocumentAssigneeV2",
    schema: batchUpdateAssigneeValidator,
  },
  {
    route: "/documents/batch-move/v2",
    operationId: "batchMoveDocumentsV2",
    schema: batchMoveDocumentsValidator,
  },
  {
    route: "/documents/batch-delete/v2",
    operationId: "batchDeleteDocumentsV2",
    schema: batchDeleteValidator,
  },
  {
    route: "/entity-tags/batch/v2",
    operationId: "batchApplyTagV2",
    schema: batchEntityTagValidator,
  },
  {
    route: "/entity-tags/batch-remove/v2",
    operationId: "batchRemoveTagV2",
    schema: batchEntityTagValidator,
  },
  {
    route: "/agent-sessions/bulk-assign/v2",
    operationId: "bulkAssignAgentSessionsV2",
    schema: agentSessionBulkAssignBodySchema,
  },
  {
    route: "/artifacts/favorites/batch/v2",
    operationId: "batchSetArtifactFavoritesV2",
    schema: batchFavoritesBodySchema,
  },
] as const;

function operation(route: string): Operation {
  const documented = spec.paths[route]?.post;
  if (!documented) {
    throw new Error(`openapi.json documents no POST ${route}`);
  }
  return documented;
}

function requestBody(route: string): { schema: JsonSchema; example?: unknown } {
  const content = operation(route).requestBody?.content["application/json"];
  if (!content) {
    throw new Error(`POST ${route} documents no JSON request body`);
  }
  return content;
}

function bodySchema(route: string): JsonSchema {
  return requestBody(route).schema;
}

const IDS_ARM = "documentIds";
const SELECTION_ARM = "selection";

/**
 * The body POST `route` publishes as its example, which every case that parses
 * a real body starts from. Reading it here rather than hand-writing seven bodies
 * makes the validator judge the published example too: a spec whose example its
 * own route refuses is a defect this guard should not be able to pass over.
 */
function publishedExample(route: string): Record<string, unknown> {
  const example = requestBody(route).example;
  if (!example || typeof example !== "object") {
    throw new Error(`POST ${route} publishes no request-body example`);
  }
  return example as Record<string, unknown>;
}

/**
 * The body's BRANCHES. ISS-9579 publishes the batch bodies as a `oneOf` over a
 * `documentIds` arm and a `selection` arm, because the exactly-one rule is a
 * field-pair rule and `apps/web/AGENTS.md` refuses to leave one in prose. A
 * flat body is its own single branch.
 *
 * Every guard below folds over these rather than reading `properties` off the
 * top level, so a branched body is held to the same agreement with its
 * validator in EVERY arm instead of only where a flat read happened to look.
 */
function bodyBranches(route: string): JsonSchema[] {
  const schema = bodySchema(route);
  return schema.oneOf ?? [schema];
}

function documentedProperties(route: string): string[] {
  return [
    ...new Set(
      bodyBranches(route).flatMap((branch) =>
        Object.keys(branch.properties ?? {})
      )
    ),
  ].sort();
}

function documentedProperty(route: string, field: string): JsonSchema {
  const property = bodyBranches(route)
    .map((branch) => branch.properties?.[field])
    .find((candidate) => candidate !== undefined);
  if (!property) {
    throw new Error(`POST ${route} documents no \`${field}\` body field`);
  }
  return property;
}

/**
 * A documented CLOSED vocabulary and the code that refuses everything outside
 * it, so renaming a member moves both sides at once and only an undocumented
 * member reds.
 */
const DOCUMENTED_VOCABULARIES = [
  {
    route: "/entity-tags/batch/v2",
    field: "entityType",
    accepted: enforcedVocabulary(batchEntityTagValidator, "entityType"),
  },
  {
    route: "/entity-tags/batch-remove/v2",
    field: "entityType",
    accepted: enforcedVocabulary(batchEntityTagValidator, "entityType"),
  },
  {
    route: "/agent-sessions/bulk-assign/v2",
    field: "field",
    accepted: Object.values(AgentSessionBulkAssignField),
  },
] as const;

const PRIORITY_WRITABLE_SURFACES: ReadonlySet<string> = new Set(
  ARTIFACT_PRIORITY_EDIT_SURFACE_VALUES
);

/**
 * A documented vocabulary the route deliberately leaves OPEN, and the values a
 * reader still has to be told about.
 *
 * The batch priority `surface` member uses `.catch(undefined)`, so a value
 * outside the known set is accepted and the write commits without a
 * receipt. An `enum` here reads as "anything else is refused", which is both
 * untrue and the one spelling a generated client enforces on the way out
 * (ISS-9464 review) — so the enum's absence is what gets pinned, and the
 * values move into the description where they inform without closing it.
 */
const OPEN_VOCABULARIES = [
  {
    route: "/documents/batch-update-priority/v2",
    field: "surface",
    named: [
      ...ARTIFACT_PRIORITY_EDIT_SURFACE_VALUES,
      ...Object.values(ArtifactStatusEditSurface).filter(
        (surface) => !PRIORITY_WRITABLE_SURFACES.has(surface)
      ),
    ],
  },
] as const;

/**
 * The `expected<Field>ById` guard maps, each paired with a parse of a body its
 * own validator accepts, so the published key cap is EXERCISED against the
 * schema that enforces it rather than only compared to the constant behind it.
 */
const GUARD_MAP_FIELDS = [
  {
    route: "/documents/batch-update-status/v2",
    field: "expectedStatusById",
    parseGuarding: (documentIds: string[], guardedIds: string[]) =>
      batchUpdateStatusValidator.safeParse({
        documentIds,
        status: DocumentStatus.Draft,
        expectedStatusById: Object.fromEntries(
          guardedIds.map((id) => [id, DocumentStatus.Draft])
        ),
      }),
  },
  {
    route: "/documents/batch-update-priority/v2",
    field: "expectedPriorityById",
    parseGuarding: (documentIds: string[], guardedIds: string[]) =>
      batchUpdatePriorityValidator.safeParse({
        documentIds,
        priority: Priority.Medium,
        // ISS-9440: an id carrying `null` asserts "this artifact holds no
        // priority", which is a guarded entry like any other.
        expectedPriorityById: Object.fromEntries(
          guardedIds.map((id) => [id, null])
        ),
      }),
  },
] as const;

describe("published /v2 batch mutation operations (ISS-9464)", () => {
  it("documents every /v2 route this app ships, and no route it does not", () => {
    expect(
      Object.keys(spec.paths)
        .filter((route) => route.endsWith("/v2"))
        .sort(),
      "openapi.json no longer describes exactly the /v2 routes apps/api serves. A shipped route the spec omits is reachable by any write-scoped API key with no published contract."
    ).toEqual(SHIPPED_V2_ROUTES);
  });

  it("keeps this guard's table covering every shipped /v2 route", () => {
    // Without this, a new v2 route could be documented with the wrong body or
    // the wrong response schema and every per-operation case below would simply
    // never run against it.
    expect(V2_OPERATIONS.map((entry) => entry.route).sort()).toEqual(
      SHIPPED_V2_ROUTES
    );
  });

  it.each(V2_OPERATIONS)(
    "answers $operationId with the shared per-item response schema",
    ({ route, operationId }) => {
      const documented = operation(route);

      expect(documented.operationId).toBe(operationId);
      expect(
        documented.responses?.["200"]?.content?.["application/json"]?.schema
          ?.properties?.data?.$ref,
        `POST ${route} must answer 200 with ${SHARED_RESPONSE_REF}; a per-operation response shape is what makes seven routes drift into seven contracts.`
      ).toBe(SHARED_RESPONSE_REF);
    }
  );

  it.each(V2_OPERATIONS)(
    "documents $operationId with exactly the body fields its validator accepts",
    ({ route, schema }) => {
      expect(
        documentedProperties(route),
        `The documented body for POST ${route} no longer matches its Zod schema. A client generated from the spec cannot send a field the spec omits.`
      ).toEqual(acceptedProperties(schema));
    }
  );

  it.each(V2_OPERATIONS)(
    "publishes a $operationId example its own validator accepts",
    ({ route, schema }) => {
      expect(
        schema.safeParse(publishedExample(route)).error?.issues,
        `POST ${route} publishes a request-body example its own validator refuses, so the first request a reader copies out of the docs is a 400.`
      ).toBeUndefined();
    }
  );

  it.each(V2_OPERATIONS)(
    "publishes $operationId's unknown-key behavior as its validator enforces it",
    ({ route, schema }) => {
      expect(
        acceptedProperties(schema),
        `\`${UNKNOWN_BODY_FIELD}\` became a real field of POST ${route}, so this case no longer probes an unknown key.`
      ).not.toContain(UNKNOWN_BODY_FIELD);

      const refuses = !schema.safeParse({
        ...publishedExample(route),
        [UNKNOWN_BODY_FIELD]: true,
      }).success;

      expect(
        bodyBranches(route).every(
          (branch) => branch.additionalProperties === false
        ),
        `POST ${route} publishes \`additionalProperties\` that disagrees with its validator: the validator ${refuses ? "REFUSES" : "accepts"} a body carrying an unknown key. A strict route that does not publish \`additionalProperties: false\` on EVERY branch lets a generated client build a body it answers 400 for; a permissive one that does publish it refuses a request the route would have taken.`
      ).toBe(refuses);
    }
  );

  it.each(V2_OPERATIONS)(
    "publishes $operationId's arm choice as branches, not as prose",
    ({ route, schema }) => {
      if (!acceptedProperties(schema).includes(SELECTION_ARM)) {
        expect(
          bodySchema(route).oneOf,
          `POST ${route} accepts no \`${SELECTION_ARM}\`, so it has no arm choice to branch on.`
        ).toBeUndefined();
        return;
      }

      const branches = bodyBranches(route);
      expect(
        branches.length,
        `POST ${route} publishes its \`${IDS_ARM}\`/\`${SELECTION_ARM}\` choice flat. \`apps/web/AGENTS.md\` requires discriminated branches where the runtime validates a field PAIR: flat, a generated client compiles a body naming both arms, and one naming neither, and the route answers 400 for each.`
      ).toBe(2);

      for (const arm of [IDS_ARM, SELECTION_ARM]) {
        expect(
          branches.filter((branch) => branch.required?.includes(arm)).length,
          `POST ${route} publishes no single branch REQUIRING \`${arm}\`, so the spec still admits a body that omits it.`
        ).toBe(1);
      }
      for (const branch of branches) {
        expect(
          [IDS_ARM, SELECTION_ARM].filter(
            (arm) => arm in (branch.properties ?? {})
          ),
          `A branch of POST ${route} offers both arms, which is the flat shape again inside a \`oneOf\`.`
        ).toHaveLength(1);
      }

      // The selection branch must describe a body the validator takes, and must
      // withhold exactly what the validator refuses there. ISS-9440's
      // `expected*ById` is the live case: keyed to ids the caller enumerated, it
      // cannot describe a set the caller never saw, so publishing it on this
      // branch compiles a guaranteed 400.
      const example = publishedExample(route);
      const selectionBranch = branches.find(
        (branch) => SELECTION_ARM in (branch.properties ?? {})
      );
      const selectionFields = Object.keys(selectionBranch?.properties ?? {});
      const selectionBody: Record<string, unknown> = {
        [SELECTION_ARM]: { query: {} },
      };
      for (const field of selectionFields) {
        if (field !== SELECTION_ARM && field in example) {
          selectionBody[field] = example[field];
        }
      }

      expect(
        schema.safeParse(selectionBody).error?.issues,
        `POST ${route}'s selection branch describes a body its own validator refuses, so a client generated from it cannot drive the arm at all.`
      ).toBeUndefined();

      const idsBranch = branches.find(
        (branch) => IDS_ARM in (branch.properties ?? {})
      );
      const withheld = Object.keys(idsBranch?.properties ?? {}).filter(
        (field) => field !== IDS_ARM && !selectionFields.includes(field)
      );
      for (const field of withheld) {
        expect(
          schema.safeParse({ ...selectionBody, [field]: example[field] })
            .success,
          `POST ${route} withholds \`${field}\` from its selection branch, but the validator ACCEPTS it there — the spec refuses a request the route would have taken.`
        ).toBe(false);
      }
    }
  );

  it.each(V2_OPERATIONS)(
    "bounds $operationId's documented arrays exactly where its validator does",
    ({ route, schema }) => {
      const documented = bodyBranches(route).flatMap((branch) =>
        Object.entries(branch.properties ?? {})
      );
      const arrays = documented.filter(
        ([, property]) => property.type === "array"
      );

      expect(
        arrays.map(([field]) => field),
        `POST ${route} documents no array field, so the cap it enforces on the id set is unpublished.`
      ).not.toEqual([]);
      for (const [field, property] of arrays) {
        const enforced = enforcedArrayBound(schema, field);

        expect(
          property.minItems,
          `POST ${route} publishes a \`${field}\` floor its validator does not enforce.`
        ).toBe(enforced.minItems);
        expect(
          property.maxItems,
          `POST ${route} publishes a \`${field}\` cap its validator does not enforce. Moving the constant without moving this number leaves generated clients building a batch the route refuses whole.`
        ).toBe(enforced.maxItems);
      }
    }
  );

  it.each(DOCUMENTED_VOCABULARIES)(
    "pins POST $route's $field vocabulary to the code that enforces it",
    ({ route, field, accepted }) => {
      expect(
        documentedProperty(route, field).enum?.slice().sort(),
        `POST ${route} publishes a \`${field}\` vocabulary the code that enforces it no longer agrees with.`
      ).toEqual(accepted.slice().sort());
    }
  );

  it("advertises bulk as the canonical batch-status surface while tolerating unknown version-skew input", () => {
    const route = "/documents/batch-update-status/v2";
    expect(documentedProperty(route, "surface").enum).toEqual([
      ArtifactStatusEditSurface.Bulk,
    ]);

    // The OpenAPI enum names the canonical value generated clients send. The
    // parser's broader inbound tolerance is a separate compatibility boundary:
    // future values commit with provenance omitted instead of blocking writes.
    const parsed = batchUpdateStatusValidator.safeParse({
      ...publishedExample(route),
      surface: "future_surface",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw parsed.error;
    }
    expect(parsed.data.surface).toBeUndefined();
  });

  it.each(OPEN_VOCABULARIES)(
    "leaves POST $route's $field open, as the route does",
    ({ route, field, named }) => {
      const documented = documentedProperty(route, field);

      expect(
        documented.enum,
        `POST ${route} closes \`${field}\` to an enum, but its validator accepts a value outside that set. A generated client enforces the enum on the way out, so the request never reaches the server that would have taken it.`
      ).toBeUndefined();
      expect(documented.type).toBe("string");
      for (const value of named) {
        expect(
          documented.description,
          `POST ${route} leaves \`${field}\` open without naming \`${value}\`, so nothing published says what that value does. An open vocabulary documents its members in prose or it documents them nowhere.`
        ).toEqual(expect.stringContaining(value));
      }
    }
  );

  it.each(GUARD_MAP_FIELDS)(
    "enforces POST $route's documented $field key cap in the validator behind it",
    ({ route, field, parseGuarding }) => {
      const publishedCap = documentedProperty(route, field).maxProperties;

      expect(
        publishedCap,
        `POST ${route} publishes no \`${field}\` key cap, or one the shared batch limit does not agree with. A guard map over the cap is a whole-request 400, not a per-item failure.`
      ).toBe(BATCH_MUTATION_ENTITY_LIMIT);

      const guardedIds = Array.from(
        { length: BATCH_MUTATION_ENTITY_LIMIT },
        () => randomUUID()
      );

      expect(
        parseGuarding(guardedIds, guardedIds).success,
        `the \`${field}\` validator refuses a map AT the cap POST ${route} publishes, so the published cap is one key too high.`
      ).toBe(true);
      expect(
        reportedKeyCap(
          parseGuarding(guardedIds, [...guardedIds, randomUUID()]),
          field
        ),
        `the \`${field}\` validator reports no cap of its own for a map one key PAST the one POST ${route} publishes, so nothing behind that operation enforces the \`maxProperties\` it carries.`
      ).toBe(publishedCap);
    }
  );

  it("defines both credentials the /v2 operations name", () => {
    // Every /v2 operation now names its own `security`, so none of them
    // inherits this default — but `PUBLISHED_SECURITY` still spells the
    // API-key-only mode as inheritance, and the operations outside this guard
    // rely on it, so a deleted or renamed default has to red somewhere.
    expect(
      spec.security,
      `openapi.json no longer defaults every operation to \`${DEFAULT_SECURITY_SCHEME}\`, so the operations that override nothing publish no credential at all.`
    ).toEqual([{ [DEFAULT_SECURITY_SCHEME]: [] }]);
    expect(
      spec.components.securitySchemes?.[DEFAULT_SECURITY_SCHEME],
      `the document default names \`${DEFAULT_SECURITY_SCHEME}\`, which \`components.securitySchemes\` does not define as a bearer scheme.`
    ).toMatchObject({ scheme: "bearer", type: "http" });
    expect(
      spec.components.securitySchemes?.[SESSION_SECURITY_SCHEME],
      `the session-authenticated /v2 operation names \`${SESSION_SECURITY_SCHEME}\`, which \`components.securitySchemes\` does not define. An operation pointing at an undefined scheme is as good as unauthenticated to a generator.`
    ).toMatchObject({ scheme: "bearer", type: "http" });
  });

  it.each(V2_OPERATIONS)(
    "publishes $operationId's credential and 403 as its route's own wrapper",
    ({ route }) => {
      const documented = operation(route);
      const auth = routeAuth(apiRoot, route);
      const forbidden = documented.responses?.["403"]?.description;

      expect(
        Object.keys(documented.responses ?? {}),
        `POST ${route} documents no 401, which its wrapper answers for an absent or unusable credential.`
      ).toContain("401");
      expect(
        documented.security,
        `POST ${route} publishes an EMPTY \`security\`, which clears the document-level requirement and means "no credential at all" — not "a different credential". Name the scheme this route actually takes.`
      ).not.toEqual([]);

      expect(
        documented.security,
        `POST ${route} runs the ${auth.mode} wrapper and publishes a credential set that does not match it. \`withAnyAuth\` takes an API key OR a session, which is two alternatives rather than one; publishing only the API key makes a session client read as unsupported.`
      ).toEqual(PUBLISHED_SECURITY[auth.mode]);

      // `withApiKeyAuth` 403s only for a verified key missing a scope, and
      // `withAuth` only for an org the caller is not in. A route reachable
      // through both answers both, and its 403 is the only place a client
      // learns which one it hit.
      if (auth.mode !== RouteAuthMode.Session) {
        for (const scope of auth.requiredScopes) {
          expect(
            forbidden,
            `POST ${route} requires the \`${scope}\` API-key scope, and its 403 is where a client learns that. \`withApiKeyAuth\` answers this one for a verified key that lacks a scope, so the scope is what it has to name.`
          ).toEqual(expect.stringContaining(`\`${scope}\``));
        }
      }
      if (auth.mode !== RouteAuthMode.ApiKey) {
        expect(
          forbidden,
          `POST ${route} is reachable with a session, and \`withAuth\` answers 403 with \`code\` \`${AuthErrorCode.OrgForbidden}\` when the request names an organization the caller is not a member of. Leaving it out publishes a contract that omits a response the route really sends.`
        ).toEqual(expect.stringContaining(AuthErrorCode.OrgForbidden));
      }
    }
  );

  it("spells a nullable v2 field as a null branch, not the 3.0 keyword", () => {
    // `nullable` is OAS 3.0. JSON Schema 2020-12, which 3.1 adopted, dropped it,
    // so a generator IGNORES it: the field publishes as non-null and a client
    // generated from this document cannot express clearing it (ISS-9464 review).
    expect(
      spec.openapi,
      "this guard's premise is a 3.1 document; on 3.0 `nullable` would be the correct spelling."
    ).toMatch(OPENAPI_3_1_VERSION);
    for (const { route } of V2_OPERATIONS) {
      expect(
        operationWithResolvedSchemas(operation(route), spec.components.schemas),
        `POST ${route}, or a component schema it reaches, marks a field with \`nullable\`, which this document's version ignores. Use an \`anyOf\` carrying a \`{"type": "null"}\` branch.`
      ).not.toContain('"nullable"');
    }
  });

  it("splits the per-item result into the two shapes the wire produces", () => {
    // One object with `code` and `message` optional publishes a failure without
    // diagnostics as a legal response. `batchItemFailed` cannot build one, so a
    // client generated from that shape branches on a case that cannot occur
    // (ISS-9464 review). The branches, and which keys each one owes, come off
    // the constructors rather than being listed here.
    const applied = batchItemApplied(SAMPLE_ITEM_ID);
    const failures = Object.values(BatchItemFailureCode).flatMap((code) => [
      batchItemFailed(SAMPLE_ITEM_ID, code),
      batchItemFailed(SAMPLE_ITEM_ID, code, {}),
    ]);
    const failed = sharedAndUnionKeys(failures);

    expect(
      spec.components.schemas.BatchItemResult?.oneOf,
      "`BatchItemResult` is not a choice between the applied and failed shapes, so one of them is being published with the other's fields optional."
    ).toEqual([
      { $ref: `#/components/schemas/${APPLIED_BRANCH}` },
      { $ref: `#/components/schemas/${FAILED_BRANCH}` },
    ]);
    expect(
      spec.components.schemas[APPLIED_BRANCH]?.properties?.status?.const,
      `the applied branch does not pin \`status\` to ${BATCH_ITEM_APPLIED_STATUS}, which is what makes the two branches disjoint — without it a failure matches both and \`oneOf\` is unsatisfiable.`
    ).toBe(BATCH_ITEM_APPLIED_STATUS);
    expect(
      spec.components.schemas[APPLIED_BRANCH]?.required?.slice().sort(),
      "the applied branch's required fields no longer match what `batchItemApplied` actually returns."
    ).toEqual(Object.keys(applied).sort());
    expect(
      spec.components.schemas[FAILED_BRANCH]?.required?.slice().sort(),
      "the failed branch publishes as optional a field `batchItemFailed` sets on every code, or requires one it does not always set. A client then null-checks diagnostics that are always there, or trusts one that is not."
    ).toEqual(failed.shared);
    expect(
      Object.keys(
        spec.components.schemas[FAILED_BRANCH]?.properties ?? {}
      ).sort(),
      "the failed branch's fields no longer match the union of what `batchItemFailed` emits across every code."
    ).toEqual(failed.union);
    // No runtime case for "a failure never carries 200": `BatchItemFailureStatus`
    // excludes it, so `BATCH_ITEM_FAILURE_STATUS` mapping a code to 200 fails
    // typecheck before it can reach an assertion. tsc owns that half.
    expect(
      spec.components.schemas[FAILED_BRANCH]?.properties?.status?.not?.const,
      `a failure never carries ${BATCH_ITEM_APPLIED_STATUS}, and the failed branch has to say so or it overlaps the applied one.`
    ).toBe(BATCH_ITEM_APPLIED_STATUS);
  });

  it("publishes the failure code as the open vocabulary the wire keeps it", () => {
    const documented = spec.components.schemas[FAILED_BRANCH]?.properties?.code;

    expect(documented?.type).toBe("string");
    expect(
      documented?.enum,
      `\`${FAILED_BRANCH}.code\` is published as a closed enum, but \`batchItemFailedSchema\` accepts a code this build has never seen so a newer server does not invalidate an older client's whole response. A client generated from this enum refuses the next code before that fallback can run.`
    ).toBeUndefined();
    for (const code of Object.values(BatchItemFailureCode)) {
      expect(
        documented?.description,
        `\`${code}\` is a code this build emits and the published \`code\` description does not name it. With the enum gone, that prose is the only published inventory of the codes a client will actually see.`
      ).toEqual(expect.stringContaining(code));
    }
  });

  it("publishes batch tag removal's applied outcomes as the closed wire vocabulary", () => {
    expect(
      spec.components.schemas[APPLIED_BRANCH]?.properties?.outcome?.enum
        ?.slice()
        .sort()
    ).toEqual(Object.values(BatchItemAppliedOutcome).sort());
  });

  it("resolves every schema the v2 operations reference", () => {
    for (const { route } of V2_OPERATIONS) {
      const names = reachableSchemaNames(
        operation(route),
        spec.components.schemas
      );

      expect(names, `POST ${route} references no component schema`).not.toEqual(
        []
      );
      for (const name of names) {
        expect(
          spec.components.schemas[name],
          `#/components/schemas/${name} is referenced by POST ${route} but not defined`
        ).toBeDefined();
      }
    }
  });
});
