import { describe, expect, it } from "vitest";
import {
  ARTIFACT_BULK_ACTION_KINDS,
  ArtifactBulkAction,
  ArtifactBulkKind,
} from "./artifact-bulk-action";

describe("artifact bulk action kind capabilities", () => {
  it("classifies every action and every kind", () => {
    expect(Object.keys(ARTIFACT_BULK_ACTION_KINDS).sort()).toEqual(
      Object.values(ArtifactBulkAction).sort()
    );
    for (const supportedByKind of Object.values(ARTIFACT_BULK_ACTION_KINDS)) {
      expect(Object.keys(supportedByKind).sort()).toEqual(
        Object.values(ArtifactBulkKind).sort()
      );
    }
  });

  it("keeps owner immutable on branches and absent on deployments", () => {
    expect(ARTIFACT_BULK_ACTION_KINDS[ArtifactBulkAction.ChangeOwner]).toEqual({
      [ArtifactBulkKind.Project]: true,
      [ArtifactBulkKind.Document]: true,
      [ArtifactBulkKind.Issue]: true,
      [ArtifactBulkKind.Session]: true,
      [ArtifactBulkKind.Branch]: false,
      [ArtifactBulkKind.Deployment]: false,
    });
  });

  it("allows favorites for every kind and keeps Projects as placement roots", () => {
    expect(
      Object.values(
        ARTIFACT_BULK_ACTION_KINDS[ArtifactBulkAction.ChangeFavorite]
      )
    ).toEqual(Object.values(ArtifactBulkKind).map(() => true));
    expect(
      ARTIFACT_BULK_ACTION_KINDS[ArtifactBulkAction.ChangeProject]
    ).toEqual({
      [ArtifactBulkKind.Project]: false,
      [ArtifactBulkKind.Document]: true,
      [ArtifactBulkKind.Issue]: true,
      [ArtifactBulkKind.Session]: true,
      [ArtifactBulkKind.Branch]: true,
      [ArtifactBulkKind.Deployment]: true,
    });
  });

  it("admits only code-supported actions for Project rows", () => {
    expect(
      Object.fromEntries(
        Object.values(ArtifactBulkAction).map((action) => [
          action,
          ARTIFACT_BULK_ACTION_KINDS[action][ArtifactBulkKind.Project],
        ])
      )
    ).toEqual({
      [ArtifactBulkAction.ChangeFavorite]: true,
      [ArtifactBulkAction.ChangeStatus]: true,
      [ArtifactBulkAction.ChangePriority]: false,
      [ArtifactBulkAction.AddTag]: false,
      [ArtifactBulkAction.RemoveTag]: false,
      [ArtifactBulkAction.ChangeOwner]: true,
      [ArtifactBulkAction.ChangeProject]: false,
      [ArtifactBulkAction.Delete]: false,
    });
  });
});
