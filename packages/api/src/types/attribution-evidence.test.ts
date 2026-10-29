import { describe, expect, it } from "vitest";
import {
  AttributionRelationshipKind,
  formatOperationId,
  OPERATION_ID_PREFIX,
  OperationEvidenceOutcome,
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
  parseOperationId,
  parseOperationReceiptOutcome,
  UnresolvedReason,
} from "./attribution-evidence.ts";
import {
  attributionCoverageSchema,
  attributionOperationIdentitySchema,
  attributionRelationshipEvidenceSchema,
  operationReceiptSchema,
  sessionLinkAttributionEvidenceSchema,
} from "./attribution-evidence-schema.ts";

const RECEIPT_ID = "01a14224-9b59-77ba-b518-16aaa9880991";
const ARTIFACT_UUID = "01a13c2a-7842-7212-ad4b-3a93ea38bcd8";

describe("operation ids", () => {
  it("round-trips a receipt id through its prefixed wire form", () => {
    const wire = formatOperationId(RECEIPT_ID);

    expect(wire).toBe(`clop_${RECEIPT_ID}`);
    expect(parseOperationId(wire)).toBe(RECEIPT_ID);
  });

  it("never reads a bare artifact UUID as an operation id", () => {
    expect(parseOperationId(ARTIFACT_UUID)).toBeNull();
  });

  it("rejects a prefix followed by something other than a uuid", () => {
    expect(parseOperationId(`${OPERATION_ID_PREFIX}ISS-12552`)).toBeNull();
    expect(parseOperationId(OPERATION_ID_PREFIX)).toBeNull();
  });
});

describe("parseOperationReceiptOutcome", () => {
  it("returns a known outcome unchanged", () => {
    expect(parseOperationReceiptOutcome(OperationReceiptOutcome.NoOp)).toBe(
      OperationReceiptOutcome.NoOp
    );
  });

  it("reads a value it does not know as unknown instead of failing", () => {
    expect(parseOperationReceiptOutcome("partiallyCommitted")).toBe("unknown");
  });

  it("keeps internal evidence states off the public receipt vocabulary", () => {
    expect(
      parseOperationReceiptOutcome(OperationEvidenceOutcome.AwaitingReceipt)
    ).toBe("unknown");
  });
});

describe("operationReceiptSchema", () => {
  it("accepts an outcome added after this client shipped", () => {
    const parsed = operationReceiptSchema.parse({
      operationId: formatOperationId(RECEIPT_ID),
      outcome: "partiallyCommitted",
    });

    expect(parsed.outcome).toBe("partiallyCommitted");
  });

  it("rejects a receipt whose id is a bare uuid", () => {
    const result = operationReceiptSchema.safeParse({
      operationId: RECEIPT_ID,
      outcome: OperationReceiptOutcome.Committed,
    });

    expect(result.success).toBe(false);
  });
});

describe("attributionOperationIdentitySchema", () => {
  it("parses the minimal shape an older producer can send", () => {
    const parsed = attributionOperationIdentitySchema.parse({
      source: OperationSource.TranscriptOnly,
      operationKind: OperationKind.Read,
      outcome: OperationEvidenceOutcome.Committed,
    });

    expect(parsed).toEqual({
      source: OperationSource.TranscriptOnly,
      operationKind: OperationKind.Read,
      outcome: OperationEvidenceOutcome.Committed,
    });
  });

  it("rejects an unknown key at the strict boundary", () => {
    const result = attributionOperationIdentitySchema.safeParse({
      source: OperationSource.Mcp,
      operationKind: OperationKind.Create,
      outcome: OperationEvidenceOutcome.Committed,
      sessionClaim: "forged",
    });

    expect(result.success).toBe(false);
  });
});

describe("attributionRelationshipEvidenceSchema", () => {
  it("keeps an unresolved reason instead of a class when nothing is proven", () => {
    const parsed = attributionRelationshipEvidenceSchema.parse({
      evidenceId: "evidence-1",
      kind: AttributionRelationshipKind.Unresolved,
      target: { observedSlug: "ISS-12552" },
      unresolvedReason: UnresolvedReason.MissingResult,
    });

    expect(parsed.kind).toBe(AttributionRelationshipKind.Unresolved);
    expect(parsed.unresolvedReason).toBe(UnresolvedReason.MissingResult);
    expect(parsed.durableResult).toBeUndefined();
  });
});

describe("sessionLinkAttributionEvidenceSchema", () => {
  it("passes through a key a newer API added", () => {
    const parsed = sessionLinkAttributionEvidenceSchema.parse({
      contractVersion: 1,
      policyVersion: 1,
      extractorVersion: 1,
      relationshipKind: AttributionRelationshipKind.Revision,
      operations: [
        {
          operationId: formatOperationId(RECEIPT_ID),
          relationshipKind: AttributionRelationshipKind.Revision,
          operationKind: OperationKind.CreateVersion,
          outcome: OperationEvidenceOutcome.Committed,
          durableResult: { versionNumber: 3 },
        },
      ],
      addedLater: "kept",
    });

    expect(parsed).toMatchObject({ addedLater: "kept" });
    expect(parsed.operations[0]?.durableResult?.versionNumber).toBe(3);
  });

  it("drops an operation a newer API added and keeps the row's known evidence", () => {
    const parsed = sessionLinkAttributionEvidenceSchema.parse({
      contractVersion: 1,
      policyVersion: 1,
      extractorVersion: 1,
      relationshipKind: AttributionRelationshipKind.Creation,
      operations: [
        {
          relationshipKind: AttributionRelationshipKind.Creation,
          operationKind: OperationKind.Create,
          outcome: OperationEvidenceOutcome.Committed,
          durableResult: { versionNumber: 1, addedLater: "kept" },
        },
        {
          relationshipKind: AttributionRelationshipKind.Revision,
          operationKind: "operationKindAddedLater",
          outcome: OperationEvidenceOutcome.Committed,
        },
      ],
    });

    expect(parsed.relationshipKind).toBe(AttributionRelationshipKind.Creation);
    expect(parsed.operations).toHaveLength(1);
    expect(parsed.operations[0]?.operationKind).toBe(OperationKind.Create);
    expect(parsed.operations[0]?.durableResult).toMatchObject({
      addedLater: "kept",
    });
  });

  it("re-derives a row kind a newer API added from the operations it can read", () => {
    const parsed = sessionLinkAttributionEvidenceSchema.parse({
      contractVersion: 1,
      policyVersion: 1,
      extractorVersion: 1,
      relationshipKind: "relationshipKindAddedLater",
      operations: [
        {
          relationshipKind: AttributionRelationshipKind.Reference,
          operationKind: OperationKind.Read,
          outcome: OperationEvidenceOutcome.Committed,
        },
        {
          relationshipKind: AttributionRelationshipKind.Revision,
          operationKind: OperationKind.UpdateFields,
          outcome: OperationEvidenceOutcome.Committed,
        },
        {
          relationshipKind: "relationshipKindAddedLater",
          operationKind: OperationKind.UpdateFields,
          outcome: OperationEvidenceOutcome.Committed,
        },
      ],
    });

    expect(parsed.relationshipKind).toBe(AttributionRelationshipKind.Revision);
    expect(parsed.operations).toHaveLength(2);
  });

  it("rejects a row whose kind and operations are all ones it cannot read", () => {
    expect(
      sessionLinkAttributionEvidenceSchema.safeParse({
        contractVersion: 1,
        policyVersion: 1,
        extractorVersion: 1,
        relationshipKind: "relationshipKindAddedLater",
        operations: [],
      }).success
    ).toBe(false);
  });
});

describe("attributionCoverageSchema session cost gap", () => {
  const coverage = {
    measuredTokens: 100,
    provenTokens: 40,
    estimatedTokens: 50,
    unattributedTokens: 10,
    unpricedTokens: 20,
    unresolvedOperations: 0,
    unsupportedOperations: 0,
    extractionComplete: true,
  };

  it("accepts coverage with no gap, and a gap in either direction", () => {
    expect(attributionCoverageSchema.safeParse(coverage).success).toBe(true);
    for (const sessionCostGapMicros of [1500, -1500, 0]) {
      expect(
        attributionCoverageSchema.safeParse({
          ...coverage,
          sessionCostGapMicros,
        }).success
      ).toBe(true);
    }
  });

  it("rejects a gap that is not whole micro-dollars", () => {
    expect(
      attributionCoverageSchema.safeParse({
        ...coverage,
        sessionCostGapMicros: 0.5,
      }).success
    ).toBe(false);
  });

  it("round-trips the allocated per-event cost beside the gap", () => {
    const published = {
      ...coverage,
      allocatedCostMicros: 6000,
      sessionCostGapMicros: 4000,
    };

    expect(
      attributionCoverageSchema.parse(JSON.parse(JSON.stringify(published)))
    ).toEqual(published);
  });

  it.each([-1, 0.5, Number.NaN])(
    "rejects an allocated per-event cost of %s",
    (allocatedCostMicros) => {
      expect(
        attributionCoverageSchema.safeParse({
          ...coverage,
          allocatedCostMicros,
        }).success
      ).toBe(false);
    }
  );
});
