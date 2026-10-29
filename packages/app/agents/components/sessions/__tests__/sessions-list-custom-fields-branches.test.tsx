import { ArtifactType } from "@repo/api/src/types/artifact";
import type {
  CreateCustomFieldInput,
  CustomFieldReferenceTarget,
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import { GROUP_EMPTY_VALUE } from "@repo/api/src/types/custom-field-capabilities";
import { CUSTOM_FIELD_EDITOR_CONTRACTS_FLAG_KEY } from "@repo/api/src/types/custom-field-editor-contracts-flag";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { FIELD_TYPE_LABELS } from "@repo/app/custom-fields/components/constants";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { TableCustomFieldType } from "@repo/design-system/components/ui/table-add-field-dialog";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import {
  buildSessionsCustomFieldColumns,
  buildSessionsCustomFieldFacetGroups,
  filterSessionsByCustomFields,
  isSessionsCustomFieldGroupable,
  renderSessionsCustomFieldCell,
  representableCustomFieldFilters,
  SESSION_CUSTOM_FIELD_WIDTH_PX,
  SessionsAddFieldDialog,
  type SessionsCustomFieldFilter,
  type SessionsCustomFieldsController,
  sessionsCustomFieldColumnId,
  sessionsCustomFieldGroupContribution,
  sortSessionsByCustomField,
} from "../sessions-list-custom-fields";

const FIELD_TITLE_PATTERN = /Field title/;
const STAGE_FIELD_OPTION = /stage-field/;

afterEach(cleanup);

describe("SessionsAddFieldDialog", () => {
  it("adds an existing field through the host callback when one is supplied", async () => {
    const onAddExistingField = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <SessionsAddFieldDialog
        controller={{
          availableFields: [field("stage-field", CustomFieldType.Enum)],
          fields: [],
          onAddExistingField,
          onCreateField: vi.fn(),
          valuesBySessionId: new Map(),
        }}
        onOpenChange={onOpenChange}
        open
      />
    );

    fireEvent.click(
      await screen.findByRole("option", { name: STAGE_FIELD_OPTION })
    );

    await waitFor(() =>
      expect(onAddExistingField).toHaveBeenCalledWith("stage-field")
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("opens straight on the create form when the host cannot add existing fields", () => {
    render(
      <SessionsAddFieldDialog
        controller={{
          fields: [],
          onCreateField: vi.fn(),
          valuesBySessionId: new Map(),
        }}
        onOpenChange={vi.fn()}
        open
      />
    );

    expect(
      screen.getByRole("textbox", { name: FIELD_TITLE_PATTERN })
    ).toBeInTheDocument();
    expect(screen.queryByText("Existing fields")).toBeNull();
  });

  it("passes a field with no enum options through unchanged under the colour gate", async () => {
    let captured: CreateCustomFieldInput | undefined;
    const onCreateField = vi.fn((input: CreateCustomFieldInput) => {
      captured = input;
      return field("created", CustomFieldType.Text);
    });
    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [CUSTOM_FIELD_EDITOR_CONTRACTS_FLAG_KEY],
        })}
      >
        <SessionsAddFieldDialog
          controller={{
            fields: [],
            onCreateField,
            valuesBySessionId: new Map(),
          }}
          onOpenChange={vi.fn()}
          open
        />
      </FeatureFlagAdapterProvider>
    );

    fireEvent.change(
      screen.getByRole("textbox", { name: FIELD_TITLE_PATTERN }),
      { target: { value: "Notes" } }
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Field type" }));
    fireEvent.click(
      await screen.findByRole("option", { name: TableCustomFieldType.Text })
    );
    fireEvent.click(screen.getByRole("button", { name: "Create field" }));

    await waitFor(() => expect(onCreateField).toHaveBeenCalledTimes(1));
    expect(captured?.name).toBe("Notes");
    expect(captured?.fieldType).toBe(CustomFieldType.Text);
    expect(captured?.enumOptions).toBeUndefined();
  });
});

describe("SessionsAddFieldDialog guards", () => {
  it("renders nothing when the host cannot create a field", () => {
    render(
      <SessionsAddFieldDialog
        controller={{ fields: [], valuesBySessionId: new Map() }}
        onOpenChange={vi.fn()}
        open
      />
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Add field")).toBeNull();
  });

  it("offers no existing field when the host lists none", async () => {
    render(
      <SessionsAddFieldDialog
        controller={{
          fields: [],
          onAddExistingField: vi.fn(),
          onCreateField: vi.fn(),
          valuesBySessionId: new Map(),
        }}
        onOpenChange={vi.fn()}
        open
      />
    );

    expect(await screen.findByText("No fields found")).toBeInTheDocument();
    expect(screen.queryByRole("option")).toBeNull();
  });
});

describe("buildSessionsCustomFieldColumns", () => {
  it("describes each shown field by id, label, width, and typed tooltip", () => {
    const enumField = field("stage", CustomFieldType.Enum);
    const hiddenField = {
      ...field("hidden", CustomFieldType.Text),
      showInTable: false,
    };

    expect(
      buildSessionsCustomFieldColumns(
        controllerWith([enumField, hiddenField], {})
      )
    ).toEqual([
      {
        customField: enumField,
        id: sessionsCustomFieldColumnId("stage"),
        label: "stage",
        minWidthPx: SESSION_CUSTOM_FIELD_WIDTH_PX,
        tooltip: `${FIELD_TYPE_LABELS[CustomFieldType.Enum]} field: stage`,
        width: `${SESSION_CUSTOM_FIELD_WIDTH_PX}px`,
      },
    ]);
  });
});

describe("renderSessionsCustomFieldCell", () => {
  it("forwards an edit to the host with the row and field, swallowing a rejected write", async () => {
    const textField = field("notes", CustomFieldType.Text);
    const sessionRow = createSessionTableRowFixture({
      id: "ses-1",
      name: "Session One",
    });
    const onValueChange = vi.fn().mockRejectedValue(new Error("write failed"));
    render(
      renderSessionsCustomFieldCell({
        controller: {
          fields: [textField],
          onValueChange,
          valuesBySessionId: new Map([[sessionRow.id, []]]),
        },
        field: textField,
        row: sessionRow,
      })
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit notes for Session One" })
    );
    const input = screen.getByRole("textbox", {
      name: "Edit notes for Session One",
    });
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(onValueChange).toHaveBeenCalledWith(sessionRow, textField, "hello")
    );
  });

  it("scopes reference search to the cell's field and row", async () => {
    const referenceField = field("linked", CustomFieldType.Reference);
    const sessionRow = createSessionTableRowFixture({
      id: "ses-2",
      name: "Session Two",
    });
    const searchReferenceTargets = vi
      .fn()
      .mockResolvedValue({ hasMore: false, targets: [] });
    render(
      renderSessionsCustomFieldCell({
        controller: {
          fields: [referenceField],
          onValueChange: vi.fn(),
          searchReferenceTargets,
          valuesBySessionId: new Map([[sessionRow.id, []]]),
        },
        field: referenceField,
        row: sessionRow,
      })
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit linked for Session Two" })
    );

    await waitFor(() =>
      expect(searchReferenceTargets).toHaveBeenCalledWith(
        referenceField,
        sessionRow,
        ""
      )
    );
  });

  it("withholds the editor and reference search from an operand-less row", () => {
    const referenceField = field("linked", CustomFieldType.Reference);
    const sessionRow = createSessionTableRowFixture({
      id: "ses-local",
      name: "Local Session",
    });
    const onValueChange = vi.fn();
    const searchReferenceTargets = vi.fn();

    render(
      renderSessionsCustomFieldCell({
        controller: {
          fields: [referenceField],
          isValueWritable: () => false,
          onValueChange,
          searchReferenceTargets,
          valuesBySessionId: new Map(),
        },
        field: referenceField,
        row: sessionRow,
      })
    );

    expect(
      screen.queryByRole("button", { name: "Edit linked for Local Session" })
    ).toBeNull();
    expect(onValueChange).not.toHaveBeenCalled();
    expect(searchReferenceTargets).not.toHaveBeenCalled();
  });
});

describe("sortSessionsByCustomField", () => {
  it("returns the rows in input order when the column is not a shown custom field", () => {
    const hidden = {
      ...field("hidden", CustomFieldType.Text),
      showInTable: false,
    };
    const controller = controllerWith([hidden], {
      a: [value(hidden, "a", { displayValue: "z" })],
      b: [value(hidden, "b", { displayValue: "a" })],
    });

    const sorted = sortSessionsByCustomField(
      [row("a"), row("b")],
      controller,
      sessionsCustomFieldColumnId("hidden"),
      "asc"
    );

    expect(sorted.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("orders descending with present empty text before unavailable projection", () => {
    const textField = field("notes", CustomFieldType.Text);
    const controller = controllerWith([textField], {
      alpha: [value(textField, "alpha", { displayValue: "alpha" })],
      beta: [value(textField, "beta", { displayValue: "beta" })],
      "null-display": [
        value(textField, "null-display", { displayValue: null }),
      ],
    });

    const sorted = sortSessionsByCustomField(
      [row("missing"), row("alpha"), row("null-display"), row("beta")],
      controller,
      sessionsCustomFieldColumnId("notes"),
      "desc"
    );

    expect(sorted.map((entry) => entry.id)).toEqual([
      "beta",
      "alpha",
      "null-display",
      "missing",
    ]);
  });

  it("orders a malformed stored date by its display text instead of NaN", () => {
    const dateField = field("due", CustomFieldType.Date);
    const controller = controllerWith([dateField], {
      bad: [
        value(dateField, "bad", {
          dateValue: new Date("not-a-date"),
          displayValue: "a-bad",
        }),
      ],
      good: [value(dateField, "good", { displayValue: "b-good" })],
    });

    const sorted = sortSessionsByCustomField(
      [row("bad"), row("good")],
      controller,
      sessionsCustomFieldColumnId("due"),
      "asc"
    );

    // Were the NaN kept, "NaN" would order after "b-good" as text.
    expect(sorted.map((entry) => entry.id)).toEqual(["bad", "good"]);
  });
});

describe("filterSessionsByCustomFields", () => {
  const numberField = field("points", CustomFieldType.Number);
  const enumField = field("stage", CustomFieldType.Enum);
  const labelsField = field("labels", CustomFieldType.MultiEnum);
  const controller = controllerWith([numberField, enumField, labelsField], {
    "enum-only": [
      value(enumField, "enum-only", { enumValue: enumOption("Done") }),
    ],
    high: [
      value(numberField, "high", { numberValue: 10 }),
      value(enumField, "high", { enumValue: enumOption("Done") }),
      value(labelsField, "high", {
        multiEnumValues: [enumOption("red"), enumOption("blue")],
      }),
    ],
    low: [value(numberField, "low", { numberValue: 1 })],
    mid: [value(numberField, "mid", { numberValue: 5 })],
    "no-number": [value(numberField, "no-number", { numberValue: null })],
  });
  const allRows = [
    row("low"),
    row("mid"),
    row("high"),
    row("no-number"),
    row("enum-only"),
    // Carries no custom-field values at all, so a range read must not assume one.
    row("no-value"),
  ];

  function filterIds(filters: [string, SessionsCustomFieldFilter][]) {
    return filterSessionsByCustomFields(
      allRows,
      controller,
      new Map(filters)
    ).map((entry) => entry.id);
  }

  it("keeps rows within an inclusive min and max, dropping rows with no number", () => {
    expect(
      filterIds([
        [
          sessionsCustomFieldColumnId("points"),
          { kind: "range", max: 5, min: 1 },
        ],
      ])
    ).toEqual(["low", "mid"]);
  });

  it("applies a min-only bound", () => {
    expect(
      filterIds([
        [sessionsCustomFieldColumnId("points"), { kind: "range", min: 5 }],
      ])
    ).toEqual(["mid", "high"]);
  });

  it("applies a max-only bound", () => {
    expect(
      filterIds([
        [sessionsCustomFieldColumnId("points"), { kind: "range", max: 1 }],
      ])
    ).toEqual(["low"]);
  });

  it("returns every row when the only range filter has no bounds", () => {
    expect(
      filterIds([[sessionsCustomFieldColumnId("points"), { kind: "range" }]])
    ).toEqual(["low", "mid", "high", "no-number", "enum-only", "no-value"]);
  });

  it("skips an inactive filter while applying an active one beside it", () => {
    // `enum-only` has no number value at all, so it survives only because the
    // bound-less range filter is skipped rather than applied.
    expect(
      filterIds([
        [sessionsCustomFieldColumnId("points"), { kind: "range" }],
        [
          sessionsCustomFieldColumnId("stage"),
          { kind: "options", selectedValues: ["Done"] },
        ],
      ])
    ).toEqual(["high", "enum-only"]);
  });

  it("keeps a row when any one of its multi-select options is selected", () => {
    expect(
      filterIds([
        [
          sessionsCustomFieldColumnId("labels"),
          // MULTI_ENUM facets are keyed by the option NAME, as the facet builder emits.
          { kind: "options", selectedValues: ["red"] },
        ],
      ])
    ).toEqual(["high"]);
  });
});

describe("buildSessionsCustomFieldFacetGroups", () => {
  it("builds a range group for a number field carrying its stored bounds", () => {
    const numberField = field("points", CustomFieldType.Number);
    const onRangeChange = vi.fn();
    const [group] = buildSessionsCustomFieldFacetGroups(
      controllerWith([numberField], {}),
      new Map([
        [
          sessionsCustomFieldColumnId("points"),
          { kind: "range", max: 9, min: 2 },
        ],
      ]),
      vi.fn(),
      onRangeChange
    );

    expect(group).toMatchObject({
      id: sessionsCustomFieldColumnId("points"),
      kind: "range",
      label: "points",
      max: 9,
      min: 2,
    });
    if (group?.kind !== "range") {
      throw new Error("expected a range group");
    }
    group.onChange({ min: 3 });
    expect(onRangeChange).toHaveBeenCalledWith(
      sessionsCustomFieldColumnId("points"),
      { min: 3 }
    );
  });

  it("names the range inputs and leaves both bounds unset with no stored filter", () => {
    const numberField = field("points", CustomFieldType.Number);
    const [group] = buildSessionsCustomFieldFacetGroups(
      controllerWith([numberField], {}),
      new Map(),
      vi.fn(),
      vi.fn()
    );

    if (group?.kind !== "range") {
      throw new Error("expected a range group");
    }
    expect(group.minPlaceholder).toBe("Min");
    expect(group.maxPlaceholder).toBe("Max");
    expect(group.min).toBeUndefined();
    expect(group.max).toBeUndefined();
  });

  it("omits a field the reader cannot search on", () => {
    const searchable = field("stage", CustomFieldType.Enum);
    const unsearchable = {
      ...field("secret", CustomFieldType.Enum),
      isSearchable: false,
    };

    const groups = buildSessionsCustomFieldFacetGroups(
      controllerWith([searchable, unsearchable], {}),
      new Map(),
      vi.fn(),
      vi.fn()
    );

    expect(groups.map((group) => group.label)).toEqual(["stage"]);
  });

  it("carries the stored option selection, and an empty one when nothing is stored", () => {
    const enumField = field("stage", CustomFieldType.Enum);
    const otherField = field("other", CustomFieldType.Enum);
    const onToggle = vi.fn();
    const groups = buildSessionsCustomFieldFacetGroups(
      controllerWith([enumField, otherField], {
        s1: [value(enumField, "s1", { enumValue: enumOption("Done") })],
      }),
      new Map([
        [
          sessionsCustomFieldColumnId("stage"),
          { kind: "options", selectedValues: ["Done"] },
        ],
      ]),
      onToggle,
      vi.fn()
    );
    const [stageGroup, otherGroup] = groups;

    if (stageGroup?.kind !== "options" || otherGroup?.kind !== "options") {
      throw new Error("expected two option groups");
    }
    expect(stageGroup.selectedValues).toEqual(["Done"]);
    expect(otherGroup.selectedValues).toEqual([]);
    stageGroup.onToggle("Done");
    expect(onToggle).toHaveBeenCalledWith(
      sessionsCustomFieldColumnId("stage"),
      "Done"
    );
  });

  it("names a single reference target by its slug", () => {
    const refField = field("link", CustomFieldType.Reference);
    const [group] = buildSessionsCustomFieldFacetGroups(
      controllerWith([refField], {
        s1: [
          value(refField, "s1", {
            referenceValues: [referenceTarget("t1", "ISS-9", "Named")],
          }),
        ],
      }),
      new Map(),
      vi.fn(),
      vi.fn()
    );

    if (group?.kind !== "options") {
      throw new Error("expected an options group");
    }
    expect(group.options).toEqual([{ id: "ISS-9", label: "ISS-9" }]);
  });

  it("leaves range bounds unset when the stored filter is an options filter", () => {
    const numberField = field("points", CustomFieldType.Number);
    const [group] = buildSessionsCustomFieldFacetGroups(
      controllerWith([numberField], {}),
      new Map([
        [
          sessionsCustomFieldColumnId("points"),
          { kind: "options", selectedValues: ["x"] },
        ],
      ]),
      vi.fn(),
      vi.fn()
    );

    expect(group).toMatchObject({ kind: "range" });
    if (group?.kind !== "range") {
      throw new Error("expected a range group");
    }
    expect(group.min).toBeUndefined();
    expect(group.max).toBeUndefined();
  });

  it("derives option labels per field type and ignores rows without a value", () => {
    const enumField = field("stage", CustomFieldType.Enum);
    const multiField = field("labels", CustomFieldType.MultiEnum);
    const refField = field("links", CustomFieldType.ReferenceMulti);
    const textField = field("notes", CustomFieldType.Text);
    const controller = controllerWith(
      [enumField, multiField, refField, textField],
      {
        empty: [
          value(enumField, "empty", { enumValue: null }),
          value(textField, "empty", { displayValue: "" }),
        ],
        full: [
          value(enumField, "full", { enumValue: enumOption("Review") }),
          value(multiField, "full", {
            multiEnumValues: [enumOption("red"), enumOption("blue")],
          }),
          value(refField, "full", {
            referenceValues: [
              referenceTarget("t1", "ISS-1", "Slugged"),
              referenceTarget("t2", null, "Unslugged"),
            ],
          }),
          value(textField, "full", { displayValue: "typed" }),
        ],
        missing: [],
      }
    );

    const groups = buildSessionsCustomFieldFacetGroups(
      controller,
      new Map(),
      vi.fn(),
      vi.fn()
    );
    const optionLabels = Object.fromEntries(
      groups.map((group) => [
        group.label,
        group.kind === "options"
          ? group.options.map((option) => option.label)
          : null,
      ])
    );

    expect(optionLabels).toEqual({
      labels: ["blue", "red"],
      links: ["ISS-1", "Unslugged"],
      notes: ["typed"],
      stage: ["Review"],
    });
  });
});

describe("custom-field sort value and comparison", () => {
  it("orders by the column's own value, not whichever value a row lists first", () => {
    const sortField = field("notes", CustomFieldType.Text);
    const decoyField = field("decoy", CustomFieldType.Text);
    const controller = controllerWith([sortField, decoyField], {
      first: [
        value(decoyField, "first", { displayValue: "a-decoy" }),
        value(sortField, "first", { displayValue: "z-sorted" }),
      ],
      second: [
        value(decoyField, "second", { displayValue: "z-decoy" }),
        value(sortField, "second", { displayValue: "a-sorted" }),
      ],
    });

    const sorted = sortSessionsByCustomField(
      [row("first"), row("second")],
      controller,
      sessionsCustomFieldColumnId("notes"),
      "asc"
    );

    expect(sorted.map((entry) => entry.id)).toEqual(["second", "first"]);
  });

  it("orders two numbers numerically rather than as text", () => {
    const numberField = field("points", CustomFieldType.Number);
    const controller = controllerWith([numberField], {
      bigger: [value(numberField, "bigger", { numberValue: 1.5 })],
      smaller: [value(numberField, "smaller", { numberValue: 1.25 })],
    });

    const sorted = sortSessionsByCustomField(
      [row("bigger"), row("smaller")],
      controller,
      sessionsCustomFieldColumnId("points"),
      "asc"
    );

    // A text compare puts "1.5" before "1.25"; the numeric one does not.
    expect(sorted.map((entry) => entry.id)).toEqual(["smaller", "bigger"]);
  });

  it("orders a number against untyped text without collapsing to an unordered compare", () => {
    const numberField = field("points", CustomFieldType.Number);
    const controller = controllerWith([numberField], {
      texty: [value(numberField, "texty", { displayValue: "abc" })],
      typed: [value(numberField, "typed", { numberValue: 10 })],
    });

    const sorted = sortSessionsByCustomField(
      [row("texty"), row("typed")],
      controller,
      sessionsCustomFieldColumnId("points"),
      "asc"
    );

    // Mixed kinds fall back to a text compare: "10" before "abc". A numeric
    // compare would produce NaN and leave the input order untouched.
    expect(sorted.map((entry) => entry.id)).toEqual(["typed", "texty"]);
  });

  it("orders numeric-looking text by its number, not character by character", () => {
    const textField = field("notes", CustomFieldType.Text);
    const controller = controllerWith([textField], {
      nine: [value(textField, "nine", { displayValue: "9" })],
      ten: [value(textField, "ten", { displayValue: "10" })],
    });

    const sorted = sortSessionsByCustomField(
      [row("ten"), row("nine")],
      controller,
      sessionsCustomFieldColumnId("notes"),
      "asc"
    );

    expect(sorted.map((entry) => entry.id)).toEqual(["nine", "ten"]);
  });
});

describe("representableCustomFieldFilters", () => {
  it("resolves each filter against its own column, not the first one", () => {
    const unsearchable = {
      ...field("hidden-facet", CustomFieldType.Text),
      isSearchable: false,
    };
    const searchable = field("stage", CustomFieldType.Enum);
    const columns = buildSessionsCustomFieldColumns(
      controllerWith([unsearchable, searchable], {})
    );
    const filter: SessionsCustomFieldFilter = {
      kind: "options",
      selectedValues: ["Done"],
    };

    const representable = representableCustomFieldFilters(
      new Map([[sessionsCustomFieldColumnId("stage"), filter]]),
      columns
    );

    expect([...representable]).toEqual([
      [sessionsCustomFieldColumnId("stage"), filter],
    ]);
  });

  it("drops a filter whose column is not searchable", () => {
    const unsearchable = {
      ...field("stage", CustomFieldType.Enum),
      isSearchable: false,
    };
    const columns = buildSessionsCustomFieldColumns(
      controllerWith([unsearchable], {})
    );

    expect(
      representableCustomFieldFilters(
        new Map([
          [
            sessionsCustomFieldColumnId("stage"),
            { kind: "options", selectedValues: ["Done"] },
          ],
        ]),
        columns
      ).size
    ).toBe(0);
  });
});

describe("isSessionsCustomFieldGroupable", () => {
  it.each([
    { expected: true, fieldType: CustomFieldType.Enum },
    { expected: true, fieldType: CustomFieldType.Date },
    { expected: true, fieldType: CustomFieldType.People },
    { expected: true, fieldType: CustomFieldType.Reference },
    { expected: false, fieldType: CustomFieldType.Text },
    { expected: false, fieldType: CustomFieldType.Number },
    { expected: false, fieldType: CustomFieldType.MultiEnum },
    { expected: false, fieldType: CustomFieldType.ReferenceMulti },
  ])("reports $fieldType as groupable=$expected", ({ expected, fieldType }) => {
    expect(isSessionsCustomFieldGroupable(field("f", fieldType))).toBe(
      expected
    );
  });
});

describe("sessionsCustomFieldGroupContribution", () => {
  it("writes the enum option id, not the label the cell rendered", () => {
    const enumField = field("stage", CustomFieldType.Enum);
    const option = enumOption("Done");
    const contribution = sessionsCustomFieldGroupContribution(
      controllerWith([enumField], {
        s1: [
          value(enumField, "s1", { displayValue: "Done", enumValue: option }),
        ],
      }),
      sessionsCustomFieldColumnId("stage"),
      "s1"
    );

    expect(contribution).toEqual({ key: "Done", value: option.id });
  });

  it("writes the empty value for a settable band with no stored value", () => {
    const refField = field("link", CustomFieldType.Reference);
    const contribution = sessionsCustomFieldGroupContribution(
      controllerWith([refField], { s1: [] }),
      sessionsCustomFieldColumnId("link"),
      "s1"
    );

    expect(contribution).toEqual({ key: "—", value: GROUP_EMPTY_VALUE });
  });

  it("offers no value for a band the capability table does not call settable", () => {
    const dateField = field("due", CustomFieldType.Date);
    const contribution = sessionsCustomFieldGroupContribution(
      controllerWith([dateField], { s1: [] }),
      sessionsCustomFieldColumnId("due"),
      "s1"
    );

    expect(contribution).toEqual({ key: "—", value: undefined });
  });

  it("offers no value for a column with no custom field behind it", () => {
    const contribution = sessionsCustomFieldGroupContribution(
      controllerWith([], { s1: [] }),
      sessionsCustomFieldColumnId("gone"),
      "s1"
    );

    expect(contribution).toEqual({ key: "—", value: undefined });
  });

  it("writes the empty value for a reference cell with no targets", () => {
    const refField = field("link", CustomFieldType.Reference);
    const contribution = sessionsCustomFieldGroupContribution(
      controllerWith([refField], {
        s1: [value(refField, "s1", { displayValue: "", referenceValues: [] })],
      }),
      sessionsCustomFieldColumnId("link"),
      "s1"
    );

    expect(contribution).toEqual({ key: "—", value: "" });
  });
});

function field(
  id: string,
  fieldType: CustomFieldWithOptions["fieldType"]
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
    id,
    isGlobalToOrg: false,
    isSearchable: true,
    isSortable: true,
    name: id,
    numberFormat: NumberFormat.None,
    organizationId: "org-1",
    precision: null,
    referenceTargetSources: [],
    showInTable: true,
    updatedAt: new Date("2026-08-25T12:00:00.000Z"),
  };
}

function value(
  owner: CustomFieldWithOptions,
  entityId: string,
  overrides: Partial<CustomFieldValueDetail>
): CustomFieldValueDetail {
  return {
    customFieldId: owner.id,
    dateValue: null,
    displayValue: null,
    entityId,
    enumValue: null,
    fieldType: owner.fieldType,
    id: `${owner.id}-${entityId}`,
    multiEnumValues: [],
    name: owner.name,
    numberValue: null,
    peopleValues: [],
    referenceValues: [],
    showInTable: true,
    textValue: null,
    ...overrides,
  };
}

function enumOption(name: string) {
  return {
    color: "gray",
    customFieldId: "field",
    enabled: true,
    id: `option-${name}`,
    name,
    sortOrder: 0,
  };
}

function referenceTarget(
  id: string,
  slug: string | null,
  name: string
): CustomFieldReferenceTarget {
  return {
    artifactType: ArtifactType.Document,
    id,
    name,
    slug,
    status: "open",
    subtype: null,
  };
}

function controllerWith(
  fields: CustomFieldWithOptions[],
  values: Record<string, CustomFieldValueDetail[]>
): SessionsCustomFieldsController {
  return { fields, valuesBySessionId: new Map(Object.entries(values)) };
}

function row(id: string): SessionTableRow {
  return createSessionTableRowFixture({ id, name: id });
}
