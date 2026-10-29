import { ARTIFACT_STATUS_ROOT } from "@repo/api/src/types/artifact-status";
import { describe, expect, it } from "vitest";
import { ArtifactKind, ArtifactStatus, genericArtifacts } from "../../fixtures";
import {
  resolveArtifactGroupDestination,
  resolveArtifactGroupDrop,
} from "../artifact-list-group-drop";

describe("resolveArtifactGroupDrop", () => {
  it("refuses every axis when one requested status is unsupported", () => {
    const document = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Document
    )!;

    expect(
      resolveArtifactGroupDrop(document, [
        { fieldId: "status", value: ARTIFACT_STATUS_ROOT.Todo },
        { fieldId: "owner", value: "Sam Chen" },
      ])
    ).toBeNull();
  });

  it("refuses a source-managed status before changing another axis", () => {
    const branch = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Branch
    )!;

    expect(
      resolveArtifactGroupDrop(branch, [
        { fieldId: "owner", value: "Sam Chen" },
        { fieldId: "status", value: ARTIFACT_STATUS_ROOT.Done },
      ])
    ).toBeNull();
  });

  it("commits both axes together when every value is valid", () => {
    const issue = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Issue
    )!;

    expect(
      resolveArtifactGroupDrop(issue, [
        { fieldId: "status", value: ARTIFACT_STATUS_ROOT.Done },
        { fieldId: "owner", value: "Sam Chen" },
      ])
    ).toMatchObject({
      owner: "Sam Chen",
      status: ArtifactStatus.Done,
      statusRaw: undefined,
    });
  });
});

describe("resolveArtifactGroupDestination", () => {
  it("rejects only the status lane the row cannot resolve", () => {
    const document = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Document
    )!;

    expect(
      resolveArtifactGroupDestination(
        document,
        "status",
        ARTIFACT_STATUS_ROOT.Todo,
        undefined
      )
    ).toBeNull();
    expect(
      resolveArtifactGroupDestination(
        document,
        "status",
        ARTIFACT_STATUS_ROOT.Done,
        undefined
      )
    ).not.toBeNull();
  });

  it("rejects the synthetic unassigned owner band the mutation cannot map", () => {
    const issue = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Issue
    )!;

    expect(
      resolveArtifactGroupDestination(issue, "owner", "No value")
    ).toBeNull();
  });
});
