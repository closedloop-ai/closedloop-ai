/**
 * Route-handler tests for the custom-field VALUES factory (ISS-7209).
 *
 * The factory is what makes "valued on a Session and a Branch through the API"
 * reachable — Sessions and Branches have no PATCH body to carry values in. The
 * entityType it was built with is what keeps one surface from writing values
 * against another, so that binding is the main thing under test here, alongside
 * the service-error → HTTP status mapping.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: {
    clerkOrgId: "clerk-org-1",
    clerkUserId: "clerk-user-1",
    user: { id: "user-1", organizationId: "org-1" },
    authMethod: "session" as "session" | "api_key",
  },
  artifactValues: {
    set: vi.fn(),
    clear: vi.fn(),
  },
  valuesService: {
    getValuesForEntity: vi.fn(),
  },
  withAnyAuthOptions: [] as unknown[],
  captureAnalytics: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>, options: unknown) =>
    (request: NextRequest, context: { params: Promise<unknown> }) => {
      mocks.withAnyAuthOptions.push(options);
      return handler(mocks.authContext, request, context?.params);
    },
}));

vi.mock("@/app/custom-fields/values-service", () => ({
  customFieldValuesService: mocks.valuesService,
}));

vi.mock("../artifact-custom-field-value-service", () => ({
  artifactCustomFieldValueService: {
    set: mocks.artifactValues.set,
    clear: mocks.artifactValues.clear,
  },
}));

vi.mock("@/lib/artifact-field-edit-analytics", () => ({
  captureArtifactFieldEditAnalytics: mocks.captureAnalytics,
}));

import { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { ArtifactCustomFieldValueErrorKind } from "../artifact-custom-field-value-contract";
import { makeCustomFieldValuesHandlers } from "../custom-field-values-handlers";

const ENTITY_ID = "11111111-1111-4111-8111-111111111111";
const FIELD_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "org-1";

const sessionHandlers = makeCustomFieldValuesHandlers(
  CustomFieldEntityType.Session
);
const branchHandlers = makeCustomFieldValuesHandlers(
  CustomFieldEntityType.Branch
);

function putRequest(body: unknown): NextRequest {
  return new NextRequest(
    "http://localhost/agent-sessions/x/custom-field-values/y",
    {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }
  );
}

function deleteRequest(surface?: string): NextRequest {
  const url = new URL(
    "http://localhost/agent-sessions/x/custom-field-values/y"
  );
  if (surface !== undefined) {
    url.searchParams.set("surface", surface);
  }
  return new NextRequest(url, { method: "DELETE" });
}

/** Invokes a factory handler the way Next.js does, with a params promise. */
function callHandler(
  handler: unknown,
  request: NextRequest,
  params: Record<string, string>
): Promise<Response> {
  return (handler as (req: NextRequest, ctx: unknown) => Promise<Response>)(
    request,
    { params: Promise.resolve(params) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withAnyAuthOptions.length = 0;
  mocks.authContext.authMethod = "session";
  mocks.valuesService.getValuesForEntity.mockResolvedValue([]);
  mocks.artifactValues.set.mockResolvedValue({
    ok: true,
    value: { value: { id: "cfv-1" }, changed: true },
  });
  mocks.artifactValues.clear.mockResolvedValue({ changed: true });
});

describe("PUT /{entity}/:id/custom-field-values/:fieldId", () => {
  it("writes the value against the entity type the factory was built with", async () => {
    const response = await callHandler(
      sessionHandlers.PUT,
      putRequest({ value: "1h 12m" }),
      { id: ENTITY_ID, fieldId: FIELD_ID }
    );

    expect(response.status).toBe(200);
    expect(mocks.artifactValues.set).toHaveBeenCalledWith(
      expect.objectContaining({
        fieldId: FIELD_ID,
        entityType: CustomFieldEntityType.Session,
        entityId: ENTITY_ID,
        organizationId: ORG_ID,
        rawValue: "1h 12m",
      }),
      undefined
    );
  });

  it("binds the Branch factory to BRANCH, not to whatever Session used", async () => {
    await callHandler(branchHandlers.PUT, putRequest({ value: 42 }), {
      id: ENTITY_ID,
      fieldId: FIELD_ID,
    });

    expect(mocks.artifactValues.set).toHaveBeenCalledWith(
      expect.objectContaining({
        fieldId: FIELD_ID,
        entityType: CustomFieldEntityType.Branch,
        entityId: ENTITY_ID,
        organizationId: ORG_ID,
        rawValue: 42,
      }),
      undefined
    );
  });

  it("keeps API-key custom-field writes unattributed even when they claim a surface", async () => {
    mocks.authContext.authMethod = "api_key";

    await callHandler(
      sessionHandlers.PUT,
      putRequest({ value: 42, surface: "board" }),
      { id: ENTITY_ID, fieldId: FIELD_ID }
    );

    expect(mocks.artifactValues.set).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          actor: { userId: "user-1", authMethod: "api_key" },
          receipt: undefined,
        },
      }),
      undefined
    );
  });

  it("rejects known bulk provenance on a single-resource write", async () => {
    const response = await callHandler(
      sessionHandlers.PUT,
      putRequest({
        value: 42,
        surface: ArtifactStatusEditSurface.Bulk,
      }),
      { id: ENTITY_ID, fieldId: FIELD_ID }
    );

    expect(response.status).toBe(400);
    expect(mocks.artifactValues.set).not.toHaveBeenCalled();
  });

  it("omits unknown future surface provenance", async () => {
    const response = await callHandler(
      sessionHandlers.PUT,
      putRequest({ value: 42, surface: "future_surface" }),
      { id: ENTITY_ID, fieldId: FIELD_ID }
    );

    expect(response.status).toBe(200);
    expect(mocks.artifactValues.set).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ receipt: undefined }),
      }),
      undefined
    );
  });

  it("treats a null value as a clear rather than storing null", async () => {
    const response = await callHandler(
      sessionHandlers.PUT,
      putRequest({ value: null }),
      { id: ENTITY_ID, fieldId: FIELD_ID }
    );

    expect(response.status).toBe(200);
    expect(mocks.artifactValues.clear).toHaveBeenCalledWith(
      expect.objectContaining({
        fieldId: FIELD_ID,
        entityType: CustomFieldEntityType.Session,
        entityId: ENTITY_ID,
        organizationId: ORG_ID,
      }),
      undefined
    );
    expect(mocks.artifactValues.set).not.toHaveBeenCalled();
  });

  it("rejects a body with no value key without touching the service", async () => {
    const response = await callHandler(
      sessionHandlers.PUT,
      putRequest({ nope: 1 }),
      { id: ENTITY_ID, fieldId: FIELD_ID }
    );

    expect(response.status).toBe(400);
    expect(mocks.artifactValues.set).not.toHaveBeenCalled();
  });

  it("maps a cross-type or unknown entity to 404", async () => {
    mocks.artifactValues.set.mockResolvedValue({
      ok: false,
      error: {
        kind: ArtifactCustomFieldValueErrorKind.EntityNotFound,
        message: "Session not found",
      },
    });

    const response = await callHandler(
      sessionHandlers.PUT,
      putRequest({ value: 1 }),
      { id: ENTITY_ID, fieldId: FIELD_ID }
    );

    expect(response.status).toBe(404);
  });

  it("maps an unknown field to 404", async () => {
    mocks.artifactValues.set.mockResolvedValue({
      ok: false,
      error: {
        kind: ArtifactCustomFieldValueErrorKind.FieldNotFound,
        message: "Custom field not found",
      },
    });

    const response = await callHandler(
      sessionHandlers.PUT,
      putRequest({ value: 1 }),
      { id: ENTITY_ID, fieldId: FIELD_ID }
    );

    expect(response.status).toBe(404);
  });

  it("maps a rejected value to 400, not to a 500", async () => {
    // A negative duration or a disabled enum option is bad input. Letting it
    // fall through to `errorResponse` would report the caller's mistake as a
    // server fault and bury the message that says what was wrong.
    mocks.artifactValues.set.mockResolvedValue({
      ok: false,
      error: {
        kind: ArtifactCustomFieldValueErrorKind.InvalidValue,
        message: 'Invalid value for DURATION field: "-5" is not a duration.',
      },
    });

    const response = await callHandler(
      sessionHandlers.PUT,
      putRequest({ value: -5 }),
      { id: ENTITY_ID, fieldId: FIELD_ID }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("DURATION"),
    });
    expect(mocks.captureAnalytics).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      userId: "user-1",
      field: ArtifactFieldEditField.CustomField,
      result: ArtifactFieldEditOutcome.ValidationFailed,
      artifactCount: 1,
    });
    expect(JSON.stringify(mocks.captureAnalytics.mock.calls)).not.toContain(
      "DURATION"
    );
  });

  it("is write-scoped, so a read-only API key cannot set a value", async () => {
    await callHandler(sessionHandlers.PUT, putRequest({ value: 1 }), {
      id: ENTITY_ID,
      fieldId: FIELD_ID,
    });

    expect(mocks.withAnyAuthOptions).toEqual([
      { requiredScopes: [ApiKeyScope.Write] },
    ]);
  });

  it("maps an infrastructure failure to 500, not to a 400", async () => {
    // A Prisma connection failure is an `Error` too. If the 400 arm matched
    // `Error` rather than the rejected-value class, a DB incident would answer
    // every write with a non-retryable 400 carrying the raw driver message —
    // and skip the logging that makes the incident visible at all.
    const prismaError = Object.assign(
      new Error("Can't reach database server at db:5432"),
      { code: "P1001", clientVersion: "6.0.0" }
    );
    mocks.artifactValues.set.mockRejectedValue(prismaError);

    const response = await callHandler(
      sessionHandlers.PUT,
      putRequest({ value: 1 }),
      { id: ENTITY_ID, fieldId: FIELD_ID }
    );

    expect(response.status).toBe(500);
    // The driver's message must not be handed to the caller as the reason.
    await expect(response.json()).resolves.not.toMatchObject({
      error: expect.stringContaining("db:5432"),
    });
  });
});

describe("GET /{entity}/:id/custom-field-values", () => {
  it("reads values scoped to the factory's entity type", async () => {
    const response = await callHandler(branchHandlers.GET, putRequest({}), {
      id: ENTITY_ID,
    });

    expect(response.status).toBe(200);
    expect(mocks.valuesService.getValuesForEntity).toHaveBeenCalledWith(
      CustomFieldEntityType.Branch,
      ENTITY_ID,
      ORG_ID
    );
  });

  it("declares no scopes, leaving withAnyAuth's method fallback to require read", async () => {
    // Omission is the contract here, not an oversight: `withAnyAuth` derives
    // `read` from the GET method, so restating it would be a second source for
    // the same value.
    await callHandler(branchHandlers.GET, putRequest({}), { id: ENTITY_ID });

    expect(mocks.withAnyAuthOptions).toEqual([undefined]);
  });
});

describe("DELETE /{entity}/:id/custom-field-values/:fieldId", () => {
  it("clears the value scoped to the factory's entity type", async () => {
    const response = await callHandler(sessionHandlers.DELETE, putRequest({}), {
      id: ENTITY_ID,
      fieldId: FIELD_ID,
    });

    expect(response.status).toBe(200);
    expect(mocks.artifactValues.clear).toHaveBeenCalledWith(
      expect.objectContaining({
        fieldId: FIELD_ID,
        entityType: CustomFieldEntityType.Session,
        entityId: ENTITY_ID,
        organizationId: ORG_ID,
      }),
      undefined
    );
  });

  it("rejects known bulk provenance without clearing the value", async () => {
    const response = await callHandler(
      sessionHandlers.DELETE,
      deleteRequest(ArtifactStatusEditSurface.Bulk),
      { id: ENTITY_ID, fieldId: FIELD_ID }
    );

    expect(response.status).toBe(400);
    expect(mocks.artifactValues.clear).not.toHaveBeenCalled();
  });

  it("omits unknown future surface provenance on clear", async () => {
    const response = await callHandler(
      sessionHandlers.DELETE,
      deleteRequest("future_surface"),
      { id: ENTITY_ID, fieldId: FIELD_ID }
    );

    expect(response.status).toBe(200);
    expect(mocks.artifactValues.clear).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ receipt: undefined }),
      }),
      undefined
    );
  });

  it("is delete-scoped, so a write-only API key cannot clear a value", async () => {
    await callHandler(sessionHandlers.DELETE, putRequest({}), {
      id: ENTITY_ID,
      fieldId: FIELD_ID,
    });

    expect(mocks.withAnyAuthOptions).toEqual([
      { requiredScopes: [ApiKeyScope.Delete] },
    ]);
  });
});
