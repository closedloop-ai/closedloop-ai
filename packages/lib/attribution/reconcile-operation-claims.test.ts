import {
  OperationEvidenceOutcome,
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import {
  type OperationClaim,
  OperationClaimSource,
  ToolResultState,
} from "@repo/api/src/types/operation-claims";
import { describe, expect, it } from "vitest";
import { FINGERPRINT_WINDOW_MS } from "./receipt-outcome";
import {
  type ReceiptCandidate,
  type ReceiptHolder,
  reconcileOperationClaims,
} from "./reconcile-operation-claims";

const INVOKED = "2026-10-16T12:00:00.000Z";
const RESULT = "2026-10-16T12:00:05.000Z";
const RECEIPT_ID = "01a14224-9b59-77ba-b518-16aaa9880991";
const OTHER_RECEIPT_ID = "01a14224-9b59-77ba-b518-16aaa9880992";

function writeClaim(extra: Partial<OperationClaim> = {}): OperationClaim {
  return {
    claimKey: "claude:toolu_1",
    providerCallId: "toolu_1",
    source: OperationClaimSource.ClosedloopMcp,
    toolName: "update-document",
    operationKind: OperationKind.UpdateFields,
    resultState: ToolResultState.Present,
    requestFingerprint: "fp-1",
    invokedAt: INVOKED,
    resultAt: RESULT,
    ...extra,
  };
}

function receipt(extra: Partial<ReceiptCandidate> = {}): ReceiptCandidate {
  return {
    id: RECEIPT_ID,
    operationKind: OperationKind.UpdateFields,
    outcome: OperationReceiptOutcome.Committed,
    clientCallId: "toolu_1",
    requestFingerprint: "fp-1",
    requestedAt: new Date("2026-10-16T12:00:01.000Z"),
    committedAt: new Date("2026-10-16T12:00:02.000Z"),
    targetArtifactId: "01a14224-0000-7000-8000-000000000001",
    createdArtifactId: null,
    versionNumber: null,
    changedFields: ["fileName"],
    contentDigestBefore: null,
    contentDigestAfter: null,
    ...extra,
  };
}

function reconcile(
  claims: OperationClaim[],
  receipts: ReceiptCandidate[],
  heldElsewhere: Map<string, ReceiptHolder> = new Map()
) {
  return reconcileOperationClaims({ claims, receipts, heldElsewhere });
}

describe("reconcileOperationClaims", () => {
  it("binds the receipt carrying the claim's harness call id", () => {
    const [entry] = reconcile(
      [writeClaim()],
      [receipt({ requestFingerprint: null })]
    );

    expect(entry?.receipt?.id).toBe(RECEIPT_ID);
    expect(entry?.outcome).toBe(OperationEvidenceOutcome.Committed);
  });

  it("binds by the operation id the write returned when no call id matches", () => {
    const [entry] = reconcile(
      [
        writeClaim({
          providerCallId: undefined,
          operationIds: [`clop_${RECEIPT_ID}`],
        }),
      ],
      [receipt({ clientCallId: null, requestFingerprint: null })]
    );

    expect(entry?.receipt?.id).toBe(RECEIPT_ID);
  });

  it("binds a unique fingerprint inside the window, and not outside it", () => {
    const claim = writeClaim({ providerCallId: undefined });
    const inside = reconcile([claim], [receipt({ clientCallId: null })]);
    const outside = reconcile(
      [claim],
      [
        receipt({
          clientCallId: null,
          requestedAt: new Date(Date.parse(RESULT) + FINGERPRINT_WINDOW_MS + 1),
        }),
      ]
    );

    expect(inside[0]?.receipt?.id).toBe(RECEIPT_ID);
    expect(outside[0]).toMatchObject({
      outcome: OperationEvidenceOutcome.AwaitingReceipt,
    });
    expect(outside[0]?.receipt).toBeUndefined();
  });

  it("binds nothing when two fingerprint candidates match", () => {
    const [entry] = reconcile(
      [writeClaim({ providerCallId: undefined })],
      [
        receipt({ clientCallId: null }),
        receipt({ id: OTHER_RECEIPT_ID, clientCallId: null }),
      ]
    );

    expect(entry?.outcome).toBe(OperationEvidenceOutcome.Ambiguous);
    expect(entry?.receipt).toBeUndefined();
  });

  it("never binds an ambiguous claim by its call id", () => {
    const [entry] = reconcile(
      [writeClaim({ ambiguous: true, requestFingerprint: undefined })],
      [receipt()]
    );

    expect(entry?.outcome).toBe(OperationEvidenceOutcome.AwaitingReceipt);
  });

  it("takes a committed receipt over a transcript error (committed timeout)", () => {
    const [entry] = reconcile(
      [writeClaim({ resultState: ToolResultState.Error })],
      [receipt()]
    );

    expect(entry?.outcome).toBe(OperationEvidenceOutcome.Committed);
  });

  it("binds one receipt to one claim within a session", () => {
    const entries = reconcile(
      [writeClaim(), writeClaim({ claimKey: "claude:toolu_2" })],
      [receipt()]
    );

    expect(entries.map((entry) => entry.receipt?.id)).toEqual([
      RECEIPT_ID,
      undefined,
    ]);
  });

  it("binds a shell claim's printed receipts only inside its call window", () => {
    const shell: OperationClaim = {
      claimKey: "claude:toolu_shell",
      source: OperationClaimSource.Shell,
      operationIds: [`clop_${RECEIPT_ID}`, `clop_${OTHER_RECEIPT_ID}`],
      invokedAt: INVOKED,
      resultAt: RESULT,
    };
    const entries = reconcile(
      [shell],
      [
        receipt({ clientCallId: null }),
        receipt({
          id: OTHER_RECEIPT_ID,
          clientCallId: null,
          requestedAt: new Date(Date.parse(RESULT) + 1),
        }),
      ]
    );

    expect(entries.map((entry) => [entry.rowKey, entry.receipt?.id])).toEqual([
      [`claude:toolu_shell#${RECEIPT_ID}`, RECEIPT_ID],
    ]);
  });

  it("leaves a receipt with the lineage's first claim, and takes it from a later one", () => {
    const later: ReceiptHolder = {
      ...HOLDER_SESSION,
      receiptId: RECEIPT_ID,
      evidenceId: "evidence-later",
      invokedAt: new Date("2026-10-16T13:00:00.000Z"),
      sameSession: false,
      canonical: false,
      otherOwner: false,
      tied: false,
    };
    const earlier: ReceiptHolder = {
      ...later,
      evidenceId: "evidence-earlier",
      invokedAt: new Date("2026-10-16T11:00:00.000Z"),
    };

    const [takes] = reconcile(
      [writeClaim()],
      [receipt()],
      new Map([[RECEIPT_ID, later]])
    );
    const [yields] = reconcile(
      [writeClaim()],
      [receipt()],
      new Map([[RECEIPT_ID, earlier]])
    );

    expect(takes?.receipt?.id).toBe(RECEIPT_ID);
    expect(takes?.displaced).toEqual({
      ...later,
      outcome: OperationEvidenceOutcome.DuplicateInLineage,
    });
    expect(yields?.receipt).toBeUndefined();
    expect(yields?.outcome).toBe(OperationEvidenceOutcome.DuplicateInLineage);
  });

  it("gives a receipt to neither of two claims invoked at the same instant", () => {
    const tied: ReceiptHolder = {
      ...HOLDER_SESSION,
      receiptId: RECEIPT_ID,
      evidenceId: "evidence-tied",
      invokedAt: new Date(INVOKED),
      sameSession: false,
      canonical: false,
      otherOwner: false,
      tied: false,
    };

    const [entry] = reconcile(
      [writeClaim()],
      [receipt()],
      new Map([[RECEIPT_ID, tied]])
    );

    expect(entry?.receipt).toBeUndefined();
    expect(entry?.outcome).toBe(OperationEvidenceOutcome.Ambiguous);
    expect(entry?.contestedReceiptId).toBe(RECEIPT_ID);
    expect(entry?.displaced).toEqual({
      ...tied,
      outcome: OperationEvidenceOutcome.Ambiguous,
    });
  });

  it("keeps a tie contested when one side resyncs at a different instant", () => {
    const contesting: ReceiptHolder = {
      ...HOLDER_SESSION,
      receiptId: RECEIPT_ID,
      evidenceId: "evidence-contesting",
      invokedAt: new Date("2026-10-16T13:00:00.000Z"),
      sameSession: false,
      canonical: false,
      otherOwner: false,
      tied: true,
    };

    const [entry] = reconcile(
      [writeClaim()],
      [receipt()],
      new Map([[RECEIPT_ID, contesting]])
    );

    expect(entry?.receipt).toBeUndefined();
    expect(entry?.outcome).toBe(OperationEvidenceOutcome.Ambiguous);
    expect(entry?.contestedReceiptId).toBe(RECEIPT_ID);
    expect(entry?.displaced).toBeUndefined();
  });

  it("leaves a receipt with the canonical copy of the same session, tie or not", () => {
    const canonicalCopy: ReceiptHolder = {
      ...HOLDER_SESSION,
      receiptId: RECEIPT_ID,
      evidenceId: "evidence-canonical-copy",
      invokedAt: new Date(INVOKED),
      sameSession: true,
      canonical: true,
      otherOwner: false,
      tied: false,
    };

    const [entry] = reconcile(
      [writeClaim()],
      [receipt()],
      new Map([[RECEIPT_ID, canonicalCopy]])
    );

    expect(entry?.receipt).toBeUndefined();
    expect(entry?.outcome).toBe(OperationEvidenceOutcome.DuplicateInLineage);
    expect(entry?.displaced).toBeUndefined();
  });

  it("takes a receipt from a non-canonical copy of the same session, tie or not", () => {
    const otherCopy: ReceiptHolder = {
      ...HOLDER_SESSION,
      receiptId: RECEIPT_ID,
      evidenceId: "evidence-other-copy",
      invokedAt: new Date(INVOKED),
      sameSession: true,
      canonical: false,
      otherOwner: false,
      tied: false,
    };

    const [entry] = reconcile(
      [writeClaim()],
      [receipt()],
      new Map([[RECEIPT_ID, otherCopy]])
    );

    expect(entry?.receipt?.id).toBe(RECEIPT_ID);
    expect(entry?.outcome).toBe(OperationEvidenceOutcome.Committed);
    expect(entry?.displaced).toEqual({
      ...otherCopy,
      outcome: OperationEvidenceOutcome.DuplicateInLineage,
    });
  });

  it("gives a read the transcript's own outcome", () => {
    const read = (resultState: ToolResultState) =>
      reconcile(
        [
          writeClaim({
            operationKind: OperationKind.Read,
            toolName: "get-document",
            resultState,
          }),
        ],
        [receipt()]
      )[0];

    expect(read(ToolResultState.Present)?.outcome).toBe(
      OperationEvidenceOutcome.Committed
    );
    expect(read(ToolResultState.Present)?.receipt).toBeUndefined();
    expect(read(ToolResultState.Error)?.outcome).toBe(
      OperationEvidenceOutcome.Errored
    );
    expect(read(ToolResultState.Missing)?.outcome).toBe(
      OperationEvidenceOutcome.MissingResult
    );
  });
});

describe("receipt kind must match the claim (ISS-12552 review)", () => {
  it("binds no receipt of another operation to a write claim", () => {
    const [entry] = reconcile(
      [writeClaim({ operationKind: OperationKind.Create })],
      [receipt({ operationKind: OperationKind.Comment })]
    );

    expect(entry?.receipt).toBeUndefined();
    expect(entry?.outcome).toBe(OperationEvidenceOutcome.AwaitingReceipt);
  });

  it("binds a shell claim, which names no operation, to the receipt it printed", () => {
    const [entry] = reconcile(
      [
        {
          claimKey: "claude:toolu_shell",
          source: OperationClaimSource.Shell,
          resultState: ToolResultState.Present,
          operationIds: [`clop_${RECEIPT_ID}`],
          invokedAt: INVOKED,
          resultAt: RESULT,
        },
      ],
      [receipt({ operationKind: OperationKind.Comment })]
    );

    expect(entry?.receipt?.id).toBe(RECEIPT_ID);
  });
});

/** Another session of the owner holding a receipt by its call id. */
const HOLDER_SESSION = {
  agentSessionId: "session-holder",
  sessionStartedAt: null,
  byIdentity: true,
  session: {
    harness: "claude",
    externalSessionId: "holder-session",
    computeTargetId: "00000000-0000-0000-0000-000000000001",
  },
};
