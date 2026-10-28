import {
  AttributionRelationshipKind,
  OperationEvidenceOutcome,
  OperationKind,
  OperationReceiptOutcome,
  UnresolvedReason,
} from "@repo/api/src/types/attribution-evidence";
import {
  type OperationClaim,
  OperationClaimSource,
} from "@repo/api/src/types/operation-claims";
import { describe, expect, it } from "vitest";
import {
  classifyBoundReceipt,
  classifyReconciledClaim,
} from "./classify-reconciled-claim";
import type {
  ReceiptCandidate,
  ReconciledClaim,
} from "./reconcile-operation-claims";

const DOCUMENT_ID = "01a155a2-71c2-74f2-93bc-9f34a4d6ab1d";
const OTHER_ORG_DOCUMENT_ID = "01a1559c-25fd-753e-b834-ee3dfd982b24";

function mcpClaim(operationKind: OperationKind): OperationClaim {
  return {
    claimKey: `claude:toolu_${operationKind}`,
    source: OperationClaimSource.ClosedloopMcp,
    operationKind,
  };
}

function receipt(extra: Partial<ReceiptCandidate>): ReceiptCandidate {
  return {
    id: "clop_01a155a2-71e0-7393-ae47-818560d156bc",
    operationKind: OperationKind.UpdateFields,
    outcome: OperationReceiptOutcome.Committed,
    clientCallId: null,
    requestFingerprint: null,
    requestedAt: new Date("2026-10-19T19:27:51.664Z"),
    committedAt: new Date("2026-10-19T19:27:51.775Z"),
    targetArtifactId: DOCUMENT_ID,
    createdArtifactId: null,
    versionNumber: null,
    changedFields: [],
    contentDigestBefore: null,
    contentDigestAfter: null,
    ...extra,
  };
}

function entry(
  claim: OperationClaim,
  outcome: OperationEvidenceOutcome,
  withReceipt?: ReceiptCandidate
): ReconciledClaim {
  return {
    claim,
    rowKey: claim.claimKey,
    outcome,
    ...(withReceipt ? { receipt: withReceipt } : {}),
  };
}

describe("classifyReconciledClaim", () => {
  it("keeps a reference claim a reference", () => {
    const result = classifyReconciledClaim(
      entry(
        {
          claimKey: "ref:PRD-1",
          source: OperationClaimSource.Reference,
          referenceSlug: "PRD-1",
        },
        OperationEvidenceOutcome.Committed
      ),
      DOCUMENT_ID
    );

    expect(result.kind).toBe(AttributionRelationshipKind.Reference);
  });

  it("classifies a rejected update whose target never resolved as unresolved, not a reference", () => {
    const result = classifyReconciledClaim(
      entry(
        mcpClaim(OperationKind.UpdateFields),
        OperationEvidenceOutcome.Rejected,
        receipt({
          outcome: OperationReceiptOutcome.Rejected,
          targetArtifactId: null,
        })
      ),
      null
    );

    expect(result).toEqual({
      operationKind: OperationKind.UpdateFields,
      targetArtifactId: null,
      kind: AttributionRelationshipKind.Unresolved,
      unresolvedReason: UnresolvedReason.Rejected,
    });
  });

  it("classifies a failed create with no receipt and no target as unresolved", () => {
    const result = classifyReconciledClaim(
      entry(
        mcpClaim(OperationKind.Create),
        OperationEvidenceOutcome.AwaitingReceipt
      ),
      null
    );

    expect(result.kind).toBe(AttributionRelationshipKind.Unresolved);
    expect(result.unresolvedReason).toBe(UnresolvedReason.AwaitingReceipt);
  });

  it("classifies a successful list with no single target as a read", () => {
    const result = classifyReconciledClaim(
      entry(mcpClaim(OperationKind.List), OperationEvidenceOutcome.Committed),
      null
    );

    expect(result).toEqual({
      operationKind: OperationKind.List,
      targetArtifactId: null,
      kind: AttributionRelationshipKind.Usage,
    });
  });

  it("targets a create's created artifact and an update's receipt target ahead of the observed id", () => {
    const created = classifyReconciledClaim(
      entry(
        mcpClaim(OperationKind.Create),
        OperationEvidenceOutcome.Committed,
        receipt({
          operationKind: OperationKind.Create,
          targetArtifactId: OTHER_ORG_DOCUMENT_ID,
          createdArtifactId: DOCUMENT_ID,
        })
      ),
      OTHER_ORG_DOCUMENT_ID
    );
    const revised = classifyReconciledClaim(
      entry(
        mcpClaim(OperationKind.UpdateFields),
        OperationEvidenceOutcome.Committed,
        receipt({ changedFields: ["title"] })
      ),
      OTHER_ORG_DOCUMENT_ID
    );

    expect(created).toMatchObject({
      targetArtifactId: DOCUMENT_ID,
      kind: AttributionRelationshipKind.Creation,
    });
    expect(revised).toMatchObject({
      targetArtifactId: DOCUMENT_ID,
      kind: AttributionRelationshipKind.Revision,
    });
  });

  it("falls back to the observed id for a read with no receipt", () => {
    const result = classifyReconciledClaim(
      entry(mcpClaim(OperationKind.Read), OperationEvidenceOutcome.Committed),
      DOCUMENT_ID
    );

    expect(result).toMatchObject({
      targetArtifactId: DOCUMENT_ID,
      kind: AttributionRelationshipKind.Usage,
    });
  });
});

describe("a bound receipt decides its own operation and artifact (ISS-12552 review)", () => {
  it("never takes the claim's kind or the observed target over the receipt's", () => {
    const bound = receipt({
      operationKind: OperationKind.Comment,
      targetArtifactId: DOCUMENT_ID,
    });

    expect(
      classifyReconciledClaim(
        entry(
          mcpClaim(OperationKind.Create),
          OperationEvidenceOutcome.Committed,
          bound
        ),
        OTHER_ORG_DOCUMENT_ID
      )
    ).toEqual({
      operationKind: OperationKind.Comment,
      targetArtifactId: DOCUMENT_ID,
      kind: AttributionRelationshipKind.CommentReview,
    });
  });

  it("keeps a rejected create with no created artifact unresolved, on the late-bind path too", () => {
    const rejected = receipt({
      operationKind: OperationKind.Create,
      outcome: OperationReceiptOutcome.Rejected,
      targetArtifactId: null,
    });

    expect(
      classifyBoundReceipt(rejected, OperationEvidenceOutcome.Rejected)
    ).toEqual({
      operationKind: OperationKind.Create,
      targetArtifactId: null,
      kind: AttributionRelationshipKind.Unresolved,
      unresolvedReason: UnresolvedReason.Rejected,
    });
  });
});
