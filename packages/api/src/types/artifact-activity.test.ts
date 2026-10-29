import { describe, expect, it } from "vitest";
import {
  ARTIFACT_STATUS_SNAPSHOT_FIELD,
  ArtifactStatusCommitResult,
  artifactFieldEditFieldForSessionMetadata,
  buildStatusChangeSnapshots,
  SessionMetadataActivityField,
} from "./artifact-activity.ts";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditValueClassification,
} from "./artifact-field-edit-receipt.ts";
import { ArtifactStatusEditSurface } from "./artifact-status-contract.ts";

describe("ArtifactStatusCommitResult", () => {
  it("declares exactly the one outcome a receipt can describe today", () => {
    // A wire value on a persisted receipt: renaming it is a contract break.
    // One member is deliberate — see the docstring. If a second appears here,
    // the open product question (is a REFUSED attempt recorded?) was answered,
    // and that answer belongs to a human, not to this test.
    expect(Object.values(ArtifactStatusCommitResult)).toEqual(["committed"]);
  });
});

describe("ISS-9489 AC-7 legacy receipt reconciliation", () => {
  it("derives every live legacy session field from the canonical edit contract", () => {
    expect(SessionMetadataActivityField).toEqual({
      Name: ArtifactFieldEditField.Name,
      Priority: ArtifactFieldEditField.Priority,
      ProjectId: ArtifactFieldEditField.ProjectId,
      AssigneeId: ArtifactFieldEditField.AssigneeId,
      OwnerUserId: "ownerUserId",
      Tag: ArtifactFieldEditField.Tag,
    });
  });

  it("maps the legacy owner field onto the canonical assignee taxonomy", () => {
    expect(
      Object.fromEntries(
        Object.values(SessionMetadataActivityField).map((field) => [
          field,
          artifactFieldEditFieldForSessionMetadata(field),
        ])
      )
    ).toEqual({
      [ArtifactFieldEditField.Name]: ArtifactFieldEditField.Name,
      [ArtifactFieldEditField.Priority]: ArtifactFieldEditField.Priority,
      [ArtifactFieldEditField.ProjectId]: ArtifactFieldEditField.ProjectId,
      [ArtifactFieldEditField.AssigneeId]: ArtifactFieldEditField.AssigneeId,
      ownerUserId: ArtifactFieldEditField.AssigneeId,
      [ArtifactFieldEditField.Tag]: ArtifactFieldEditField.Tag,
    });
  });
});

describe("buildStatusChangeSnapshots", () => {
  it("returns BARE STRINGS when no surface is named", () => {
    expect(
      buildStatusChangeSnapshots({ before: "DRAFT", after: "IN_REVIEW" })
    ).toEqual({ before: "DRAFT", after: "IN_REVIEW" });
  });

  it("does not invent a null surface for an unattributed write", () => {
    const { after } = buildStatusChangeSnapshots({
      before: "DRAFT",
      after: "IN_REVIEW",
    });
    expect(after).not.toHaveProperty("surface");
    expect(after).not.toHaveProperty("result");
  });

  it("wraps both sides and files provenance on the after half only", () => {
    expect(
      buildStatusChangeSnapshots({
        before: "DRAFT",
        after: "IN_REVIEW",
        provenance: { surface: ArtifactStatusEditSurface.Detail },
      })
    ).toEqual({
      before: {
        field: ARTIFACT_STATUS_SNAPSHOT_FIELD,
        value: "DRAFT",
        valueClassification: ArtifactFieldEditValueClassification.Enumerated,
      },
      after: {
        field: ARTIFACT_STATUS_SNAPSHOT_FIELD,
        value: "IN_REVIEW",
        surface: ArtifactStatusEditSurface.Detail,
        result: ArtifactStatusCommitResult.Committed,
        valueClassification: ArtifactFieldEditValueClassification.Enumerated,
      },
    });
  });

  it("carries commitGroupId for a grouped commit", () => {
    const { after } = buildStatusChangeSnapshots({
      before: "DRAFT",
      after: "IN_REVIEW",
      provenance: {
        surface: ArtifactStatusEditSurface.Bulk,
        commitGroupId: "group-1",
      },
    });
    expect(after).toMatchObject({ commitGroupId: "group-1" });
  });

  it("OMITS commitGroupId rather than nulling it when there is no group", () => {
    const { after } = buildStatusChangeSnapshots({
      before: "DRAFT",
      after: "IN_REVIEW",
      provenance: { surface: ArtifactStatusEditSurface.Detail },
    });
    expect("commitGroupId" in (after as object)).toBe(false);
  });

  it("keys the envelope on the same field the feed reader labels status by", () => {
    expect(ARTIFACT_STATUS_SNAPSHOT_FIELD).toBe("status");
  });
});
