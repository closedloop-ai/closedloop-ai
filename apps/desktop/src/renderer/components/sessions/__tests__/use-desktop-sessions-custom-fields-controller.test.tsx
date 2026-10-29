import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDesktopSessionsCustomFieldsController } from "../use-desktop-sessions-custom-fields-controller";

/**
 * ISS-12455: the desktop half of the custom-field columns — which mode has the
 * data, and which writes the Desktop gateway bridge actually admits.
 */

const mocks = vi.hoisted(() => ({
  createField: vi.fn(),
  updateField: vi.fn(),
  updateValue: vi.fn(),
  useCustomFields: vi.fn(),
}));

vi.mock("@repo/app/custom-fields/hooks/use-custom-fields", () => ({
  useCreateCustomField: () => ({ mutateAsync: mocks.createField }),
  useCustomFieldReferenceTargetSearch: () => vi.fn(),
  useCustomFields: (options: unknown) => mocks.useCustomFields(options),
  useUpdateCustomField: () => ({ mutateAsync: mocks.updateField }),
  useUpdateCustomFieldValueForEntityType: () => ({
    mutateAsync: mocks.updateValue,
  }),
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => ({ data: [] }),
}));

const SESSION_FIELD: CustomFieldWithOptions = {
  id: "session-field",
  organizationId: "org-1",
  name: "session-field",
  description: null,
  fieldType: CustomFieldType.Text,
  createdById: null,
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
  updatedAt: new Date("2026-08-28T00:00:00.000Z"),
  precision: null,
  numberFormat: null,
  currencyCode: null,
  customLabel: null,
  customLabelPosition: null,
  isGlobalToOrg: true,
  entityTypes: [CustomFieldEntityType.Session],
  referenceTargetSources: [],
  showInTable: true,
  isSearchable: false,
  isSortable: false,
  enumOptions: [],
};

const ITEM = createAgentSessionListItemFixture({
  id: "session-1",
  customFields: [],
});

describe("useDesktopSessionsCustomFieldsController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useCustomFields.mockReturnValue({
      data: [SESSION_FIELD],
      isSuccess: true,
    });
  });

  it("opts in on cloud mode and out on local mode", () => {
    // Cloud mode's HTTP source carries `customFields` on every row, same as
    // the web list; local mode's producer emits none.
    expect(
      renderHook(() => useDesktopSessionsCustomFieldsController(true, [ITEM]), {
        wrapper: createWrapperWithClient(createTestQueryClient()),
      }).result.current
    ).not.toBeUndefined();
    expect(
      renderHook(
        () => useDesktopSessionsCustomFieldsController(false, [ITEM]),
        { wrapper: createWrapperWithClient(createTestQueryClient()) }
      ).result.current
    ).toBeUndefined();
  });

  it("fires no field query on local mode, even with a well-formed row", () => {
    renderHook(() => useDesktopSessionsCustomFieldsController(false, [ITEM]), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    expect(mocks.useCustomFields).toHaveBeenCalledWith({ enabled: false });
  });

  it("strips field-DEFINITION writes pending the ticket's open 'Add Field?' question, in cloud mode", () => {
    // The bridge actually admits `POST /custom-fields` and
    // `PUT /custom-fields/[id]` (for Documents), so this is a deliberate
    // product choice left to a human, not a route the gateway would refuse —
    // see `cloud-api-fetch-ipc-custom-field-values.test.ts`.
    const { result } = renderHook(
      () => useDesktopSessionsCustomFieldsController(true, [ITEM]),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    expect(result.current?.onCreateField).toBeUndefined();
    expect(result.current?.onAddExistingField).toBeUndefined();
    expect(result.current?.availableFields).toBeUndefined();
    // Value edits — the admitted route — stay wired.
    expect(typeof result.current?.onValueChange).toBe("function");
    expect(result.current?.fields).toEqual([SESSION_FIELD]);
  });
});
