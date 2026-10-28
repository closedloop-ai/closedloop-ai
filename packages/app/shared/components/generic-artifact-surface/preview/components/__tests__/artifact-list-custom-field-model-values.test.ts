import type { FilterMenuGroup } from "@repo/design-system/components/ui/filter-popover";
import {
  type TableCustomFieldDefinition as CustomFieldDefinition,
  TableCustomFieldType,
} from "@repo/design-system/components/ui/table-add-field-dialog";
import { describe, expect, it } from "vitest";
import {
  ArtifactKind,
  type GenericArtifact,
  genericArtifacts,
} from "../../fixtures";
import {
  buildCustomFieldFilterGroups,
  customFieldReferenceValues,
  customFieldValues,
  matchesCustomFieldFilters,
} from "../artifact-list-custom-field-model";
import type { CustomFieldFilter } from "../artifact-list-model";
import { createStateSetter } from "./support/state-setter";

const template = genericArtifacts[0]!;

/** A row whose id and five-letter title make every derived value predictable. */
function row(
  id: string,
  overrides: Partial<GenericArtifact> = {}
): GenericArtifact {
  return { ...template, id, title: "abcde", ...overrides };
}

function field(
  type: CustomFieldDefinition["type"],
  overrides: Partial<CustomFieldDefinition> = {}
): CustomFieldDefinition {
  return { id: `field-${type}`, label: `Field ${type}`, type, ...overrides };
}

function slugsOfKind(kind: ArtifactKind): string[] {
  return genericArtifacts
    .filter((artifact) => artifact.kind === kind)
    .map((artifact) => artifact.slug);
}

function isRangeGroup(
  group: FilterMenuGroup | undefined
): group is Extract<FilterMenuGroup, { kind: "range" }> {
  return group?.kind === "range";
}

function optionGroup(
  group: FilterMenuGroup | undefined
): Exclude<FilterMenuGroup, { kind: "range" }> {
  if (!group || isRangeGroup(group)) {
    throw new Error("expected an options facet");
  }
  return group;
}

const OPTIONS = ["Alpha", "Beta", "Gamma"];

describe("customFieldValues", () => {
  it("returns a created number as the numeric value", () => {
    const artifact = row("artifact-1", { creationValues: { score: 7 } });

    expect(
      customFieldValues(
        artifact,
        field(TableCustomFieldType.Number, { id: "score" }),
        []
      )
    ).toEqual({ numericValue: 7, textValues: [] });
  });

  it("returns a created string as one text value and an empty one as none", () => {
    const filled = row("artifact-1", { creationValues: { note: "hello" } });
    const blank = row("artifact-1", { creationValues: { note: "" } });
    const noteField = field(TableCustomFieldType.Text, { id: "note" });

    expect(customFieldValues(filled, noteField, [])).toEqual({
      textValues: ["hello"],
    });
    expect(customFieldValues(blank, noteField, [])).toEqual({ textValues: [] });
  });

  it("copies a created list", () => {
    const created = ["one", "two"] as const;
    const artifact = row("artifact-1", { creationValues: { picks: created } });

    const values = customFieldValues(
      artifact,
      field(TableCustomFieldType.MultiSelect, { id: "picks" }),
      []
    );

    expect(values).toEqual({ textValues: ["one", "two"] });
    expect(values.textValues).not.toBe(created);
  });

  it("falls through a null created value to the demo value", () => {
    const artifact = row("artifact-1", {
      creationValues: { [`field-${TableCustomFieldType.Text}`]: null },
    });

    expect(
      customFieldValues(artifact, field(TableCustomFieldType.Text), [])
    ).toEqual({ textValues: ["Custom text value"] });
  });

  it("leaves every third fixture id empty regardless of field type", () => {
    for (const type of [
      TableCustomFieldType.Text,
      TableCustomFieldType.Number,
      TableCustomFieldType.People,
    ]) {
      expect(customFieldValues(row("artifact-3"), field(type), [])).toEqual({
        textValues: [],
      });
    }
    expect(
      customFieldValues(row("artifact-6"), field(TableCustomFieldType.Text), [])
    ).toEqual({ textValues: [] });
  });

  it("reads the whole last dash-separated segment of the id", () => {
    const text = field(TableCustomFieldType.Text);

    expect(customFieldValues(row("artifact-12"), text, [])).toEqual({
      textValues: [],
    });
    expect(customFieldValues(row("row-x-3"), text, [])).toEqual({
      textValues: [],
    });
    expect(customFieldValues(row("row-3-x"), text, [])).toEqual({
      textValues: ["Custom text value"],
    });
  });

  it("treats an id with no numeric suffix as populated", () => {
    expect(
      customFieldValues(row("draft-row"), field(TableCustomFieldType.Text), [])
    ).toEqual({ textValues: ["Custom text value"] });
  });

  it("derives a demo value per field type from the row title", () => {
    const artifact = row("artifact-1");

    expect(
      customFieldValues(
        artifact,
        field(TableCustomFieldType.SingleSelect, { options: OPTIONS }),
        []
      )
    ).toEqual({ textValues: ["Gamma"] });
    expect(
      customFieldValues(
        artifact,
        field(TableCustomFieldType.MultiSelect, { options: OPTIONS }),
        []
      )
    ).toEqual({ textValues: ["Alpha", "Beta"] });
    expect(
      customFieldValues(artifact, field(TableCustomFieldType.Date), [])
    ).toEqual({ textValues: ["Jul 25, 2026"] });
    expect(
      customFieldValues(artifact, field(TableCustomFieldType.People), [])
    ).toEqual({ textValues: [template.owner] });
    expect(
      customFieldValues(artifact, field(TableCustomFieldType.Time), [])
    ).toEqual({ numericValue: 17, textValues: [] });
    expect(
      customFieldValues(artifact, field(TableCustomFieldType.Number), [])
    ).toEqual({ numericValue: 135, textValues: [] });
    expect(
      customFieldValues(artifact, field(TableCustomFieldType.Text), [])
    ).toEqual({ textValues: ["Custom text value"] });
  });

  it("yields an empty choice when a select field has no options", () => {
    const artifact = row("artifact-1");

    // pins current behavior; looks odd because an option-less single-select yields one empty-string value rather than none
    expect(
      customFieldValues(artifact, field(TableCustomFieldType.SingleSelect), [])
    ).toEqual({ textValues: [""] });
    expect(
      customFieldValues(artifact, field(TableCustomFieldType.MultiSelect), [])
    ).toEqual({ textValues: [] });
  });

  it("takes one reference for a single reference and up to three for a multi reference", () => {
    const artifact = row("artifact-1");
    const [firstIssue, secondIssue] = slugsOfKind(ArtifactKind.Issue);

    expect(
      customFieldValues(
        artifact,
        field(TableCustomFieldType.Reference, { sources: ["Issues"] }),
        genericArtifacts
      )
    ).toEqual({ textValues: [secondIssue] });
    expect(
      customFieldValues(
        artifact,
        field(TableCustomFieldType.ReferenceMulti, { sources: ["Issues"] }),
        genericArtifacts
      )
    ).toEqual({ textValues: [secondIssue, firstIssue] });
    expect(
      customFieldValues(
        artifact,
        field(TableCustomFieldType.ReferenceMulti),
        genericArtifacts
      ).textValues
    ).toHaveLength(3);
  });
});

describe("customFieldReferenceValues", () => {
  it("returns nothing for a source with no artifact kind behind it", () => {
    expect(
      customFieldReferenceValues(
        field(TableCustomFieldType.Reference, { sources: ["Projects"] }),
        genericArtifacts,
        row("artifact-1")
      )
    ).toEqual([]);
    expect(
      customFieldReferenceValues(
        field(TableCustomFieldType.Reference, { sources: ["Repositories"] }),
        genericArtifacts
      )
    ).toEqual([]);
  });

  it("offers every artifact in fixture order when the field names no source", () => {
    expect(
      customFieldReferenceValues(
        field(TableCustomFieldType.Reference),
        genericArtifacts
      )
    ).toEqual(genericArtifacts.map((artifact) => artifact.slug));
  });

  it("rotates the candidates to start at the row's title offset", () => {
    const documents = slugsOfKind(ArtifactKind.Document);

    expect(
      customFieldReferenceValues(
        field(TableCustomFieldType.ReferenceMulti, { sources: ["Documents"] }),
        genericArtifacts,
        row("artifact-1")
      )
    ).toEqual([documents[1], documents[0]]);
    expect(
      customFieldReferenceValues(
        field(TableCustomFieldType.ReferenceMulti, { sources: ["Documents"] }),
        genericArtifacts,
        row("artifact-1", { title: "abcd" })
      )
    ).toEqual(documents);
  });

  it("does not rotate a single candidate", () => {
    const session = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Session
    )!;

    expect(
      customFieldReferenceValues(
        field(TableCustomFieldType.Reference, { sources: ["Sessions"] }),
        genericArtifacts,
        row("artifact-1")
      )
    ).toEqual([session.slug]);
  });
});

describe("matchesCustomFieldFilters", () => {
  const select = field(TableCustomFieldType.SingleSelect, {
    id: "select",
    options: OPTIONS,
  });
  const count = field(TableCustomFieldType.Number, { id: "count" });
  const artifact = row("artifact-1");

  function matches(filters: Record<string, CustomFieldFilter>): boolean {
    return matchesCustomFieldFilters(artifact, [select, count], filters, []);
  }

  it("passes a row no filter constrains", () => {
    expect(matches({})).toBe(true);
    expect(matches({ select: { selectedValues: [] } })).toBe(true);
  });

  it("matches a selected value against the row's text values", () => {
    expect(matches({ select: { selectedValues: ["Alpha", "Gamma"] } })).toBe(
      true
    );
    expect(matches({ select: { selectedValues: ["Alpha"] } })).toBe(false);
  });

  it("holds the numeric value inside inclusive bounds", () => {
    expect(matches({ count: { max: 135, min: 135 } })).toBe(true);
    expect(matches({ count: { min: 136 } })).toBe(false);
    expect(matches({ count: { max: 134 } })).toBe(false);
  });

  it("fails a bound on a field with no numeric value", () => {
    expect(matches({ select: { min: 0 } })).toBe(false);
    expect(matches({ select: { max: 999 } })).toBe(false);
  });
});

describe("buildCustomFieldFilterGroups", () => {
  const numberField = field(TableCustomFieldType.Number, { id: "points" });
  const timeField = field(TableCustomFieldType.Time, { id: "effort" });
  const selectField = field(TableCustomFieldType.SingleSelect, {
    id: "stage",
    label: "Stage",
  });
  const bareSelect = field(TableCustomFieldType.SingleSelect, {
    id: "bare",
    label: "Bare",
  });
  const artifacts = [
    row("artifact-1", { creationValues: { stage: "Build" } }),
    row("artifact-2", { creationValues: { stage: "Ship" } }),
    row("artifact-4", { creationValues: { stage: "Build" } }),
  ];

  it("builds a range facet for number and time fields carrying the current bounds", () => {
    const state = createStateSetter<Record<string, CustomFieldFilter>>({
      points: { max: 9, min: 2 },
    });

    const [points, effort] = buildCustomFieldFilterGroups(
      [numberField, timeField],
      artifacts,
      state.current(),
      state.set
    );

    if (!(isRangeGroup(points) && isRangeGroup(effort))) {
      throw new Error("expected range facets");
    }
    expect(points).toMatchObject({
      id: "points",
      label: numberField.label,
      max: 9,
      maxPlaceholder: "Max",
      min: 2,
      minPlaceholder: "Min",
    });
    expect(effort.min).toBeUndefined();
    expect(effort.max).toBeUndefined();

    effort.onChange({ min: 1 });
    expect(state.current()).toEqual({
      effort: { min: 1 },
      points: { max: 9, min: 2 },
    });
  });

  it("offers each distinct non-empty value once, in first-seen order", () => {
    const state = createStateSetter<Record<string, CustomFieldFilter>>({});

    const [stage, bare] = buildCustomFieldFilterGroups(
      [selectField, bareSelect],
      artifacts,
      state.current(),
      state.set
    ).map(optionGroup);

    expect(stage?.options).toEqual([
      { id: "Build", label: "Build" },
      { id: "Ship", label: "Ship" },
    ]);
    expect(stage?.selectedValues).toEqual([]);
    expect(bare?.options).toEqual([]);
  });

  it("toggles a selected value while keeping the field's other bounds", () => {
    const state = createStateSetter<Record<string, CustomFieldFilter>>({
      stage: { min: 3, selectedValues: ["Build"] },
    });
    const build = () =>
      optionGroup(
        buildCustomFieldFilterGroups(
          [selectField],
          artifacts,
          state.current(),
          state.set
        )[0]
      );

    expect(build().selectedValues).toEqual(["Build"]);
    build().onToggle("Ship");
    expect(state.current()).toEqual({
      stage: { min: 3, selectedValues: ["Build", "Ship"] },
    });
    build().onToggle("Build");
    expect(state.current()).toEqual({
      stage: { min: 3, selectedValues: ["Ship"] },
    });
  });

  it("starts a selection for a field that had no filter", () => {
    const state = createStateSetter<Record<string, CustomFieldFilter>>({});

    optionGroup(
      buildCustomFieldFilterGroups(
        [selectField],
        artifacts,
        state.current(),
        state.set
      )[0]
    ).onToggle("Ship");

    expect(state.current()).toEqual({ stage: { selectedValues: ["Ship"] } });
  });
});
