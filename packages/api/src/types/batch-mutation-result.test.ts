import { describe, expect, it } from "vitest";
import {
  BATCH_ITEM_APPLIED_STATUS,
  BATCH_ITEM_FAILURE_MESSAGE,
  BatchItemAppliedOutcome,
  BatchItemFailureCode,
  BatchItemFailureStatus,
  batchItemFailed,
  batchMutationResponseSchema,
  resolveBatchItemFailureCode,
} from "./batch-mutation-result.ts";
import { Status } from "./result.ts";

const ITEM_ID = "01a0a687-9baf-76d0-94d9-9430885eb648";

/** Codes this build has never seen, including names on `Object.prototype`. */
const UNSEEN_CODES = ["quota_exceeded", "constructor", "__proto__", ""];

/** ISS-9464: per-item statuses follow the single-document route. */
const EXPECTED_STATUS_BY_CODE: [BatchItemFailureCode, number][] = [
  [BatchItemFailureCode.ArtifactsNotFound, Status.NotFound],
  [BatchItemFailureCode.InvalidStatusForSubtype, Status.BadRequest],
  [BatchItemFailureCode.StaleStatus, Status.Conflict],
  [BatchItemFailureCode.StalePriority, Status.Conflict],
  [BatchItemFailureCode.BatchRefused, BatchItemFailureStatus.FailedDependency],
  [BatchItemFailureCode.OutcomeUnknown, Status.Error],
];

describe("batchItemFailed", () => {
  it("covers every failure code", () => {
    expect(EXPECTED_STATUS_BY_CODE.map(([code]) => code).sort()).toEqual(
      Object.values(BatchItemFailureCode).sort()
    );
  });

  it.each(EXPECTED_STATUS_BY_CODE)(
    "derives the status and a message for %s",
    (code, status) => {
      const item = batchItemFailed(ITEM_ID, code);

      expect(item).toEqual({
        id: ITEM_ID,
        status,
        code,
        message: BATCH_ITEM_FAILURE_MESSAGE[code],
      });
      expect(item.message.length).toBeGreaterThan(0);
    }
  );

  it("carries details only when given", () => {
    const details = { documentId: ITEM_ID };

    expect(
      batchItemFailed(ITEM_ID, BatchItemFailureCode.StaleStatus, details)
    ).toHaveProperty("details", details);
    expect(
      batchItemFailed(ITEM_ID, BatchItemFailureCode.StaleStatus)
    ).not.toHaveProperty("details");
  });
});

describe("resolveBatchItemFailureCode", () => {
  it("returns every known code as itself", () => {
    for (const code of Object.values(BatchItemFailureCode)) {
      expect(resolveBatchItemFailureCode(code)).toBe(code);
    }
  });

  it.each(UNSEEN_CODES)(
    "maps the unseen code %j to null, the generic item failure",
    (raw) => {
      expect(resolveBatchItemFailureCode(raw)).toBeNull();
    }
  );
});

describe("batchMutationResponseSchema", () => {
  it("parses ISS-10686 removed and not-present success outcomes", () => {
    const parsed = batchMutationResponseSchema.parse({
      results: [
        {
          id: ITEM_ID,
          status: BATCH_ITEM_APPLIED_STATUS,
          outcome: BatchItemAppliedOutcome.Removed,
        },
        {
          id: "01a0a687-9baf-76d0-94d9-9430885eb649",
          status: BATCH_ITEM_APPLIED_STATUS,
          outcome: BatchItemAppliedOutcome.NotPresent,
        },
      ],
    });

    expect(
      parsed.results.map((result) =>
        "outcome" in result ? result.outcome : undefined
      )
    ).toEqual([
      BatchItemAppliedOutcome.Removed,
      BatchItemAppliedOutcome.NotPresent,
    ]);
  });

  it("drops a future success outcome without rejecting the whole response", () => {
    const parsed = batchMutationResponseSchema.parse({
      results: [
        {
          id: ITEM_ID,
          status: BATCH_ITEM_APPLIED_STATUS,
          outcome: "changed_by_newer_server",
        },
      ],
    });

    const result = parsed.results[0];
    expect(
      result && "outcome" in result ? result.outcome : undefined
    ).toBeUndefined();
  });

  it("parses a failed result whose code this build has never seen", () => {
    const parsed = batchMutationResponseSchema.safeParse({
      results: [
        { id: ITEM_ID, status: BATCH_ITEM_APPLIED_STATUS },
        {
          id: "01a0a687-9baf-76d0-94d9-9430885eb649",
          status: 429,
          code: "quota_exceeded",
          message: "Try again later.",
        },
      ],
      receipt: { id: "a later additive field" },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.results[1]).toMatchObject({ code: "quota_exceeded" });
  });

  it("reads a status-200 result that carries a code as a failure, never as applied", () => {
    const parsed = batchMutationResponseSchema.safeParse({
      results: [
        {
          id: ITEM_ID,
          status: BATCH_ITEM_APPLIED_STATUS,
          code: "quota_exceeded",
          message: "Try again later.",
        },
      ],
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.results[0]).toMatchObject({ code: "quota_exceeded" });
  });

  it("rejects a result missing its id or its status", () => {
    for (const result of [
      { status: BATCH_ITEM_APPLIED_STATUS },
      {
        id: ITEM_ID,
        code: BatchItemFailureCode.StaleStatus,
        message: "stale",
      },
    ]) {
      expect(
        batchMutationResponseSchema.safeParse({ results: [result] }).success
      ).toBe(false);
    }
  });
});
