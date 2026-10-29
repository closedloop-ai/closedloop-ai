/**
 * PRD-722 (ISS-9349, ISS-12642): the Session custom-field grid's SCALAR,
 * PEOPLE and REFERENCE branches on the champions, behind the same
 * `gridview-adoption` gate the CHOICE branch already sits behind.
 *
 * The defect this closes: each of those branches handed the host's write to a
 * helper that swallowed its rejection and closed, so a value the server
 * refused stayed on screen (the scalar draft, the picked person, the picked
 * target). Every case below asserts what the CELL SHOWS after a refused write
 * settles, not that a handler was called, because the broken editors called it
 * too.
 *
 * Fixtures carry two candidates with different names (two people, two
 * targets, two values), so "it reverted to the confirmed one" cannot be
 * satisfied by a cell that simply shows the first.
 */

import { ArtifactType } from "@repo/api/src/types/artifact";
import type {
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
import type { BasicUser } from "@repo/api/src/types/user";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY,
  CUSTOM_FIELD_VALUE_CLEAR_FEATURE_FLAG_KEY,
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { INLINE_SCALAR_NUMBER_INVALID_MESSAGE } from "@repo/app/shared/lib/inline-scalar-invalid-message";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INVALID_DATE_MESSAGE } from "../constants";
import { CustomFieldTableCell } from "../custom-field-table-cell";

afterEach(cleanup);

const ITEM_LABEL = "Row one";
const OWNER_ID = "entity-1";
const EXTENDED_YEAR_ISO = "+010000-01-01T00:00:00.000Z";
const FIRST_TARGET_NAME = /First session/;
const SECOND_TARGET = /Second session/;

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

const FIRST_TARGET: CustomFieldReferenceTarget = {
  artifactType: ArtifactType.Session,
  id: "target-1",
  name: "First session",
  slug: "SES-1",
  status: "active",
  subtype: null,
};

const OTHER_TARGET: CustomFieldReferenceTarget = {
  artifactType: ArtifactType.Session,
  id: "target-2",
  name: "Second session",
  slug: "SES-2",
  status: "active",
  subtype: null,
};

function field(
  fieldType: CustomFieldType,
  name: string,
  overrides: Partial<CustomFieldWithOptions> = {}
): CustomFieldWithOptions {
  return {
    createdAt: new Date("2026-08-25T12:00:00.000Z"),
    createdById: "user-1",
    currencyCode: null,
    customLabel: null,
    customLabelPosition: null,
    description: null,
    entityTypes: [CustomFieldEntityType.Session],
    enumOptions: [],
    fieldType,
    id: `field-${name}`,
    isGlobalToOrg: false,
    isSearchable: false,
    isSortable: true,
    name,
    numberFormat: null,
    organizationId: "org-1",
    precision: null,
    referenceTargetSources: [ReferenceTargetSource.Session],
    showInTable: true,
    updatedAt: new Date("2026-08-25T12:00:00.000Z"),
    ...overrides,
  };
}

function stored(
  target: CustomFieldWithOptions,
  overrides: Partial<CustomFieldValueDetail>
): CustomFieldValueDetail {
  return {
    customFieldId: target.id,
    dateValue: null,
    displayValue: null,
    entityId: OWNER_ID,
    enumValue: null,
    fieldType: target.fieldType,
    id: `value-${target.id}`,
    multiEnumValues: [],
    name: target.name,
    numberValue: null,
    peopleValues: [],
    referenceValues: [],
    showInTable: true,
    textValue: null,
    ...overrides,
  };
}

function renderCell(
  node: ReactElement,
  { gate = true, flags = [] }: { gate?: boolean; flags?: string[] } = {}
) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: gate
          ? [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY, ...flags]
          : flags,
      })}
    >
      {node}
    </FeatureFlagAdapterProvider>
  );
}

function refusing() {
  return vi.fn().mockRejectedValue(new Error("the server refused it"));
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("scalar branch on InlineScalarCell", () => {
  const notes = field(CustomFieldType.Text, "Notes");

  it("puts the confirmed text back in the field when the write is refused", async () => {
    const onValueChange = refusing();
    renderCell(
      <CustomFieldTableCell
        field={notes}
        itemLabel={ITEM_LABEL}
        onValueChange={onValueChange}
        ownerEntityId={OWNER_ID}
        value={stored(notes, { textValue: "kept" })}
      />
    );
    const input = screen.getByRole("textbox", { name: "Notes for Row one" });

    fireEvent.change(input, { target: { value: "refused" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await settle();

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("refused");
    await waitFor(() => expect(input).toHaveValue("kept"));
  });

  it("refuses an unparseable number in the canonical words and sends nothing", () => {
    const estimate = field(CustomFieldType.Number, "Estimate");
    const onValueChange = vi.fn();
    renderCell(
      <CustomFieldTableCell
        field={estimate}
        itemLabel={ITEM_LABEL}
        onValueChange={onValueChange}
        ownerEntityId={OWNER_ID}
        value={stored(estimate, { numberValue: 3, displayValue: "3" })}
      />
    );
    const input = screen.getByRole("textbox", { name: "Estimate for Row one" });

    fireEvent.change(input, { target: { value: "three" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onValueChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("three");
    expect(
      screen.getByText(INLINE_SCALAR_NUMBER_INVALID_MESSAGE)
    ).toBeInTheDocument();
  });

  it("commits a duration through the duration codec and never on an untouched blur", () => {
    const span = field(CustomFieldType.Number, "Span", {
      numberFormat: NumberFormat.Duration,
    });
    const onValueChange = vi.fn();
    renderCell(
      <CustomFieldTableCell
        field={span}
        itemLabel={ITEM_LABEL}
        onValueChange={onValueChange}
        ownerEntityId={OWNER_ID}
        value={stored(span, {
          numberValue: 4_350_500,
          displayValue: "1h 12m",
        })}
      />,
      { flags: [CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY] }
    );
    const input = screen.getByRole("textbox", { name: "Span for Row one" });
    expect(input).toHaveValue("1h 12m");

    fireEvent.blur(input);
    expect(onValueChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith(90_000);
  });

  it("edits a healthy date through the picker, not a native date input", () => {
    const due = field(CustomFieldType.Date, "Due");
    const { container } = renderCell(
      <CustomFieldTableCell
        field={due}
        itemLabel={ITEM_LABEL}
        onValueChange={vi.fn()}
        ownerEntityId={OWNER_ID}
        value={stored(due, {
          dateValue: new Date("2026-08-07T12:00:00.000Z"),
          displayValue: "Aug 7, 2026",
        })}
      />
    );

    expect(container.querySelector('input[type="date"]')).toBeNull();
    expect(
      screen.getByRole("button", { name: "Due for Row one: Aug 7, 2026" })
    ).toBeInTheDocument();
  });

  it("edits a poison date as its raw text, refuses it, and clears it when emptied", () => {
    const due = field(CustomFieldType.Date, "Due");
    const onValueChange = vi.fn();
    renderCell(
      <CustomFieldTableCell
        field={due}
        itemLabel={ITEM_LABEL}
        onValueChange={onValueChange}
        ownerEntityId={OWNER_ID}
        value={stored(due, {
          // The wire reviver leaves an extended-year string unrevived.
          dateValue: EXTENDED_YEAR_ISO as unknown as Date,
          displayValue: "Jan 1, 10000",
        })}
      />
    );
    const input = screen.getByRole("textbox", { name: "Due for Row one" });
    expect(input).toHaveValue(EXTENDED_YEAR_ISO);

    fireEvent.change(input, { target: { value: "10000-01-02" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText(INVALID_DATE_MESSAGE)).toBeInTheDocument();
    expect(onValueChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("rests a formatted number on its display text and puts it back when a write is refused", async () => {
    const budget = field(CustomFieldType.Number, "Budget", {
      numberFormat: NumberFormat.Currency,
      currencyCode: "USD",
    });
    const onValueChange = refusing();
    renderCell(
      <CustomFieldTableCell
        field={budget}
        itemLabel={ITEM_LABEL}
        onValueChange={onValueChange}
        ownerEntityId={OWNER_ID}
        value={stored(budget, {
          numberValue: 1234.5,
          displayValue: "$1,234.50",
        })}
      />
    );
    const input = screen.getByRole("textbox", { name: "Budget for Row one" });

    expect(screen.getByText("$1,234.50")).toBeVisible();
    expect(input).toHaveAccessibleDescription("$1,234.50");

    fireEvent.focus(input);
    expect(input).toHaveValue("1234.5");
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.blur(input);
    await settle();

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith(99);
    expect(input).toHaveValue("1234.5");
    expect(screen.getByText("$1,234.50")).toBeVisible();
  });

  it("rests on the formatted text after saving an equivalent spelling of the same number", async () => {
    const budget = field(CustomFieldType.Number, "Budget", {
      numberFormat: NumberFormat.Currency,
      currencyCode: "USD",
    });
    const onValueChange = vi.fn(() => Promise.resolve());
    renderCell(
      <CustomFieldTableCell
        field={budget}
        itemLabel={ITEM_LABEL}
        onValueChange={onValueChange}
        ownerEntityId={OWNER_ID}
        value={stored(budget, {
          numberValue: 1234.5,
          displayValue: "$1,234.50",
        })}
      />
    );
    const input = screen.getByRole("textbox", { name: "Budget for Row one" });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "1234.50" } });
    fireEvent.blur(input);
    await settle();

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith(1234.5);
    expect(screen.getByText("$1,234.50")).toBeVisible();
  });

  it("keeps a poison date with no readable text on the legacy editor", () => {
    const due = field(CustomFieldType.Date, "Due");
    renderCell(
      <CustomFieldTableCell
        field={due}
        itemLabel={ITEM_LABEL}
        onValueChange={vi.fn()}
        ownerEntityId={OWNER_ID}
        value={stored(due, {
          dateValue: new Date("2026-99-99T00:00:00.000Z"),
          displayValue: "Jan 1, 10000",
        })}
      />
    );

    // Still readable, and still reachable through the legacy editor's button.
    expect(screen.getByText("Jan 1, 10000")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Edit Due for Row one" })
    ).toBeInTheDocument();
  });

  it("keeps the legacy editor while the gate is closed", () => {
    renderCell(
      <CustomFieldTableCell
        field={notes}
        itemLabel={ITEM_LABEL}
        onValueChange={vi.fn()}
        ownerEntityId={OWNER_ID}
        value={stored(notes, { textValue: "kept" })}
      />,
      { gate: false }
    );

    expect(
      screen.getByRole("button", { name: "Edit Notes for Row one" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("people branch on InlineMultiSelectCell", () => {
  const reviewers = field(CustomFieldType.People, "Reviewers");

  // ISS-12938 visual QA: the searchable people picker is the same Popover and
  // Command search the Reference column beside it opens, so it is a dialog
  // holding a combobox over options, not a menu.
  function openPicker(name: string) {
    fireEvent.click(screen.getByRole("button", { name }));
    return screen.getByRole("dialog");
  }

  it("puts the confirmed people back when the toggle is refused", async () => {
    const onValueChange = refusing();
    renderCell(
      <CustomFieldTableCell
        field={reviewers}
        itemLabel={ITEM_LABEL}
        onValueChange={onValueChange}
        ownerEntityId={OWNER_ID}
        peopleOptions={[ADA, GRACE]}
        value={stored(reviewers, { peopleValues: [ADA] })}
      />
    );

    const picker = openPicker(
      "Edit Reviewers for Row one, currently Ada Lovelace"
    );
    fireEvent.click(
      within(picker).getByRole("option", { name: "Grace Hopper" })
    );
    await settle();

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith([ADA.id, GRACE.id]);
    // The picker stays open across picks; close it so the trigger is reachable.
    fireEvent.keyDown(within(picker).getByRole("combobox"), { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Edit Reviewers for Row one, currently Ada Lovelace",
        })
      ).toBeInTheDocument()
    );
  });

  it("keeps the people search the legacy editor offered", () => {
    renderCell(
      <CustomFieldTableCell
        field={reviewers}
        itemLabel={ITEM_LABEL}
        onValueChange={vi.fn()}
        ownerEntityId={OWNER_ID}
        peopleOptions={[ADA, GRACE]}
        value={stored(reviewers, {})}
      />
    );

    const picker = openPicker("Set Reviewers for Row one");
    const search = within(picker).getByRole("combobox", {
      name: "Search Reviewers people",
    });
    expect(search).toHaveAttribute("placeholder", "Search people…");
    fireEvent.change(search, { target: { value: "zz" } });

    expect(within(picker).getByText("No matching people")).toBeInTheDocument();
  });
});

describe("reference branch on InlineReferenceCell", () => {
  const links = field(CustomFieldType.Reference, "Links");

  it("puts the confirmed target back when the pick is refused", async () => {
    const onValueChange = refusing();
    renderCell(
      <CustomFieldTableCell
        field={links}
        itemLabel={ITEM_LABEL}
        onValueChange={onValueChange}
        ownerEntityId={OWNER_ID}
        referenceOptions={[FIRST_TARGET, OTHER_TARGET]}
        value={stored(links, { referenceValues: [FIRST_TARGET] })}
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit Links for Row one, currently SES-1",
      })
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("option", {
        name: SECOND_TARGET,
      })
    );
    await settle();

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith(OTHER_TARGET.id);
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Edit Links for Row one, currently SES-1",
        })
      ).toBeInTheDocument()
    );
  });

  it("clears with null, never an empty set", async () => {
    const onValueChange = vi.fn();
    renderCell(
      <CustomFieldTableCell
        field={links}
        itemLabel={ITEM_LABEL}
        onValueChange={onValueChange}
        ownerEntityId={OWNER_ID}
        referenceOptions={[FIRST_TARGET, OTHER_TARGET]}
        value={stored(links, { referenceValues: [FIRST_TARGET] })}
      />,
      { flags: [CUSTOM_FIELD_VALUE_CLEAR_FEATURE_FLAG_KEY] }
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit Links for Row one, currently SES-1",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear Links" }));
    await settle();

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("names a queued pick after the search list it came from has changed", async () => {
    const many = field(CustomFieldType.ReferenceMulti, "Related");
    const settles: Array<() => void> = [];
    const onValueChange = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settles.push(resolve);
        })
    );
    renderCell(
      <CustomFieldTableCell
        field={many}
        itemLabel={ITEM_LABEL}
        onValueChange={onValueChange}
        ownerEntityId={OWNER_ID}
        referenceOptions={[FIRST_TARGET, OTHER_TARGET]}
        value={stored(many, { referenceValues: [] })}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Set Related for Row one" })
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("option", { name: FIRST_TARGET_NAME })
    );
    fireEvent.click(
      within(dialog).getByRole("option", { name: SECOND_TARGET })
    );
    // A new query empties the list while the second pick waits its turn.
    fireEvent.change(within(dialog).getByRole("combobox"), {
      target: { value: "no such session" },
    });
    await act(async () => {
      settles[0]?.();
      await Promise.resolve();
    });
    await settle();

    expect(
      screen.getByRole("button", {
        name: "Edit Related for Row one, currently SES-1, SES-2",
      })
    ).toBeInTheDocument();
  });

  it("toggles a multi reference as a whole set", async () => {
    const many = field(CustomFieldType.ReferenceMulti, "Related");
    const onValueChange = vi.fn();
    renderCell(
      <CustomFieldTableCell
        field={many}
        itemLabel={ITEM_LABEL}
        onValueChange={onValueChange}
        ownerEntityId={OWNER_ID}
        referenceOptions={[FIRST_TARGET, OTHER_TARGET]}
        value={stored(many, { referenceValues: [FIRST_TARGET] })}
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit Related for Row one, currently SES-1",
      })
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("option", {
        name: SECOND_TARGET,
      })
    );
    await settle();

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith([
      FIRST_TARGET.id,
      OTHER_TARGET.id,
    ]);
    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });

  it("keeps the legacy editor while the gate is closed", () => {
    renderCell(
      <CustomFieldTableCell
        field={links}
        itemLabel={ITEM_LABEL}
        onValueChange={vi.fn()}
        ownerEntityId={OWNER_ID}
        referenceOptions={[FIRST_TARGET, OTHER_TARGET]}
        value={stored(links, { referenceValues: [FIRST_TARGET] })}
      />,
      { gate: false }
    );

    expect(
      screen.getByRole("button", { name: "Edit Links for Row one" })
    ).toBeInTheDocument();
  });
});
