import { describe, expect, it } from "vitest";
import { isDuplicateArtifactTagRelationViolation } from "./tag-relation-unique-violation";

describe("isDuplicateArtifactTagRelationViolation", () => {
  it("recognizes the adapter-pg Artifact tag constraint", () => {
    const error = {
      code: "P2002",
      meta: {
        driverAdapterError: {
          cause: {
            constraint: { index: "tag_artifacts_tag_id_artifact_id_key" },
          },
        },
      },
    };
    expect(isDuplicateArtifactTagRelationViolation(error)).toBe(true);
  });

  it("recognizes the matching Prisma field target", () => {
    expect(
      isDuplicateArtifactTagRelationViolation({
        code: "P2002",
        meta: { target: ["tagId", "artifactId"] },
      })
    ).toBe(true);
  });

  it("rejects a receipt conflict, a sibling relation and a targetless P2002", () => {
    const receiptConflict = {
      code: "P2002",
      meta: {
        driverAdapterError: {
          cause: { constraint: { index: "artifact_activity_events_pkey" } },
        },
      },
    };
    expect(isDuplicateArtifactTagRelationViolation(receiptConflict)).toBe(
      false
    );
    expect(
      isDuplicateArtifactTagRelationViolation({
        code: "P2002",
        meta: {
          driverAdapterError: {
            cause: { constraint: { index: "tag_artifacts_pkey" } },
          },
        },
      })
    ).toBe(false);
    expect(
      isDuplicateArtifactTagRelationViolation({
        code: "P2002",
        meta: { target: ["tagId", "projectId"] },
      })
    ).toBe(false);
    expect(isDuplicateArtifactTagRelationViolation({ code: "P2002" })).toBe(
      false
    );
  });
});
