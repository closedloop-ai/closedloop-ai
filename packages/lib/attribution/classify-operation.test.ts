import {
  AttributionRelationshipKind,
  OperationEvidenceOutcome,
  OperationKind,
  UnresolvedReason,
} from "@repo/api/src/types/attribution-evidence";
import { MACHINE_OPERATION_KINDS } from "@repo/api/src/types/closedloop-operation-semantics";
import { describe, expect, it } from "vitest";
import {
  classifyOperation,
  qualifiesForProduction,
  qualifiesForWritingCost,
} from "./classify-operation";

const committed = (
  operationKind: OperationKind,
  extra: { contentChanged?: boolean; changedFields?: string[] } = {}
) =>
  classifyOperation({
    operationKind,
    outcome: OperationEvidenceOutcome.Committed,
    targetMatched: true,
    ...extra,
  });

describe("classifyOperation (ISS-12552 classification table)", () => {
  it("maps each committed operation on its target", () => {
    expect(committed(OperationKind.Create).kind).toBe(
      AttributionRelationshipKind.Creation
    );
    expect(
      committed(OperationKind.CreateVersion, { contentChanged: true }).kind
    ).toBe(AttributionRelationshipKind.Revision);
    expect(
      committed(OperationKind.UpdateFields, { changedFields: ["fileName"] })
        .kind
    ).toBe(AttributionRelationshipKind.Revision);
    expect(committed(OperationKind.Comment).kind).toBe(
      AttributionRelationshipKind.CommentReview
    );
    for (const kind of [
      OperationKind.Read,
      OperationKind.List,
      OperationKind.Search,
    ]) {
      expect(committed(kind).kind).toBe(AttributionRelationshipKind.Usage);
    }
  });

  it("gives no revision for a version or update that changed nothing", () => {
    for (const result of [
      committed(OperationKind.CreateVersion, { contentChanged: false }),
      committed(OperationKind.CreateVersion),
      committed(OperationKind.UpdateFields, { changedFields: [] }),
      committed(OperationKind.UpdateFields),
    ]) {
      expect(result).toEqual({
        kind: AttributionRelationshipKind.Unresolved,
        unresolvedReason: UnresolvedReason.NoOp,
      });
    }
  });

  it("leaves committed writes the table does not name unresolved", () => {
    for (const kind of [
      OperationKind.LinkCreate,
      OperationKind.Tag,
      OperationKind.Attach,
      OperationKind.Move,
      OperationKind.Delete,
      OperationKind.Rate,
      ...MACHINE_OPERATION_KINDS,
      OperationKind.Unsupported,
    ]) {
      expect(committed(kind)).toEqual({
        kind: AttributionRelationshipKind.Unresolved,
        unresolvedReason: UnresolvedReason.UnsupportedOperation,
      });
    }
  });

  it("never counts a live-draft reset as a revision, even one that moved content", () => {
    const result = committed(OperationKind.LiveDraftReset, {
      contentChanged: true,
      changedFields: ["content"],
    });

    expect(result).toEqual({
      kind: AttributionRelationshipKind.Unresolved,
      unresolvedReason: UnresolvedReason.UnsupportedOperation,
    });
    expect(qualifiesForWritingCost(result.kind)).toBe(false);
    expect(qualifiesForProduction(result.kind)).toBe(false);
  });

  it("gives a nested or prose target a reference, whatever the operation did", () => {
    expect(
      classifyOperation({
        operationKind: OperationKind.Create,
        outcome: OperationEvidenceOutcome.Committed,
        targetMatched: false,
      }).kind
    ).toBe(AttributionRelationshipKind.Reference);
  });

  it("keeps every outcome short of a commit unresolved, with its reason", () => {
    const cases: [OperationEvidenceOutcome, UnresolvedReason][] = [
      [OperationEvidenceOutcome.Rejected, UnresolvedReason.Rejected],
      [OperationEvidenceOutcome.Errored, UnresolvedReason.Errored],
      [OperationEvidenceOutcome.Canceled, UnresolvedReason.Canceled],
      [OperationEvidenceOutcome.MissingResult, UnresolvedReason.MissingResult],
      [
        OperationEvidenceOutcome.AwaitingReceipt,
        UnresolvedReason.AwaitingReceipt,
      ],
      [
        OperationEvidenceOutcome.DuplicateInLineage,
        UnresolvedReason.DuplicateInLineage,
      ],
    ];
    for (const [outcome, reason] of cases) {
      expect(
        classifyOperation({
          operationKind: OperationKind.Create,
          outcome,
          targetMatched: true,
        })
      ).toEqual({
        kind: AttributionRelationshipKind.Unresolved,
        unresolvedReason: reason,
      });
    }
  });

  it("counts only creation as production, and creation and revision as writing", () => {
    expect(
      Object.values(AttributionRelationshipKind).filter(qualifiesForProduction)
    ).toEqual([AttributionRelationshipKind.Creation]);
    expect(
      Object.values(AttributionRelationshipKind).filter(qualifiesForWritingCost)
    ).toEqual([
      AttributionRelationshipKind.Creation,
      AttributionRelationshipKind.Revision,
    ]);
  });
});
