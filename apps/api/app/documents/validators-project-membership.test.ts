import { describe, expect, it } from "vitest";
import {
  batchMoveDocumentsValidator,
  updateDocumentValidator,
} from "./validators";

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";

// ISS-12858: `null` clears a project; an omitted key leaves it untouched.
describe("updateDocumentValidator projectId (ISS-12858)", () => {
  it("parses projectId: null as null", () => {
    const result = updateDocumentValidator.safeParse({ projectId: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectId).toBeNull();
    }
  });

  it("leaves an omitted projectId absent", () => {
    const result = updateDocumentValidator.safeParse({ title: "Plan" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect("projectId" in result.data).toBe(false);
    }
  });

  it("still parses a project slug", () => {
    const result = updateDocumentValidator.safeParse({ projectId: "PRO-7" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectId).toBe("PRO-7");
    }
  });
});

describe("batchMoveDocumentsValidator targetProjectId (ISS-12858)", () => {
  it("parses targetProjectId: null with documentIds", () => {
    const result = batchMoveDocumentsValidator.safeParse({
      documentIds: [DOCUMENT_ID],
      targetProjectId: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.targetProjectId).toBeNull();
    }
  });

  it("still parses a uuid targetProjectId", () => {
    const result = batchMoveDocumentsValidator.safeParse({
      documentIds: [DOCUMENT_ID],
      targetProjectId: PROJECT_ID,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a body without targetProjectId on path targetProjectId", () => {
    const result = batchMoveDocumentsValidator.safeParse({
      documentIds: [DOCUMENT_ID],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual([
        "targetProjectId",
      ]);
    }
  });
});
