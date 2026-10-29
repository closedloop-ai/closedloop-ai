import { describe, expect, it } from "vitest";
import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
  recordActivityEventsInputSchema,
} from "./artifact-activity";

const TRANSACTION_ID = "0b7c9a52-3d2f-4f1e-9c1a-2b6d8e4f5a10";
const UNDO_OF_ID = "5f0e2c1b-7a9d-4e3b-8c6f-1d2a3b4c5e6f";

function batch(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: "org-1",
    events: [
      {
        artifactId: "art-1",
        actorType: ArtifactActivityActorType.User,
        action: ArtifactActivityAction.FieldChange,
        before: { title: "old", tags: ["a", 1, true, null] },
        after: { title: "new", nested: { deep: [1.5] } },
      },
    ],
    ...overrides,
  };
}

describe("recordActivityEventsInputSchema", () => {
  it("accepts nested JSON values in before/after", () => {
    const result = recordActivityEventsInputSchema.safeParse(batch());
    expect(result.success).toBe(true);
    expect(result.data?.events[0]?.after).toEqual({
      title: "new",
      nested: { deep: [1.5] },
    });
  });

  it("rejects a non-JSON value in before", () => {
    const result = recordActivityEventsInputSchema.safeParse(
      batch({
        events: [
          {
            artifactId: "art-1",
            actorType: ArtifactActivityActorType.User,
            action: ArtifactActivityAction.FieldChange,
            before: { when: new Date(0) },
          },
        ],
      })
    );
    expect(result.success).toBe(false);
  });

  it("accepts an undo alongside its own transaction id", () => {
    const result = recordActivityEventsInputSchema.safeParse(
      batch({ transactionId: TRANSACTION_ID, undoOfTransactionId: UNDO_OF_ID })
    );
    expect(result.success).toBe(true);
  });

  it("rejects an undo without a transaction id, on the undo path", () => {
    const result = recordActivityEventsInputSchema.safeParse(
      batch({ undoOfTransactionId: UNDO_OF_ID })
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      ["undoOfTransactionId"],
    ]);
  });

  it("accepts a transaction id with no undo", () => {
    const result = recordActivityEventsInputSchema.safeParse(
      batch({ transactionId: TRANSACTION_ID })
    );
    expect(result.success).toBe(true);
  });
});
