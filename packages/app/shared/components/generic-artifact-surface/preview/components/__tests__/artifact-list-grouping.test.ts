import {
  ARTIFACT_STATUS_ROOT,
  DISPLAYED_ARTIFACT_STATUS,
} from "@repo/api/src/types/artifact-status";
import { describe, expect, it } from "vitest";
import { ArtifactKind } from "../../fixtures";
import { artifactGroupDefinitions } from "../artifact-list-grouping";

describe("artifactGroupDefinitions status lanes", () => {
  it("derives only roots supported by a Document-only surface", () => {
    expect(
      artifactGroupDefinitions("status", [ArtifactKind.Document]).map(
        (definition) => definition.key
      )
    ).toEqual([
      ARTIFACT_STATUS_ROOT.InProgress,
      ARTIFACT_STATUS_ROOT.InReview,
      ARTIFACT_STATUS_ROOT.Done,
      ARTIFACT_STATUS_ROOT.Canceled,
    ]);
  });

  it("uses the represented Session profile without unrelated empty lanes", () => {
    expect(
      artifactGroupDefinitions("status", [ArtifactKind.Session]).map(
        (definition) => definition.key
      )
    ).toEqual([
      ARTIFACT_STATUS_ROOT.InProgress,
      ARTIFACT_STATUS_ROOT.Done,
      ARTIFACT_STATUS_ROOT.Canceled,
    ]);
  });

  it("adds one explicit Unknown lane only when rows require it", () => {
    expect(
      artifactGroupDefinitions("status", [ArtifactKind.Document], true).at(-1)
    ).toMatchObject({
      key: DISPLAYED_ARTIFACT_STATUS.Unknown,
      label: "Unknown",
    });
  });
});
