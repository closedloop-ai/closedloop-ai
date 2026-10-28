/**
 * Branch coverage for CreateCustomFieldDialog (ISS-10515): create vs edit
 * titles and submit labels, pending state, name validation, the number/enum
 * sub-sections, the create/update payload builders per number format, the
 * reset-on-reopen path, and the entity-type uncheck path.
 */

import type {
  CustomFieldEnumOption,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  LabelPosition,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIELD_TYPE_LABELS } from "../constants";
import { CreateCustomFieldDialog } from "../create-custom-field-dialog";

const mockCreateMutate = vi.fn();
const mockUpdateMutate = vi.fn();
const mockCreateOptionMutate = vi.fn();
let createPending = false;
let updatePending = false;
let serverEnumOptions: CustomFieldEnumOption[] = [];

vi.mock("@repo/app/custom-fields/hooks/use-custom-fields", () => ({
  useCreateCustomField: () => ({
    mutate: mockCreateMutate,
    isPending: createPending,
  }),
  useUpdateCustomField: () => ({
    mutate: mockUpdateMutate,
    isPending: updatePending,
  }),
  useCustomFieldEnumOptions: () => ({ data: serverEnumOptions }),
  useCreateEnumOption: () => ({
    mutate: mockCreateOptionMutate,
    isPending: false,
  }),
  useUpdateEnumOption: () => ({ mutate: vi.fn(), isPending: false }),
  useReorderEnumOptions: () => ({ mutate: vi.fn(), isPending: false }),
}));

const NAME_PLACEHOLDER_RE = /e\.g\. Priority/i;
const DESCRIPTION_PLACEHOLDER_RE = /Optional description/i;
const CREATE_FIELD_RE = /^Create field$/;
const SAVE_CHANGES_RE = /^Save changes$/;
const CREATING_RE = /^Creating\.\.\.$/;
const SAVING_RE = /^Saving\.\.\.$/;
const CANCEL_RE = /^Cancel$/;
const NAME_REQUIRED_RE = /Name is required/;
const PROJECTS_RE = /^Projects$/;
const DOCUMENTS_RE = /^Documents$/;
const SEARCHABLE_RE = /^Searchable$/;
const SORTABLE_RE = /^Sortable$/;
const CURRENCY_RE = /^Currency$/;
const CUSTOM_RE = /^Custom$/;
const NUMBER_FORMAT_LEGEND_RE = /Number format/;
const OPTIONS_LABEL_RE = /^Options$/;
const ADD_OPTION_RE = /Add option/i;
const CURRENCY_CODE_RE = /Currency code/i;
const CUSTOM_LABEL_RE = /Custom label/i;

beforeEach(() => {
  createPending = false;
  updatePending = false;
  serverEnumOptions = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("CreateCustomFieldDialog titles and submit labels", () => {
  it("labels create mode and closes through Cancel", () => {
    const onOpenChange = vi.fn();
    render(<CreateCustomFieldDialog onOpenChange={onOpenChange} open={true} />);

    expect(screen.getByText("Create custom field")).toBeTruthy();
    const submit = screen.getByRole("button", { name: CREATE_FIELD_RE });
    expect(submit).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: CANCEL_RE }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("labels edit mode and disables the type select", () => {
    render(
      <CreateCustomFieldDialog
        field={buildField()}
        onOpenChange={vi.fn()}
        open={true}
      />
    );

    expect(screen.getByText("Edit custom field")).toBeTruthy();
    expect(screen.getByRole("button", { name: SAVE_CHANGES_RE })).toBeTruthy();
    expect(screen.getByRole("combobox")).toBeDisabled();
  });

  it("shows Creating... and disables submit while a create is pending", () => {
    createPending = true;
    render(<CreateCustomFieldDialog onOpenChange={vi.fn()} open={true} />);

    expect(screen.getByRole("button", { name: CREATING_RE })).toBeDisabled();
  });

  it("shows Saving... and disables submit while an update is pending", () => {
    updatePending = true;
    render(
      <CreateCustomFieldDialog
        field={buildField()}
        onOpenChange={vi.fn()}
        open={true}
      />
    );

    expect(screen.getByRole("button", { name: SAVING_RE })).toBeDisabled();
  });
});

describe("CreateCustomFieldDialog create submit", () => {
  it("refuses an empty name and never calls the mutation", async () => {
    render(<CreateCustomFieldDialog onOpenChange={vi.fn()} open={true} />);

    fireEvent.click(screen.getByRole("button", { name: CREATE_FIELD_RE }));

    expect(await screen.findByText(NAME_REQUIRED_RE)).toBeTruthy();
    expect(mockCreateMutate).not.toHaveBeenCalled();
  });

  it("submits a text field with a description and no number or enum settings, closing on success", async () => {
    const onOpenChange = vi.fn();
    render(<CreateCustomFieldDialog onOpenChange={onOpenChange} open={true} />);

    typeName("Notes");
    fireEvent.change(screen.getByPlaceholderText(DESCRIPTION_PLACEHOLDER_RE), {
      target: { value: "Free text" },
    });
    // Number and enum sections stay unmounted for a text field.
    expect(screen.queryByText(NUMBER_FORMAT_LEGEND_RE)).toBeNull();
    expect(screen.queryByText(OPTIONS_LABEL_RE)).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: SEARCHABLE_RE }));
    fireEvent.click(screen.getByRole("switch", { name: SORTABLE_RE }));
    fireEvent.click(screen.getByRole("button", { name: CREATE_FIELD_RE }));

    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalledTimes(1));
    const [payload, options] = mockCreateMutate.mock.calls[0];
    expect(payload).toEqual({
      name: "Notes",
      description: "Free text",
      fieldType: CustomFieldType.Text,
      numberFormat: undefined,
      precision: undefined,
      currencyCode: undefined,
      customLabel: undefined,
      customLabelPosition: undefined,
      enumOptions: undefined,
      entityTypes: [],
      showInTable: false,
      isSearchable: true,
      isSortable: true,
    });

    expect(onOpenChange).not.toHaveBeenCalled();
    options.onSuccess();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("sends currency code only for a currency-formatted number", async () => {
    render(<CreateCustomFieldDialog onOpenChange={vi.fn()} open={true} />);

    typeName("Budget");
    pickFieldType(CustomFieldType.Number);
    fireEvent.click(screen.getByRole("radio", { name: CURRENCY_RE }));
    fireEvent.change(screen.getByLabelText(CURRENCY_CODE_RE), {
      target: { value: "EUR" },
    });
    fireEvent.click(screen.getByRole("button", { name: CREATE_FIELD_RE }));

    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalledTimes(1));
    const payload = mockCreateMutate.mock.calls[0][0];
    expect(payload.description).toBeUndefined();
    expect(payload.fieldType).toBe(CustomFieldType.Number);
    expect(payload.numberFormat).toBe(NumberFormat.Currency);
    expect(payload.precision).toBe(0);
    expect(payload.currencyCode).toBe("EUR");
    expect(payload.customLabel).toBeUndefined();
    expect(payload.customLabelPosition).toBeUndefined();
    expect(payload.enumOptions).toBeUndefined();
  });

  it("sends label and position only for a custom-formatted number", async () => {
    render(<CreateCustomFieldDialog onOpenChange={vi.fn()} open={true} />);

    typeName("Effort");
    pickFieldType(CustomFieldType.Number);
    fireEvent.click(screen.getByRole("radio", { name: CUSTOM_RE }));
    fireEvent.change(screen.getByLabelText(CUSTOM_LABEL_RE), {
      target: { value: "pts" },
    });
    fireEvent.click(screen.getByRole("button", { name: CREATE_FIELD_RE }));

    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalledTimes(1));
    const payload = mockCreateMutate.mock.calls[0][0];
    expect(payload.numberFormat).toBe(NumberFormat.Custom);
    expect(payload.currencyCode).toBeUndefined();
    expect(payload.customLabel).toBe("pts");
    expect(payload.customLabelPosition).toBe(LabelPosition.Prefix);
  });

  it.each([CustomFieldType.Enum, CustomFieldType.MultiEnum])(
    "sends the locally built options for a %s field",
    async (fieldType) => {
      render(<CreateCustomFieldDialog onOpenChange={vi.fn()} open={true} />);

      typeName("Stage");
      pickFieldType(fieldType);
      expect(screen.getByText(OPTIONS_LABEL_RE)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: ADD_OPTION_RE }));
      fireEvent.click(screen.getByRole("button", { name: CREATE_FIELD_RE }));

      await waitFor(() => expect(mockCreateMutate).toHaveBeenCalledTimes(1));
      const payload = mockCreateMutate.mock.calls[0][0];
      expect(payload.fieldType).toBe(fieldType);
      expect(payload.numberFormat).toBeUndefined();
      expect(payload.enumOptions).toEqual([
        {
          name: "New Option",
          color: undefined,
          enabled: true,
          sortOrder: undefined,
        },
      ]);
      // No API-backed option write in create mode.
      expect(mockCreateOptionMutate).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["currency", CURRENCY_RE, "currencyCode" as const],
    ["custom label", CUSTOM_RE, "customLabel" as const],
  ])(
    "submits an untouched %s as an empty string",
    async (_label, radio, key) => {
      render(<CreateCustomFieldDialog onOpenChange={vi.fn()} open={true} />);

      typeName("Budget");
      pickFieldType(CustomFieldType.Number);
      fireEvent.click(screen.getByRole("radio", { name: radio }));
      fireEvent.click(screen.getByRole("button", { name: CREATE_FIELD_RE }));

      await waitFor(() => expect(mockCreateMutate).toHaveBeenCalledTimes(1));
      expect(mockCreateMutate.mock.calls[0][0][key]).toBe("");
    }
  );

  it("removes an entity type when its checkbox is unchecked", async () => {
    render(<CreateCustomFieldDialog onOpenChange={vi.fn()} open={true} />);

    typeName("Owner");
    const projects = screen.getByRole("checkbox", { name: PROJECTS_RE });
    const documents = screen.getByRole("checkbox", { name: DOCUMENTS_RE });
    fireEvent.click(projects);
    fireEvent.click(documents);
    fireEvent.click(projects);
    expect(projects.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: CREATE_FIELD_RE }));

    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalledTimes(1));
    expect(mockCreateMutate.mock.calls[0][0].entityTypes).toEqual([
      CustomFieldEntityType.Document,
    ]);
  });

  it("resets typed values when the dialog is closed and reopened", () => {
    const { rerender } = render(
      <CreateCustomFieldDialog onOpenChange={vi.fn()} open={true} />
    );
    typeName("Draft name");
    expect(screen.getByPlaceholderText(NAME_PLACEHOLDER_RE)).toHaveValue(
      "Draft name"
    );

    rerender(<CreateCustomFieldDialog onOpenChange={vi.fn()} open={false} />);
    rerender(<CreateCustomFieldDialog onOpenChange={vi.fn()} open={true} />);

    expect(screen.getByPlaceholderText(NAME_PLACEHOLDER_RE)).toHaveValue("");
  });
});

describe("CreateCustomFieldDialog edit submit", () => {
  it("prefills a currency number field and sends an update keyed by id", async () => {
    const onOpenChange = vi.fn();
    render(
      <CreateCustomFieldDialog
        field={buildField({
          name: "Budget",
          description: "Planned spend",
          fieldType: CustomFieldType.Number,
          numberFormat: NumberFormat.Currency,
          precision: 2,
          currencyCode: "USD",
          entityTypes: [
            CustomFieldEntityType.Project,
            CustomFieldEntityType.Document,
          ],
          showInTable: true,
        })}
        onOpenChange={onOpenChange}
        open={true}
      />
    );

    expect(screen.getByPlaceholderText(NAME_PLACEHOLDER_RE)).toHaveValue(
      "Budget"
    );
    expect(screen.getByLabelText(CURRENCY_CODE_RE)).toHaveValue("USD");
    fireEvent.click(screen.getByRole("checkbox", { name: DOCUMENTS_RE }));
    fireEvent.click(screen.getByRole("button", { name: SAVE_CHANGES_RE }));

    await waitFor(() => expect(mockUpdateMutate).toHaveBeenCalledTimes(1));
    const [payload, options] = mockUpdateMutate.mock.calls[0];
    expect(payload).toEqual({
      id: "field-1",
      name: "Budget",
      description: "Planned spend",
      numberFormat: NumberFormat.Currency,
      precision: 2,
      currencyCode: "USD",
      customLabel: undefined,
      customLabelPosition: undefined,
      entityTypes: [CustomFieldEntityType.Project],
      showInTable: true,
      isSearchable: false,
      isSortable: false,
    });
    expect(mockCreateMutate).not.toHaveBeenCalled();

    options.onSuccess();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("prefills a custom-label number field with a suffix position", async () => {
    render(
      <CreateCustomFieldDialog
        field={buildField({
          fieldType: CustomFieldType.Number,
          numberFormat: NumberFormat.Custom,
          customLabel: "hrs",
          customLabelPosition: LabelPosition.Suffix,
        })}
        onOpenChange={vi.fn()}
        open={true}
      />
    );

    expect(screen.getByLabelText(CUSTOM_LABEL_RE)).toHaveValue("hrs");
    fireEvent.click(screen.getByRole("button", { name: SAVE_CHANGES_RE }));

    await waitFor(() => expect(mockUpdateMutate).toHaveBeenCalledTimes(1));
    const payload = mockUpdateMutate.mock.calls[0][0];
    expect(payload.numberFormat).toBe(NumberFormat.Custom);
    expect(payload.currencyCode).toBeUndefined();
    expect(payload.customLabel).toBe("hrs");
    expect(payload.customLabelPosition).toBe(LabelPosition.Suffix);
  });

  it("fills null number settings with defaults and omits them for a text field", async () => {
    render(
      <CreateCustomFieldDialog
        field={buildField()}
        onOpenChange={vi.fn()}
        open={true}
      />
    );

    expect(screen.getByPlaceholderText(DESCRIPTION_PLACEHOLDER_RE)).toHaveValue(
      ""
    );
    fireEvent.click(screen.getByRole("button", { name: SAVE_CHANGES_RE }));

    await waitFor(() => expect(mockUpdateMutate).toHaveBeenCalledTimes(1));
    const payload = mockUpdateMutate.mock.calls[0][0];
    expect(payload.description).toBeUndefined();
    expect(payload.numberFormat).toBeUndefined();
    expect(payload.precision).toBeUndefined();
    expect(payload.currencyCode).toBeUndefined();
    expect(payload).not.toHaveProperty("enumOptions");
    expect(payload).not.toHaveProperty("fieldType");
  });

  it("keeps a true display flag and an empty label when the stored label is null", async () => {
    render(
      <CreateCustomFieldDialog
        field={buildField({
          fieldType: CustomFieldType.Number,
          numberFormat: NumberFormat.Currency,
          isSearchable: true,
          isSortable: true,
        })}
        onOpenChange={vi.fn()}
        open={true}
      />
    );

    expect(screen.getByLabelText(CURRENCY_CODE_RE)).toHaveValue("");
    expect(screen.getByRole("switch", { name: SEARCHABLE_RE })).toBeChecked();
    expect(screen.getByRole("switch", { name: SORTABLE_RE })).toBeChecked();

    fireEvent.click(screen.getByRole("radio", { name: CUSTOM_RE }));
    expect(screen.getByLabelText(CUSTOM_LABEL_RE)).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: SAVE_CHANGES_RE }));

    await waitFor(() => expect(mockUpdateMutate).toHaveBeenCalledTimes(1));
    const payload = mockUpdateMutate.mock.calls[0][0];
    expect(payload.isSearchable).toBe(true);
    expect(payload.isSortable).toBe(true);
    expect(payload.customLabel).toBe("");
  });

  it("returns to an empty create form when the edited field is dropped", () => {
    const { rerender } = render(
      <CreateCustomFieldDialog
        field={buildField({
          name: "Budget",
          fieldType: CustomFieldType.Number,
          numberFormat: NumberFormat.Currency,
        })}
        onOpenChange={vi.fn()}
        open={true}
      />
    );
    expect(screen.getByText(NUMBER_FORMAT_LEGEND_RE)).toBeTruthy();

    rerender(<CreateCustomFieldDialog onOpenChange={vi.fn()} open={true} />);

    expect(screen.getByText("Create custom field")).toBeTruthy();
    expect(screen.getByPlaceholderText(NAME_PLACEHOLDER_RE)).toHaveValue("");
    expect(screen.queryByText(NUMBER_FORMAT_LEGEND_RE)).toBeNull();
  });

  it("mounts the API-backed option builder for an existing enum field", () => {
    serverEnumOptions = [
      {
        id: "opt-1",
        customFieldId: "field-1",
        name: "Ready",
        color: "none",
        enabled: true,
        sortOrder: 0,
      },
    ];
    render(
      <CreateCustomFieldDialog
        field={buildField({ fieldType: CustomFieldType.Enum })}
        onOpenChange={vi.fn()}
        open={true}
      />
    );

    expect(screen.getByText("Ready")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: ADD_OPTION_RE }));
    expect(mockCreateOptionMutate).toHaveBeenCalledWith({
      name: "New Option",
      enabled: true,
      sortOrder: 1,
    });
  });
});

function typeName(name: string) {
  fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER_RE), {
    target: { value: name },
  });
}

function pickFieldType(fieldType: CustomFieldType) {
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(
    screen.getByRole("option", { name: FIELD_TYPE_LABELS[fieldType] })
  );
}

function buildField(
  overrides: Partial<CustomFieldWithOptions> = {}
): CustomFieldWithOptions {
  return {
    id: "field-1",
    organizationId: "org-1",
    name: "Existing",
    description: null,
    fieldType: CustomFieldType.Text,
    createdById: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    precision: null,
    numberFormat: null,
    currencyCode: null,
    customLabel: null,
    customLabelPosition: null,
    isGlobalToOrg: false,
    entityTypes: [],
    referenceTargetSources: [],
    showInTable: false,
    isSearchable: false,
    isSortable: false,
    enumOptions: [],
    ...overrides,
  };
}
