/**
 * Component tests for CustomFieldValueEditor.
 *
 * Covers: renders the correct sub-editor for each field type,
 * blur-to-save calls mutation for TextFieldEditor.
 */

import type {
  CustomFieldEnumOption,
  CustomFieldSettingWithOptions,
  CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import { INLINE_SCALAR_NUMBER_INVALID_MESSAGE } from "@repo/app/shared/lib/inline-scalar-invalid-message";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomFieldValueEditor } from "../custom-field-value-editor";

// Mock useUpdateCustomFieldValue

const mockMutate = vi.fn();

const NO_PEOPLE_ASSIGNED_RE = /No people assigned/i;
const REMOVE_ARCHIVED_RE = /Remove Archived/i;
const REMOVE_UNKNOWN_RE = /Remove unknown option/i;

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

// Fixtures

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
      referenceTargetSources: [],
      showInTable: false,
      isSearchable: false,
      isSortable: false,
      enumOptions: [],
      ...extra,
    },
  };
}

// Tests

describe("CustomFieldValueEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Renders correct sub-editor per field type

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

    it("renders the date picker empty for an Invalid Date value instead of throwing (ISS-8884)", () => {
      render(
        <CustomFieldValueEditor
          {...BASE_ENTITY}
          setting={makeSetting(CustomFieldType.Date)}
          value={
            {
              id: "v-date",
              customFieldId: "field-1",
              entityId: "proj-1",
              name: "Due",
              fieldType: CustomFieldType.Date,
              displayValue: null,
              showInTable: false,
              textValue: null,
              numberValue: null,
              // The revived shape of an ISO-looking junk string.
              dateValue: new Date("2026-99-99T00:00:00.000Z"),
              enumValue: null,
              multiEnumValues: [],
              peopleValues: [],
              referenceValues: [],
            } satisfies CustomFieldValueDetail
          }
        />
      );
      expect(screen.getByTestId("date-picker")).toHaveAttribute(
        "data-value",
        ""
      );
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
              referenceValues: [],
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

    it("calls mutation when an enum option is selected", () => {
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
      const { container } = render(
        <CustomFieldValueEditor {...BASE_ENTITY} setting={setting} />
      );

      const trigger = container.querySelector('[role="combobox"]');
      expect(trigger).toBeTruthy();
      fireEvent.click(trigger!);
      const option = screen.getByText("High");
      fireEvent.click(option);

      expect(mockMutate).toHaveBeenCalledWith(
        { fieldId: "field-1", value: "opt-1" },
        expect.anything()
      );
    });

    it("calls mutation with null when None is selected for enum", () => {
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
      render(
        <CustomFieldValueEditor
          {...BASE_ENTITY}
          setting={setting}
          value={
            {
              id: "v1",
              customFieldId: "field-1",
              entityId: "proj-1",
              name: "Priority",
              fieldType: CustomFieldType.Enum,
              displayValue: "High",
              showInTable: false,
              textValue: null,
              numberValue: null,
              dateValue: null,
              enumValue: {
                id: "opt-1",
                customFieldId: "field-1",
                name: "High",
                color: "#ff0000",
                enabled: true,
                sortOrder: 0,
              },
              multiEnumValues: [],
              peopleValues: [],
              referenceValues: [],
            } satisfies CustomFieldValueDetail
          }
        />
      );

      const trigger = screen.getByRole("combobox");
      fireEvent.click(trigger);
      const noneOption = screen.getByText("None");
      fireEvent.click(noneOption);

      expect(mockMutate).toHaveBeenCalledWith(
        { fieldId: "field-1", value: null },
        expect.anything()
      );
    });

    it("renders a multi-select trigger button for MULTI_ENUM field type", () => {
      const setting = makeSetting(CustomFieldType.MultiEnum);
      render(<CustomFieldValueEditor {...BASE_ENTITY} setting={setting} />);
      expect(screen.getByText("Select options...")).toBeTruthy();
    });
  });

  // Blur-to-save for TextFieldEditor

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
              referenceValues: [],
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
              referenceValues: [],
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

    it("restores text and exits without writing when Escape cancels", () => {
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
              referenceValues: [],
            } satisfies CustomFieldValueDetail
          }
        />
      );

      const input = screen.getByRole("textbox", { name: "Title" });
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "discarded" } });
      fireEvent.keyDown(input, { key: "Escape" });

      expect(input).toHaveValue("initial");
      expect(input).not.toHaveFocus();
      expect(mockMutate).not.toHaveBeenCalled();
    });
  });

  // NumberFieldEditor blur-to-save

  describe("NumberFieldEditor blur-to-save", () => {
    function mountNumberEditor(
      extra: Partial<CustomFieldSettingWithOptions["customField"]> = {},
      entityId: string = BASE_ENTITY.entityId
    ) {
      render(
        <CustomFieldValueEditor
          {...BASE_ENTITY}
          entityId={entityId}
          setting={makeSetting(CustomFieldType.Number, {
            name: "Score",
            numberFormat: NumberFormat.None,
            ...extra,
          })}
        />
      );
    }

    function renderNumberEditor(
      extra: Partial<CustomFieldSettingWithOptions["customField"]> = {}
    ) {
      mountNumberEditor(extra);
      return screen.getByRole("textbox", { name: "Score" });
    }

    function typeAndBlur(input: HTMLElement, raw: string) {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: raw } });
      fireEvent.blur(input);
    }

    it("calls mutation with parsed float on blur", () => {
      const input = renderNumberEditor();
      typeAndBlur(input, "42.5");

      expect(mockMutate).toHaveBeenCalledWith({
        fieldId: "field-1",
        value: 42.5,
      });
    });

    it("calls mutation with null on blur when input is empty", () => {
      const input = renderNumberEditor();
      fireEvent.focus(input);
      fireEvent.blur(input);

      expect(mockMutate).toHaveBeenCalledWith({
        fieldId: "field-1",
        value: null,
      });
    });

    it("treats whitespace-only input as a clear, never as zero", () => {
      const input = renderNumberEditor();
      typeAndBlur(input, "   ");

      expect(mockMutate).toHaveBeenCalledTimes(1);
      expect(mockMutate).toHaveBeenCalledWith({
        fieldId: "field-1",
        value: null,
      });
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it.each([
      ["1.5", 1.5],
      ["0", 0],
      ["-3", -3],
      // Number() accepts radix syntax; the grid cell and the server validator
      // already accept it through the same helper, so the editor matches them.
      ["0x10", 16],
    ])("persists %s as %s", (raw, expected) => {
      const input = renderNumberEditor();
      typeAndBlur(input, raw);

      expect(mockMutate).toHaveBeenCalledTimes(1);
      expect(mockMutate).toHaveBeenCalledWith({
        fieldId: "field-1",
        value: expected,
      });
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it.each(["1e999", "-1e999", "12abc", "1,234", "+", ".", "Infinity"])(
      "rejects %s without writing and keeps the typed text on screen",
      (raw) => {
        const input = renderNumberEditor();
        typeAndBlur(input, raw);

        expect(mockMutate).not.toHaveBeenCalled();
        const alert = screen.getByRole("alert");
        expect(alert).toHaveTextContent(INLINE_SCALAR_NUMBER_INVALID_MESSAGE);
        expect(alert.id).not.toBe("");
        expect(input).toHaveAttribute("aria-invalid", "true");
        expect(input).toHaveAttribute("aria-describedby", alert.id);
        expect(input).toHaveValue(raw);
      }
    );

    it("clears the error once the user types again", () => {
      const input = renderNumberEditor();
      typeAndBlur(input, "1e999");
      expect(screen.getByRole("alert")).toBeVisible();

      fireEvent.change(input, { target: { value: "1e9" } });

      expect(screen.queryByRole("alert")).toBeNull();
      expect(input).toHaveAttribute("aria-invalid", "false");
      expect(input).not.toHaveAttribute("aria-describedby");
    });

    it("gives two editors of the same field distinct alert ids", () => {
      mountNumberEditor({}, "proj-1");
      mountNumberEditor({}, "proj-2");
      const inputs = screen.getAllByRole("textbox", { name: "Score" });
      expect(inputs).toHaveLength(2);
      for (const input of inputs) {
        typeAndBlur(input, "1e999");
      }

      const alerts = screen.getAllByRole("alert");
      expect(alerts).toHaveLength(2);
      expect(alerts[0].id).not.toBe(alerts[1].id);
      expect(inputs[0]).toHaveAttribute("aria-describedby", alerts[0].id);
      expect(inputs[1]).toHaveAttribute("aria-describedby", alerts[1].id);
    });

    it("renders the error row beneath a currency prefix", () => {
      const input = renderNumberEditor({ numberFormat: NumberFormat.Currency });
      typeAndBlur(input, "12abc");

      expect(screen.getByText("$")).toBeVisible();
      expect(screen.getByRole("alert")).toHaveTextContent(
        INLINE_SCALAR_NUMBER_INVALID_MESSAGE
      );
      expect(mockMutate).not.toHaveBeenCalled();
    });

    it("renders the error row beneath a percentage suffix", () => {
      const input = renderNumberEditor({
        numberFormat: NumberFormat.Percentage,
      });
      typeAndBlur(input, "1e999");

      expect(screen.getByText("%")).toBeVisible();
      expect(screen.getByRole("alert")).toHaveTextContent(
        INLINE_SCALAR_NUMBER_INVALID_MESSAGE
      );
      expect(mockMutate).not.toHaveBeenCalled();
    });
  });

  // MultiEnumFieldEditor — disabled-but-selected "ghost" values (FEA-3269)

  describe("MultiEnumFieldEditor ghost selections", () => {
    const OPT_ACTIVE: CustomFieldEnumOption = {
      id: "opt-active",
      customFieldId: "field-1",
      name: "Active",
      color: "#00ff00",
      enabled: true,
      sortOrder: 0,
    };
    const OPT_DISABLED: CustomFieldEnumOption = {
      id: "opt-disabled",
      customFieldId: "field-1",
      name: "Archived",
      color: "#888888",
      enabled: false,
      sortOrder: 1,
    };

    function renderWithSelected(selected: CustomFieldEnumOption[]) {
      render(
        <CustomFieldValueEditor
          {...BASE_ENTITY}
          setting={makeSetting(CustomFieldType.MultiEnum, {
            name: "Tags",
            enumOptions: [OPT_ACTIVE, OPT_DISABLED],
          })}
          value={
            {
              id: "v1",
              customFieldId: "field-1",
              entityId: "proj-1",
              name: "Tags",
              fieldType: CustomFieldType.MultiEnum,
              displayValue: null,
              showInTable: false,
              textValue: null,
              numberValue: null,
              dateValue: null,
              enumValue: null,
              multiEnumValues: selected,
              peopleValues: [],
              referenceValues: [],
            } satisfies CustomFieldValueDetail
          }
        />
      );
    }

    it("renders a pill for a selected option whose option is now disabled", () => {
      renderWithSelected([OPT_ACTIVE, OPT_DISABLED]);
      // Both pills render even though "Archived" is disabled, and the count
      // matches the number of pills (no invisible ghost).
      expect(screen.getByText("Active")).toBeTruthy();
      expect(screen.getByText("Archived")).toBeTruthy();
      expect(screen.getByText("2 selected")).toBeTruthy();
    });

    it("removes a disabled-but-selected option via its pill", () => {
      renderWithSelected([OPT_ACTIVE, OPT_DISABLED]);
      const removeButton = screen.getByRole("button", {
        name: REMOVE_ARCHIVED_RE,
      });
      fireEvent.click(removeButton);
      expect(mockMutate).toHaveBeenCalledWith({
        fieldId: "field-1",
        value: ["opt-active"],
      });
    });

    it("renders a removable pill for an id that resolves to no option", () => {
      // Simulate an id left in the stored value after its option was
      // hard-deleted from the field (multiEnumValueIds has no FK cascade).
      const orphan: CustomFieldEnumOption = {
        id: "opt-deleted",
        customFieldId: "field-1",
        name: "Gone",
        color: "none",
        enabled: true,
        sortOrder: 9,
      };
      renderWithSelected([OPT_ACTIVE, orphan]);
      // The orphan renders as an "Unknown option" pill, and the count matches
      // the pills shown (no invisible ghost).
      expect(screen.getByText("Active")).toBeTruthy();
      expect(screen.getByText("Unknown option")).toBeTruthy();
      expect(screen.getByText("2 selected")).toBeTruthy();
    });

    it("removes an orphaned id via its Unknown option pill", () => {
      const orphan: CustomFieldEnumOption = {
        id: "opt-deleted",
        customFieldId: "field-1",
        name: "Gone",
        color: "none",
        enabled: true,
        sortOrder: 9,
      };
      renderWithSelected([OPT_ACTIVE, orphan]);
      const removeButton = screen.getByRole("button", {
        name: REMOVE_UNKNOWN_RE,
      });
      fireEvent.click(removeButton);
      expect(mockMutate).toHaveBeenCalledWith({
        fieldId: "field-1",
        value: ["opt-active"],
      });
    });
  });

  // Field label rendered from customField.name

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
