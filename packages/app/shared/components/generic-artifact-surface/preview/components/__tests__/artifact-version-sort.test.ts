import { describe, expect, it } from "vitest";
import {
  ArtifactKind,
  ArtifactStatus,
  type GenericArtifact,
} from "../../fixtures";
import {
  compareGenericArtifactStatus,
  genericArtifactCompare,
  genericArtifactSortValue,
} from "../artifact-list-custom-cells";

/**
 * ISS-6384 — the render-vs-comparator disagreement the ticket named as a real
 * ordering bug, not a nit.
 *
 * `genericArtifactSortValue` used to return `Number(value.replace(/\D/g, ""))`
 * for the version column, which reads `v1.10` as 110 and `v1.9` as 19. The same
 * function also feeds the GROUP label, so a row displaying `v1.10` grouped under
 * "110". Both are fixed by one decision: the sort value IS the version as
 * rendered, and `compareMonoIds` supplies the ordering that matches it.
 */

const VERSIONS = ["v1.9", "v2.0", "v1.10", "v1.2"] as const;

function artifactWithVersion(currentVersion: string): GenericArtifact {
  return { currentVersion } as GenericArtifact;
}

function sortValue(currentVersion: string): string | number | null {
  return genericArtifactSortValue(
    artifactWithVersion(currentVersion),
    "currentVersion",
    [],
    []
  );
}

describe("generic-artifact version ordering (ISS-6384)", () => {
  it("orders v1.9 before v1.10, the case digit-stripping got backwards", () => {
    const sorted = [...VERSIONS].sort((left, right) =>
      genericArtifactCompare(
        sortValue(left),
        sortValue(right),
        "currentVersion"
      )
    );

    expect(sorted).toEqual(["v1.2", "v1.9", "v1.10", "v2.0"]);
  });

  it("sorts on the value the cell actually renders", () => {
    // The old sort value for `v1.10` was the number 110 — nothing a reader
    // could reconcile with the cell, and the string the group header printed.
    expect(sortValue("v1.10")).toBe("v1.10");
  });

  it("leaves the numeric and lexical columns comparing as they did", () => {
    expect(genericArtifactCompare(3, 10, "comments")).toBeLessThan(0);
    expect(genericArtifactCompare("beta", "alpha", "owner")).toBeGreaterThan(0);
  });
});

describe("generic-artifact status ordering", () => {
  const recognized = {
    kind: ArtifactKind.Issue,
    status: ArtifactStatus.Todo,
  } as GenericArtifact;
  const unknown = {
    ...recognized,
    statusRaw: "FUTURE_STATUS",
  } as GenericArtifact;

  it("keeps unknown last in both directions", () => {
    expect(
      compareGenericArtifactStatus(recognized, unknown, "asc")
    ).toBeLessThan(0);
    expect(
      compareGenericArtifactStatus(recognized, unknown, "desc")
    ).toBeLessThan(0);
  });

  it("uses canonical raw order as the tiebreak beneath a shared root", () => {
    const triage = {
      kind: ArtifactKind.Issue,
      status: ArtifactStatus.Triage,
    } as GenericArtifact;
    const todo = {
      kind: ArtifactKind.Issue,
      status: ArtifactStatus.Todo,
    } as GenericArtifact;

    expect(compareGenericArtifactStatus(triage, todo, "asc")).toBeLessThan(0);
    expect(compareGenericArtifactStatus(triage, todo, "desc")).toBeGreaterThan(
      0
    );
  });
});
