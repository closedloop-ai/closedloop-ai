import { randomUUID } from "node:crypto";
import {
  formatOperationId,
  OperationKind,
  type OperationReceipt,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import type { TransactionClient } from "@repo/database";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@repo/database", () => ({ withDb: vi.fn() }));
vi.mock("./bind-awaiting-claim", () => ({
  bindAwaitingClaimForReceipt: vi.fn(),
}));
vi.mock("./operation-receipt-writer", () => ({
  recordOperationReceipt: vi.fn(),
  recordRejectedOperationReceipt: vi.fn(),
}));

import { bindAwaitingClaimForReceipt } from "./bind-awaiting-claim";
import {
  createRecorderForRequest,
  type OperationReceiptRecorder,
  recordRejectionForClientError,
} from "./operation-receipt-recorder";
import type { OperationReceiptRequest } from "./operation-receipt-request";
import { recordOperationReceipt } from "./operation-receipt-writer";

const COMMITTED_RECEIPT: OperationReceipt = {
  operationId: "clop_receipt-1",
  outcome: OperationReceiptOutcome.Committed,
};

describe("recordRejectionForClientError", () => {
  it("records a rejection for a 4xx answer to a request with no receipt", async () => {
    const recorder = fakeRecorder(undefined);

    await recordRejectionForClientError(
      new Response(null, { status: 400 }),
      recorder,
      OperationKind.UpdateFields
    );

    expect(recorder.rejected).toHaveBeenCalledWith(
      OperationKind.UpdateFields,
      undefined
    );
  });

  it("never calls a request that already holds a receipt rejected", async () => {
    const recorder = fakeRecorder(COMMITTED_RECEIPT);

    await recordRejectionForClientError(
      new Response(null, { status: 400 }),
      recorder,
      OperationKind.UpdateFields
    );

    expect(recorder.rejected).not.toHaveBeenCalled();
  });
});

describe("settle", () => {
  it("runs no late bind for a receipt with no call id and no fingerprint", async () => {
    const receiptId = await recordAndSettle(receiptRequest({}));

    expect(receiptId).not.toBeNull();
    expect(bindAwaitingClaimForReceipt).not.toHaveBeenCalled();
  });

  it("late-binds a receipt that carries a call id", async () => {
    const receiptId = await recordAndSettle(
      receiptRequest({ clientCallId: "toolu_settle" })
    );

    expect(bindAwaitingClaimForReceipt).toHaveBeenCalledWith(
      receiptId,
      ORGANIZATION_ID
    );
  });

  it("late-binds every receipt a batch recorded, in order", async () => {
    const receiptIds = [randomUUID(), randomUUID(), randomUUID()];
    for (const receiptId of receiptIds) {
      vi.mocked(recordOperationReceipt).mockResolvedValueOnce({
        operationId: formatOperationId(receiptId),
        outcome: OperationReceiptOutcome.Committed,
      });
    }
    const recorder = createRecorderForRequest(
      receiptRequest({ clientCallId: "toolu_batch" })
    );
    for (const _receiptId of receiptIds) {
      await recorder.record({} as TransactionClient, {
        operationKind: OperationKind.Create,
        outcome: OperationReceiptOutcome.Committed,
      });
    }

    await recorder.settle();

    expect(vi.mocked(bindAwaitingClaimForReceipt).mock.calls).toEqual(
      receiptIds.map((receiptId) => [receiptId, ORGANIZATION_ID])
    );
  });

  it("late-binds a receipt that carries only a fingerprint", async () => {
    const receiptId = await recordAndSettle(
      receiptRequest({ requestFingerprint: "fp_settle" })
    );

    expect(bindAwaitingClaimForReceipt).toHaveBeenCalledWith(
      receiptId,
      ORGANIZATION_ID
    );
  });
});

describe("whenRecording", () => {
  it("hands the record callback over only when the request records", () => {
    const record = vi.fn(async () => undefined);

    expect(
      createRecorderForRequest(receiptRequest({})).whenRecording(record)
    ).toBe(record);
    expect(createRecorderForRequest(null).whenRecording(record)).toBe(
      undefined
    );
  });
});

function fakeRecorder(
  receipt: OperationReceipt | undefined
): OperationReceiptRecorder & {
  rejected: ReturnType<typeof vi.fn<OperationReceiptRecorder["rejected"]>>;
} {
  return {
    record: vi.fn(),
    recordStandalone: vi.fn(),
    rejected: vi.fn<OperationReceiptRecorder["rejected"]>(
      async () => undefined
    ),
    settle: vi.fn(),
    whenRecording: vi.fn(),
    receipt,
    active: true,
  };
}

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000012552";

function receiptRequest(
  keys: Pick<OperationReceiptRequest, "clientCallId" | "requestFingerprint">
): OperationReceiptRequest {
  return {
    organizationId: ORGANIZATION_ID,
    principalUserId: randomUUID(),
    source: OperationSource.Mcp,
    requestedAt: new Date(),
    ...keys,
  };
}

/** Records one committed receipt, settles, and returns its receipt id. */
async function recordAndSettle(
  request: OperationReceiptRequest
): Promise<string> {
  const receiptId = randomUUID();
  vi.mocked(recordOperationReceipt).mockResolvedValue({
    operationId: formatOperationId(receiptId),
    outcome: OperationReceiptOutcome.Committed,
  });
  const recorder = createRecorderForRequest(request);
  await recorder.record({} as TransactionClient, {
    operationKind: OperationKind.DesktopSync,
    outcome: OperationReceiptOutcome.Committed,
  });
  await recorder.settle();
  return receiptId;
}
