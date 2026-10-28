/**
 * Branch coverage for CustomFieldTableCell (ISS-10515): read-only rendering per
 * field type with and without a loaded value, the editable people picker
 * (search, empty match, toggle), text commit, and a DATE draft whose year the
 * range gate refuses.
 */

import { ArtifactType } from "@repo/api/src/types/artifact";
import type {
  CustomFieldEnumOption,
  CustomFieldReferenceTarget,
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import type { BasicUser } from "@repo/api/src/types/user";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY,
  CUSTOM_FIELD_VALUE_CLEAR_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { FeatureFlagAdapterProvider } from "../../../shared/feature-flags/provider";
import { durationValidationMessage } from "../../lib/duration-field";
import { CustomFieldTableCell } from "../custom-field-table-cell";

const ITEM_LABEL = "Row one";
const OWNER_ID = "entity-1";
const PEOPLE_SUMMARY_RE = /People: Ada Lovelace, Grace Hopper/;
const EXTENDED_YEAR_ISO = "+010000-01-01T00:00:00.000Z";
const EDIT_PREFIX_RE = /^Edit /;
const EMPTY_VALUE_SELECTOR = '[data-slot="grid-empty-value"]';

const ADA: BasicUser = {
  id: "user-ada",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  avatarUrl: "https://example.com/ada.png",
};

const GRACE: BasicUser = {
  id: "user-grace",
  email: "grace@example.com",
  firstName: "Grace",
  lastName: "Hopper",
  avatarUrl: null,
};

const BASE_FIELD: CustomFieldWithOptions = {
  createdAt: new Date("2026-08-25T12:00:00.000Z"),
  createdById: "user-1",
  currencyCode: null,
  customLabel: null,
  customLabelPosition: null,
  description: null,
  entityTypes: [CustomFieldEntityType.Session],
  enumOptions: [],
  fieldType: CustomFieldType.Text,
  id: "field-1",
  isGlobalToOrg: false,
  isSearchable: false,
  isSortable: false,
  name: "Notes",
  numberFormat: null,
  organizationId: "org-1",
  precision: null,
  referenceTargetSources: [],
  showInTable: true,
  updatedAt: new Date("2026-08-25T12:00:00.000Z"),
};

const BASE_VALUE: CustomFieldValueDetail = {
  customFieldId: BASE_FIELD.id,
  dateValue: null,
  displayValue: null,
  entityId: OWNER_ID,
  enumValue: null,
  fieldType: CustomFieldType.Text,
  id: "value-1",
  multiEnumValues: [],
  name: BASE_FIELD.name,
  numberValue: null,
  peopleValues: [],
  referenceValues: [],
  showInTable: true,
  textValue: null,
};

const OPT_LOW: CustomFieldEnumOption = {
  id: "opt-low",
  customFieldId: BASE_FIELD.id,
  name: "Low",
  color: "none",
  enabled: true,
  sortOrder: 0,
};

const OPT_HIGH: CustomFieldEnumOption = {
  id: "opt-high",
  customFieldId: BASE_FIELD.id,
  name: "High",
  color: "none",
  enabled: true,
  sortOrder: 1,
};

const UNSLUGGED_TARGET: CustomFieldReferenceTarget = {
  artifactType: ArtifactType.Session,
  id: "target-1",
  name: "Unslugged session",
  slug: null,
  status: "active",
  subtype: null,
};

describe("CustomFieldTableCell read-only rendering", () => {
  it("renders stored text", () => {
    render(
      cell(field(CustomFieldType.Text), {
        ...BASE_VALUE,
        textValue: "Hello",
      })
    );

    expect(screen.getByText("Hello")).toBeTruthy();
  });

  it("names every stored person, with or without an avatar", () => {
    render(
      cell(field(CustomFieldType.People), {
        ...BASE_VALUE,
        fieldType: CustomFieldType.People,
        peopleValues: [ADA, GRACE],
      })
    );

    expect(screen.getByText(PEOPLE_SUMMARY_RE)).toBeTruthy();
  });

  it("labels a reference by its name when it has no slug", () => {
    render(
      cell(field(CustomFieldType.Reference), {
        ...BASE_VALUE,
        fieldType: CustomFieldType.Reference,
        referenceValues: [UNSLUGGED_TARGET],
      })
    );

    expect(screen.getAllByText(UNSLUGGED_TARGET.name).length).toBeGreaterThan(
      0
    );
    // No onValueChange means no editor, for references too.
    expect(screen.queryByRole("button", { name: EDIT_PREFIX_RE })).toBeNull();
  });

  it.each([
    CustomFieldType.MultiEnum,
    CustomFieldType.People,
    CustomFieldType.Reference,
    CustomFieldType.ReferenceMulti,
  ])(
    "renders the empty dash for a %s field whose value has not loaded",
    (fieldType) => {
      const { container } = render(cell(field(fieldType)));

      expect(container.querySelector(EMPTY_VALUE_SELECTOR)).not.toBeNull();
    }
  );
});

describe("CustomFieldTableCell editable people", () => {
  it("filters people by search, reports no match, and toggles a person in", async () => {
    const onValueChange = vi.fn();
    render(
      cell(
        field(CustomFieldType.People, "Owners"),
        {
          ...BASE_VALUE,
          fieldType: CustomFieldType.People,
          peopleValues: [GRACE],
        },
        { onValueChange, peopleOptions: [ADA, GRACE] }
      )
    );

    await userEvent.click(
      screen.getByRole("button", { name: `Edit Owners for ${ITEM_LABEL}` })
    );
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Grace Hopper" })
    ).toHaveAttribute("aria-checked", "true");

    const search = screen.getByRole("textbox", {
      name: "Search Owners people",
    });
    fireEvent.change(search, { target: { value: "  ADA " } });
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Grace Hopper" })
    ).toBeNull();
    expect(screen.queryByText("No matching people")).toBeNull();

    await userEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Ada Lovelace" })
    );
    expect(onValueChange).toHaveBeenCalledWith(["user-grace", "user-ada"]);

    fireEvent.change(search, { target: { value: "nobody" } });
    expect(screen.getByText("No matching people")).toBeTruthy();
  });

  it("opens with nothing selected when the value has not loaded", async () => {
    const onValueChange = vi.fn();
    render(
      cell(field(CustomFieldType.People, "Owners"), undefined, {
        onValueChange,
        peopleOptions: [ADA],
      })
    );

    await userEvent.click(
      screen.getByRole("button", { name: `Edit Owners for ${ITEM_LABEL}` })
    );
    await userEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Ada Lovelace" })
    );

    expect(onValueChange).toHaveBeenCalledWith(["user-ada"]);
  });
});

describe("CustomFieldTableCell scalar text and date commits", () => {
  it.each([
    ["a stored value", { ...BASE_VALUE, textValue: "old" }],
    ["no loaded value", undefined],
  ])("commits trimmed text over %s", async (_label, value) => {
    const onValueChange = vi.fn();
    render(cell(field(CustomFieldType.Text), value, { onValueChange }));

    await userEvent.click(
      screen.getByRole("button", { name: `Edit Notes for ${ITEM_LABEL}` })
    );
    const input = screen.getByRole("textbox", {
      name: `Edit Notes for ${ITEM_LABEL}`,
    });
    expect(input).toHaveValue(value?.textValue ?? "");

    fireEvent.change(input, { target: { value: "  fresh  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onValueChange).toHaveBeenCalledWith("fresh");
  });

  it("refuses a calendar-shaped date whose year is outside the allowed range", async () => {
    const onValueChange = vi.fn();
    // A stored year past 9999 fails the year gate, so the cell edits it as a
    // text box rather than a native date input that would sanitize the draft.
    const poison: CustomFieldValueDetail = {
      ...BASE_VALUE,
      fieldType: CustomFieldType.Date,
      dateValue: new Date(EXTENDED_YEAR_ISO),
    };
    render(cell(field(CustomFieldType.Date, "Due"), poison, { onValueChange }));

    await userEvent.click(
      screen.getByRole("button", { name: `Edit Due for ${ITEM_LABEL}` })
    );
    const input = screen.getByRole("textbox", {
      name: `Edit Due for ${ITEM_LABEL}`,
    });
    fireEvent.change(input, { target: { value: "0000-01-01" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onValueChange).not.toHaveBeenCalled();
    expect(input).toHaveAccessibleDescription("Enter a valid date");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid date");
  });
});

describe("CustomFieldTableCell read-only choices", () => {
  it("renders the empty dash for a single-select value with no option", () => {
    const { container } = render(
      cell(field(CustomFieldType.Enum), {
        ...BASE_VALUE,
        fieldType: CustomFieldType.Enum,
      })
    );

    expect(container.querySelector(EMPTY_VALUE_SELECTOR)).not.toBeNull();
  });

  it("labels each multi-select choice by its option name", () => {
    const { container } = render(
      cell(field(CustomFieldType.MultiEnum), {
        ...BASE_VALUE,
        fieldType: CustomFieldType.MultiEnum,
        multiEnumValues: [OPT_LOW, OPT_HIGH],
      })
    );

    expect(screen.getAllByText("Low").length).toBeGreaterThan(0);
    expect(screen.getAllByText("High").length).toBeGreaterThan(0);
    expect(container.querySelector(EMPTY_VALUE_SELECTOR)).toBeNull();
  });
});

describe("CustomFieldTableCell editable choices", () => {
  it("writes the picked single-select option and marks the stored one", async () => {
    const onValueChange = vi.fn();
    render(
      cell(
        enumField(CustomFieldType.Enum),
        { ...BASE_VALUE, fieldType: CustomFieldType.Enum, enumValue: OPT_HIGH },
        { onValueChange }
      )
    );

    await userEvent.click(editButton("Stage"));
    expect(screen.getByRole("menuitemradio", { name: "High" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(screen.getByRole("menuitemradio", { name: "Low" })).toHaveAttribute(
      "aria-checked",
      "false"
    );

    await userEvent.click(screen.getByRole("menuitemradio", { name: "Low" }));
    expect(onValueChange).toHaveBeenCalledWith(OPT_LOW.id);
  });

  it("offers no clear on a single-select record whose value holds no option", async () => {
    render(
      withFlags(
        cell(
          enumField(CustomFieldType.Enum),
          { ...BASE_VALUE, fieldType: CustomFieldType.Enum },
          { onValueChange: vi.fn() }
        ),
        [CUSTOM_FIELD_VALUE_CLEAR_FEATURE_FLAG_KEY]
      )
    );

    await userEvent.click(editButton("Stage"));

    expect(screen.getByRole("menuitemradio", { name: "Low" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Clear Stage" })).toBeNull();
  });

  it("starts an unloaded multi-select from nothing and keeps the menu open after a toggle", async () => {
    const onValueChange = vi.fn();
    render(
      cell(enumField(CustomFieldType.MultiEnum), undefined, { onValueChange })
    );

    await userEvent.click(editButton("Stage"));
    await userEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "High" })
    );

    expect(onValueChange).toHaveBeenCalledWith([OPT_HIGH.id]);
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Low" })
    ).toBeInTheDocument();
  });
});

describe("CustomFieldTableCell editable people and references defaults", () => {
  it("shows an empty picker and an empty trigger when no people or value are passed", async () => {
    const { container } = render(
      cell(field(CustomFieldType.People, "Owners"), undefined, {
        onValueChange: vi.fn(),
      })
    );

    expect(container.querySelector(EMPTY_VALUE_SELECTOR)).not.toBeNull();
    await userEvent.click(editButton("Owners"));

    expect(screen.getByText("No matching people")).toBeTruthy();
    expect(screen.queryAllByRole("menuitemcheckbox")).toHaveLength(0);
  });

  it("keeps typing in the people search box instead of jumping to a matching person", async () => {
    render(
      cell(field(CustomFieldType.People, "Owners"), undefined, {
        onValueChange: vi.fn(),
        peopleOptions: [ADA, GRACE],
      })
    );

    await userEvent.click(editButton("Owners"));
    const search = screen.getByRole("textbox", {
      name: "Search Owners people",
    });
    await userEvent.type(search, "gr");

    expect(search).toHaveValue("gr");
    expect(search).toHaveFocus();
  });

  it("reports no references when neither options nor a loader are passed", async () => {
    render(
      cell(field(CustomFieldType.Reference, "Links"), undefined, {
        onValueChange: vi.fn(),
      })
    );

    await userEvent.click(editButton("Links"));

    expect(screen.getByText("No references available")).toBeTruthy();
  });
});

describe("CustomFieldTableCell scalar drafts", () => {
  it("opens a stored number as its raw digits and an unset one as empty", async () => {
    const numberField = field(CustomFieldType.Number, "Score");
    const { unmount } = render(
      cell(
        numberField,
        {
          ...BASE_VALUE,
          fieldType: CustomFieldType.Number,
          numberValue: 1234.5,
          displayValue: "1,234.50",
        },
        { onValueChange: vi.fn() }
      )
    );
    await userEvent.click(editButton("Score"));
    expect(editInput("Score")).toHaveValue("1234.5");
    expect(editInput("Score")).toHaveAttribute("aria-invalid", "false");
    unmount();

    render(cell(numberField, undefined, { onValueChange: vi.fn() }));
    await userEvent.click(editButton("Score"));
    expect(editInput("Score")).toHaveValue("");
  });

  it("clears a text value with null, not an empty string", async () => {
    const onValueChange = vi.fn();
    render(
      cell(
        field(CustomFieldType.Text),
        { ...BASE_VALUE, textValue: "old" },
        { onValueChange }
      )
    );

    await userEvent.click(editButton("Notes"));
    fireEvent.change(editInput("Notes"), { target: { value: "   " } });
    fireEvent.keyDown(editInput("Notes"), { key: "Enter" });

    expect(onValueChange).toHaveBeenCalledWith(null);
  });

  it("follows a new stored value, restores it on Escape, and never writes an untouched reopen", async () => {
    const onValueChange = vi.fn();
    const textField = field(CustomFieldType.Text);
    const { rerender } = render(
      cell(textField, { ...BASE_VALUE, textValue: "one" }, { onValueChange })
    );
    rerender(
      cell(textField, { ...BASE_VALUE, textValue: "two" }, { onValueChange })
    );

    await userEvent.click(editButton("Notes"));
    expect(editInput("Notes")).toHaveValue("two");

    fireEvent.change(editInput("Notes"), { target: { value: "draft" } });
    fireEvent.keyDown(editInput("Notes"), { key: "Escape" });
    await userEvent.click(editButton("Notes"));
    expect(editInput("Notes")).toHaveValue("two");

    fireEvent.blur(editInput("Notes"));
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("opens a healthy stored date in a native date input as YYYY-MM-DD", async () => {
    render(
      cell(
        field(CustomFieldType.Date, "Due"),
        {
          ...BASE_VALUE,
          fieldType: CustomFieldType.Date,
          dateValue: new Date("2026-08-07T00:00:00.000Z"),
        },
        { onValueChange: vi.fn() }
      )
    );

    await userEvent.click(editButton("Due"));
    const input = screen.getByLabelText(`Edit Due for ${ITEM_LABEL}`);
    expect(input).toHaveAttribute("type", "date");
    expect(input).toHaveValue("2026-08-07");
  });

  it("edits an unset date in a native date input and closes an untouched blur without an error", async () => {
    const onValueChange = vi.fn();
    render(
      cell(
        field(CustomFieldType.Date, "Due"),
        { ...BASE_VALUE, fieldType: CustomFieldType.Date },
        { onValueChange }
      )
    );

    await userEvent.click(editButton("Due"));
    const input = screen.getByLabelText(`Edit Due for ${ITEM_LABEL}`);
    expect(input).toHaveAttribute("type", "date");
    fireEvent.blur(input);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(onValueChange).not.toHaveBeenCalled();
    // Back to the trigger button: the date input is gone.
    expect(editButton("Due").tagName).toBe("BUTTON");
    expect(document.querySelector("input")).toBeNull();
  });

  it("does not treat a text field carrying an unusable date as a poison date", async () => {
    const onValueChange = vi.fn();
    render(
      cell(
        field(CustomFieldType.Text),
        { ...BASE_VALUE, dateValue: new Date(EXTENDED_YEAR_ISO) },
        { onValueChange }
      )
    );

    await userEvent.click(editButton("Notes"));
    fireEvent.blur(editInput("Notes"));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it.each([
    ["a non-calendar shape the Date parser accepts", "12/31/2020"],
    ["a calendar date with a leading prefix", "a 2020-01-01"],
    ["a calendar date with a trailing time", "2020-01-01T00:00"],
  ])("refuses %s", async (_label, typed) => {
    const onValueChange = vi.fn();
    render(
      cell(
        field(CustomFieldType.Date, "Due"),
        {
          ...BASE_VALUE,
          fieldType: CustomFieldType.Date,
          dateValue: new Date(EXTENDED_YEAR_ISO),
        },
        { onValueChange }
      )
    );

    await userEvent.click(editButton("Due"));
    fireEvent.change(editInput("Due"), { target: { value: typed } });
    fireEvent.keyDown(editInput("Due"), { key: "Enter" });

    expect(onValueChange).not.toHaveBeenCalled();
    expect(editInput("Due")).toHaveAccessibleDescription("Enter a valid date");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid date");
  });
});

describe("CustomFieldTableCell duration drafts", () => {
  it("opens on the server display value rather than re-formatting the milliseconds", async () => {
    render(
      withFlags(
        cell(
          durationField(),
          {
            ...BASE_VALUE,
            fieldType: CustomFieldType.Number,
            numberValue: 4_320_000,
            displayValue: "72m",
          },
          { onValueChange: vi.fn() }
        ),
        [CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY]
      )
    );

    await userEvent.click(editButton("Cycle"));
    expect(editInput("Cycle")).toHaveValue("72m");
  });

  it("names the trimmed input in the refusal", async () => {
    const onValueChange = vi.fn();
    render(
      withFlags(cell(durationField(), undefined, { onValueChange }), [
        CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY,
      ])
    );

    await userEvent.click(editButton("Cycle"));
    fireEvent.change(editInput("Cycle"), { target: { value: "  junk  " } });
    fireEvent.keyDown(editInput("Cycle"), { key: "Enter" });

    expect(editInput("Cycle")).toHaveAccessibleDescription(
      durationValidationMessage("junk")
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      durationValidationMessage("junk")
    );
    expect(onValueChange).not.toHaveBeenCalled();
  });
});

/**
 * ISS-9589. The Sessions v2 list refetches under an open editor — the
 * active-row poll, a refetch on focus, another cell's write invalidating the
 * list — and a stored value that landed mid-edit used to replace the typing.
 * Two cells, so a rule that holds every cell cannot pass for one that holds
 * only the one being typed into.
 */
describe("CustomFieldTableCell scalar drafts under a live update", () => {
  it("holds a stored value while the user types, and restores it on Escape", async () => {
    const onValueChange = vi.fn();
    const { rerender } = render(
      twoTextCells({ notes: "one", onValueChange, summary: "alpha" })
    );

    await userEvent.click(editButton("Notes"));
    fireEvent.change(editInput("Notes"), { target: { value: "mine" } });
    rerender(twoTextCells({ notes: "two", onValueChange, summary: "beta" }));

    expect(editInput("Notes")).toHaveValue("mine");

    fireEvent.keyDown(editInput("Notes"), { key: "Escape" });
    await userEvent.click(editButton("Notes"));
    expect(editInput("Notes")).toHaveValue("two");
    fireEvent.keyDown(editInput("Notes"), { key: "Escape" });

    // The cell nobody typed into took the new value as it landed.
    await userEvent.click(editButton("Summary"));
    expect(editInput("Summary")).toHaveValue("beta");
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("commits the typing over a stored value that landed mid-edit", async () => {
    const onValueChange = vi.fn();
    const { rerender } = render(
      twoTextCells({ notes: "one", onValueChange, summary: "alpha" })
    );

    await userEvent.click(editButton("Notes"));
    fireEvent.change(editInput("Notes"), { target: { value: "mine" } });
    rerender(twoTextCells({ notes: "two", onValueChange, summary: "beta" }));
    fireEvent.keyDown(editInput("Notes"), { key: "Enter" });

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith("mine");
  });

  it("takes the stored value over typing the commit already refused", async () => {
    const onValueChange = vi.fn();
    const scoreField = field(CustomFieldType.Number, "Score");
    const stored = (numberValue: number) => ({
      ...BASE_VALUE,
      fieldType: CustomFieldType.Number,
      numberValue,
      displayValue: String(numberValue),
    });
    const { rerender } = render(cell(scoreField, stored(5), { onValueChange }));

    await userEvent.click(editButton("Score"));
    fireEvent.change(editInput("Score"), { target: { value: "abc" } });
    fireEvent.blur(editInput("Score"));
    // Pins that the refusal happened, so the release below is the fix and not
    // an edit that never got refused.
    expect(editInput("Score")).toHaveAttribute("aria-invalid", "true");

    rerender(cell(scoreField, stored(7), { onValueChange }));

    expect(editInput("Score")).toHaveValue("7");
    expect(editInput("Score")).toHaveAttribute("aria-invalid", "false");
    fireEvent.blur(editInput("Score"));
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("holds typing that Enter refused while the user is still in the cell", async () => {
    // marisolashgrove review, PR #7836: Enter refuses without blurring, so the
    // user is still typing next to the error when the stored value lands.
    const onValueChange = vi.fn();
    const scoreField = field(CustomFieldType.Number, "Score");
    const stored = (numberValue: number) => ({
      ...BASE_VALUE,
      fieldType: CustomFieldType.Number,
      numberValue,
      displayValue: String(numberValue),
    });
    const { rerender } = render(cell(scoreField, stored(5), { onValueChange }));

    await userEvent.click(editButton("Score"));
    fireEvent.change(editInput("Score"), { target: { value: "abc" } });
    fireEvent.keyDown(editInput("Score"), { key: "Enter" });
    expect(editInput("Score")).toHaveAttribute("aria-invalid", "true");
    expect(editInput("Score")).toHaveFocus();

    rerender(cell(scoreField, stored(7), { onValueChange }));

    expect(editInput("Score")).toHaveValue("abc");
    expect(editInput("Score")).toHaveAttribute("aria-invalid", "true");
    fireEvent.keyDown(editInput("Score"), { key: "Escape" });
    await userEvent.click(editButton("Score"));
    expect(editInput("Score")).toHaveValue("7");
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("takes the stored value over typing that ended where it began, and writes nothing", async () => {
    const onValueChange = vi.fn();
    const { rerender } = render(
      twoTextCells({ notes: "one", onValueChange, summary: "alpha" })
    );

    await userEvent.click(editButton("Notes"));
    fireEvent.change(editInput("Notes"), { target: { value: "onex" } });
    fireEvent.change(editInput("Notes"), { target: { value: "one" } });
    rerender(twoTextCells({ notes: "two", onValueChange, summary: "beta" }));

    expect(editInput("Notes")).toHaveValue("two");
    fireEvent.blur(editInput("Notes"));
    expect(onValueChange).not.toHaveBeenCalled();
  });
});

function twoTextCells({
  notes,
  onValueChange,
  summary,
}: {
  notes: string;
  onValueChange: (value: string | number | string[] | null) => void;
  summary: string;
}) {
  return (
    <>
      {cell(
        field(CustomFieldType.Text),
        { ...BASE_VALUE, textValue: notes },
        { onValueChange }
      )}
      {cell(
        field(CustomFieldType.Text, "Summary"),
        { ...BASE_VALUE, textValue: summary },
        { onValueChange }
      )}
    </>
  );
}

function field(
  fieldType: CustomFieldType,
  name: string = BASE_FIELD.name
): CustomFieldWithOptions {
  return { ...BASE_FIELD, fieldType, name };
}

function cell(
  fieldDef: CustomFieldWithOptions,
  value?: CustomFieldValueDetail,
  extra: {
    onValueChange?: (value: string | number | string[] | null) => void;
    peopleOptions?: readonly BasicUser[];
  } = {}
) {
  return (
    <CustomFieldTableCell
      field={fieldDef}
      itemLabel={ITEM_LABEL}
      onValueChange={extra.onValueChange}
      ownerEntityId={OWNER_ID}
      peopleOptions={extra.peopleOptions}
      value={value}
    />
  );
}

function enumField(fieldType: CustomFieldType): CustomFieldWithOptions {
  return {
    ...BASE_FIELD,
    fieldType,
    name: "Stage",
    enumOptions: [OPT_LOW, OPT_HIGH],
  };
}

function durationField(): CustomFieldWithOptions {
  return {
    ...BASE_FIELD,
    fieldType: CustomFieldType.Number,
    name: "Cycle",
    numberFormat: NumberFormat.Duration,
  };
}

function editButton(fieldName: string): HTMLElement {
  return screen.getByRole("button", {
    name: `Edit ${fieldName} for ${ITEM_LABEL}`,
  });
}

function editInput(fieldName: string): HTMLElement {
  return screen.getByRole("textbox", {
    name: `Edit ${fieldName} for ${ITEM_LABEL}`,
  });
}

function withFlags(node: ReactElement, enabledFlags: readonly string[]) {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      {node}
    </FeatureFlagAdapterProvider>
  );
}
