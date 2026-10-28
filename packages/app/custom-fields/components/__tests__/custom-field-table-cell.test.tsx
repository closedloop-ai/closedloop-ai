import { ArtifactType } from "@repo/api/src/types/artifact";
import type {
  CustomFieldReferenceSearchResponse,
  CustomFieldReferenceTarget,
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  NumberFormat,
  ReferenceTargetSource,
} from "@repo/api/src/types/custom-field";
import { INLINE_SCALAR_NUMBER_INVALID_MESSAGE } from "@repo/app/shared/lib/inline-scalar-invalid-message";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CustomFieldTableCell } from "../custom-field-table-cell";

const SEARCH_TARGET_NAME_PATTERN = /BRN-search\s*Search custom fields/;
const EPOCH_YEAR_PATTERN = /1970/;

describe("CustomFieldTableCell scalar editing", () => {
  it("keeps an invalid number in edit mode instead of clearing the value", async () => {
    const { input, onValueChange } = await openNumberCellEditor();
    await userEvent.type(input, "not-a-number");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      screen.getByText(INLINE_SCALAR_NUMBER_INVALID_MESSAGE)
    ).toBeVisible();
    expect(onValueChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("not-a-number");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByText(INLINE_SCALAR_NUMBER_INVALID_MESSAGE)).toBeNull();
    expect(screen.getByText("12")).toBeVisible();
  });

  // The same helper guards the sidebar editor (ISS-8738): a non-finite or
  // partially parsed number must never reach onValueChange from the grid either.
  it.each(["1e999", "12abc"])(
    "rejects %s in the grid cell without committing",
    async (raw) => {
      const { input, onValueChange } = await openNumberCellEditor();
      await userEvent.type(input, raw);
      fireEvent.keyDown(input, { key: "Enter" });

      expect(
        screen.getByText(INLINE_SCALAR_NUMBER_INVALID_MESSAGE)
      ).toBeVisible();
      expect(onValueChange).not.toHaveBeenCalled();
      expect(input).toHaveValue(raw);
    }
  );

  it("PRD-722 DT-056 describes a number rejected on blur", async () => {
    const { input, onValueChange } = await openNumberCellEditor();
    await userEvent.type(input, "12abc");
    input.blur();

    await waitFor(() => {
      expect(input).toHaveValue("12abc");
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input).toHaveAccessibleDescription(
        INLINE_SCALAR_NUMBER_INVALID_MESSAGE
      );
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      INLINE_SCALAR_NUMBER_INVALID_MESSAGE
    );
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("does not refocus invalid input after the user moves to another control", async () => {
    const { input, onValueChange } = await openNumberCellEditor();
    const next = document.createElement("button");
    document.body.append(next);
    try {
      await userEvent.type(input, "12abc");
      fireEvent.blur(input, { relatedTarget: next });
      act(() => next.focus());

      await waitFor(() =>
        expect(input).toHaveAttribute("aria-invalid", "true")
      );
      expect(next).toHaveFocus();
      expect(input).not.toHaveFocus();
      expect(onValueChange).not.toHaveBeenCalled();
    } finally {
      next.remove();
    }
  });
});

/**
 * ISS-8884 — `dateValue` is typed `Date | null` but arrives as whatever the
 * wire reviver left it: an extended-year ISO string it never matched, or an
 * Invalid Date from an ISO-shaped junk string. Both used to throw from the
 * cell's `toISOString()` during render and take the whole table to its error
 * boundary. The stored value stays clearable, but only by an explicit act.
 */
describe("CustomFieldTableCell DATE guards (ISS-8884)", () => {
  const EXTENDED_YEAR_STRING = "+010000-01-01T00:00:00.000Z";
  const INVALID_DATE = new Date("2026-99-99T00:00:00.000Z");
  // Third column is the draft the cell opens with: an unrevived wire STRING is
  // real stored text, a revived Invalid Date has none — `String()` on it would
  // put the words "Invalid Date" in the box (marisolashgrove review).
  const poisonValues = [
    ["an extended-year string", EXTENDED_YEAR_STRING, EXTENDED_YEAR_STRING],
    ["an Invalid Date", INVALID_DATE, ""],
  ] as const;

  it.each(poisonValues)(
    "renders the read-only cell for %s instead of throwing",
    (_label, dateValue) => {
      render(
        <CustomFieldTableCell
          field={DATE_FIELD}
          itemLabel="Session one"
          ownerEntityId="session-1"
          value={dateValue_(dateValue)}
        />
      );

      expect(screen.getByText("Jan 1, 10000")).toBeVisible();
    }
  );

  it.each(poisonValues)(
    "renders the editable cell for %s and refuses a no-edit blur",
    async (_label, dateValue, expectedDraft) => {
      const onValueChange = vi.fn();
      render(
        <CustomFieldTableCell
          field={DATE_FIELD}
          itemLabel="Session one"
          onValueChange={onValueChange}
          ownerEntityId="session-1"
          value={dateValue_(dateValue)}
        />
      );

      await userEvent.click(
        screen.getByRole("button", { name: "Edit Due for Session one" })
      );
      const input = screen.getByLabelText("Edit Due for Session one");
      // Edited as text so the raw value is visible and can be deleted; a native
      // date input would blank it and swallow Backspace.
      expect(input).toHaveAttribute("type", "text");
      expect(input).toHaveValue(expectedDraft);
      fireEvent.blur(input);

      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("Enter a valid date");
      expect(input).toHaveAttribute("aria-describedby", alert.id);
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(onValueChange).not.toHaveBeenCalled();

      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByText("Enter a valid date")).toBeNull();
      expect(screen.getByText("Jan 1, 10000")).toBeVisible();
    }
  );

  it("clears a poison row only when the user empties the field and commits", async () => {
    const onValueChange = vi.fn();
    render(
      <CustomFieldTableCell
        field={DATE_FIELD}
        itemLabel="Session one"
        onValueChange={onValueChange}
        ownerEntityId="session-1"
        value={dateValue_(EXTENDED_YEAR_STRING)}
      />
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Edit Due for Session one" })
    );
    const input = screen.getByLabelText("Edit Due for Session one");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  // A wire kind `dateValueAsDate` refuses outright still reaches the draft as
  // its raw text, and `new Date("0")` is a valid January 2000 the year gate
  // accepts — so the draft's shape check is the only thing standing between a
  // no-edit blur and a persisted date nobody typed.
  it("refuses a numeric wire value instead of committing a fabricated date", async () => {
    const onValueChange = vi.fn();
    render(
      <CustomFieldTableCell
        field={DATE_FIELD}
        itemLabel="Session one"
        onValueChange={onValueChange}
        ownerEntityId="session-1"
        value={dateValue_(0)}
      />
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Edit Due for Session one" })
    );
    const input = screen.getByLabelText("Edit Due for Session one");
    // No stored text to show, and an untouched blur must not read that empty
    // box as a clear.
    expect(input).toHaveValue("");
    fireEvent.blur(input);

    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid date");
    expect(onValueChange).not.toHaveBeenCalled();

    // The refusal keeps the cell in edit mode; typing then emptying IS an
    // explicit clear.
    fireEvent.change(input, { target: { value: "2026-09-01" } });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("renders a real Date with the same ISO title as before", () => {
    const stored = new Date("2026-08-07T00:00:00.000Z");
    render(
      <CustomFieldTableCell
        field={DATE_FIELD}
        itemLabel="Session one"
        ownerEntityId="session-1"
        value={{
          ...dateValue_(stored),
          displayValue: "Aug 7, 2026",
        }}
      />
    );

    expect(screen.getByText("Aug 7, 2026")).toHaveAttribute(
      "title",
      "2026-08-07T00:00:00.000Z"
    );
  });

  it("refuses an out-of-range typed date and commits an in-range one", async () => {
    const onValueChange = vi.fn();
    render(
      <CustomFieldTableCell
        field={DATE_FIELD}
        itemLabel="Session one"
        onValueChange={onValueChange}
        ownerEntityId="session-1"
        value={{
          ...dateValue_(new Date("2026-08-07T00:00:00.000Z")),
          displayValue: "Aug 7, 2026",
        }}
      />
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Edit Due for Session one" })
    );
    const input = screen.getByLabelText("Edit Due for Session one");
    expect(input).toHaveAttribute("type", "date");
    expect(input).toHaveAttribute("max", "9999-12-31");

    fireEvent.change(input, { target: { value: "10000-01-01" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("Enter a valid date")).toBeVisible();
    expect(onValueChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "2026-09-01" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("2026-09-01");
  });

  it.each([
    [
      "a null dateValue",
      { ...dateValue_(INVALID_DATE), dateValue: null, displayValue: "" },
    ],
    ["no value at all", undefined],
  ])(
    "renders an absent date as empty, never 1970, for %s",
    async (_label, value) => {
      const onValueChange = vi.fn();
      render(
        <CustomFieldTableCell
          field={DATE_FIELD}
          itemLabel="Session one"
          onValueChange={onValueChange}
          ownerEntityId="session-1"
          value={value}
        />
      );

      expect(screen.queryByText(EPOCH_YEAR_PATTERN)).toBeNull();
      await userEvent.click(
        screen.getByRole("button", { name: "Edit Due for Session one" })
      );
      expect(screen.getByLabelText("Edit Due for Session one")).toHaveValue("");
    }
  );

  it("keeps NUMBER commits byte-identical through the shared finish path", async () => {
    const onValueChange = vi.fn();
    render(
      <CustomFieldTableCell
        field={NUMBER_FIELD}
        itemLabel="Session one"
        onValueChange={onValueChange}
        ownerEntityId="session-1"
        value={NUMBER_VALUE}
      />
    );

    await userEvent.click(
      screen.getByRole("button", {
        name: "Edit Revision count for Session one",
      })
    );
    const input = screen.getByRole("textbox", {
      name: "Edit Revision count for Session one",
    });
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onValueChange).toHaveBeenLastCalledWith(42);

    await userEvent.click(
      screen.getByRole("button", {
        name: "Edit Revision count for Session one",
      })
    );
    const again = screen.getByRole("textbox", {
      name: "Edit Revision count for Session one",
    });
    fireEvent.change(again, { target: { value: "   " } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(onValueChange).toHaveBeenLastCalledWith(null);
    expect(onValueChange).toHaveBeenCalledTimes(2);
  });
});

describe("CustomFieldTableCell reference search", () => {
  it("loads on open and retains selected targets when another target is chosen", async () => {
    let resolveSearch: (result: CustomFieldReferenceSearchResponse) => void =
      () => undefined;
    const loadReferenceOptions = vi.fn(
      () =>
        new Promise<CustomFieldReferenceSearchResponse>((resolve) => {
          resolveSearch = resolve;
        })
    );
    const onValueChange = vi.fn();
    render(
      <CustomFieldTableCell
        field={REFERENCE_FIELD}
        itemLabel="Session one"
        loadReferenceOptions={loadReferenceOptions}
        onValueChange={onValueChange}
        ownerEntityId="session-1"
        value={REFERENCE_VALUE}
      />
    );

    expect(loadReferenceOptions).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Edit Related work for Session one",
      })
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Loading references…"
    );
    expect(loadReferenceOptions).toHaveBeenCalledWith("");
    expect(
      screen
        .getAllByText("SES-1")
        .find((element) => element.closest('[aria-hidden="true"]') === null)
    ).toBeVisible();

    await act(async () => {
      resolveSearch({ hasMore: true, targets: [SEARCH_TARGET] });
      await Promise.resolve();
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Keep typing to narrow results."
    );

    await userEvent.click(
      screen.getByRole("button", { name: SEARCH_TARGET_NAME_PATTERN })
    );
    expect(onValueChange).toHaveBeenCalledWith([
      SELECTED_TARGET.id,
      SEARCH_TARGET.id,
    ]);
  });

  it("reports a failed load and an honest empty state after retry", async () => {
    const loadReferenceOptions = vi
      .fn<() => Promise<CustomFieldReferenceSearchResponse>>()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({ hasMore: false, targets: [] });
    render(
      <CustomFieldTableCell
        field={REFERENCE_FIELD}
        itemLabel="Session one"
        loadReferenceOptions={loadReferenceOptions}
        onValueChange={vi.fn()}
        ownerEntityId="session-1"
      />
    );

    await userEvent.click(
      screen.getByRole("button", {
        name: "Edit Related work for Session one",
      })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load references."
    );

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "No references available"
      )
    );
    expect(loadReferenceOptions).toHaveBeenCalledTimes(2);
  });
});

const NUMBER_FIELD: CustomFieldWithOptions = {
  createdAt: new Date("2026-08-25T12:00:00.000Z"),
  createdById: "user-1",
  currencyCode: null,
  customLabel: null,
  customLabelPosition: null,
  description: null,
  entityTypes: [CustomFieldEntityType.Session],
  enumOptions: [],
  fieldType: CustomFieldType.Number,
  id: "revision-count",
  isGlobalToOrg: false,
  isSearchable: false,
  isSortable: true,
  name: "Revision count",
  numberFormat: NumberFormat.None,
  organizationId: "org-1",
  precision: 0,
  referenceTargetSources: [],
  showInTable: true,
  updatedAt: new Date("2026-08-25T12:00:00.000Z"),
};

const NUMBER_VALUE: CustomFieldValueDetail = {
  customFieldId: NUMBER_FIELD.id,
  dateValue: null,
  displayValue: "12",
  entityId: "session-1",
  enumValue: null,
  fieldType: CustomFieldType.Number,
  id: "value-1",
  multiEnumValues: [],
  name: NUMBER_FIELD.name,
  numberValue: 12,
  peopleValues: [],
  referenceValues: [],
  showInTable: true,
  textValue: null,
};

const REFERENCE_FIELD: CustomFieldWithOptions = {
  ...NUMBER_FIELD,
  fieldType: CustomFieldType.ReferenceMulti,
  id: "related-work",
  name: "Related work",
  numberFormat: null,
  precision: null,
  referenceTargetSources: [ReferenceTargetSource.Artifact],
};

const SELECTED_TARGET: CustomFieldReferenceTarget = {
  artifactType: ArtifactType.Session,
  id: "selected-session",
  name: "Selected session",
  slug: "SES-1",
  status: "active",
  subtype: null,
};

const SEARCH_TARGET: CustomFieldReferenceTarget = {
  artifactType: ArtifactType.Branch,
  id: "search-branch",
  name: "Search custom fields",
  slug: "BRN-search",
  status: "active",
  subtype: null,
};

const REFERENCE_VALUE: CustomFieldValueDetail = {
  customFieldId: REFERENCE_FIELD.id,
  dateValue: null,
  displayValue: SELECTED_TARGET.slug,
  entityId: "session-1",
  enumValue: null,
  fieldType: CustomFieldType.ReferenceMulti,
  id: "reference-value-1",
  multiEnumValues: [],
  name: REFERENCE_FIELD.name,
  numberValue: null,
  peopleValues: [],
  referenceValues: [SELECTED_TARGET],
  showInTable: true,
  textValue: null,
};

const NUMBER_CELL_EDIT_LABEL = "Edit Revision count for Session one";

async function openNumberCellEditor() {
  const onValueChange = vi.fn();
  render(
    <CustomFieldTableCell
      field={NUMBER_FIELD}
      itemLabel="Session one"
      onValueChange={onValueChange}
      ownerEntityId="session-1"
      value={NUMBER_VALUE}
    />
  );

  await userEvent.click(
    screen.getByRole("button", { name: NUMBER_CELL_EDIT_LABEL })
  );
  const input = screen.getByRole("textbox", { name: NUMBER_CELL_EDIT_LABEL });
  await userEvent.clear(input);
  return { input, onValueChange };
}

const DATE_FIELD: CustomFieldWithOptions = {
  ...NUMBER_FIELD,
  fieldType: CustomFieldType.Date,
  id: "due",
  name: "Due",
  numberFormat: null,
  precision: null,
};

// `dateValue` is typed `Date | null`; the string form is what an unrevived
// extended-year wire value looks like at runtime, and the numeric form what a
// skewed producer sends.
function dateValue_(dateValue: Date | string | number): CustomFieldValueDetail {
  return {
    ...NUMBER_VALUE,
    customFieldId: DATE_FIELD.id,
    dateValue: dateValue as unknown as Date,
    displayValue: "Jan 1, 10000",
    fieldType: CustomFieldType.Date,
    id: "value-date",
    name: DATE_FIELD.name,
    numberValue: null,
  };
}
