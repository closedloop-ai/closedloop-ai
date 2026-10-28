import { BATCH_MUTATION_ENTITY_LIMIT } from "@repo/api/src/types/batch-mutation-limits";
import {
  BATCH_ITEM_FAILURE_MESSAGE,
  BatchItemAppliedOutcome,
  BatchItemFailureCode,
  type BatchMutationResponse,
  batchItemApplied,
  batchItemAppliedWithOutcome,
  batchItemFailed,
  batchMutationResponseSchema,
} from "@repo/api/src/types/batch-mutation-result";
import { describe, expect, it, vi } from "vitest";
import { BulkTagMutation } from "../bulk-tag-mutation";
import { performBulkTagMutation } from "../bulk-tag-operation";
import {
  resolveBulkTagOutcome,
  toBatchMutationResponse,
} from "../bulk-tag-outcome";

const TARGETS = [
  { artifactId: "artifact-a", canApply: true, rowId: "branch-a" },
  { artifactId: "artifact-b", canApply: true, rowId: "branch-b" },
];
const LOWERCASE_UUID = "01932b3a-7e4d-7c8f-9a1b-2c3d4e5f6a7b";
const UPPERCASE_UUID = LOWERCASE_UUID.toUpperCase();

describe("confirmed bulk tag outcomes", () => {
  it("separates removed and not-present row receipts for ISS-10686", () => {
    expect(
      resolveBulkTagOutcome(
        TARGETS,
        {
          results: [
            batchItemAppliedWithOutcome(
              "artifact-a",
              BatchItemAppliedOutcome.Removed
            ),
            batchItemAppliedWithOutcome(
              "artifact-b",
              BatchItemAppliedOutcome.NotPresent
            ),
          ],
        },
        BulkTagMutation.Remove
      )
    ).toEqual({
      succeededIds: ["branch-a", "branch-b"],
      failedIds: [],
      removedIds: ["branch-a"],
      notPresentIds: ["branch-b"],
      messages: [],
    });
  });

  it("refuses a remove success receipt without an ISS-10686 outcome", () => {
    expect(
      resolveBulkTagOutcome(
        TARGETS,
        {
          results: TARGETS.map((target) => batchItemApplied(target.artifactId)),
        },
        BulkTagMutation.Remove
      )
    ).toMatchObject({
      succeededIds: [],
      failedIds: ["branch-a", "branch-b"],
      messages: [
        BATCH_ITEM_FAILURE_MESSAGE[BatchItemFailureCode.OutcomeUnknown],
      ],
    });
  });

  it("maps canonical receipts back to distinct row identities", () => {
    expect(
      resolveBulkTagOutcome(TARGETS, {
        results: [
          batchItemApplied("artifact-a"),
          batchItemFailed("artifact-b", BatchItemFailureCode.ArtifactsNotFound),
        ],
      })
    ).toEqual({
      succeededIds: ["branch-a"],
      failedIds: ["branch-b"],
      removedIds: [],
      notPresentIds: [],
      messages: [
        BATCH_ITEM_FAILURE_MESSAGE[BatchItemFailureCode.ArtifactsNotFound],
      ],
    });
  });

  it("matches a lowercase Add receipt to an uppercase UUID target", () => {
    expect(
      resolveBulkTagOutcome(
        [{ artifactId: UPPERCASE_UUID, canApply: true, rowId: "branch-a" }],
        { results: [batchItemApplied(LOWERCASE_UUID)] },
        BulkTagMutation.Add
      )
    ).toMatchObject({
      failedIds: [],
      succeededIds: ["branch-a"],
    });
  });

  it.each([
    { results: [batchItemApplied("unrequested")] },
    {
      results: [batchItemApplied("artifact-a"), batchItemApplied("artifact-a")],
    },
    {
      results: [
        {
          id: "artifact-a",
          status: 200,
          code: "future_failure",
          message: "new server failure",
        },
      ],
    },
    {
      results: [
        {
          id: "artifact-a",
          status: 409,
          code: "future_failure",
          message: "new server failure",
        },
      ],
    },
  ])("never clears ambiguous, absent or newer failure receipts: %j", (wire) => {
    const result = resolveBulkTagOutcome(
      TARGETS,
      toBatchMutationResponse(batchMutationResponseSchema.parse(wire))
    );
    expect(result.succeededIds).toEqual([]);
    expect(result.failedIds).toEqual(["branch-a", "branch-b"]);
    expect(result.messages).toEqual([
      BATCH_ITEM_FAILURE_MESSAGE[BatchItemFailureCode.OutcomeUnknown],
    ]);
  });
});

describe("bounded tag operation", () => {
  it("deduplicates UUID casing aliases and submits the canonical key", async () => {
    const applyBatch = vi.fn(async (ids: string[]) => ({
      results: ids.map((id) =>
        batchItemAppliedWithOutcome(id, BatchItemAppliedOutcome.Removed)
      ),
    }));
    const result = await performBulkTagMutation({
      targets: [
        { artifactId: UPPERCASE_UUID, canApply: true, rowId: "branch-a" },
        { artifactId: LOWERCASE_UUID, canApply: true, rowId: "branch-a-alias" },
      ],
      applyBatch,
      isCurrent: () => true,
      operation: BulkTagMutation.Remove,
    });

    expect(applyBatch).toHaveBeenCalledExactlyOnceWith([LOWERCASE_UUID]);
    expect(result.removedIds).toEqual(["branch-a", "branch-a-alias"]);
    expect(result.failedIds).toEqual([]);
  });

  it("deduplicates remove artifacts while preserving aliased row outcomes", async () => {
    const applyBatch = vi.fn(async (ids: string[]) => ({
      results: ids.map((id) =>
        batchItemAppliedWithOutcome(id, BatchItemAppliedOutcome.Removed)
      ),
    }));
    const result = await performBulkTagMutation({
      targets: [...TARGETS, { ...TARGETS[0], rowId: "branch-a-alias" }],
      applyBatch,
      isCurrent: () => true,
      operation: BulkTagMutation.Remove,
    });

    expect(applyBatch).toHaveBeenCalledExactlyOnceWith([
      "artifact-a",
      "artifact-b",
    ]);
    expect(result.removedIds).toEqual([
      "branch-a",
      "branch-a-alias",
      "branch-b",
    ]);
    expect(result.failedIds).toEqual([]);
  });

  it("deduplicates artifacts and excludes forbidden or non-cloud targets", async () => {
    const applyBatch = vi.fn(async (ids: string[]) => ({
      results: ids.map(batchItemApplied),
    }));
    const result = await performBulkTagMutation({
      targets: [
        ...TARGETS,
        { ...TARGETS[0], rowId: "branch-alias" },
        { artifactId: "denied", canApply: false, rowId: "denied-row" },
        { canApply: true, rowId: "local-only" },
      ],
      applyBatch,
      isCurrent: () => true,
      operation: BulkTagMutation.Add,
    });
    expect(applyBatch).toHaveBeenCalledExactlyOnceWith([
      "artifact-a",
      "artifact-b",
    ]);
    expect(result.succeededIds).toEqual([
      "branch-a",
      "branch-alias",
      "branch-b",
    ]);
    expect(result.failedIds).toEqual([]);
  });

  it("continues after one failed chunk without claiming its rows succeeded", async () => {
    const targets = Array.from(
      { length: BATCH_MUTATION_ENTITY_LIMIT + 1 },
      (_, i) => ({
        artifactId: `artifact-${i}`,
        canApply: true,
        rowId: `row-${i}`,
      })
    );
    const applyBatch = vi
      .fn<(ids: string[]) => Promise<BatchMutationResponse>>()
      .mockRejectedValueOnce(new Error("request failed"))
      .mockImplementation(async (ids) => ({
        results: ids.map(batchItemApplied),
      }));
    const result = await performBulkTagMutation({
      targets,
      applyBatch,
      isCurrent: () => true,
      operation: BulkTagMutation.Add,
    });
    expect(applyBatch.mock.calls.map(([ids]) => ids.length)).toEqual([
      BATCH_MUTATION_ENTITY_LIMIT,
      1,
    ]);
    expect(result.failedIds).toEqual(
      targets.slice(0, BATCH_MUTATION_ENTITY_LIMIT).map((row) => row.rowId)
    );
    expect(result.succeededIds).toEqual([
      targets[BATCH_MUTATION_ENTITY_LIMIT].rowId,
    ]);
  });

  it("does not submit later chunks once the account scope changes", async () => {
    let current = true;
    const applyBatch = vi.fn((ids: string[]) => {
      current = false;
      return Promise.resolve({ results: ids.map(batchItemApplied) });
    });
    const targets = Array.from(
      { length: BATCH_MUTATION_ENTITY_LIMIT + 1 },
      (_, i) => ({
        artifactId: `artifact-${i}`,
        canApply: true,
        rowId: `row-${i}`,
      })
    );
    await performBulkTagMutation({
      targets,
      applyBatch,
      isCurrent: () => current,
      operation: BulkTagMutation.Add,
    });
    expect(applyBatch).toHaveBeenCalledTimes(1);
  });
});
