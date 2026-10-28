import { memoizeAttributionEvidenceGate } from "@/lib/attribution-evidence-gate-scope";
import type {
  recordOperationReceipt as RecordOperationReceipt,
  recordRejectedOperationReceipt as RecordRejectedOperationReceipt,
} from "@/lib/operation-receipts/operation-receipt-writer";

/**
 * ISS-12552: module mocks for route tests that drive a real write route as an
 * API-key caller and force its receipt insert to fail. Its only runtime import
 * is the gate's request scope, which no suite mocks, so a `vi.mock` factory
 * can still load it with `await import(...)`.
 */
export const receiptRouteState: {
  context: unknown;
  scheduled: Promise<unknown>[];
  failReceiptInsert: boolean;
  /** How many receipt inserts the forced failure actually broke. */
  forcedFailures: number;
  failRejectedReceiptInsert: boolean;
  /** How many rejected-receipt inserts the forced failure broke. */
  forcedRejectedFailures: number;
  /** The organization's `attribution-evidence-policy` answer. */
  attributionFlagOn: boolean;
  /** How many times a read site evaluated that answer. */
  attributionFlagEvaluations: number;
} = {
  context: null,
  scheduled: [],
  failReceiptInsert: false,
  forcedFailures: 0,
  failRejectedReceiptInsert: false,
  forcedRejectedFailures: 0,
  attributionFlagOn: true,
  attributionFlagEvaluations: 0,
};

/** `withAnyAuth` that hands every handler the test's auth context. */
export function receiptRouteAuthMock() {
  return {
    withAnyAuth:
      (handler: (...args: unknown[]) => Promise<Response>) =>
      (request: Request, context?: { params: Promise<unknown> }) =>
        handler(receiptRouteState.context, request, context?.params),
  };
}

/** `waitUntil` that keeps the scheduled work so a test can await it. */
export function receiptRouteWaitUntilMock() {
  return {
    waitUntil: (work: Promise<unknown>) => {
      receiptRouteState.scheduled.push(work);
    },
  };
}

/**
 * The real receipt writer, except that while `failReceiptInsert` is set the
 * insert fails with a genuine database error on the write's transaction,
 * which aborts it exactly as a failed insert would.
 */
export function failingReceiptWriterMock<
  T extends {
    recordOperationReceipt: typeof RecordOperationReceipt;
    recordRejectedOperationReceipt: typeof RecordRejectedOperationReceipt;
  },
>(actual: T): T {
  return {
    ...actual,
    recordRejectedOperationReceipt: async (
      params: Parameters<typeof RecordRejectedOperationReceipt>[0]
    ) => {
      if (receiptRouteState.failRejectedReceiptInsert && params.request) {
        receiptRouteState.forcedRejectedFailures += 1;
        throw new Error("forced rejected-receipt insert failure");
      }
      return await actual.recordRejectedOperationReceipt(params);
    },
    recordOperationReceipt: async (
      params: Parameters<typeof RecordOperationReceipt>[0]
    ) => {
      if (receiptRouteState.failReceiptInsert && params.request) {
        receiptRouteState.forcedFailures += 1;
        await params.tx.$queryRaw`SELECT 1 / 0`;
      }
      return actual.recordOperationReceipt(params);
    },
  };
}

/**
 * `attribution-evidence-policy` as the test sets it: on unless a case turns
 * it off, for every read site (the recorder and the gated derivations). Only
 * the organization's evaluation is replaced. The answer still goes through
 * the real per-request scope, so a writer inside a transaction that reads the
 * memo alone (`isAttributionEvidenceReadOnForOrganization`) sees the same
 * answer the request read before its transaction opened. The real
 * `readAttributionEvidenceForRequest` calls the module's own evaluation, which
 * this mock cannot reach, so it is replaced with one that reads this answer.
 */
export function receiptRouteFlagMock<
  T extends {
    isAttributionEvidenceEnabledForOrganization: (
      organizationId: string
    ) => Promise<boolean>;
    evaluateAttributionEvidenceForOrganization: (
      organizationId: string
    ) => Promise<boolean | null>;
    readAttributionEvidenceForRequest: (
      organizationId: string
    ) => Promise<void>;
  },
>(actual: T): T {
  const evaluate = (organizationId: string) =>
    memoizeAttributionEvidenceGate(organizationId, () => {
      receiptRouteState.attributionFlagEvaluations += 1;
      return Promise.resolve(receiptRouteState.attributionFlagOn);
    });
  return {
    ...actual,
    isAttributionEvidenceEnabledForOrganization: async (
      organizationId: string
    ) => (await evaluate(organizationId)) === true,
    evaluateAttributionEvidenceForOrganization: evaluate,
    readAttributionEvidenceForRequest: async (organizationId: string) => {
      await evaluate(organizationId);
    },
  };
}
