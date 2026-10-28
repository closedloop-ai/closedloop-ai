import { describe, expect, it } from "vitest";
import { ArtifactStatus, initialArtifactRows } from "../fixtures";
import { sortArtifacts } from "../model";

const issue = initialArtifactRows[0]!;
const sameRootRows = [
  { ...issue, id: "todo", status: ArtifactStatus.Todo },
  { ...issue, id: "triage", status: ArtifactStatus.Triage },
  { ...issue, id: "backlog", status: ArtifactStatus.Backlog },
];

describe("sortArtifacts status ordering", () => {
  it("uses the raw vocabulary rank as the tiebreak within one root", () => {
    expect(
      sortArtifacts(sameRootRows, "status", "asc").map((row) => row.status)
    ).toEqual([
      ArtifactStatus.Triage,
      ArtifactStatus.Backlog,
      ArtifactStatus.Todo,
    ]);
    expect(
      sortArtifacts(sameRootRows, "status", "desc").map((row) => row.status)
    ).toEqual([
      ArtifactStatus.Todo,
      ArtifactStatus.Backlog,
      ArtifactStatus.Triage,
    ]);
  });
});
