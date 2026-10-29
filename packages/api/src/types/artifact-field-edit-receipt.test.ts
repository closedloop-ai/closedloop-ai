import { describe, expect, it } from "vitest";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditReceiptResult,
  ArtifactFieldEditValueClassification,
  buildArtifactFieldEditSnapshots,
  classifyArtifactFieldEditValue,
} from "./artifact-field-edit-receipt.ts";
import { ArtifactStatusEditSurface } from "./artifact-status-contract.ts";

describe("artifact field edit receipt classification (ISS-9489 AC-1, AC-2)", () => {
  it.each([
    [
      ArtifactFieldEditField.Status,
      "IN_REVIEW",
      ArtifactFieldEditValueClassification.Enumerated,
    ],
    [
      ArtifactFieldEditField.AssigneeId,
      "user-secret-reference",
      ArtifactFieldEditValueClassification.Reference,
    ],
    [
      ArtifactFieldEditField.ApproverId,
      "approver-secret-reference",
      ArtifactFieldEditValueClassification.Reference,
    ],
    [
      ArtifactFieldEditField.Priority,
      "URGENT",
      ArtifactFieldEditValueClassification.Enumerated,
    ],
    [
      ArtifactFieldEditField.Title,
      "raw title allowed",
      ArtifactFieldEditValueClassification.Content,
    ],
    [
      ArtifactFieldEditField.DueDate,
      "2026-10-22T00:00:00.000Z",
      ArtifactFieldEditValueClassification.Date,
    ],
    [
      ArtifactFieldEditField.ProjectId,
      "project-secret-reference",
      ArtifactFieldEditValueClassification.Reference,
    ],
    [
      ArtifactFieldEditField.Tag,
      "tag-secret-reference",
      ArtifactFieldEditValueClassification.Reference,
    ],
    [
      ArtifactFieldEditField.Name,
      "private session name",
      ArtifactFieldEditValueClassification.Content,
    ],
    [
      ArtifactFieldEditField.CustomField,
      "dynamic value",
      ArtifactFieldEditValueClassification.Content,
    ],
  ] as const)(
    "classifies %s without inspecting its value",
    (field, value, expected) => {
      expect(classifyArtifactFieldEditValue(field, value)).toBe(expected);
    }
  );

  it.each(Object.values(ArtifactFieldEditField))(
    "classifies a cleared %s as absent",
    (field) => {
      expect(classifyArtifactFieldEditValue(field, null)).toBe(
        ArtifactFieldEditValueClassification.Absent
      );
    }
  );

  it("preserves raw title snapshots for the established activity feed", () => {
    expect(
      buildArtifactFieldEditSnapshots({
        field: ArtifactFieldEditField.Title,
        before: "Old title",
        after: "New title",
      })
    ).toEqual({
      before: {
        field: ArtifactFieldEditField.Title,
        value: "Old title",
        valueClassification: ArtifactFieldEditValueClassification.Content,
      },
      after: {
        field: ArtifactFieldEditField.Title,
        value: "New title",
        valueClassification: ArtifactFieldEditValueClassification.Content,
        result: ArtifactFieldEditReceiptResult.Committed,
      },
    });
  });

  it("preserves raw session names for the established activity feed", () => {
    const snapshots = buildArtifactFieldEditSnapshots({
      field: ArtifactFieldEditField.Name,
      before: "Private old session name",
      after: "Private new session name",
    });

    expect(snapshots).toEqual({
      before: {
        field: ArtifactFieldEditField.Name,
        value: "Private old session name",
        valueClassification: ArtifactFieldEditValueClassification.Content,
      },
      after: {
        field: ArtifactFieldEditField.Name,
        value: "Private new session name",
        valueClassification: ArtifactFieldEditValueClassification.Content,
        result: ArtifactFieldEditReceiptResult.Committed,
      },
    });
  });

  it("omits dynamic custom-field ids and values from the canonical envelope", () => {
    const snapshots = buildArtifactFieldEditSnapshots({
      field: ArtifactFieldEditField.CustomField,
      before: "private old custom value",
      after: "private new custom value",
    });

    expect(snapshots).toEqual({
      before: {
        field: ArtifactFieldEditField.CustomField,
        value: null,
        valueClassification: ArtifactFieldEditValueClassification.Content,
        valueOmitted: true,
      },
      after: {
        field: ArtifactFieldEditField.CustomField,
        value: null,
        valueClassification: ArtifactFieldEditValueClassification.Content,
        valueOmitted: true,
        result: ArtifactFieldEditReceiptResult.Committed,
      },
    });
    expect(Object.keys(snapshots.before).sort()).toEqual([
      "field",
      "value",
      "valueClassification",
      "valueOmitted",
    ]);
    expect(Object.keys(snapshots.after).sort()).toEqual([
      "field",
      "result",
      "value",
      "valueClassification",
      "valueOmitted",
    ]);
    expect(JSON.stringify(snapshots)).not.toContain("private");
  });
});

describe("artifact field edit receipt provenance (ISS-9489 AC-5)", () => {
  it("records authoritative surface, group, and undo lineage on the committed half", () => {
    const snapshots = buildArtifactFieldEditSnapshots({
      field: ArtifactFieldEditField.Status,
      before: "IN_REVIEW",
      after: "DONE",
      context: {
        provenance: {
          surface: ArtifactStatusEditSurface.Bulk,
          commitGroupId: "commit-group-2",
        },
        undoOfCommitGroupId: "commit-group-1",
      },
    });

    expect(snapshots.after).toMatchObject({
      surface: ArtifactStatusEditSurface.Bulk,
      result: ArtifactFieldEditReceiptResult.Committed,
      commitGroupId: "commit-group-2",
      undoOfCommitGroupId: "commit-group-1",
    });
    expect(snapshots.before).not.toHaveProperty("surface");
    expect(snapshots.before).not.toHaveProperty("commitGroupId");
  });

  it("preserves omission when provenance is missing", () => {
    const { after } = buildArtifactFieldEditSnapshots({
      field: ArtifactFieldEditField.Priority,
      before: "LOW",
      after: "HIGH",
    });

    expect(after).not.toHaveProperty("surface");
    expect(after).not.toHaveProperty("commitGroupId");
    expect(after).not.toHaveProperty("undoOfCommitGroupId");
  });

  it("does not publish orphan undo lineage without an authoritative commit group", () => {
    const { after } = buildArtifactFieldEditSnapshots({
      field: ArtifactFieldEditField.Status,
      before: "DONE",
      after: "IN_REVIEW",
      context: { undoOfCommitGroupId: "untrusted-group" },
    });

    expect(after).not.toHaveProperty("undoOfCommitGroupId");
  });
});
