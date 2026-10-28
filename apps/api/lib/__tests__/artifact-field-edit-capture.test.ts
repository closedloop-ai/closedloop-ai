import {
  ArtifactActivityAction,
  ArtifactStatusCommitResult,
} from "@repo/api/src/types/artifact-activity";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditReceiptResult,
  ArtifactFieldEditValueClassification,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { TransactionClient } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const recordActivityEvent = vi.hoisted(() => vi.fn());
const recordActivityEvents = vi.hoisted(() => vi.fn());

vi.mock("@/app/documents/artifact-activity-service", () => ({
  artifactActivityService: {
    recordActivityEvent,
    recordActivityEvents,
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import {
  type CapturedArtifactFields,
  captureArtifactUpdate,
  captureBatchPriorityChange,
  captureBatchProjectChange,
  captureBatchSessionOwnerAssignment,
  captureBatchStatusChange,
  captureBatchTagApplied,
  diffArtifactFields,
} from "../artifact-activity-capture";

const TX = { __brand: "tx" } as unknown as TransactionClient;
const SHARED = {
  tx: TX,
  organizationId: "org-1",
  actor: { userId: "user-1", authMethod: "session" as const },
};
const TRANSACTION_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  recordActivityEvent.mockReset().mockResolvedValue(undefined);
  recordActivityEvents
    .mockReset()
    .mockImplementation(
      async (input: { events: unknown[] }) => input.events.length
    );
});

describe("field edit receipt provenance (ISS-9489 AC-4, AC-6)", () => {
  it("files surface, classification, result, and commit group on a status edit", () => {
    const changes = diffArtifactFields(
      fields({ status: "DRAFT" }),
      fields({ status: "IN_REVIEW" }),
      { surface: ArtifactStatusEditSurface.Board, commitGroupId: "board-1" }
    );

    expect(changes).toEqual([
      {
        action: ArtifactActivityAction.StatusChange,
        before: classified(
          ArtifactFieldEditField.Status,
          "DRAFT",
          ArtifactFieldEditValueClassification.Enumerated
        ),
        after: {
          field: ArtifactFieldEditField.Status,
          value: "IN_REVIEW",
          surface: ArtifactStatusEditSurface.Board,
          result: ArtifactStatusCommitResult.Committed,
          commitGroupId: "board-1",
          valueClassification: ArtifactFieldEditValueClassification.Enumerated,
        },
      },
    ]);
  });

  it("preserves omission when a client supplies no edit surface", () => {
    const changes = diffArtifactFields(
      fields({ status: "DRAFT" }),
      fields({ status: "IN_REVIEW" })
    );

    expect(changes).toEqual([
      {
        action: ArtifactActivityAction.StatusChange,
        before: "DRAFT",
        after: "IN_REVIEW",
      },
    ]);
  });

  it("stamps one authoritative surface on every changed field in a save", () => {
    const changes = diffArtifactFields(
      fields({ status: "DRAFT", title: "Old" }),
      fields({ status: "IN_REVIEW", title: "New" }),
      { surface: ArtifactStatusEditSurface.Detail }
    );

    expect(
      changes.find(
        (change) => change.action === ArtifactActivityAction.FieldChange
      )
    ).toEqual({
      action: ArtifactActivityAction.FieldChange,
      before: classified(
        ArtifactFieldEditField.Title,
        "Old",
        ArtifactFieldEditValueClassification.Content
      ),
      after: {
        ...committed(
          ArtifactFieldEditField.Title,
          "New",
          ArtifactFieldEditValueClassification.Content
        ),
        surface: ArtifactStatusEditSurface.Detail,
      },
    });
  });

  it("carries a detail surface through the production capture boundary", async () => {
    await captureArtifactUpdate({
      ...SHARED,
      artifactId: "artifact-1",
      before: fields({ status: "DRAFT" }),
      after: fields({ status: "IN_REVIEW" }),
      provenance: { surface: ArtifactStatusEditSurface.Detail },
    });

    expect(recordActivityEvent).toHaveBeenCalledTimes(1);
    expect(recordActivityEvent.mock.calls[0][0].after).toEqual({
      field: ArtifactFieldEditField.Status,
      value: "IN_REVIEW",
      surface: ArtifactStatusEditSurface.Detail,
      result: ArtifactStatusCommitResult.Committed,
      valueClassification: ArtifactFieldEditValueClassification.Enumerated,
    });
  });

  it("shares one commit group across every row of a bulk status commit", async () => {
    await captureBatchStatusChange({
      ...SHARED,
      changes: [
        { artifactId: "a-1", before: "DRAFT", after: "IN_REVIEW" },
        { artifactId: "a-2", before: "TODO", after: "IN_REVIEW" },
      ],
      provenance: {
        surface: ArtifactStatusEditSurface.Bulk,
        commitGroupId: TRANSACTION_ID,
      },
    });

    const { events } = recordActivityEvents.mock.calls[0][0];
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.after).toMatchObject({
        surface: ArtifactStatusEditSurface.Bulk,
        commitGroupId: TRANSACTION_ID,
        result: ArtifactStatusCommitResult.Committed,
      });
    }
    expect(events[0].before).toEqual(
      classified(
        ArtifactFieldEditField.Status,
        "DRAFT",
        ArtifactFieldEditValueClassification.Enumerated
      )
    );
    expect(events[1].after.value).toBe("IN_REVIEW");
  });

  it("omits commitGroupId on a single-row commit", async () => {
    await captureArtifactUpdate({
      ...SHARED,
      artifactId: "artifact-1",
      before: fields({ status: "DRAFT" }),
      after: fields({ status: "IN_REVIEW" }),
      provenance: { surface: ArtifactStatusEditSurface.Detail },
    });

    expect(recordActivityEvent.mock.calls[0][0].after).not.toHaveProperty(
      "commitGroupId"
    );
  });
});

describe("bulk field activity receipts", () => {
  it("classifies priority receipts and preserves caller-supplied bulk provenance", async () => {
    await captureBatchPriorityChange({
      ...SHARED,
      changes: [{ artifactId: "artifact-1", before: null, after: "URGENT" }],
      provenance: {
        surface: ArtifactStatusEditSurface.Bulk,
        commitGroupId: TRANSACTION_ID,
      },
      transactionId: TRANSACTION_ID,
    });

    expect(recordActivityEvents).toHaveBeenCalledWith(
      {
        organizationId: "org-1",
        events: [
          expect.objectContaining({
            artifactId: "artifact-1",
            action: ArtifactActivityAction.FieldChange,
            before: {
              field: ArtifactFieldEditField.Priority,
              value: null,
              valueClassification: ArtifactFieldEditValueClassification.Absent,
            },
            after: {
              field: ArtifactFieldEditField.Priority,
              value: "URGENT",
              valueClassification:
                ArtifactFieldEditValueClassification.Enumerated,
              surface: ArtifactStatusEditSurface.Bulk,
              result: ArtifactFieldEditReceiptResult.Committed,
              commitGroupId: TRANSACTION_ID,
            },
          }),
        ],
        transactionId: TRANSACTION_ID,
        undoOfTransactionId: undefined,
      },
      TX
    );
  });

  it("preserves omitted priority provenance for a version-skewed batch surface", async () => {
    await captureBatchPriorityChange({
      ...SHARED,
      changes: [{ artifactId: "artifact-1", before: null, after: "URGENT" }],
      preserveProvenanceOmission: true,
      transactionId: TRANSACTION_ID,
    });

    const { events } = recordActivityEvents.mock.calls[0][0];
    expect(events[0].after).not.toHaveProperty("surface");
    expect(events[0].after).not.toHaveProperty("commitGroupId");
  });

  it.each([
    ["project", ArtifactFieldEditField.ProjectId, "project-2"],
    ["owner", ArtifactFieldEditField.AssigneeId, "user-2"],
  ] as const)(
    "adds authoritative bulk grouping to %s receipts",
    async (kind, field, after) => {
      const params = {
        ...SHARED,
        changes: [{ artifactId: "artifact-1", before: null, after }],
        transactionId: TRANSACTION_ID,
      };
      if (kind === "project") {
        await captureBatchProjectChange(params);
      } else {
        await captureBatchSessionOwnerAssignment(params);
      }

      const event = recordActivityEvents.mock.calls[0][0].events[0];
      expect(event.after).toMatchObject({
        field,
        value: after,
        valueClassification: ArtifactFieldEditValueClassification.Reference,
        surface: ArtifactStatusEditSurface.Bulk,
        result: ArtifactFieldEditReceiptResult.Committed,
        commitGroupId: TRANSACTION_ID,
      });
    }
  );

  it("classifies tag references without claiming the artifact had no other tags", async () => {
    await captureBatchTagApplied({
      ...SHARED,
      tagId: "tag-secret-id",
      taggedArtifactIds: ["artifact-1"],
      transactionId: TRANSACTION_ID,
    });

    const event = recordActivityEvents.mock.calls[0][0].events[0];
    expect(event).not.toHaveProperty("before");
    expect(event.after).toEqual({
      field: ArtifactFieldEditField.Tag,
      value: "tag-secret-id",
      valueClassification: ArtifactFieldEditValueClassification.Reference,
      surface: ArtifactStatusEditSurface.Bulk,
      result: ArtifactFieldEditReceiptResult.Committed,
      commitGroupId: TRANSACTION_ID,
    });
  });

  it.each(["project", "owner", "tag"] as const)(
    "keeps %s grouping in the row columns but omits UI provenance for API keys",
    async (kind) => {
      const shared = {
        ...SHARED,
        actor: { userId: "user-1", authMethod: "api_key" as const },
        transactionId: TRANSACTION_ID,
      };
      if (kind === "project") {
        await captureBatchProjectChange({
          ...shared,
          changes: [
            { artifactId: "artifact-1", before: null, after: "project-2" },
          ],
        });
      } else if (kind === "owner") {
        await captureBatchSessionOwnerAssignment({
          ...shared,
          changes: [
            { artifactId: "artifact-1", before: null, after: "user-2" },
          ],
        });
      } else {
        await captureBatchTagApplied({
          ...shared,
          tagId: "tag-1",
          taggedArtifactIds: ["artifact-1"],
        });
      }

      const input = recordActivityEvents.mock.calls[0][0];
      expect(input.transactionId).toBe(TRANSACTION_ID);
      expect(input.events[0].after).not.toHaveProperty("surface");
      expect(input.events[0].after).not.toHaveProperty("commitGroupId");
    }
  );

  it("records no batch activity when every requested value is already stored", async () => {
    await captureBatchSessionOwnerAssignment({
      ...SHARED,
      changes: [
        { artifactId: "artifact-1", before: "user-2", after: "user-2" },
      ],
      transactionId: TRANSACTION_ID,
    });

    expect(recordActivityEvents).not.toHaveBeenCalled();
  });

  it("fails the transaction boundary when the store inserts fewer receipts than intended", async () => {
    recordActivityEvents.mockResolvedValueOnce(0);

    await expect(
      captureBatchPriorityChange({
        ...SHARED,
        changes: [{ artifactId: "artifact-1", before: null, after: "HIGH" }],
        provenance: {
          surface: ArtifactStatusEditSurface.Bulk,
          commitGroupId: TRANSACTION_ID,
        },
        transactionId: TRANSACTION_ID,
      })
    ).rejects.toThrow(
      "artifact activity receipt cardinality mismatch: expected 1, inserted 0"
    );
  });
});

function fields(
  over: Partial<CapturedArtifactFields> = {}
): CapturedArtifactFields {
  return {
    status: "DRAFT",
    assigneeId: null,
    approverId: null,
    priority: "MEDIUM",
    title: "Doc",
    dueDate: null,
    projectId: "project-1",
    ...over,
  };
}

function classified(
  field: ArtifactFieldEditField,
  value: string | null,
  valueClassification: ArtifactFieldEditValueClassification
) {
  return { field, value, valueClassification };
}

function committed(
  field: ArtifactFieldEditField,
  value: string | null,
  valueClassification: ArtifactFieldEditValueClassification
) {
  return {
    ...classified(field, value, valueClassification),
    result: ArtifactStatusCommitResult.Committed,
  };
}
