/**
 * Branch coverage for CustomFieldValueEditor (ISS-10515): server sync while
 * idle vs editing, the number display formatter per format, prefix/suffix
 * labels, enum values that resolve to no option, multi-enum toggling, the date
 * set/clear paths, and people removal.
 */

import type {
  CustomFieldEnumOption,
  CustomFieldSettingWithOptions,
  CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  LabelPosition,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import type { BasicUser } from "@repo/api/src/types/user";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagAdapterProvider } from "../../../shared/feature-flags/provider";
import { CustomFieldValueEditor } from "../custom-field-value-editor";

const mockMutate = vi.fn();

vi.mock("@repo/app/custom-fields/hooks/use-custom-fields", () => ({
  useUpdateCustomFieldValue: () => ({ mutate: mockMutate, isPending: false }),
}));

const PICKED_DATE_ISO = "2026-03-15T00:00:00.000Z";

// Radix's date popover needs layout jsdom lacks; the editor's own select/clear
// handling is what these cases drive.
vi.mock("@repo/design-system/components/ui/date-picker-popover", () => ({
  DatePickerPopover: ({
    onSelect,
    value,
  }: {
    onSelect: (d: Date | null) => void;
    value: Date | null;
  }) => (
    <div>
      <output data-testid="date-value">{value?.toISOString() ?? ""}</output>
      <button onClick={() => onSelect(new Date(PICKED_DATE_ISO))} type="button">
        Pick date
      </button>
      <button onClick={() => onSelect(null)} type="button">
        Clear date
      </button>
    </div>
  ),
}));

const SELECT_OPTIONS_RE = /Select options\.\.\./;
const ONE_SELECTED_RE = /^1 selected$/;
const REMOVE_ADA_RE = /Remove Ada Lovelace/;
const REMOVE_HIGH_RE = /Remove High/;
const REMOVE_UNKNOWN_RE = /Remove unknown option/;
const TWO_SELECTED_RE = /^2 selected$/;
const NO_OPTIONS_RE = /No options available/;
const NO_PEOPLE_RE = /No people assigned/;

const OPT_LOW: CustomFieldEnumOption = {
  id: "opt-low",
  customFieldId: "field-1",
  name: "Low",
  color: "#00ff00",
  enabled: true,
  sortOrder: 0,
};

const OPT_HIGH: CustomFieldEnumOption = {
  id: "opt-high",
  customFieldId: "field-1",
  name: "High",
  color: "#ff0000",
  enabled: true,
  sortOrder: 1,
};

const OPT_ARCHIVED: CustomFieldEnumOption = {
  id: "opt-archived",
  customFieldId: "field-1",
  name: "Archived",
  color: "#888888",
  enabled: false,
  sortOrder: 2,
};

const ADA: BasicUser = {
  id: "user-ada",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  avatarUrl: null,
};

const GRACE: BasicUser = {
  id: "user-grace",
  email: "grace@example.com",
  firstName: "Grace",
  lastName: "Hopper",
  avatarUrl: null,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("TextFieldEditor server sync", () => {
  it("adopts a new server value while idle but keeps typed text while focused", () => {
    const setting = makeSetting(CustomFieldType.Text);
    const { rerender } = render(
      editor(setting, makeValue(CustomFieldType.Text, { textValue: "one" }))
    );
    const input = screen.getByRole("textbox", { name: "Test Field" });

    rerender(
      editor(setting, makeValue(CustomFieldType.Text, { textValue: "two" }))
    );
    expect(input).toHaveValue("two");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "typing" } });
    rerender(
      editor(setting, makeValue(CustomFieldType.Text, { textValue: "three" }))
    );
    expect(input).toHaveValue("typing");
  });
});

describe("NumberFieldEditor display", () => {
  it.each([
    [
      "no format, default precision",
      { numberFormat: NumberFormat.None },
      1.5,
      "1.50",
    ],
    [
      "currency",
      { numberFormat: NumberFormat.Currency, precision: 0 },
      2,
      "$2",
    ],
    [
      "percentage",
      { numberFormat: NumberFormat.Percentage, precision: 1 },
      12.5,
      "12.5%",
    ],
    [
      "custom label with no position (prefix)",
      { numberFormat: NumberFormat.Custom, precision: 0, customLabel: "pts" },
      3,
      "pts 3",
    ],
    [
      "custom label as suffix",
      {
        numberFormat: NumberFormat.Custom,
        precision: 0,
        customLabel: "pts",
        customLabelPosition: LabelPosition.Suffix,
      },
      3,
      "3 pts",
    ],
    [
      "custom format with no label",
      { numberFormat: NumberFormat.Custom, precision: 0 },
      3,
      "3",
    ],
  ])(
    "formats %s when the server sent no display value",
    (_label, extra, numberValue, expected) => {
      render(
        editor(
          makeSetting(CustomFieldType.Number, extra),
          makeValue(CustomFieldType.Number, { numberValue })
        )
      );

      expect(screen.getByRole("textbox", { name: "Test Field" })).toHaveValue(
        expected
      );
    }
  );

  it.each([
    [
      "a prefix label",
      { customLabel: "pts", customLabelPosition: LabelPosition.Prefix },
      "pts 7",
    ],
    [
      "a suffix label",
      { customLabel: "hrs", customLabelPosition: LabelPosition.Suffix },
      "7 hrs",
    ],
  ])(
    "renders %s beside the input on only one side",
    (_label, extra, display) => {
      render(
        editor(
          makeSetting(CustomFieldType.Number, {
            numberFormat: NumberFormat.Custom,
            ...extra,
          }),
          makeValue(CustomFieldType.Number, {
            numberValue: 7,
            displayValue: display,
          })
        )
      );

      const input = screen.getByRole("textbox", { name: "Test Field" });
      const row = input.parentElement;
      const spans = Array.from(row?.querySelectorAll(":scope > span") ?? []);
      expect(spans.map((span) => span.textContent)).toEqual([
        extra.customLabel,
      ]);
      const labelFirst = extra.customLabelPosition === LabelPosition.Prefix;
      expect(row?.firstElementChild === spans[0]).toBe(labelFirst);
    }
  );

  it("shows the server display value idle and the raw number while focused", () => {
    render(
      editor(
        makeSetting(CustomFieldType.Number, {
          numberFormat: NumberFormat.Currency,
        }),
        makeValue(CustomFieldType.Number, {
          numberValue: 1234.5,
          displayValue: "$1,234.50",
        })
      )
    );
    const input = screen.getByRole("textbox", { name: "Test Field" });
    expect(input).toHaveValue("$1,234.50");

    fireEvent.focus(input);
    expect(input).toHaveValue("1234.5");
  });

  it("adopts a new server number while idle", () => {
    const setting = makeSetting(CustomFieldType.Number, {
      numberFormat: NumberFormat.None,
      precision: 0,
    });
    const { rerender } = render(
      editor(setting, makeValue(CustomFieldType.Number, { numberValue: 1 }))
    );
    rerender(
      editor(setting, makeValue(CustomFieldType.Number, { numberValue: 9 }))
    );
    const input = screen.getByRole("textbox", { name: "Test Field" });

    fireEvent.focus(input);
    expect(input).toHaveValue("9");
  });
});

describe("EnumFieldEditor", () => {
  it("shows the placeholder when the stored option no longer exists on the field", () => {
    render(
      editor(
        makeSetting(CustomFieldType.Enum, { enumOptions: [OPT_LOW] }),
        makeValue(CustomFieldType.Enum, { enumValue: OPT_HIGH })
      )
    );

    expect(screen.getByRole("combobox")).toHaveTextContent("Select option...");
  });
});

describe("MultiEnumFieldEditor", () => {
  it("adds and removes options through the popover checkboxes", async () => {
    render(
      editor(
        makeSetting(CustomFieldType.MultiEnum, {
          enumOptions: [OPT_LOW, OPT_HIGH],
        })
      )
    );

    await userEvent.click(
      screen.getByRole("button", { name: SELECT_OPTIONS_RE })
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "High" }));
    expect(mockMutate).toHaveBeenLastCalledWith({
      fieldId: "field-1",
      value: ["opt-high"],
    });

    await userEvent.click(screen.getByRole("checkbox", { name: "High" }));
    expect(mockMutate).toHaveBeenLastCalledWith({
      fieldId: "field-1",
      value: [],
    });
  });

  it("does not overwrite the in-progress selection with a server update while open", async () => {
    const setting = makeSetting(CustomFieldType.MultiEnum, {
      enumOptions: [OPT_LOW, OPT_HIGH],
    });
    const { rerender } = render(
      editor(
        setting,
        makeValue(CustomFieldType.MultiEnum, { multiEnumValues: [OPT_LOW] })
      )
    );

    await userEvent.click(
      screen.getByRole("button", { name: ONE_SELECTED_RE })
    );
    rerender(
      editor(
        setting,
        makeValue(CustomFieldType.MultiEnum, {
          multiEnumValues: [OPT_LOW, OPT_HIGH],
        })
      )
    );

    expect(screen.getByRole("checkbox", { name: "High" })).toHaveAttribute(
      "aria-checked",
      "false"
    );
    expect(screen.getByRole("checkbox", { name: "Low" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
  });
});

describe("DateFieldEditor", () => {
  it("adopts a new server date and writes an ISO string or null", () => {
    const setting = makeSetting(CustomFieldType.Date);
    const { rerender } = render(
      editor(
        setting,
        makeValue(CustomFieldType.Date, {
          dateValue: new Date("2026-01-01T00:00:00.000Z"),
        })
      )
    );
    expect(screen.getByTestId("date-value")).toHaveTextContent(
      "2026-01-01T00:00:00.000Z"
    );

    rerender(
      editor(
        setting,
        makeValue(CustomFieldType.Date, {
          dateValue: new Date("2026-02-02T00:00:00.000Z"),
        })
      )
    );
    expect(screen.getByTestId("date-value")).toHaveTextContent(
      "2026-02-02T00:00:00.000Z"
    );

    fireEvent.click(screen.getByRole("button", { name: "Pick date" }));
    expect(mockMutate).toHaveBeenLastCalledWith({
      fieldId: "field-1",
      value: PICKED_DATE_ISO,
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear date" }));
    expect(mockMutate).toHaveBeenLastCalledWith({
      fieldId: "field-1",
      value: null,
    });
    expect(screen.getByTestId("date-value")).toHaveTextContent("");
  });
});

describe("PeopleFieldEditor", () => {
  it("renders assigned people and removes one, writing the remaining ids", () => {
    render(
      editor(
        makeSetting(CustomFieldType.People),
        makeValue(CustomFieldType.People, { peopleValues: [ADA, GRACE] })
      )
    );

    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: REMOVE_ADA_RE }));

    expect(mockMutate).toHaveBeenCalledWith({
      fieldId: "field-1",
      value: ["user-grace"],
    });
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
  });

  it("shows no people when the value has not loaded", () => {
    render(editor(makeSetting(CustomFieldType.People)));

    expect(screen.getByText("No people assigned")).toBeTruthy();
  });
});

describe("TextFieldEditor empty and post-blur sync", () => {
  it("shows an empty box for an unloaded value and adopts server updates after a blur", () => {
    const setting = makeSetting(CustomFieldType.Text);
    const { rerender } = render(editor(setting));
    const input = screen.getByRole("textbox", { name: "Test Field" });
    expect(input).toHaveValue("");

    fireEvent.focus(input);
    fireEvent.blur(input);
    rerender(
      editor(setting, makeValue(CustomFieldType.Text, { textValue: "later" }))
    );

    expect(input).toHaveValue("later");
  });
});

describe("NumberFieldEditor labels and focus", () => {
  it.each([
    [
      "no format with a stale prefix label",
      {
        numberFormat: NumberFormat.None,
        customLabel: "pts",
        customLabelPosition: LabelPosition.Prefix,
      },
      [],
    ],
    [
      "no format with a stale suffix label",
      {
        numberFormat: NumberFormat.None,
        customLabel: "hrs",
        customLabelPosition: LabelPosition.Suffix,
      },
      [],
    ],
    [
      "percentage with a stale label",
      { numberFormat: NumberFormat.Percentage, customLabel: "pts" },
      ["%"],
    ],
    ["custom format with no label", { numberFormat: NumberFormat.Custom }, []],
  ])("renders only the adornments owned by %s", (_label, extra, expected) => {
    render(editor(makeSetting(CustomFieldType.Number, extra)));

    const row = screen.getByRole("textbox", {
      name: "Test Field",
    }).parentElement;
    const spans = Array.from(row?.querySelectorAll(":scope > span") ?? []);
    expect(spans.map((span) => span.textContent)).toEqual(expected);
  });

  it("shows an empty box for an unloaded number", () => {
    render(editor(makeSetting(CustomFieldType.Number)));

    expect(screen.getByRole("textbox", { name: "Test Field" })).toHaveValue("");
  });

  it.each([
    ["clearing", ""],
    ["a valid number", "8"],
  ])(
    "returns to the stored display value after blurring with %s",
    (_label, typed) => {
      render(
        editor(
          makeSetting(CustomFieldType.Number, {
            numberFormat: NumberFormat.None,
          }),
          makeValue(CustomFieldType.Number, {
            numberValue: 7,
            displayValue: "7",
          })
        )
      );
      const input = screen.getByRole("textbox", { name: "Test Field" });

      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: typed } });
      fireEvent.blur(input);

      // The server has not answered yet, so the idle box still shows what is stored.
      expect(input).toHaveValue("7");
    }
  );

  it("keeps typed digits when a server update lands mid-edit", () => {
    const setting = makeSetting(CustomFieldType.Number, {
      numberFormat: NumberFormat.None,
    });
    const { rerender } = render(
      editor(setting, makeValue(CustomFieldType.Number, { numberValue: 1 }))
    );
    const input = screen.getByRole("textbox", { name: "Test Field" });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "5" } });
    rerender(
      editor(setting, makeValue(CustomFieldType.Number, { numberValue: 9 }))
    );

    expect(input).toHaveValue("5");
  });
});

describe("DurationFieldEditor", () => {
  it("opens on the server display value for a stored duration", () => {
    render(
      durationEditor(
        makeValue(CustomFieldType.Number, {
          numberValue: 4_320_000,
          displayValue: "72m",
        })
      )
    );

    const input = screen.getByRole("textbox", { name: "Test Field" });
    expect(input).toHaveValue("72m");
    expect(input).toHaveAttribute("aria-invalid", "false");
  });

  it("follows server updates while idle, including after a blur, but not mid-edit", () => {
    const { rerender } = render(durationEditor(durationValue(60_000, "1m")));
    const input = screen.getByRole("textbox", { name: "Test Field" });

    rerender(durationEditor(durationValue(120_000, "2m")));
    expect(input).toHaveValue("2m");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "5m" } });
    rerender(durationEditor(durationValue(180_000, "3m")));
    expect(input).toHaveValue("5m");

    fireEvent.blur(input);
    expect(mockMutate).toHaveBeenLastCalledWith({
      fieldId: "field-1",
      value: 300_000,
    });
    rerender(durationEditor(durationValue(300_000, "5m 0s")));
    expect(input).toHaveValue("5m 0s");
  });

  it("treats whitespace as a clear and then follows the next server value", () => {
    const { rerender } = render(durationEditor(durationValue(60_000, "1m")));
    const input = screen.getByRole("textbox", { name: "Test Field" });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);

    expect(mockMutate).toHaveBeenCalledWith({
      fieldId: "field-1",
      value: null,
    });
    expect(screen.queryByRole("alert")).toBeNull();

    rerender(durationEditor(makeValue(CustomFieldType.Number)));
    expect(input).toHaveValue("");
  });

  it("points the input at a field-scoped error id", () => {
    render(durationEditor());
    const input = screen.getByRole("textbox", { name: "Test Field" });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "junk" } });
    fireEvent.blur(input);

    const error = screen.getByRole("alert");
    expect(error.id).toBe("duration-error-field-1");
    expect(input).toHaveAttribute("aria-describedby", "duration-error-field-1");
  });
});

describe("EnumFieldEditor choices and sync", () => {
  const setting = makeSetting(CustomFieldType.Enum, {
    enumOptions: [OPT_LOW, OPT_HIGH, OPT_ARCHIVED],
  });

  it("marks None when nothing is stored and hides disabled options", () => {
    render(editor(setting));

    fireEvent.click(screen.getByRole("combobox"));

    expect(screen.getByRole("option", { name: "None" })).toHaveAttribute(
      "data-state",
      "checked"
    );
    expect(screen.getByRole("option", { name: "Low" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Archived" })).toBeNull();
  });

  it("follows a new stored option", () => {
    const { rerender } = render(
      editor(setting, makeValue(CustomFieldType.Enum, { enumValue: OPT_LOW }))
    );
    rerender(
      editor(setting, makeValue(CustomFieldType.Enum, { enumValue: OPT_HIGH }))
    );

    expect(screen.getByRole("combobox")).toHaveTextContent("High");
  });

  it("reverts to the previous option when the write fails", () => {
    render(
      editor(setting, makeValue(CustomFieldType.Enum, { enumValue: OPT_LOW }))
    );

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "High" }));
    expect(mockMutate).toHaveBeenCalledWith(
      { fieldId: "field-1", value: "opt-high" },
      { onError: expect.any(Function) }
    );

    const { onError } = mockMutate.mock.calls[0][1];
    act(() => onError());

    expect(screen.getByRole("combobox")).toHaveTextContent("Low");
  });
});

describe("MultiEnumFieldEditor selections", () => {
  const setting = makeSetting(CustomFieldType.MultiEnum, {
    enumOptions: [OPT_LOW, OPT_HIGH, OPT_ARCHIVED],
  });

  it("follows a new stored selection while closed", () => {
    const { rerender } = render(
      editor(
        setting,
        makeValue(CustomFieldType.MultiEnum, { multiEnumValues: [OPT_LOW] })
      )
    );
    rerender(
      editor(
        setting,
        makeValue(CustomFieldType.MultiEnum, {
          multiEnumValues: [OPT_LOW, OPT_HIGH],
        })
      )
    );

    expect(screen.getByRole("button", { name: TWO_SELECTED_RE })).toBeTruthy();
    expect(screen.getByRole("button", { name: REMOVE_HIGH_RE })).toBeTruthy();
  });

  it("unchecks one option and keeps the rest, pilling only selected options", async () => {
    render(
      editor(
        setting,
        makeValue(CustomFieldType.MultiEnum, {
          multiEnumValues: [OPT_LOW, OPT_HIGH],
        })
      )
    );

    await userEvent.click(
      screen.getByRole("button", { name: TWO_SELECTED_RE })
    );
    expect(screen.queryByRole("checkbox", { name: "Archived" })).toBeNull();
    expect(screen.queryByText(NO_OPTIONS_RE)).toBeNull();

    await userEvent.click(screen.getByRole("checkbox", { name: "High" }));

    expect(mockMutate).toHaveBeenLastCalledWith({
      fieldId: "field-1",
      value: ["opt-low"],
    });
    expect(screen.queryByRole("button", { name: REMOVE_HIGH_RE })).toBeNull();
  });

  it("says no options are available when every option is disabled", async () => {
    render(
      editor(
        makeSetting(CustomFieldType.MultiEnum, { enumOptions: [OPT_ARCHIVED] })
      )
    );

    await userEvent.click(
      screen.getByRole("button", { name: SELECT_OPTIONS_RE })
    );

    expect(screen.getByText(NO_OPTIONS_RE)).toBeTruthy();
  });

  it("renders a pill row for orphaned ids alone and no pill row when nothing is selected", () => {
    const orphan: CustomFieldEnumOption = { ...OPT_LOW, id: "opt-deleted" };
    const { container, rerender } = render(
      editor(
        setting,
        makeValue(CustomFieldType.MultiEnum, { multiEnumValues: [orphan] })
      )
    );
    expect(
      screen.getByRole("button", { name: REMOVE_UNKNOWN_RE })
    ).toBeTruthy();

    rerender(editor(setting, makeValue(CustomFieldType.MultiEnum)));
    const column = screen.getByRole("button", {
      name: SELECT_OPTIONS_RE,
    }).parentElement;
    expect(column?.children).toHaveLength(1);
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });
});

describe("PeopleFieldEditor sync", () => {
  it("follows a new people list, even one whose ids concatenate to the old ones", () => {
    const setting = makeSetting(CustomFieldType.People);
    const first: BasicUser = { ...ADA, id: "a" };
    const second: BasicUser = { ...GRACE, id: "b" };
    const merged: BasicUser = {
      ...ADA,
      id: "ab",
      firstName: "Merged",
      lastName: "Person",
    };
    const { rerender } = render(
      editor(
        setting,
        makeValue(CustomFieldType.People, { peopleValues: [first, second] })
      )
    );
    expect(screen.getByText("Grace Hopper")).toBeTruthy();

    rerender(
      editor(
        setting,
        makeValue(CustomFieldType.People, { peopleValues: [merged] })
      )
    );

    expect(screen.getByText("Merged Person")).toBeTruthy();
    expect(screen.queryByText("Grace Hopper")).toBeNull();
  });
});

describe("CustomFieldValueEditor dispatch", () => {
  it("mounts only the text editor for a text field", () => {
    render(editor(makeSetting(CustomFieldType.Text)));

    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(
      screen.queryByRole("button", { name: SELECT_OPTIONS_RE })
    ).toBeNull();
    expect(screen.queryByTestId("date-value")).toBeNull();
    expect(screen.queryByText(NO_PEOPLE_RE)).toBeNull();
  });
});

function editor(
  setting: CustomFieldSettingWithOptions,
  value?: CustomFieldValueDetail
) {
  return (
    <CustomFieldValueEditor
      entityId="proj-1"
      entityType={CustomFieldEntityType.Project}
      setting={setting}
      value={value}
    />
  );
}

function makeSetting(
  fieldType: CustomFieldType,
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
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    customField: {
      id: "field-1",
      organizationId: "org-1",
      name: "Test Field",
      description: null,
      fieldType,
      createdById: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
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

function makeValue(
  fieldType: CustomFieldType,
  extra: Partial<CustomFieldValueDetail> = {}
): CustomFieldValueDetail {
  return {
    id: "v1",
    customFieldId: "field-1",
    entityId: "proj-1",
    name: "Test Field",
    fieldType,
    displayValue: null,
    showInTable: false,
    textValue: null,
    numberValue: null,
    dateValue: null,
    enumValue: null,
    multiEnumValues: [],
    peopleValues: [],
    referenceValues: [],
    ...extra,
  };
}

function durationEditor(value?: CustomFieldValueDetail) {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY],
      })}
    >
      {editor(
        makeSetting(CustomFieldType.Number, {
          numberFormat: NumberFormat.Duration,
        }),
        value
      )}
    </FeatureFlagAdapterProvider>
  );
}

function durationValue(ms: number, display: string): CustomFieldValueDetail {
  return makeValue(CustomFieldType.Number, {
    numberValue: ms,
    displayValue: display,
  });
}
