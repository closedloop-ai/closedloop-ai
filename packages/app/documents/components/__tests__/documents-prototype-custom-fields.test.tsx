import {
  CustomFieldEntityType,
  CustomFieldType,
  type CustomFieldValueDetail,
  type CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import type { CustomFieldTableCell } from "@repo/app/custom-fields/components/custom-field-table-cell";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import {
  type TableAddFieldDialog,
  TableCustomFieldType,
} from "@repo/design-system/components/ui/table-add-field-dialog";
import { act, renderHook } from "@testing-library/react";
import { type ComponentProps, isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  documentCustomFieldCreationValues,
  useDocumentsPrototypeCustomFields,
} from "../documents-prototype-custom-fields";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  updateValue: vi.fn(),
  search: vi.fn(),
  fields: vi.fn(),
}));
vi.mock("@repo/app/custom-fields/hooks/use-custom-fields", () => ({
  useCustomFields: mocks.fields,
  useCreateCustomField: () => ({ mutateAsync: mocks.create }),
  useUpdateCustomField: () => ({ mutateAsync: mocks.update }),
  useUpdateCustomFieldValueForEntityType: () => ({
    mutateAsync: mocks.updateValue,
  }),
  useCustomFieldReferenceTargetSearch: () => mocks.search,
}));
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => ({ data: [] }),
}));

const FIELD = field("field-1", [CustomFieldEntityType.Document]);
const EXISTING = field("existing-1", [CustomFieldEntityType.Session]);

describe("Documents prototype custom fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fields.mockReturnValue({ data: [FIELD, EXISTING] });
    mocks.create.mockResolvedValue(FIELD);
    mocks.update.mockResolvedValue(EXISTING);
    mocks.updateValue.mockResolvedValue(undefined);
  });

  it("creates actual Document-scoped definitions and translates option colors", async () => {
    const { result } = renderHook(useDocumentsPrototypeCustomFields, {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });
    const created = vi.fn();
    const dialog = result.current.renderDialog(true, vi.fn(), created);
    if (!isValidElement<ComponentProps<typeof TableAddFieldDialog>>(dialog)) {
      throw new Error("Missing add-field dialog");
    }
    await act(async () => {
      await dialog.props.onCreate({
        label: "Review",
        type: TableCustomFieldType.SingleSelect,
        options: ["Pending"],
        optionColors: ["bg-success"],
      });
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Review",
        entityTypes: [CustomFieldEntityType.Document],
        fieldType: CustomFieldType.Enum,
        showInTable: true,
        enumOptions: [{ name: "Pending", sortOrder: 0, color: "green" }],
      })
    );
    expect(created).toHaveBeenCalledWith("custom-field-1");
    expect(result.current.columns.map((column) => column.id)).toEqual([
      "custom-field-1",
    ]);
  });

  it("attaches an existing definition without dropping its other entity types", async () => {
    const { result } = renderHook(useDocumentsPrototypeCustomFields, {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });
    const created = vi.fn();
    const dialog = result.current.renderDialog(true, vi.fn(), created);
    if (!isValidElement<ComponentProps<typeof TableAddFieldDialog>>(dialog)) {
      throw new Error("Missing add-field dialog");
    }
    await act(async () => {
      await dialog.props.onSelectExisting?.(EXISTING.id);
    });
    expect(mocks.update).toHaveBeenCalledWith({
      id: EXISTING.id,
      entityTypes: [
        CustomFieldEntityType.Session,
        CustomFieldEntityType.Document,
      ],
      showInTable: true,
    });
    expect(created).toHaveBeenCalledWith("custom-existing-1");
  });

  it("propagates refused creation and never adds a local substitute field", async () => {
    mocks.create.mockRejectedValue(new Error("refused"));
    const { result } = renderHook(useDocumentsPrototypeCustomFields, {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });
    const created = vi.fn();
    const dialog = result.current.renderDialog(true, vi.fn(), created);
    if (!isValidElement<ComponentProps<typeof TableAddFieldDialog>>(dialog)) {
      throw new Error("Missing add-field dialog");
    }
    await expect(
      dialog.props.onCreate({ label: "Notes", type: TableCustomFieldType.Text })
    ).rejects.toThrow("refused");
    expect(created).not.toHaveBeenCalled();
  });

  it("serializes commits and recovers the queue after a refused write", async () => {
    let release: (() => void) | undefined;
    mocks.updateValue
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      )
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(useDocumentsPrototypeCustomFields, {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });
    const cell = result.current.renderCell(
      createMockDocument({ customFields: [] }),
      "custom-field-1"
    );
    if (!isValidElement<ComponentProps<typeof CustomFieldTableCell>>(cell)) {
      throw new Error("Missing custom-field editor");
    }
    const first = cell.props.onValueChange?.("first");
    const second = cell.props.onValueChange?.("second");
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.updateValue).toHaveBeenCalledTimes(1);
    release?.();
    await first;
    await expect(second).rejects.toThrow("refused");
    await cell.props.onValueChange?.("third");
    expect(mocks.updateValue).toHaveBeenLastCalledWith({
      entityId: "artifact-123",
      fieldId: FIELD.id,
      value: "third",
    });
  });

  it("sorts number and date fields by typed values and leaves absent values empty", () => {
    const numeric = value({
      numberValue: 12,
      displayValue: "12 hours",
      fieldType: CustomFieldType.Number,
    });
    const date = value({
      customFieldId: "date",
      dateValue: new Date("2026-10-01T00:00:00Z"),
      displayValue: "Oct 1, 2026",
      fieldType: CustomFieldType.Date,
    });
    expect(
      documentCustomFieldCreationValues(
        createMockDocument({ customFields: [numeric, date] })
      )
    ).toEqual({
      "custom-field-1": ["12 hours"],
      "custom-field-1:sort": 12,
      "custom-date": ["Oct 1, 2026"],
      "custom-date:sort": new Date("2026-10-01T00:00:00Z").getTime(),
    });
    expect(documentCustomFieldCreationValues(createMockDocument())).toEqual({});
  });
});

function field(
  id: string,
  entityTypes: CustomFieldEntityType[]
): CustomFieldWithOptions {
  const timestamp = new Date("2026-10-01T00:00:00Z");
  return {
    id,
    organizationId: "org-1",
    name: id,
    description: null,
    fieldType: CustomFieldType.Text,
    createdById: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    precision: null,
    numberFormat: null,
    currencyCode: null,
    customLabel: null,
    customLabelPosition: null,
    isGlobalToOrg: true,
    entityTypes,
    referenceTargetSources: [],
    showInTable: true,
    isSearchable: true,
    isSortable: true,
    enumOptions: [],
  };
}

function value(
  overrides: Partial<CustomFieldValueDetail>
): CustomFieldValueDetail {
  return {
    id: "value-1",
    customFieldId: FIELD.id,
    entityId: "artifact-123",
    name: FIELD.name,
    fieldType: FIELD.fieldType,
    displayValue: null,
    showInTable: true,
    textValue: null,
    numberValue: null,
    dateValue: null,
    enumValue: null,
    multiEnumValues: [],
    peopleValues: [],
    referenceValues: [],
    ...overrides,
  };
}
