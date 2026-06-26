/**
 * Component tests for CustomFieldValueEditor.
 *
 * Covers: renders the correct sub-editor for each field type,
 * blur-to-save calls mutation for TextFieldEditor,
 * and enum selector calls mutation on change.
 */

import type {
  CustomFieldSettingWithOptions,
  CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomFieldValueEditor } from "../custom-field-value-editor";

// ---------------------------------------------------------------------------
// Mock useUpdateCustomFieldValue
// ---------------------------------------------------------------------------

const mockMutate = vi.fn();

const NO_PEOPLE_ASSIGNED_RE = /No people assigned/i;

vi.mock("@repo/app/custom-fields/hooks/use-custom-fields", () => ({
  useUpdateCustomFieldValue: () => ({
    mutate: mockMutate,
    isPending: false,
    isError: false,
    isSuccess: false,
    isIdle: true,
    error: null,
    data: undefined,
    reset: vi.fn(),
    status: "idle",
  }),
}));

// DatePickerPopover uses a Radix popover which requires DOM interactions that
// don't work well in jsdom. Mock it as a simple button so date field type is
// testable without popover infrastructure.
vi.mock("@repo/design-system/components/ui/date-picker-popover", () => ({
  DatePickerPopover: ({
    onSelect,
    value,
    placeholder,
  }: {
    onSelect: (d: Date | null) => void;
    value: Date | null;
    placeholder?: string;
  }) => (
    <button
      data-testid="date-picker"
      data-value={value?.toISOString() ?? ""}
      onClick={() => onSelect(new Date("2025-03-15"))}
      type="button"
    >
      {placeholder ?? "Select date..."}
    </button>
  ),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_ENTITY = {
  entityType: CustomFieldEntityType.Project,
  entityId: "proj-1",
} as const;

function makeSetting(
  fieldType: (typeof CustomFieldType)[keyof typeof CustomFieldType],
  extra: Partial<CustomFieldSettingWithOptions["customField"]> = {}
): CustomFieldSettingWithOptions {
  return {
    id: "setting-1",
    customFieldId: "field-1",
    entityType: CustomFieldEntityType.Project,
    entityId: "proj-1",
    isImportant: false,
    isRequired: false,
    sortOrder: 0,
    createdAt: new Date(),
    customField: {
      id: "field-1",
      organizationId: "org-1",
      name: "Test Field",
      description: null,
      fieldType,
      createdById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      precision: null,
      numberFormat: null,
      currencyCode: null,
      customLabel: null,
      customLabelPosition: null,
      isGlobalToOrg: false,
      entityTypes: [CustomFieldEntityType.Project],
      showInTable: false,
      isSearchable: false,
      isSortable: false,
      enumOptions: [],
      ...extra,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CustomFieldValueEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Renders correct sub-editor per field type
  // -------------------------------------------------------------------------

  describe("renders correct editor for each field type", () => {
    it("renders a text input for TEXT field type", () => {
      render(
        <CustomFieldValueEditor
          {...BASE_ENTITY}
          setting={makeSetting(CustomFieldType.Text, { name: "Description" })}
        />
      );
      const input = screen.getByRole("textbox", { name: "Description" });
      expect(input).toBeTruthy();
    });

    it("renders a text input for NUMBER field type", () => {
      render(
        <CustomFieldValueEditor
          {...BASE_ENTITY}
          setting={makeSetting(CustomFieldType.Number, { name: "Score" })}
        />
      );
      const input = screen.getByRole("textbox", { name: "Score" });
      expect(input).toBeTruthy();
    });

    it("renders the date picker for DATE field type", () => {
      render(
        <CustomFieldValueEditor
          {...BASE_ENTITY}
          setting={makeSetting(CustomFieldType.Date)}
        />
      );
      expect(screen.getByTestId("date-picker")).toBeTruthy();
    });

    it("renders a 'No people assigned' message for empty PEOPLE field", () => {
      render(
        <CustomFieldValueEditor
          {...BASE_ENTITY}
          setting={makeSetting(CustomFieldType.People)}
          value={
            {
              id: "v1",
              customFieldId: "field-1",
              entityId: "proj-1",
              name: "People",
              fieldType: CustomFieldType.People,
              displayValue: null,
              showInTable: false,
              textValue: null,
              numberValue: null,
              dateValue: null,
              enumValue: null,
              multiEnumValues: [],
              peopleValues: [],
            } satisfies CustomFieldValueDetail
          }
        />
      );
      expect(screen.getByText(NO_PEOPLE_ASSIGNED_RE)).toBeTruthy();
    });

    it("renders enum select trigger for ENUM field type", () => {
      const setting = makeSetting(CustomFieldType.Enum, {
        enumOptions: [
          {
            id: "opt-1",
            customFieldId: "field-1",
            name: "High",
            color: "#ff0000",
            enabled: true,
            sortOrder: 0,
          },
        ],
      });
      render(<CustomFieldValueEditor {...BASE_ENTITY} setting={setting} />);
      // The SelectTrigger renders a button with the placeholder text
      expect(screen.getByText("Select option...")).toBeTruthy();
    });

    it("renders a multi-select trigger button for MULTI_ENUM field type", () => {
      const setting = makeSetting(CustomFieldType.MultiEnum);
      render(<CustomFieldValueEditor {...BASE_ENTITY} setting={setting} />);
      expect(screen.getByText("Select options...")).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Blur-to-save for TextFieldEditor
  // -------------------------------------------------------------------------

  describe("TextFieldEditor blur-to-save", () => {
    it("calls mutation with trimmed text value on blur", () => {
      render(
        <CustomFieldValueEditor
          {...BASE_ENTITY}
          setting={makeSetting(CustomFieldType.Text, { name: "Title" })}
          value={
            {
              id: "v1",
              customFieldId: "field-1",
              entityId: "proj-1",
              name: "Title",
              fieldType: CustomFieldType.Text,
              displayValue: null,
              showInTable: false,
              textValue: "initial",
              numberValue: null,
              dateValue: null,
              enumValue: null,
              multiEnumValues: [],
              peopleValues: [],
            } satisfies CustomFieldValueDetail
          }
        />
      );

      const input = screen.getByRole("textbox", { name: "Title" });
      fireEvent.change(input, { target: { value: "  Updated text  " } });
      fireEvent.blur(input);

      expect(mockMutate).toHaveBeenCalledOnce();
      expect(mockMutate).toHaveBeenCalledWith({
        fieldId: "field-1",
        value: "Updated text",
      });
    });

    it("calls mutation with null when text is blank on blur", () => {
      render(
        <CustomFieldValueEditor
          {...BASE_ENTITY}
          setting={makeSetting(CustomFieldType.Text, { name: "Title" })}
          value={
            {
              id: "v1",
              customFieldId: "field-1",
              entityId: "proj-1",
              name: "Title",
              fieldType: CustomFieldType.Text,
              displayValue: null,
              showInTable: false,
              textValue: "has value",
              numberValue: null,
              dateValue: null,
              enumValue: null,
              multiEnumValues: [],
              peopleValues: [],
            } satisfies CustomFieldValueDetail
          }
        />
      );

      const input = screen.getByRole("textbox", { name: "Title" });
      fireEvent.change(input, { target: { value: "   " } });
      fireEvent.blur(input);

      expect(mockMutate).toHaveBeenCalledWith({
        fieldId: "field-1",
        value: null,
      });
    });
  });

  // -------------------------------------------------------------------------
  // NumberFieldEditor blur-to-save
  // -------------------------------------------------------------------------

  describe("NumberFieldEditor blur-to-save", () => {
    it("calls mutation with parsed float on blur", () => {
      render(
        <CustomFieldValueEditor
          {...BASE_ENTITY}
          setting={makeSetting(CustomFieldType.Number, {
            name: "Score",
            numberFormat: NumberFormat.None,
          })}
        />
      );

      const input = screen.getByRole("textbox", { name: "Score" });
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "42.5" } });
      fireEvent.blur(input);

      expect(mockMutate).toHaveBeenCalledWith({
        fieldId: "field-1",
        value: 42.5,
      });
    });

    it("calls mutation with null on blur when input is empty", () => {
      render(
        <CustomFieldValueEditor
          {...BASE_ENTITY}
          setting={makeSetting(CustomFieldType.Number, { name: "Score" })}
        />
      );

      const input = screen.getByRole("textbox", { name: "Score" });
      fireEvent.focus(input);
      fireEvent.blur(input);

      expect(mockMutate).toHaveBeenCalledWith({
        fieldId: "field-1",
        value: null,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Field label rendered from customField.name
  // -------------------------------------------------------------------------

  it("displays the field name as a label", () => {
    render(
      <CustomFieldValueEditor
        {...BASE_ENTITY}
        setting={makeSetting(CustomFieldType.Text, { name: "Priority" })}
      />
    );
    expect(screen.getByText("Priority")).toBeTruthy();
  });
});
