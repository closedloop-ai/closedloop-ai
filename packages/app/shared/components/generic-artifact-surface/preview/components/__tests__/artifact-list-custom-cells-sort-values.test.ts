import {
  type TableCustomFieldDefinition,
  TableCustomFieldType,
} from "@repo/design-system/components/ui/table-add-field-dialog";
import { describe, expect, it } from "vitest";
import { genericArtifactStatusRank } from "../../../generic-artifact-status";
import {
  ArtifactKind,
  ArtifactStatus,
  type GenericArtifact,
  genericArtifacts,
} from "../../fixtures";
import {
  compareGenericArtifactStatus,
  genericArtifactCompare,
  genericArtifactSortValue,
} from "../artifact-list-custom-cells";

const ROW: GenericArtifact = {
  ...genericArtifacts[0],
  collaborators: ["Pascoe Birchall", "Sam Chen"],
  commentCount: 14,
  id: "artifact-1",
  owner: "Ottilie Eastwick",
  tags: ["Foundations", "UX"],
  title: "abcd",
  updatedAgoMinutes: 90,
};

const POINTS: TableCustomFieldDefinition = {
  id: "points",
  label: "Points",
  type: TableCustomFieldType.Number,
};

const LABELS: TableCustomFieldDefinition = {
  id: "labels",
  label: "Labels",
  options: ["Alpha", "Beta", "Gamma"],
  type: TableCustomFieldType.MultiSelect,
};

function sortValue(
  columnId: string,
  artifact: GenericArtifact = ROW,
  fields: TableCustomFieldDefinition[] = [POINTS, LABELS]
) {
  return genericArtifactSortValue(artifact, columnId, fields, genericArtifacts);
}

describe("genericArtifactSortValue built-in columns", () => {
  it.each([
    ["collaborators", "Pascoe Birchall Sam Chen"],
    ["tags", "Foundations UX"],
    ["comments", 14],
    ["owner", "Ottilie Eastwick"],
    ["updated", -90],
    ["name", "abcd"],
    ["an-unknown-column", "abcd"],
  ] as const)("reads %s as %j", (columnId, expected) => {
    expect(sortValue(columnId)).toBe(expected);
  });

  it("reads status as the canonical status rank", () => {
    const issue: GenericArtifact = {
      ...ROW,
      kind: ArtifactKind.Issue,
      status: ArtifactStatus.Todo,
    };

    expect(sortValue("status", issue)).toBe(genericArtifactStatusRank(issue));
    expect(typeof sortValue("status", issue)).toBe("number");
  });
});

describe("genericArtifactSortValue custom fields", () => {
  it("prefers the numeric value of a number field", () => {
    expect(sortValue(POINTS.id)).toBe(128);
  });

  it("joins text values of a multi-value field", () => {
    expect(sortValue(LABELS.id)).toBe("Alpha Beta");
  });

  it("reads an empty-state row as an empty string", () => {
    expect(sortValue(LABELS.id, { ...ROW, id: "artifact-3" })).toBe("");
  });

  it("treats a custom field id as a custom field before a built-in column", () => {
    const ownerShadow: TableCustomFieldDefinition = {
      ...POINTS,
      id: "owner",
    };

    expect(sortValue("owner", ROW, [ownerShadow])).toBe(128);
  });
});

describe("genericArtifactCompare", () => {
  it("subtracts two numbers", () => {
    expect(genericArtifactCompare(3, 10, "comments")).toBe(-7);
  });

  it("compares a number against text as strings", () => {
    // "10" sorts before "9" as text, the opposite of numeric order.
    expect(genericArtifactCompare(10, "9", "comments")).toBeLessThan(0);
    expect(genericArtifactCompare("10", 9, "comments")).toBeLessThan(0);
  });

  it("stringifies a null operand", () => {
    // pins current behavior; looks odd because a missing value compares equal to the literal text "null" instead of sorting apart
    expect(genericArtifactCompare(null, "null", "owner")).toBe(0);
  });

  it("orders the version column by digit runs, not character by character", () => {
    // Character order puts "v1.9" after "v1.10"; only the mono-id branch reverses it.
    expect(
      genericArtifactCompare("v1.9", "v1.10", "currentVersion")
    ).toBeLessThan(0);
    expect(genericArtifactCompare("v1.9", "v1.10", "owner")).toBeGreaterThan(0);
    expect(genericArtifactCompare("v1.10", "v1.10", "currentVersion")).toBe(0);
  });
});

describe("compareGenericArtifactStatus ties", () => {
  it("returns zero for two rows with the same status", () => {
    const todo: GenericArtifact = {
      ...ROW,
      kind: ArtifactKind.Issue,
      status: ArtifactStatus.Todo,
    };

    expect(compareGenericArtifactStatus(todo, { ...todo }, "asc")).toBe(0);
  });
});

describe("compareGenericArtifactStatus across vocabularies", () => {
  it("decides on the root before the raw rank", () => {
    // Triage's root sorts before Draft's, while the two vocabularies' raw ranks
    // order them the other way round.
    const triage: GenericArtifact = {
      ...ROW,
      kind: ArtifactKind.Agent,
      status: ArtifactStatus.Triage,
    };
    const draft: GenericArtifact = {
      ...ROW,
      kind: ArtifactKind.Document,
      status: ArtifactStatus.Draft,
    };

    expect(compareGenericArtifactStatus(triage, draft, "asc")).toBeLessThan(0);
  });
});
