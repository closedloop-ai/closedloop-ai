/**
 * `orderBatchResults` (ISS-9464), which every `/v2` batch route answers
 * through.
 *
 * PR #7353 shipped it with no test of its own, so the missing-id path added
 * during its review was pinned only indirectly, through one route test that
 * could not see the server-error report at all. What it owes is the whole
 * contract: one result per DISTINCT requested id in first-appearance order,
 * an id the service forgot degraded to `outcome_unknown` rather than dropped
 * or thrown, and that bug reported once with its count.
 */
import { SpanErrorSource } from "@closedloop-ai/telemetry-contract/span";
import {
  BATCH_ITEM_APPLIED_STATUS,
  BatchItemFailureCode,
  BatchItemFailureStatus,
  type BatchItemResult,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logError: vi.fn(),
  recordRequestErrorCause: vi.fn(),
  scheduleLogFlush: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    error: mocks.logError,
    info: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock("@/lib/observability/request-span-attribution", () => ({
  recordRequestErrorCause: mocks.recordRequestErrorCause,
}));
vi.mock(import("@/lib/route-utils"), async (importOriginal) => ({
  ...(await importOriginal()),
  scheduleLogFlush: mocks.scheduleLogFlush,
}));

import { orderBatchResults } from "./batch-mutation-response";

const DOC_A = "11111111-1111-4111-8111-111111111111";
const DOC_B = "22222222-2222-4222-8222-222222222222";
const DOC_C = "33333333-3333-4333-8333-333333333333";

/** The sample the server-error log quotes is bounded; the count is not. */
const LOGGED_MISSING_ID_SAMPLE_SIZE = 10;

function resultsFor(results: BatchItemResult[]): Map<string, BatchItemResult> {
  return new Map(results.map((result) => [result.id, result]));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("orderBatchResults", () => {
  it("emits one result per distinct id, in the order the caller first named it", () => {
    // Keyed the way a service hands them back: id order, which is the lock's
    // order and not the caller's.
    const resultsById = resultsFor([
      batchItemApplied(DOC_A),
      batchItemApplied(DOC_B),
      batchItemApplied(DOC_C),
    ]);

    const ordered = orderBatchResults(
      [DOC_C, DOC_A, DOC_C, DOC_B, DOC_A],
      resultsById
    );

    expect(ordered.map((result) => result.id)).toEqual([DOC_C, DOC_A, DOC_B]);
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("reports an id the service omitted as outcome_unknown, leaving the rest applied", () => {
    const ordered = orderBatchResults(
      [DOC_A, DOC_B, DOC_C],
      resultsFor([batchItemApplied(DOC_A), batchItemApplied(DOC_C)])
    );

    expect(ordered).toEqual([
      { id: DOC_A, status: BATCH_ITEM_APPLIED_STATUS },
      batchItemFailed(DOC_B, BatchItemFailureCode.OutcomeUnknown),
      { id: DOC_C, status: BATCH_ITEM_APPLIED_STATUS },
    ]);
    // Named explicitly rather than only through the builder: the whole point of
    // the code is that the item, not the envelope, carries the server error.
    expect(ordered[1]).toMatchObject({
      code: BatchItemFailureCode.OutcomeUnknown,
      status: BatchItemFailureStatus.ServerError,
    });
  });

  it("records the omission once as a server error carrying the missing-id count", () => {
    orderBatchResults(
      [DOC_A, DOC_B, DOC_C],
      resultsFor([batchItemApplied(DOC_B)])
    );

    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        missingIdCount: 2,
        missingIdSample: [DOC_A, DOC_C],
      })
    );
    expect(mocks.recordRequestErrorCause).toHaveBeenCalledTimes(1);
    expect(mocks.recordRequestErrorCause).toHaveBeenCalledWith(
      expect.any(Error),
      SpanErrorSource.RouteHandler
    );
    expect(mocks.scheduleLogFlush).toHaveBeenCalledTimes(1);
  });

  it("bounds the quoted sample while still counting every missing id", () => {
    const requestedIds = Array.from(
      { length: LOGGED_MISSING_ID_SAMPLE_SIZE + 5 },
      (_unused, index) =>
        `00000000-0000-4000-8000-${`${index}`.padStart(12, "0")}`
    );

    const ordered = orderBatchResults(requestedIds, new Map());

    expect(ordered).toHaveLength(requestedIds.length);
    const [, context] = mocks.logError.mock.calls[0];
    expect(context.missingIdCount).toBe(requestedIds.length);
    expect(context.missingIdSample).toHaveLength(LOGGED_MISSING_ID_SAMPLE_SIZE);
  });
});
