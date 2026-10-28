import { describe, expect, it } from "vitest";
import { DocumentStatus, IssueStatus } from "./document.ts";
import {
  PROJECT_ARTIFACT_PLACEMENT_MAX_SOURCES,
  ProjectArtifactPlacementGroupField,
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
  projectArtifactPlacementResponseValidator,
  projectArtifactPlacementValidator,
} from "./project-artifact-placement";

const SOURCE_ID = "00000000-0000-4000-8000-000000000001";
const TARGET_ID = "00000000-0000-4000-8000-000000000002";
const PROJECT_ID = "00000000-0000-4000-8000-000000000003";

function placeRequest() {
  return {
    kind: ProjectArtifactPlacementKind.Place,
    sourceArtifactIds: [SOURCE_ID],
    destinationProjectId: PROJECT_ID,
    position: ProjectArtifactPlacementPosition.Before,
    targetArtifactId: TARGET_ID,
    expectedProjectVersions: { [PROJECT_ID]: "version-1" },
    idempotencyKey: "placement-1",
    source: ProjectArtifactPlacementSource.Keyboard,
  };
}

describe("project artifact placement contract", () => {
  it("AC-001 AC-002 accepts a stable-id placement and explicit undo", () => {
    expect(projectArtifactPlacementValidator.parse(placeRequest())).toEqual(
      placeRequest()
    );
    expect(
      projectArtifactPlacementValidator.parse({
        kind: ProjectArtifactPlacementKind.Undo,
        undoOfTransactionId: TARGET_ID,
        expectedProjectVersions: { [PROJECT_ID]: "version-2" },
        idempotencyKey: "placement-undo-1",
        source: ProjectArtifactPlacementSource.Undo,
      })
    ).toMatchObject({ kind: ProjectArtifactPlacementKind.Undo });
  });

  it.each([
    [
      "duplicate sources",
      { ...placeRequest(), sourceArtifactIds: [SOURCE_ID, SOURCE_ID] },
    ],
    ["unknown position", { ...placeRequest(), position: "around" }],
    ["missing target", { ...placeRequest(), targetArtifactId: undefined }],
    [
      "target on root placement",
      {
        ...placeRequest(),
        position: ProjectArtifactPlacementPosition.Root,
      },
    ],
    ["unknown field", { ...placeRequest(), visibleIndex: 2 }],
  ])("AC-002 rejects %s", (_label, request) => {
    expect(projectArtifactPlacementValidator.safeParse(request).success).toBe(
      false
    );
  });

  it("accepts the maximum source count and rejects limit plus one", () => {
    const sourceArtifactIds = Array.from(
      { length: PROJECT_ARTIFACT_PLACEMENT_MAX_SOURCES + 1 },
      (_, index) =>
        `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
    );
    expect(
      projectArtifactPlacementValidator.safeParse({
        ...placeRequest(),
        sourceArtifactIds: sourceArtifactIds.slice(
          0,
          PROJECT_ARTIFACT_PLACEMENT_MAX_SOURCES
        ),
      }).success
    ).toBe(true);
    expect(
      projectArtifactPlacementValidator.safeParse({
        ...placeRequest(),
        sourceArtifactIds,
      }).success
    ).toBe(false);
  });

  it("PRD-724 admits only the strict optional board lane patch", () => {
    expect(
      projectArtifactPlacementValidator.parse({
        ...placeRequest(),
        lanePatch: {
          expectedPolicyRevision: "policy-v1",
          field: ProjectArtifactPlacementGroupField.Status,
          value: "IN_PROGRESS",
        },
      })
    ).toMatchObject({
      lanePatch: {
        field: ProjectArtifactPlacementGroupField.Status,
        value: "IN_PROGRESS",
      },
    });
    expect(
      projectArtifactPlacementValidator.safeParse({
        ...placeRequest(),
        lanePatch: {
          field: ProjectArtifactPlacementGroupField.Status,
          fixtureOnly: true,
          value: "IN_PROGRESS",
        },
      }).success
    ).toBe(false);
  });

  it("ISS-12908 accepts complete per-root raw status targets and refuses partial or misplaced maps", () => {
    const request = {
      ...placeRequest(),
      sourceArtifactIds: [SOURCE_ID, TARGET_ID],
      lanePatch: {
        field: ProjectArtifactPlacementGroupField.Status,
        value: IssueStatus.InReview,
        valuesByRootId: {
          [SOURCE_ID]: IssueStatus.InReview,
          [TARGET_ID]: DocumentStatus.InReview,
        },
      },
    };
    expect(projectArtifactPlacementValidator.safeParse(request).success).toBe(
      true
    );
    expect(
      projectArtifactPlacementValidator.safeParse({
        ...request,
        lanePatch: {
          ...request.lanePatch,
          valuesByRootId: { [SOURCE_ID]: IssueStatus.InReview },
        },
      }).success
    ).toBe(false);
    expect(
      projectArtifactPlacementValidator.safeParse({
        ...request,
        lanePatch: {
          ...request.lanePatch,
          field: ProjectArtifactPlacementGroupField.Priority,
        },
      }).success
    ).toBe(false);
    expect(
      projectArtifactPlacementValidator.safeParse({
        ...request,
        lanePatch: {
          ...request.lanePatch,
          valuesByRootId: {
            [SOURCE_ID]: "not-a-status",
            [TARGET_ID]: DocumentStatus.InReview,
          },
        },
      }).success
    ).toBe(false);
  });

  it("accepts additive authoritative source-root lineage evidence", () => {
    expect(
      projectArtifactPlacementResponseValidator.parse({
        placed: true,
        transactionId: TARGET_ID,
        affectedArtifactIds: [SOURCE_ID, TARGET_ID],
        affectedProjectIds: [PROJECT_ID],
        projectVersions: { [PROJECT_ID]: "version-2" },
        placement: {
          sourceArtifactIds: [SOURCE_ID],
          destinationProjectId: PROJECT_ID,
          position: ProjectArtifactPlacementPosition.Root,
        },
        sourceRootMappings: [
          { sourceArtifactId: SOURCE_ID, rootArtifactId: SOURCE_ID },
          { sourceArtifactId: TARGET_ID, rootArtifactId: SOURCE_ID },
        ],
        replayed: false,
        undoAvailable: true,
      }).sourceRootMappings
    ).toEqual([
      { sourceArtifactId: SOURCE_ID, rootArtifactId: SOURCE_ID },
      { sourceArtifactId: TARGET_ID, rootArtifactId: SOURCE_ID },
    ]);
  });
});
