import {
  ARTIFACT_STATUS_DETAIL,
  ARTIFACT_STATUS_ROOT,
} from "@repo/api/src/types/artifact-status";
import { TablePriority } from "@repo/design-system/components/ui/table-cell-semantic-primitives";
import { describe, expect, it } from "vitest";
import {
  ArtifactStatus,
  artifactColumns,
  initialArtifactRows,
} from "../../../packages/app/shared/components/generic-artifact-surface/fixtures";
import {
  buildGroups,
  cloneArtifact,
  columnLabel,
  filterArtifacts,
  filterOptions,
  setMembership,
  sortArtifacts,
  toggleArrayValue,
  toggleSetValue,
  uniqueFieldId,
} from "../../../packages/app/shared/components/generic-artifact-surface/model";

describe("Grid Table V2 Generic Artifact model (extended)", () => {
  describe("sortArtifacts", () => {
    it("sorts by collaborators", () => {
      expect(
        sortArtifacts(initialArtifactRows, "collaborators", "asc").map(
          (row) => row.id
        )
      ).toEqual(["artifact-2", "artifact-3", "artifact-1"]);
    });

    it("sorts by status", () => {
      expect(
        sortArtifacts(initialArtifactRows, "status", "asc").map((row) => row.id)
      ).toEqual(["artifact-3", "artifact-1", "artifact-2"]);
    });

    it("keeps an unrecognized status last in both directions", () => {
      const rows = initialArtifactRows.map((row, index) =>
        index === 0 ? { ...row, statusRaw: "FUTURE_STATUS" } : row
      );

      expect(sortArtifacts(rows, "status", "asc").at(-1)?.id).toBe(
        "artifact-1"
      );
      expect(sortArtifacts(rows, "status", "desc").at(-1)?.id).toBe(
        "artifact-1"
      );
    });

    it("sorts by model", () => {
      expect(
        sortArtifacts(initialArtifactRows, "model", "asc").map((row) => row.id)
      ).toEqual(["artifact-1", "artifact-3", "artifact-2"]);
    });

    it("sorts by comments using the numeric comparison path", () => {
      expect(
        sortArtifacts(initialArtifactRows, "comments", "asc").map(
          (row) => row.id
        )
      ).toEqual(["artifact-2", "artifact-1", "artifact-3"]);
    });

    it("sorts by updated, most recent first ascending", () => {
      expect(
        sortArtifacts(initialArtifactRows, "updated", "asc").map(
          (row) => row.id
        )
      ).toEqual(["artifact-3", "artifact-2", "artifact-1"]);
    });

    it("sorts by currentVersion using the numeric prefix", () => {
      expect(
        sortArtifacts(initialArtifactRows, "currentVersion", "asc").map(
          (row) => row.id
        )
      ).toEqual(["artifact-3", "artifact-2", "artifact-1"]);
    });

    it("sorts by tags joined labels", () => {
      expect(
        sortArtifacts(initialArtifactRows, "tags", "asc").map((row) => row.id)
      ).toEqual(["artifact-1", "artifact-2", "artifact-3"]);
    });

    it("sorts by repository, treating a null repository as empty", () => {
      expect(
        sortArtifacts(initialArtifactRows, "repository", "asc").map(
          (row) => row.id
        )
      ).toEqual(["artifact-3", "artifact-1", "artifact-2"]);
    });

    it("sorts by creationCost, treating a null cost as empty", () => {
      expect(
        sortArtifacts(initialArtifactRows, "creationCost", "asc").map(
          (row) => row.id
        )
      ).toEqual(["artifact-3", "artifact-2", "artifact-1"]);
    });

    it("sorts by lineChanges, summing additions and deletions", () => {
      expect(
        sortArtifacts(initialArtifactRows, "lineChanges", "asc").map(
          (row) => row.id
        )
      ).toEqual(["artifact-3", "artifact-2", "artifact-1"]);
    });

    it("sorts by name using the artifact title", () => {
      expect(
        sortArtifacts(initialArtifactRows, "name", "asc").map((row) => row.id)
      ).toEqual(["artifact-2", "artifact-3", "artifact-1"]);
    });

    it("reverses order for the desc direction", () => {
      expect(
        sortArtifacts(initialArtifactRows, "owner", "desc").map((row) => row.id)
      ).toEqual(["artifact-2", "artifact-1", "artifact-3"]);
    });

    it("sorts by an unknown column's default case using an array custom value, falling back to title when absent", () => {
      expect(
        sortArtifacts(initialArtifactRows, "custom-capabilities", "asc").map(
          (row) => row.id
        )
      ).toEqual(["artifact-2", "artifact-1", "artifact-3"]);
    });

    it("sorts by an unknown column's default case using a scalar custom value, falling back to title when absent", () => {
      expect(
        sortArtifacts(initialArtifactRows, "custom-revision-count", "asc").map(
          (row) => row.id
        )
      ).toEqual(["artifact-2", "artifact-1", "artifact-3"]);
    });
  });

  describe("filterArtifacts", () => {
    it("applies no filtering for a column with no selected values", () => {
      expect(
        filterArtifacts(initialArtifactRows, { owner: [] }).map((row) => row.id)
      ).toEqual(["artifact-1", "artifact-2", "artifact-3"]);
    });

    it("filters by owner", () => {
      expect(
        filterArtifacts(initialArtifactRows, {
          owner: ["Pascoe Birchall"],
        }).map((row) => row.id)
      ).toEqual(["artifact-2"]);
    });

    it("filters by collaborators", () => {
      expect(
        filterArtifacts(initialArtifactRows, {
          collaborators: ["Sam Chen"],
        }).map((row) => row.id)
      ).toEqual(["artifact-1", "artifact-3"]);
    });

    it("filters by status", () => {
      expect(
        filterArtifacts(initialArtifactRows, {
          status: [ARTIFACT_STATUS_DETAIL.SessionRunning],
        }).map((row) => row.id)
      ).toEqual(["artifact-3"]);
    });

    it("filters by priority", () => {
      expect(
        filterArtifacts(initialArtifactRows, {
          priority: [TablePriority.High],
        }).map((row) => row.id)
      ).toEqual(["artifact-1"]);
    });

    it("filters by model", () => {
      expect(
        filterArtifacts(initialArtifactRows, { model: ["gpt-5.6-sol"] }).map(
          (row) => row.id
        )
      ).toEqual(["artifact-2"]);
    });

    it("filters by relatedSessions", () => {
      expect(
        filterArtifacts(initialArtifactRows, {
          relatedSessions: ["SES-2481-3"],
        }).map((row) => row.id)
      ).toEqual(["artifact-1"]);
    });

    it("filters by updated", () => {
      expect(
        filterArtifacts(initialArtifactRows, { updated: ["just now"] }).map(
          (row) => row.id
        )
      ).toEqual(["artifact-1"]);
    });

    it("filters by tags with an exact label match", () => {
      expect(
        filterArtifacts(initialArtifactRows, { tags: ["Design"] }).map(
          (row) => row.id
        )
      ).toEqual(["artifact-3"]);
    });

    it("filters by repository, excluding a null repository via the empty-array branch", () => {
      expect(
        filterArtifacts(initialArtifactRows, {
          repository: ["closedloop-ai/closedloop-ai"],
        }).map((row) => row.id)
      ).toEqual(["artifact-1", "artifact-2"]);
    });

    it("filters by creationCost, excluding a null cost via the empty-array branch", () => {
      expect(
        filterArtifacts(initialArtifactRows, {
          creationCost: ["42.18"],
        }).map((row) => row.id)
      ).toEqual(["artifact-1"]);
    });

    it("filters by lineChanges, excluding an artifact whose additions and deletions are both null", () => {
      expect(
        filterArtifacts(initialArtifactRows, { lineChanges: ["226"] }).map(
          (row) => row.id
        )
      ).toEqual(["artifact-1"]);
    });

    it("filters by lineChanges, still returning a value when only deletions is null", () => {
      const partiallyMissing = {
        ...cloneArtifact(initialArtifactRows[0]),
        additions: 10,
        deletions: null,
      };

      expect(
        filterArtifacts([partiallyMissing], { lineChanges: ["10"] }).map(
          (row) => row.id
        )
      ).toEqual([partiallyMissing.id]);
    });

    it("filters by lineChanges, still returning a value when only additions is null", () => {
      const partiallyMissing = {
        ...cloneArtifact(initialArtifactRows[0]),
        additions: null,
        deletions: 20,
      };

      expect(
        filterArtifacts([partiallyMissing], { lineChanges: ["20"] }).map(
          (row) => row.id
        )
      ).toEqual([partiallyMissing.id]);
    });

    it("filters by a custom field's default case using an array value", () => {
      expect(
        filterArtifacts(initialArtifactRows, {
          "custom-capabilities": ["Governance"],
        }).map((row) => row.id)
      ).toEqual(["artifact-1", "artifact-2"]);
    });

    it("filters by a custom field's default case using a scalar value", () => {
      expect(
        filterArtifacts(initialArtifactRows, {
          "custom-stage": ["Build"],
        }).map((row) => row.id)
      ).toEqual(["artifact-1"]);
    });

    it("filters by a custom field's default case, excluding every row when the value is absent (null)", () => {
      expect(
        filterArtifacts(initialArtifactRows, {
          "custom-nonexistent": ["anything"],
        })
      ).toEqual([]);
    });

    it("applies AND across multiple filter columns", () => {
      expect(
        filterArtifacts(initialArtifactRows, {
          owner: ["Pascoe Birchall"],
          status: [ArtifactStatus.Active],
        }).map((row) => row.id)
      ).toEqual([]);
    });
  });

  describe("buildGroups", () => {
    it("groups by owner", () => {
      const groups = buildGroups(initialArtifactRows, "owner");

      expect(groups?.map((group) => group.key)).toEqual([
        "Ottilie Eastwick",
        "Pascoe Birchall",
      ]);
      expect(
        groups?.map((group) => group.items.map((item) => item.id))
      ).toEqual([["artifact-1", "artifact-3"], ["artifact-2"]]);
    });
  });

  describe("filterOptions", () => {
    it("returns the canonical status options regardless of which statuses are present", () => {
      expect(filterOptions("status", [initialArtifactRows[0]])).toEqual([
        ARTIFACT_STATUS_ROOT.Todo,
        ARTIFACT_STATUS_DETAIL.IssueTriage,
        ARTIFACT_STATUS_DETAIL.IssueBacklog,
        ARTIFACT_STATUS_ROOT.InProgress,
        ARTIFACT_STATUS_DETAIL.IssueBlocked,
        ARTIFACT_STATUS_ROOT.InReview,
        ARTIFACT_STATUS_ROOT.Done,
        ARTIFACT_STATUS_ROOT.Canceled,
      ]);
    });

    it("derives options from cellValues for a non-status column", () => {
      expect(filterOptions("owner", initialArtifactRows)).toEqual([
        "Ottilie Eastwick",
        "Pascoe Birchall",
      ]);
    });
  });

  describe("setMembership", () => {
    it("adds a value when included is true", () => {
      expect(setMembership(new Set(["a"]), "b", true)).toEqual(
        new Set(["a", "b"])
      );
    });

    it("removes a value when included is false", () => {
      expect(setMembership(new Set(["a", "b"]), "b", false)).toEqual(
        new Set(["a"])
      );
    });
  });

  describe("toggleSetValue", () => {
    it("adds a value that is not present", () => {
      expect(toggleSetValue(new Set(["a"]), "b")).toEqual(new Set(["a", "b"]));
    });

    it("removes a value that is present", () => {
      expect(toggleSetValue(new Set(["a", "b"]), "b")).toEqual(new Set(["a"]));
    });
  });

  describe("toggleArrayValue", () => {
    it("adds a value that is not present", () => {
      expect(toggleArrayValue(["a"], "b")).toEqual(["a", "b"]);
    });

    it("removes a value that is present", () => {
      expect(toggleArrayValue(["a", "b"], "b")).toEqual(["a"]);
    });
  });

  describe("columnLabel", () => {
    it("returns the matching column's label", () => {
      expect(columnLabel("owner", artifactColumns)).toBe("Owner");
    });

    it("falls back to the columnId when no column matches", () => {
      expect(columnLabel("does-not-exist", artifactColumns)).toBe(
        "does-not-exist"
      );
    });
  });

  describe("cloneArtifact", () => {
    it("deep clones collaborators, customValues, owner, relatedSessions, and tags", () => {
      const original = initialArtifactRows[0];
      const clone = cloneArtifact(original);

      expect(clone).toEqual(original);
      expect(clone).not.toBe(original);

      expect(clone.collaborators).not.toBe(original.collaborators);
      expect(clone.collaborators[0]).not.toBe(original.collaborators[0]);

      expect(clone.customValues).not.toBe(original.customValues);

      expect(clone.owner).not.toBe(original.owner);

      expect(clone.relatedSessions).not.toBe(original.relatedSessions);
      expect(clone.relatedSessions[0]).not.toBe(original.relatedSessions[0]);

      expect(clone.tags).not.toBe(original.tags);
      expect(clone.tags[0]).not.toBe(original.tags[0]);
    });
  });

  describe("uniqueFieldId", () => {
    it("falls back to 'field' when the label is entirely punctuation", () => {
      expect(uniqueFieldId("!!!", [])).toBe("field");
    });

    it("appends an incrementing suffix through a triple collision", () => {
      expect(
        uniqueFieldId("!!!", [
          { id: "field", label: "Field" },
          { id: "field-2", label: "Field 2" },
        ])
      ).toBe("field-3");
    });
  });
});
