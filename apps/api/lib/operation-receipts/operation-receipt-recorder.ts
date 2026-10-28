import "server-only";

import {
  type OperationKind,
  type OperationReceipt,
  parseOperationId,
} from "@repo/api/src/types/attribution-evidence";
import { type TransactionClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import type { NextRequest } from "next/server";
import { runWithAttributionEvidenceGate } from "@/lib/attribution-evidence-gate-scope";
import { isAttributionEvidenceEnabledForOrganization } from "@/lib/attribution-evidence-policy-feature";
import type {
  AuthContext,
  AuthenticatedJsonResponse,
  RouteContext,
} from "@/lib/auth/with-auth";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import { bindAwaitingClaimForReceipt } from "./bind-awaiting-claim";
import {
  type OperationReceiptRequest,
  readOperationReceiptRequest,
  receiptRouteTemplate,
} from "./operation-receipt-request";
import {
  type OperationReceiptWrite,
  recordOperationReceipt,
  recordRejectedOperationReceipt,
} from "./operation-receipt-writer";

/** Logged when a post-commit receipt cannot be stored. */
export const OPERATION_RECEIPT_WRITE_FAILED_EVENT =
  "operation_receipt_write_failed" as const;

/**
 * Logged when binding a committed receipt to its waiting claim fails. The
 * session's next sync, or the backfill, runs the same reconciliation.
 */
export const OPERATION_RECEIPT_BIND_FAILED_EVENT =
  "operation_receipt_bind_failed" as const;

/**
 * ISS-12552: one write's receipt, recorded from inside the service's own
 * transaction and handed back to the route for its response.
 *
 * A route builds one per request and passes `record` into the service's
 * existing in-transaction callback (for example `RecordCreatedArtifact`), so
 * the receipt commits with the write and never with a write that rolled back.
 */
export type OperationReceiptRecorder = {
  record: (
    tx: TransactionClient,
    write: OperationReceiptWrite
  ) => Promise<void>;
  /**
   * For a no-op whose write transaction rolled back, such as re-applying a
   * tag the artifact already has: the receipt gets its own short one.
   */
  recordStandalone: (write: OperationReceiptWrite) => Promise<void>;
  rejected: (
    operationKind: OperationKind,
    targetArtifactId?: string
  ) => Promise<void>;
  /**
   * After the write committed: bind each receipt the request recorded to a
   * claim a session already synced while waiting on it.
   * Never throws.
   */
  settle: () => Promise<void>;
  /**
   * `record` when this request records its write, otherwise undefined. Hand
   * the result to a service's record parameter: given undefined, the service
   * runs its write exactly as it did before receipts (`writeInShape` in
   * `record-write-in-transaction.ts`), which is how a session caller and an
   * API-key caller with the flag off keep main's behavior.
   */
  whenRecording: <T>(
    record: RecordWriteInTransaction<T>
  ) => RecordWriteInTransaction<T> | undefined;
  /** The receipt for the response; undefined when the request gets none. */
  readonly receipt: OperationReceipt | undefined;
  /**
   * True when this request gets a receipt at all (an API-key write with the
   * flag on). Only a receipt helper may read it, to return early before
   * building receipts; a service or route must never pick a write's shape
   * from it. A write's shape follows from the record it is handed
   * ({@link OperationReceiptRecorder.whenRecording}).
   */
  readonly active: boolean;
};

/**
 * ISS-12552 (PRD-800 "Rollout"): with `attribution-evidence-policy` off
 * for the caller's organization, every route gets the inactive recorder, so no
 * receipt, rejected receipt or late bind is written and no response carries
 * one. The flag is read here, before the route opens its write transaction,
 * and only for a request that would get a receipt at all.
 */
export async function createOperationReceiptRecorder(
  context: AuthContext,
  request: Request,
  routeParams: Readonly<Record<string, string | string[] | undefined>>
): Promise<OperationReceiptRecorder> {
  const receiptRequest = readOperationReceiptRequest(context, request);
  if (!receiptRequest) {
    return createRecorderForRequest(null);
  }
  const enabled = await isAttributionEvidenceEnabledForOrganization(
    receiptRequest.organizationId
  );
  return createRecorderForRequest(
    enabled
      ? {
          ...receiptRequest,
          route: receiptRouteTemplate(request, routeParams),
        }
      : null
  );
}

export function createRecorderForRequest(
  receiptRequest: OperationReceiptRequest | null
): OperationReceiptRecorder {
  let receipt: OperationReceipt | undefined;
  // ISS-12552: every receipt this request recorded, in order. A batch records
  // one per artifact, and each one needs its own late bind; `receipt` keeps
  // only the last, for the response.
  const recorded: OperationReceipt[] = [];
  const remember = (written: OperationReceipt | null) => {
    receipt = written ?? undefined;
    if (written) {
      recorded.push(written);
    }
  };
  return {
    async record(tx, write) {
      remember(
        await recordOperationReceipt({
          tx,
          request: receiptRequest,
          write,
        })
      );
    },
    async recordStandalone(write) {
      if (!receiptRequest) {
        return;
      }
      // Fail-open: the write already committed, so a receipt that cannot be
      // stored must not fail it. The transcript claim then stays unresolved,
      // which never produces a wrong classification.
      try {
        remember(
          await withDb.tx((tx) =>
            recordOperationReceipt({ tx, request: receiptRequest, write })
          )
        );
      } catch (error) {
        log.warn(OPERATION_RECEIPT_WRITE_FAILED_EVENT, {
          operationKind: write.operationKind,
          targetArtifactId: write.targetArtifactId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    async settle() {
      if (!(receiptRequest && canBindAwaitingClaim(receiptRequest))) {
        return;
      }
      for (const written of recorded) {
        const receiptId = parseOperationId(written.operationId);
        if (receiptId) {
          await bindReceipt(receiptId, receiptRequest.organizationId);
        }
      }
    },
    async rejected(operationKind, targetArtifactId) {
      // Fail-open, as recordStandalone: the caller's own refusal is the
      // response, so a rejected receipt that cannot be stored never turns it
      // into a 500.
      try {
        await recordRejectedOperationReceipt({
          request: receiptRequest,
          operationKind,
          targetArtifactId,
        });
      } catch (error) {
        log.warn(OPERATION_RECEIPT_WRITE_FAILED_EVENT, {
          operationKind,
          targetArtifactId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    whenRecording: (record) => (receiptRequest ? record : undefined),
    get receipt() {
      return receipt;
    },
    active: receiptRequest !== null,
  };
}

/** The response with the receipt attached only when one was recorded. */
export function withOperationReceipt<T extends object>(
  body: T,
  recorder: OperationReceiptRecorder
): T & { operationReceipt?: OperationReceipt } {
  return recorder.receipt
    ? { ...body, operationReceipt: recorder.receipt }
    : body;
}

/**
 * Record a rejected receipt when the route answered 4xx: the request was
 * refused, so no write happened. Skipped when the request already holds a
 * receipt, so a write that committed is never also called rejected.
 */
export async function recordRejectionForClientError(
  response: Response,
  recorder: OperationReceiptRecorder,
  operationKind: OperationKind,
  targetArtifactId?: string
): Promise<void> {
  if (recorder.receipt) {
    return;
  }
  if (response.status >= 400 && response.status < 500) {
    await recorder.rejected(operationKind, targetArtifactId);
  }
}

/**
 * Wrap a write route handler so it gets a receipt recorder and a 4xx answer
 * records a rejected receipt. The handler records its own success receipt at
 * the point the write commits.
 */
export function withOperationReceipts<TResponse, TRoute extends string>(
  operationKind: OperationKind,
  handler: (
    auth: AuthContext,
    request: NextRequest,
    params: RouteContext<TRoute>["params"],
    receipts: OperationReceiptRecorder
  ) => Promise<AuthenticatedJsonResponse<TResponse>>
): (
  auth: AuthContext,
  request: NextRequest,
  params: RouteContext<TRoute>["params"]
) => Promise<AuthenticatedJsonResponse<TResponse>> {
  return (auth, request, params) =>
    runWithAttributionEvidenceGate(async () => {
      const receipts = await createOperationReceiptRecorder(
        auth,
        request,
        (await params) ?? {}
      );
      const response = await handler(auth, request, params, receipts);
      await recordRejectionForClientError(response, receipts, operationKind);
      await receipts.settle();
      return response;
    });
}

/**
 * ISS-12552: a receipt with no call id and no fingerprint skips the late
 * bind. Nothing can match them: shell and script claims bind by printed
 * operation id at reconcile, and those claims always sync after the receipt
 * exists.
 */
function canBindAwaitingClaim(request: OperationReceiptRequest): boolean {
  return (
    request.clientCallId !== undefined ||
    request.requestFingerprint !== undefined
  );
}

/** One late bind; a failure is logged and never fails the committed write. */
async function bindReceipt(
  receiptId: string,
  organizationId: string
): Promise<void> {
  try {
    await bindAwaitingClaimForReceipt(receiptId, organizationId);
  } catch (error) {
    log.warn(OPERATION_RECEIPT_BIND_FAILED_EVENT, {
      receiptId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
