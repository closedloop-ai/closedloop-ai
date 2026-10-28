import {
  ARTIFACT_STATUS_DETAIL,
  ARTIFACT_STATUS_ROOT,
} from "@repo/api/src/types/artifact-status";
import type { TablePriority } from "@repo/design-system/components/ui/table-cell-semantic-primitives";
import { describe, expect, it } from "vitest";
import type { ArtifactRow } from "../../../packages/app/shared/components/generic-artifact-surface/fixtures";
import {
  artifactColumns,
  initialArtifactRows,
} from "../../../packages/app/shared/components/generic-artifact-surface/fixtures";
import {
  buildGroups,
  cloneArtifact,
  filterArtifacts,
  filterOptions,
  sortArtifacts,
  uniqueFieldId,
} from "../../../packages/app/shared/components/generic-artifact-surface/model";

// Lexicographic input: what a comparator reading the spelling hands back
// unchanged, so these rows tell rank and spelling apart. URGENT included
// because lexicographic order buries it last.
const ALPHABETICAL_PRIORITIES = ["HIGH", "LOW", "MEDIUM", "URGENT"] as const;

const RANKED_PRIORITIES = ["URGENT", "HIGH", "MEDIUM", "LOW"];

function rowsWithPriorities(
  priorities: readonly TablePriority[]
): ArtifactRow[] {
  return priorities.map((priority, index) => ({
    ...cloneArtifact(initialArtifactRows[index % initialArtifactRows.length]),
    id: `artifact-${priority.toLowerCase()}`,
    priority,
  }));
}

describe("Grid Table V2 Generic Artifact model", () => {
  it("preserves caller stack rank while no derived sort is active", () => {
    const ranked = initialArtifactRows.map(cloneArtifact);

    expect(sortArtifacts(ranked, null, "asc").map((row) => row.id)).toEqual([
      "artifact-1",
      "artifact-2",
      "artifact-3",
    ]);
    expect(ranked.map((row) => row.id)).toEqual([
      "artifact-1",
      "artifact-2",
      "artifact-3",
    ]);
  });

  it("sorts a derived view without mutating the caller rank", () => {
    const ranked = initialArtifactRows.map(cloneArtifact);

    expect(sortArtifacts(ranked, "owner", "asc").map((row) => row.id)).toEqual([
      "artifact-1",
      "artifact-3",
      "artifact-2",
    ]);
    expect(ranked.map((row) => row.id)).toEqual([
      "artifact-1",
      "artifact-2",
      "artifact-3",
    ]);
  });

  it("filters multi-value cells using their semantic values", () => {
    expect(
      filterArtifacts(initialArtifactRows, { tags: ["Governance"] }).map(
        (row) => row.id
      )
    ).toEqual(["artifact-2"]);
  });

  it("treats a root status filter as inclusive and a detail as exact", () => {
    expect(
      filterArtifacts(initialArtifactRows, {
        status: [ARTIFACT_STATUS_ROOT.InReview],
      }).map((row) => row.id)
    ).toEqual(["artifact-1"]);
    expect(
      filterArtifacts(initialArtifactRows, {
        status: [ARTIFACT_STATUS_DETAIL.DocumentApproved],
      }).map((row) => row.id)
    ).toEqual(["artifact-2"]);
  });

  it("groups only the two groupable canonical columns", () => {
    expect(
      buildGroups(initialArtifactRows, "status")?.map((group) => group.key)
    ).toEqual(["in_progress", "in_review", "done"]);
    expect(buildGroups(initialArtifactRows, "tags")).toBeUndefined();
  });

  it("sorts priority by semantic rank in both directions", () => {
    const rows = rowsWithPriorities(ALPHABETICAL_PRIORITIES);

    expect(
      sortArtifacts(rows, "priority", "asc").map((row) => row.priority)
    ).toEqual(RANKED_PRIORITIES);
    expect(
      sortArtifacts(rows, "priority", "desc").map((row) => row.priority)
    ).toEqual([...RANKED_PRIORITIES].reverse());
  });

  it("orders priority groups by rank rather than by row arrival", () => {
    expect(
      buildGroups(rowsWithPriorities(ALPHABETICAL_PRIORITIES), "priority")?.map(
        (group) => group.key
      )
    ).toEqual(RANKED_PRIORITIES);
  });

  it("offers the whole ranked priority vocabulary whatever the rows hold", () => {
    expect(filterOptions("priority", rowsWithPriorities(["MEDIUM"]))).toEqual(
      RANKED_PRIORITIES
    );
    expect(filterOptions("priority", [])).toEqual(RANKED_PRIORITIES);
  });

  it("gives added columns stable unique ids", () => {
    expect(uniqueFieldId("Current version", artifactColumns)).toBe(
      "current-version"
    );
    expect(
      uniqueFieldId("Owner", [
        ...artifactColumns,
        { id: "owner-2", label: "Owner 2" },
      ])
    ).toBe("owner-3");
  });
});
