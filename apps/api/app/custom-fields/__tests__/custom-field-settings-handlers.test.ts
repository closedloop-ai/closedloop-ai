/**
 * Route-handler tests for the custom-field settings factory.
 *
 * The factory is shared by the Document and Project settings routes, so the
 * entityType it was built with is what keeps one surface from writing settings
 * against the other. These cover the admin gate, body validation, the
 * service-error → HTTP mapping, and the entityType each real route wires in.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: {
    clerkOrgId: "clerk-org-1",
    clerkUserId: "clerk-user-1",
    user: { id: "user-1", organizationId: "org-1" },
  },
  isOrgAdmin: vi.fn(),
  valuesService: {
    attachField: vi.fn(),
    detachField: vi.fn(),
    listSettings: vi.fn(),
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(mocks.authContext, request, context?.params),
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(mocks.authContext, request, context?.params),
}));

vi.mock("@/lib/auth/org-admin", () => ({
  isOrgAdmin: mocks.isOrgAdmin,
}));

vi.mock("@/app/custom-fields/values-service", async () => {
  const actual = await import("@/app/custom-fields/values-service");
  return {
    customFieldValuesService: mocks.valuesService,
    EntityNotFoundError: actual.EntityNotFoundError,
    FieldNotFoundError: actual.FieldNotFoundError,
  };
});

import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { makeCustomFieldSettingsHandlers } from "../custom-field-settings-handlers";
import { EntityNotFoundError, FieldNotFoundError } from "../values-service";

const ENTITY_ID = "11111111-1111-4111-8111-111111111111";
const FIELD_ID = "22222222-2222-4222-8222-222222222222";

const handlers = makeCustomFieldSettingsHandlers(
  CustomFieldEntityType.Document
);

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/documents/x/custom-field-settings", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function routeContext(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

/** Invokes a factory handler the way Next.js does, with a params promise. */
function callHandler(
  handler: unknown,
  request: NextRequest,
  params: Record<string, string>
): Promise<Response> {
  return (handler as (req: NextRequest, ctx: unknown) => Promise<Response>)(
    request,
    routeContext(params)
  );
}

const SETTING = {
  id: "setting-1",
  customFieldId: FIELD_ID,
  entityType: CustomFieldEntityType.Document,
  entityId: ENTITY_ID,
  isImportant: false,
  isRequired: false,
  sortOrder: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isOrgAdmin.mockResolvedValue(true);
  mocks.valuesService.attachField.mockResolvedValue(SETTING);
  mocks.valuesService.detachField.mockResolvedValue(undefined);
  mocks.valuesService.listSettings.mockResolvedValue([SETTING]);
});

describe("POST /{entity}/:id/custom-field-settings", () => {
  it("refuses a non-admin caller without touching the service", async () => {
    mocks.isOrgAdmin.mockResolvedValue(false);

    const response = await callHandler(
      handlers.POST,
      postRequest({ customFieldId: FIELD_ID }),
      { id: ENTITY_ID }
    );

    expect(response.status).toBe(403);
    expect(mocks.valuesService.attachField).not.toHaveBeenCalled();
  });

  it("rejects a body whose customFieldId is not a uuid", async () => {
    const response = await callHandler(
      handlers.POST,
      postRequest({ customFieldId: "not-a-uuid" }),
      { id: ENTITY_ID }
    );

    expect(response.status).toBe(400);
    expect(mocks.valuesService.attachField).not.toHaveBeenCalled();
  });

  it("attaches with the factory's entity type, the path id, and the caller's org", async () => {
    const response = await callHandler(
      handlers.POST,
      postRequest({ customFieldId: FIELD_ID, isImportant: true, sortOrder: 3 }),
      { id: ENTITY_ID }
    );

    expect(response.status).toBe(200);
    expect(mocks.valuesService.attachField).toHaveBeenCalledWith(
      FIELD_ID,
      CustomFieldEntityType.Document,
      ENTITY_ID,
      "org-1",
      expect.objectContaining({
        customFieldId: FIELD_ID,
        isImportant: true,
        sortOrder: 3,
      })
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { id: "setting-1" },
    });
  });

  it("maps a missing entity to 404 naming the entity type", async () => {
    mocks.valuesService.attachField.mockRejectedValue(
      new EntityNotFoundError(CustomFieldEntityType.Document, ENTITY_ID)
    );

    const response = await callHandler(
      handlers.POST,
      postRequest({ customFieldId: FIELD_ID }),
      { id: ENTITY_ID }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: `${CustomFieldEntityType.Document} not found`,
    });
  });

  it("maps a missing field to 404 naming the custom field, not the entity", async () => {
    mocks.valuesService.attachField.mockRejectedValue(
      new FieldNotFoundError(FIELD_ID)
    );

    const response = await callHandler(
      handlers.POST,
      postRequest({ customFieldId: FIELD_ID }),
      { id: ENTITY_ID }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "Custom field not found",
    });
  });

  it("does not dress an unexpected failure up as a 404", async () => {
    mocks.valuesService.attachField.mockRejectedValue(
      new Error("pool timeout")
    );

    const response = await callHandler(
      handlers.POST,
      postRequest({ customFieldId: FIELD_ID }),
      { id: ENTITY_ID }
    );

    expect(response.status).toBe(500);
  });
});

describe("GET /{entity}/:id/custom-field-settings", () => {
  it("lists settings for the path entity in the caller's org", async () => {
    const response = await callHandler(
      handlers.GET,
      new NextRequest("http://localhost/documents/x/custom-field-settings"),
      { id: ENTITY_ID }
    );

    expect(response.status).toBe(200);
    expect(mocks.valuesService.listSettings).toHaveBeenCalledWith(
      CustomFieldEntityType.Document,
      ENTITY_ID,
      "org-1"
    );
  });

  it("returns an error response when the service fails", async () => {
    mocks.valuesService.listSettings.mockRejectedValue(new Error("boom"));

    const response = await callHandler(
      handlers.GET,
      new NextRequest("http://localhost/documents/x/custom-field-settings"),
      { id: ENTITY_ID }
    );

    expect(response.status).toBe(500);
  });
});

describe("DELETE /{entity}/:id/custom-field-settings/:settingId", () => {
  it("refuses a non-admin caller without touching the service", async () => {
    mocks.isOrgAdmin.mockResolvedValue(false);

    const response = await callHandler(
      handlers.DELETE,
      new NextRequest("http://localhost/x", { method: "DELETE" }),
      { id: ENTITY_ID, settingId: FIELD_ID }
    );

    expect(response.status).toBe(403);
    expect(mocks.valuesService.detachField).not.toHaveBeenCalled();
  });

  it("passes the :settingId path param through as the custom field id", async () => {
    // The param is named settingId but carries a customFieldId — the service
    // signature takes the field id first, so a rename here silently detaches
    // nothing.
    const response = await callHandler(
      handlers.DELETE,
      new NextRequest("http://localhost/x", { method: "DELETE" }),
      { id: ENTITY_ID, settingId: FIELD_ID }
    );

    expect(response.status).toBe(200);
    expect(mocks.valuesService.detachField).toHaveBeenCalledWith(
      FIELD_ID,
      CustomFieldEntityType.Document,
      ENTITY_ID,
      "org-1"
    );
  });

  it("maps a missing entity to 404", async () => {
    mocks.valuesService.detachField.mockRejectedValue(
      new EntityNotFoundError(CustomFieldEntityType.Document, ENTITY_ID)
    );

    const response = await callHandler(
      handlers.DELETE,
      new NextRequest("http://localhost/x", { method: "DELETE" }),
      { id: ENTITY_ID, settingId: FIELD_ID }
    );

    expect(response.status).toBe(404);
  });
});

describe("route wiring", () => {
  it("builds the project settings route against the Project entity type", async () => {
    const projectRoute = await import(
      "@/app/projects/[id]/custom-field-settings/route"
    );

    await callHandler(
      projectRoute.GET,
      new NextRequest("http://localhost/projects/x/custom-field-settings"),
      { id: ENTITY_ID }
    );

    expect(mocks.valuesService.listSettings).toHaveBeenCalledWith(
      CustomFieldEntityType.Project,
      ENTITY_ID,
      "org-1"
    );
  });

  it("builds the document settings route against the Document entity type", async () => {
    const documentRoute = await import(
      "@/app/documents/[id]/custom-field-settings/route"
    );

    await callHandler(
      documentRoute.GET,
      new NextRequest("http://localhost/documents/x/custom-field-settings"),
      { id: ENTITY_ID }
    );

    expect(mocks.valuesService.listSettings).toHaveBeenCalledWith(
      CustomFieldEntityType.Document,
      ENTITY_ID,
      "org-1"
    );
  });
});
