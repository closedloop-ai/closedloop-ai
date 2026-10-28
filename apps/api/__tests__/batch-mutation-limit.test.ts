/**
 * The batch-mutation row cap is one number in five places (ISS-9089 review;
 * batch-move joined in ISS-9073, whose copy had dropped the cap;
 * batch-priority in ISS-9094).
 *
 * `batchMoveDocumentsValidator`, `batchUpdateStatusValidator`,
 * `batchUpdatePriorityValidator`, `batchDeleteValidator` and
 * `batchEntityTagValidator` each enforce it at their own route, and
 * `requireBatchableEntityIds` refuses to BUILD a request past it, so the undo
 * registry cannot declare a command undoable whose replay is a guaranteed 400.
 * These cases drive the real validators at the boundary, so re-hardcoding the
 * number at any one of them — or drifting the registry's guard away from it —
 * shows up here rather than as a 400 in production.
 */
import { BATCH_MUTATION_ENTITY_LIMIT } from "@repo/api/src/types/batch-mutation-limits";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus } from "@repo/api/src/types/document";
import { TagEntityType } from "@repo/api/src/types/tag";
import { findIssue } from "@repo/api/src/types/zod-issue.test-helpers";
import { describe, expect, it } from "vitest";
import {
  batchDeleteValidator,
  batchMoveDocumentsValidator,
  batchUpdatePriorityValidator,
  batchUpdateStatusValidator,
} from "../app/documents/validators";
import { batchEntityTagValidator } from "../app/tags/validators";

/** Version and variant nibbles are real: `z.uuid()` enforces RFC 9562. */
const TAG_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";

/** `n` distinct RFC-9562 UUIDs; the validators parse the ids with `z.uuid()`. */
function uuids(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) =>
      `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`
  );
}

describe("batch mutation entity limit", () => {
  it("accepts exactly the limit and rejects one more for a move batch, naming documentIds", () => {
    expect(
      batchMoveDocumentsValidator.safeParse({
        documentIds: uuids(BATCH_MUTATION_ENTITY_LIMIT),
        targetProjectId: PROJECT_ID,
      }).success
    ).toBe(true);

    const over = batchMoveDocumentsValidator.safeParse({
      documentIds: uuids(BATCH_MUTATION_ENTITY_LIMIT + 1),
      targetProjectId: PROJECT_ID,
    });
    expect(over.success).toBe(false);
    if (!over.success) {
      expect(findIssue(over.error.issues, ["documentIds"])?.code).toBe(
        "too_big"
      );
    }
  });

  it("rejects an empty move batch with the shared minimum message", () => {
    const empty = batchMoveDocumentsValidator.safeParse({
      documentIds: [],
      targetProjectId: PROJECT_ID,
    });

    expect(empty.success).toBe(false);
    if (!empty.success) {
      expect(findIssue(empty.error.issues, ["documentIds"])?.message).toBe(
        "At least one document ID required"
      );
    }
  });

  it("accepts exactly the limit and rejects one more for a priority batch", () => {
    expect(
      batchUpdatePriorityValidator.safeParse({
        documentIds: uuids(BATCH_MUTATION_ENTITY_LIMIT),
        priority: Priority.Urgent,
      }).success
    ).toBe(true);
    expect(
      batchUpdatePriorityValidator.safeParse({
        documentIds: uuids(BATCH_MUTATION_ENTITY_LIMIT + 1),
        priority: Priority.Urgent,
      }).success
    ).toBe(false);
  });

  it("accepts exactly the limit and rejects one more for a status batch", () => {
    const documentIds = uuids(BATCH_MUTATION_ENTITY_LIMIT);

    expect(
      batchUpdateStatusValidator.safeParse({
        documentIds,
        expectedStatusById: { [documentIds[0]]: DocumentStatus.Draft },
        status: DocumentStatus.Approved,
      }).success
    ).toBe(true);
    expect(
      batchUpdateStatusValidator.safeParse({
        documentIds: uuids(BATCH_MUTATION_ENTITY_LIMIT + 1),
        status: DocumentStatus.Approved,
      }).success
    ).toBe(false);
  });

  it("rejects malformed expectedStatusById values for a status batch", () => {
    const invalid = batchUpdateStatusValidator.safeParse({
      documentIds: [PROJECT_ID],
      expectedStatusById: { [PROJECT_ID]: "" },
      status: DocumentStatus.Approved,
    });

    expect(invalid.success).toBe(false);
  });

  it("rejects an explicit null expectedStatusById entry at that entry's path", () => {
    const [selectedId] = uuids(1);
    // Status is never unset, so unlike expectedPriorityById a null here is
    // malformed rather than a guard (ISS-9440).
    const invalid = batchUpdateStatusValidator.safeParse({
      documentIds: [selectedId],
      expectedStatusById: { [selectedId]: null },
      status: DocumentStatus.Approved,
    });

    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(
        findIssue(invalid.error.issues, ["expectedStatusById", selectedId])
          ?.code
      ).toBe("invalid_type");
    }
  });

  it("rejects expectedStatusById keys outside the selected status batch", () => {
    const [selectedId] = uuids(1);
    const invalid = batchUpdateStatusValidator.safeParse({
      documentIds: [selectedId],
      expectedStatusById: { [PROJECT_ID]: DocumentStatus.Draft },
      status: DocumentStatus.Approved,
    });

    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(
        findIssue(invalid.error.issues, ["expectedStatusById", PROJECT_ID])
      ).toMatchObject({
        code: "custom",
        message: "expectedStatusById keys must be selected documentIds",
      });
    }
  });

  it("caps expectedStatusById before validating individual status guards", () => {
    const invalid = batchUpdateStatusValidator.safeParse({
      documentIds: uuids(BATCH_MUTATION_ENTITY_LIMIT),
      expectedStatusById: Object.fromEntries(
        uuids(BATCH_MUTATION_ENTITY_LIMIT + 1).map((id) => [id, ""])
      ),
      status: DocumentStatus.Approved,
    });

    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(
        findIssue(invalid.error.issues, ["expectedStatusById"])?.code
      ).toBe("too_big");
      expect(
        invalid.error.issues.some(
          (issue) =>
            issue.path[0] === "expectedStatusById" && issue.path.length > 1
        )
      ).toBe(false);
    }
  });

  it("accepts exactly the limit and rejects one more for a delete batch", () => {
    expect(
      batchDeleteValidator.safeParse({
        documentIds: uuids(BATCH_MUTATION_ENTITY_LIMIT),
      }).success
    ).toBe(true);
    expect(
      batchDeleteValidator.safeParse({
        documentIds: uuids(BATCH_MUTATION_ENTITY_LIMIT + 1),
      }).success
    ).toBe(false);
  });

  it("accepts exactly the limit and rejects one more for either tag batch (ISS-10686)", () => {
    expect(
      batchEntityTagValidator.safeParse({
        tagId: TAG_ID,
        entityType: TagEntityType.Artifact,
        entityIds: uuids(BATCH_MUTATION_ENTITY_LIMIT),
      }).success
    ).toBe(true);
    expect(
      batchEntityTagValidator.safeParse({
        tagId: TAG_ID,
        entityType: TagEntityType.Artifact,
        entityIds: uuids(BATCH_MUTATION_ENTITY_LIMIT + 1),
      }).success
    ).toBe(false);
  });
});
