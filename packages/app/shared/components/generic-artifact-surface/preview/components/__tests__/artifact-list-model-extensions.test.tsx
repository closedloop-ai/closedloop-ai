// @vitest-environment jsdom

import type { FilterMenuGroup } from "@repo/design-system/components/ui/filter-popover";
import { TableCustomFieldType } from "@repo/design-system/components/ui/table-add-field-dialog";
import { ColumnFieldKind } from "@repo/design-system/lib/column-registry";
import { describe, expect, it } from "vitest";
import { type GenericArtifact, genericArtifacts } from "../../fixtures";
import {
  type ArtifactListColumnExtension,
  buildExtensionFilterGroups,
  buildSummaryMetrics,
  type CustomFieldFilter,
  columnWidthBounds,
  genericSummaryMetricDefinitions,
  isCustomFieldGroupable,
  isCustomFieldSortable,
  matchesExtensionFilters,
  median,
} from "../artifact-list-model";
import { createStateSetter } from "./support/state-setter";

const template = genericArtifacts[0]!;

function extensionColumn(
  id: string,
  overrides: Partial<ArtifactListColumnExtension> = {}
): ArtifactListColumnExtension {
  return {
    filterable: true,
    id,
    kind: ColumnFieldKind.Custom,
    label: `Column ${id}`,
    renderCell: () => null,
    width: columnWidthBounds(100),
    ...overrides,
  };
}

function withRange(
  group: FilterMenuGroup | undefined
): Extract<FilterMenuGroup, { kind: "range" }> {
  if (group?.kind !== "range") {
    throw new Error("expected a range facet");
  }
  return group;
}

function withOptions(
  group: FilterMenuGroup | undefined
): Exclude<FilterMenuGroup, { kind: "range" }> {
  if (!group || group.kind === "range") {
    throw new Error("expected an options facet");
  }
  return group;
}

describe("custom field capabilities", () => {
  it("withholds sorting from multi-value fields only", () => {
    expect(
      isCustomFieldSortable({
        id: "a",
        label: "A",
        type: TableCustomFieldType.MultiSelect,
      })
    ).toBe(false);
    expect(
      isCustomFieldSortable({
        id: "b",
        label: "B",
        type: TableCustomFieldType.ReferenceMulti,
      })
    ).toBe(false);
    expect(
      isCustomFieldSortable({
        id: "c",
        label: "C",
        type: TableCustomFieldType.Number,
      })
    ).toBe(true);
  });

  it("allows grouping by single-value categorical fields only", () => {
    const groupable = [
      TableCustomFieldType.SingleSelect,
      TableCustomFieldType.Date,
      TableCustomFieldType.People,
      TableCustomFieldType.Reference,
    ];
    const ungroupable = [
      TableCustomFieldType.MultiSelect,
      TableCustomFieldType.ReferenceMulti,
      TableCustomFieldType.Time,
      TableCustomFieldType.Text,
      TableCustomFieldType.Number,
    ];

    for (const type of groupable) {
      expect(isCustomFieldGroupable({ id: type, label: type, type })).toBe(
        true
      );
    }
    for (const type of ungroupable) {
      expect(isCustomFieldGroupable({ id: type, label: type, type })).toBe(
        false
      );
    }
  });
});

describe("summary metrics", () => {
  it("takes the middle value, the mean of the two middles, or zero", () => {
    expect(median([])).toBe(0);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("formats one value per metric definition", () => {
    const rows: GenericArtifact[] = [
      { ...template, activityCount: 3, aiSpend: 1, outcomeScore: 50 },
      { ...template, activityCount: 5, aiSpend: 3, outcomeScore: 71 },
    ];

    const metrics = buildSummaryMetrics(rows);

    expect(metrics.map((metric) => metric.key)).toEqual(
      genericSummaryMetricDefinitions.map((definition) => definition.key)
    );
    expect(metrics.map((metric) => metric.value)).toEqual([
      "2",
      "$4.00",
      "$2.00",
      "4",
      "61%",
    ]);
  });

  it("reports zeroes for an empty population", () => {
    expect(buildSummaryMetrics([]).map((metric) => metric.value)).toEqual([
      "0",
      "$0.00",
      "$0.00",
      "0",
      "0%",
    ]);
  });
});

describe("buildExtensionFilterGroups", () => {
  const rows: GenericArtifact[] = [
    { ...template, id: "a", tags: ["red", "blue"] },
    { ...template, id: "b", tags: ["blue", ""] },
  ];

  it("skips columns that are not filterable or carry no filter accessor", () => {
    const groups = buildExtensionFilterGroups(
      [
        extensionColumn("hidden", {
          filterable: false,
          filterValues: (artifact) => [...artifact.tags],
        }),
        extensionColumn("bare"),
      ],
      rows,
      {},
      () => undefined
    );

    expect(groups).toEqual([]);
  });

  it("builds a range facet and writes its bounds under the column id", () => {
    const state = createStateSetter<Record<string, CustomFieldFilter>>({
      spend: { max: 10, min: 1 },
    });

    const range = withRange(
      buildExtensionFilterGroups(
        [
          extensionColumn("spend", {
            filterRange: (artifact) => artifact.aiSpend,
            filterValues: (artifact) => [...artifact.tags],
          }),
        ],
        rows,
        state.current(),
        state.set
      )[0]
    );

    expect(range).toMatchObject({
      id: "spend",
      label: "Column spend",
      max: 10,
      maxPlaceholder: "Max",
      min: 1,
      minPlaceholder: "Min",
    });
    range.onChange({ max: 4 });
    expect(state.current()).toEqual({ spend: { max: 4 } });
  });

  it("offers distinct non-empty values and toggles a selection", () => {
    const state = createStateSetter<Record<string, CustomFieldFilter>>({});
    const column = extensionColumn("tagged", {
      filterValues: (artifact) => [...artifact.tags],
    });
    const build = () =>
      withOptions(
        buildExtensionFilterGroups(
          [column],
          rows,
          state.current(),
          state.set
        )[0]
      );

    expect(build().options).toEqual([
      { id: "red", label: "red" },
      { id: "blue", label: "blue" },
    ]);
    expect(build().selectedValues).toEqual([]);

    build().onToggle("blue");
    expect(state.current()).toEqual({ tagged: { selectedValues: ["blue"] } });
    expect(build().selectedValues).toEqual(["blue"]);
    build().onToggle("blue");
    expect(state.current()).toEqual({ tagged: { selectedValues: [] } });
  });

  it("attaches no icon to a known or an unknown column's facet (ISS-12919)", () => {
    const groups = buildExtensionFilterGroups(
      [
        extensionColumn("comments", { filterValues: () => ["x"] }),
        extensionColumn("somethingElse", { filterValues: () => ["x"] }),
      ],
      rows,
      {},
      () => undefined
    );

    expect(groups).toHaveLength(2);
    expect(groups.every((group) => !("icon" in group))).toBe(true);
  });
});

describe("matchesExtensionFilters", () => {
  const artifact: GenericArtifact = { ...template, aiSpend: 5, tags: ["red"] };
  const spend = extensionColumn("spend", {
    filterRange: (row) => row.aiSpend,
  });
  const tagged = extensionColumn("tagged", {
    filterValues: (row) => [...row.tags],
  });
  const unfilterable = extensionColumn("plain");

  it("holds a range value inside inclusive bounds", () => {
    expect(matchesExtensionFilters(artifact, [spend], {})).toBe(true);
    expect(
      matchesExtensionFilters(artifact, [spend], { spend: { max: 5, min: 5 } })
    ).toBe(true);
    expect(
      matchesExtensionFilters(artifact, [spend], { spend: { min: 6 } })
    ).toBe(false);
    expect(
      matchesExtensionFilters(artifact, [spend], { spend: { max: 4 } })
    ).toBe(false);
  });

  it("matches any selected value and ignores a selection on a column with no values", () => {
    expect(matchesExtensionFilters(artifact, [tagged], {})).toBe(true);
    expect(
      matchesExtensionFilters(artifact, [tagged], {
        tagged: { selectedValues: [] },
      })
    ).toBe(true);
    expect(
      matchesExtensionFilters(artifact, [tagged], {
        tagged: { selectedValues: ["blue", "red"] },
      })
    ).toBe(true);
    expect(
      matchesExtensionFilters(artifact, [tagged], {
        tagged: { selectedValues: ["blue"] },
      })
    ).toBe(false);
    expect(
      matchesExtensionFilters(artifact, [unfilterable], {
        plain: { selectedValues: ["blue"] },
      })
    ).toBe(true);
  });
});
