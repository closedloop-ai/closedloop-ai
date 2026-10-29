import {
  BatchItemFailureCode,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { describe, expect, it } from "vitest";
import { batchMutationSelectionOutcome } from "./batch-mutation-selection";

describe("batchMutationSelectionOutcome", () => {
  it("partitions applied and failed ids in selection order", () => {
    expect(
      batchMutationSelectionOutcome(
        [
          batchItemFailed("doc-2", BatchItemFailureCode.StaleStatus),
          batchItemApplied("doc-1"),
        ],
        ["doc-1", "doc-2"]
      )
    ).toEqual({
      appliedIds: ["doc-1"],
      failedIds: ["doc-2"],
      failureCode: BatchItemFailureCode.StaleStatus,
    });
  });

  it("treats a missing per-item result as an unknown failure", () => {
    expect(
      batchMutationSelectionOutcome(
        [batchItemApplied("doc-1")],
        ["doc-1", "doc-2"]
      )
    ).toEqual({
      appliedIds: ["doc-1"],
      failedIds: ["doc-2"],
      failureCode: BatchItemFailureCode.OutcomeUnknown,
    });
  });
});
