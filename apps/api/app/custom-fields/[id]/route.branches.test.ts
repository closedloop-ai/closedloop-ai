/**
 * ISS-11280 branch coverage for GET/PUT/DELETE /custom-fields/[id].
 *
 * The admin-gate denial arms and the PUT/DELETE happy paths are already
 * pinned by `__tests__/api/settings-command-gate-routes.test.ts`; this file
 * targets what that shared suite doesn't reach: GET's found/not-found fork,
 * PUT's body-validation and not-found guards, and the four-way error-type
 * dispatch in PUT's catch block (each type, plus the unmatched fallthrough).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params),
}));

vi.mock("../custom-fields-admin-gate", () => ({
  requireCustomFieldsAdmin: vi.fn(),
}));

vi.mock("../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../service")>();
  return {
    ...actual,
    customFieldsService: {
      findById: vi.fn(),
      updateField: vi.fn(),
      deleteField: vi.fn(),
    },
  };
});

import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  NumberFormat,
  ReferenceTargetSource,
} from "@repo/api/src/types/custom-field";
import { requireCustomFieldsAdmin } from "../custom-fields-admin-gate";
import {
  customFieldsService,
  DuplicateNameError,
  IncompatibleNumberFormatError,
  IncompatibleReferenceSourcesError,
} from "../service";
import { ReservedNameError } from "../utils";
import { DELETE, GET, PUT } from "./route";

const FIELD_ID = "field-1";
const ORG_ID = "test-org-id";

function buildCustomField(
  overrides: Partial<CustomFieldWithOptions> = {}
): CustomFieldWithOptions {
  return {
    id: FIELD_ID,
    organizationId: ORG_ID,
    name: "Severity",
    description: null,
    fieldType: CustomFieldType.Text,
    createdById: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    precision: null,
    numberFormat: null,
    currencyCode: null,
    customLabel: null,
    customLabelPosition: null,
    isGlobalToOrg: false,
    entityTypes: [CustomFieldEntityType.Session],
    referenceTargetSources: [],
    showInTable: true,
    isSearchable: false,
    isSortable: false,
    enumOptions: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  vi.mocked(requireCustomFieldsAdmin).mockResolvedValue(null);
});

describe("GET /custom-fields/[id]", () => {
  it("returns the field when found", async () => {
    vi.mocked(customFieldsService.findById).mockResolvedValue(
      buildCustomField()
    );

    const response = await GET(
      createMockRequest({
        url: `http://localhost:3002/custom-fields/${FIELD_ID}`,
      }),
      createMockRouteContext({ id: FIELD_ID })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.name).toBe("Severity");
    expect(customFieldsService.findById).toHaveBeenCalledWith(FIELD_ID, ORG_ID);
  });

  it("returns 404 when the field does not exist", async () => {
    vi.mocked(customFieldsService.findById).mockResolvedValue(null);

    const response = await GET(
      createMockRequest({
        url: `http://localhost:3002/custom-fields/${FIELD_ID}`,
      }),
      createMockRouteContext({ id: FIELD_ID })
    );

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.error).toBe("Custom field not found");
  });

  it("falls through to a generic 500 for an unrecognized error", async () => {
    vi.mocked(customFieldsService.findById).mockRejectedValue(
      new Error("db down")
    );

    const response = await GET(
      createMockRequest({
        url: `http://localhost:3002/custom-fields/${FIELD_ID}`,
      }),
      createMockRouteContext({ id: FIELD_ID })
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Failed to fetch custom field");
  });
});

describe("PUT /custom-fields/[id]", () => {
  it("returns the parse error for an invalid body", async () => {
    const response = await PUT(
      createMockRequest({
        url: `http://localhost:3002/custom-fields/${FIELD_ID}`,
        method: "PUT",
        body: { precision: -1 },
      }),
      createMockRouteContext({ id: FIELD_ID })
    );

    expect(response.status).toBe(400);
    expect(customFieldsService.findById).not.toHaveBeenCalled();
  });

  it("returns 404 when the field does not exist", async () => {
    vi.mocked(customFieldsService.findById).mockResolvedValue(null);

    const response = await PUT(
      createMockRequest({
        url: `http://localhost:3002/custom-fields/${FIELD_ID}`,
        method: "PUT",
        body: { name: "Renamed" },
      }),
      createMockRouteContext({ id: FIELD_ID })
    );

    expect(response.status).toBe(404);
    expect(customFieldsService.updateField).not.toHaveBeenCalled();
    const json = await response.json();
    expect(json.error).toBe("Custom field not found");
  });

  it("returns 409 when the update collides with an existing name", async () => {
    vi.mocked(customFieldsService.findById).mockResolvedValue(
      buildCustomField()
    );
    vi.mocked(customFieldsService.updateField).mockRejectedValue(
      new DuplicateNameError("Renamed")
    );

    const response = await PUT(
      createMockRequest({
        url: `http://localhost:3002/custom-fields/${FIELD_ID}`,
        method: "PUT",
        body: { name: "Renamed" },
      }),
      createMockRouteContext({ id: FIELD_ID })
    );

    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.error).toBe("Custom field with this name already exists");
    expect(customFieldsService.updateField).toHaveBeenCalledWith(
      FIELD_ID,
      ORG_ID,
      { name: "Renamed" },
      undefined
    );
  });

  it("returns 409 with the error's own message for a reserved name", async () => {
    vi.mocked(customFieldsService.findById).mockResolvedValue(
      buildCustomField()
    );
    const error = new ReservedNameError(
      "status",
      CustomFieldEntityType.Session
    );
    vi.mocked(customFieldsService.updateField).mockRejectedValue(error);

    const response = await PUT(
      createMockRequest({
        url: `http://localhost:3002/custom-fields/${FIELD_ID}`,
        method: "PUT",
        body: { name: "status" },
      }),
      createMockRouteContext({ id: FIELD_ID })
    );

    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.error).toBe(error.message);
  });

  it("returns 400 for an incompatible number format change", async () => {
    vi.mocked(customFieldsService.findById).mockResolvedValue(
      buildCustomField()
    );
    const error = new IncompatibleNumberFormatError(
      NumberFormat.Currency,
      3,
      "abc"
    );
    vi.mocked(customFieldsService.updateField).mockRejectedValue(error);

    const response = await PUT(
      createMockRequest({
        url: `http://localhost:3002/custom-fields/${FIELD_ID}`,
        method: "PUT",
        body: { numberFormat: NumberFormat.Currency },
      }),
      createMockRouteContext({ id: FIELD_ID })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe(error.message);
  });

  it("returns 400 for incompatible reference target sources", async () => {
    vi.mocked(customFieldsService.findById).mockResolvedValue(
      buildCustomField()
    );
    const error = new IncompatibleReferenceSourcesError(CustomFieldType.Text);
    vi.mocked(customFieldsService.updateField).mockRejectedValue(error);

    const response = await PUT(
      createMockRequest({
        url: `http://localhost:3002/custom-fields/${FIELD_ID}`,
        method: "PUT",
        body: { referenceTargetSources: [ReferenceTargetSource.Artifact] },
      }),
      createMockRouteContext({ id: FIELD_ID })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe(error.message);
  });

  it("falls through to a generic 500 for an unrecognized error", async () => {
    vi.mocked(customFieldsService.findById).mockResolvedValue(
      buildCustomField()
    );
    vi.mocked(customFieldsService.updateField).mockRejectedValue(
      new Error("db down")
    );

    const response = await PUT(
      createMockRequest({
        url: `http://localhost:3002/custom-fields/${FIELD_ID}`,
        method: "PUT",
        body: { name: "Renamed" },
      }),
      createMockRouteContext({ id: FIELD_ID })
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Failed to update custom field");
  });
});

describe("DELETE /custom-fields/[id]", () => {
  it("returns 404 when the field does not exist", async () => {
    vi.mocked(customFieldsService.findById).mockResolvedValue(null);

    const response = await DELETE(
      createMockRequest({
        url: `http://localhost:3002/custom-fields/${FIELD_ID}`,
        method: "DELETE",
      }),
      createMockRouteContext({ id: FIELD_ID })
    );

    expect(response.status).toBe(404);
    expect(customFieldsService.deleteField).not.toHaveBeenCalled();
    const json = await response.json();
    expect(json.error).toBe("Custom field not found");
  });

  it("falls through to a generic 500 for an unrecognized error", async () => {
    vi.mocked(customFieldsService.findById).mockResolvedValue(
      buildCustomField()
    );
    vi.mocked(customFieldsService.deleteField).mockRejectedValue(
      new Error("db down")
    );

    const response = await DELETE(
      createMockRequest({
        url: `http://localhost:3002/custom-fields/${FIELD_ID}`,
        method: "DELETE",
      }),
      createMockRouteContext({ id: FIELD_ID })
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Failed to delete custom field");
  });
});
