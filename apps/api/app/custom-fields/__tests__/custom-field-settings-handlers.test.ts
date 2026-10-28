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
  requireOrgAdmin: vi.fn(),
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
  requireOrgAdmin: mocks.requireOrgAdmin,
}));

vi.mock("@/app/custom-fields/values-service", () => ({
  customFieldValuesService: mocks.valuesService,
}));

import {
  POSTGRES_INT4_MAX,
  POSTGRES_INT4_MIN,
} from "@closedloop-ai/loops-api/column-limits";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import {
  ORG_ADMIN_ADMITTED,
  orgAdminRefused,
} from "@/__tests__/support/auth/org-admin-gate.test-fixtures";
import {
  EntityNotFoundError,
  FieldNotFoundError,
} from "../custom-field-errors";
import { makeCustomFieldSettingsHandlers } from "../custom-field-settings-handlers";

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
  mocks.requireOrgAdmin.mockResolvedValue(ORG_ADMIN_ADMITTED);
  mocks.valuesService.attachField.mockResolvedValue(SETTING);
  mocks.valuesService.detachField.mockResolvedValue(undefined);
  mocks.valuesService.listSettings.mockResolvedValue([SETTING]);
});

describe("POST /{entity}/:id/custom-field-settings", () => {
  it("refuses a non-admin caller without touching the service", async () => {
    mocks.requireOrgAdmin.mockImplementation(orgAdminRefused);

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
    mocks.requireOrgAdmin.mockImplementation(orgAdminRefused);

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

// ---------------------------------------------------------------------------
// ISS-8880 §1 — malformed path segments
// ---------------------------------------------------------------------------

/**
 * This factory backs EIGHT shipped route files (branches, agent-sessions,
 * documents and projects, each with a bare and a `[settingId]` variant), so one
 * missing guard here is a missing guard on all eight.
 *
 * Both segments reach a `@db.Uuid` column: `id` is the entity's artifact id, and
 * `settingId` is despite its name a `customFieldId`. A non-uuid in either makes
 * Postgres raise, which the handler's catch-all reports as a 500.
 *
 * Every case asserts the 404 AND that the service was never called. The services
 * are wired to SUCCEED in `beforeEach` above, so a missing guard yields 200 and
 * these cannot pass vacuously.
 */
const MALFORMED_SEGMENTS = [
  "not-a-uuid",
  "PRD-42",
  "12345",
  "11111111-1111-4111-8111",
  "11111111-1111-4111-8111-11111111111z",
];

/** Artifact ids are `@default(uuid(7))`, so v7 is the production format. */
const ENTITY_ID_V7 = "0199a000-0000-7000-8000-00000000000e";
const FIELD_ID_V7 = "0199a000-0000-7000-8000-00000000000f";

describe("custom-field-settings factory — malformed path segments", () => {
  it.each(MALFORMED_SEGMENTS)(
    "POST answers 404 for entity id %j without touching the service",
    async (id) => {
      const response = await callHandler(
        handlers.POST,
        postRequest({ customFieldId: FIELD_ID }),
        { id }
      );

      expect(response.status).toBe(404);
      expect(mocks.valuesService.attachField).not.toHaveBeenCalled();
    }
  );

  it.each(MALFORMED_SEGMENTS)(
    "GET answers 404 for entity id %j without touching the service",
    async (id) => {
      const response = await callHandler(
        handlers.GET,
        new NextRequest("http://localhost/documents/x/custom-field-settings"),
        { id }
      );

      expect(response.status).toBe(404);
      expect(mocks.valuesService.listSettings).not.toHaveBeenCalled();
    }
  );

  it.each(MALFORMED_SEGMENTS)(
    "DELETE answers 404 for entity id %j without touching the service",
    async (id) => {
      const response = await callHandler(
        handlers.DELETE,
        new NextRequest(
          "http://localhost/documents/x/custom-field-settings/y",
          {
            method: "DELETE",
          }
        ),
        { id, settingId: FIELD_ID }
      );

      expect(response.status).toBe(404);
      expect(mocks.valuesService.detachField).not.toHaveBeenCalled();
    }
  );

  it.each(MALFORMED_SEGMENTS)(
    "DELETE answers 404 for settingId %j even when the entity id is valid",
    async (settingId) => {
      const response = await callHandler(
        handlers.DELETE,
        new NextRequest(
          "http://localhost/documents/x/custom-field-settings/y",
          {
            method: "DELETE",
          }
        ),
        { id: ENTITY_ID, settingId }
      );

      // `settingId` is a customFieldId on a `@db.Uuid` column, so it needs its
      // own guard — a valid entity id does not make it safe.
      expect(response.status).toBe(404);
      expect(mocks.valuesService.detachField).not.toHaveBeenCalled();
    }
  );

  it("POST still reaches the service for a uuid v7 entity id", async () => {
    const response = await callHandler(
      handlers.POST,
      postRequest({ customFieldId: FIELD_ID_V7 }),
      { id: ENTITY_ID_V7 }
    );

    expect(response.status).toBe(200);
    expect(mocks.valuesService.attachField).toHaveBeenCalled();
  });

  it("GET still reaches the service for a uuid v7 entity id", async () => {
    const response = await callHandler(
      handlers.GET,
      new NextRequest("http://localhost/documents/x/custom-field-settings"),
      { id: ENTITY_ID_V7 }
    );

    expect(response.status).toBe(200);
    expect(mocks.valuesService.listSettings).toHaveBeenCalledWith(
      CustomFieldEntityType.Document,
      ENTITY_ID_V7,
      "org-1"
    );
  });

  it("DELETE still reaches the service when both segments are uuid v7", async () => {
    await callHandler(
      handlers.DELETE,
      new NextRequest("http://localhost/documents/x/custom-field-settings/y", {
        method: "DELETE",
      }),
      { id: ENTITY_ID_V7, settingId: FIELD_ID_V7 }
    );

    expect(mocks.valuesService.detachField).toHaveBeenCalledWith(
      FIELD_ID_V7,
      CustomFieldEntityType.Document,
      ENTITY_ID_V7,
      "org-1"
    );
  });
});

// ---------------------------------------------------------------------------
// ISS-8880 §3b — sortOrder reaches CustomFieldSetting.sortOrder, a Prisma Int
// ---------------------------------------------------------------------------

describe("custom-field-settings factory — sortOrder int4 bound", () => {
  it.each([POSTGRES_INT4_MAX + 1, 1e21, POSTGRES_INT4_MIN - 1, -1e21])(
    "refuses sortOrder %d without touching the service",
    async (sortOrder) => {
      const response = await callHandler(
        handlers.POST,
        postRequest({ customFieldId: FIELD_ID, sortOrder }),
        { id: ENTITY_ID }
      );

      expect(response.status).toBe(400);
      expect(mocks.valuesService.attachField).not.toHaveBeenCalled();
    }
  );

  // `-1` is in the ACCEPT set deliberately, and this expectation was inverted:
  // it previously asserted 400. A negative is a legal int4 that this route
  // stores today, so refusing it changed behaviour on VALID input, which
  // ISS-8880's governing constraint forbids. The bound is the column's range,
  // not a product rule about what a sort position ought to mean.
  it.each([-1, 0, POSTGRES_INT4_MAX, POSTGRES_INT4_MIN])(
    "still attaches with sortOrder %d",
    async (sortOrder) => {
      const response = await callHandler(
        handlers.POST,
        postRequest({ customFieldId: FIELD_ID, sortOrder }),
        { id: ENTITY_ID }
      );

      expect(response.status).toBe(200);
      // `sortOrder` rides in the fifth positional argument's settings object.
      expect(mocks.valuesService.attachField).toHaveBeenCalledWith(
        FIELD_ID,
        CustomFieldEntityType.Document,
        ENTITY_ID,
        "org-1",
        expect.objectContaining({ sortOrder })
      );
    }
  );
});

// ---------------------------------------------------------------------------
// ISS-8880 §1 — all EIGHT re-export route files, not just the factory
// ---------------------------------------------------------------------------

/**
 * Testing the factory once proves the guard exists; it does not prove the eight
 * shipped modules re-export the guarded handlers. Existing coverage above
 * imports only two of the eight collection routes and none of the `[settingId]`
 * variants, so a route file that re-exported something else — or nothing —
 * would still have looked covered.
 */
/**
 * Static importers, not a template-literal specifier: `check:source-gates`
 * cannot fold a computed module path, so it cannot prove the import stays out
 * of the privileged Desktop gateway tree and reports it.
 */
const COLLECTION_ROUTES = [
  [
    "agent-sessions",
    CustomFieldEntityType.Session,
    () => import("@/app/agent-sessions/[id]/custom-field-settings/route"),
    () =>
      import(
        "@/app/agent-sessions/[id]/custom-field-settings/[settingId]/route"
      ),
  ],
  [
    "branches",
    CustomFieldEntityType.Branch,
    () => import("@/app/branches/[id]/custom-field-settings/route"),
    () => import("@/app/branches/[id]/custom-field-settings/[settingId]/route"),
  ],
  [
    "documents",
    CustomFieldEntityType.Document,
    () => import("@/app/documents/[id]/custom-field-settings/route"),
    () =>
      import("@/app/documents/[id]/custom-field-settings/[settingId]/route"),
  ],
  [
    "projects",
    CustomFieldEntityType.Project,
    () => import("@/app/projects/[id]/custom-field-settings/route"),
    () => import("@/app/projects/[id]/custom-field-settings/[settingId]/route"),
  ],
] as const;

describe("custom-field-settings — all 8 re-export routes carry the guard", () => {
  it.each(COLLECTION_ROUTES)(
    "%s collection route guards a malformed entity id",
    async (segment, _entityType, loadCollectionRoute) => {
      const route = await loadCollectionRoute();

      const response = await callHandler(
        route.GET,
        new NextRequest(`http://localhost/${segment}/x/custom-field-settings`),
        { id: "not-a-uuid" }
      );

      expect(response.status).toBe(404);
      expect(mocks.valuesService.listSettings).not.toHaveBeenCalled();
    }
  );

  it.each(COLLECTION_ROUTES)(
    "%s collection route still serves a uuid v7, with its own entity type",
    async (segment, entityType, loadCollectionRoute) => {
      const route = await loadCollectionRoute();

      await callHandler(
        route.GET,
        new NextRequest(`http://localhost/${segment}/x/custom-field-settings`),
        { id: ENTITY_ID_V7 }
      );

      expect(mocks.valuesService.listSettings).toHaveBeenCalledWith(
        entityType,
        ENTITY_ID_V7,
        "org-1"
      );
    }
  );

  it.each(COLLECTION_ROUTES)(
    "%s [settingId] route guards a malformed settingId",
    async (segment, _entityType, _loadCollectionRoute, loadSettingRoute) => {
      const route = await loadSettingRoute();

      const response = await callHandler(
        route.DELETE,
        new NextRequest(
          `http://localhost/${segment}/x/custom-field-settings/y`,
          {
            method: "DELETE",
          }
        ),
        { id: ENTITY_ID_V7, settingId: "not-a-uuid" }
      );

      expect(response.status).toBe(404);
      expect(mocks.valuesService.detachField).not.toHaveBeenCalled();
    }
  );
});
