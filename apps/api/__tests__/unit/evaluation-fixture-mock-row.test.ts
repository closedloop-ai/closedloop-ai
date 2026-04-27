/**
 * Unit tests for createMockEvaluationRow fixture (SS8.10).
 *
 * Validates:
 * 1. Default row includes entityId, entityType = ARTIFACT, organizationId
 * 2. artifactId defaults to the same value as entityId (denormalized FK default)
 * 3. artifactId can be overridden to null (for future issue-only rows)
 */
import { ArtifactType } from "@repo/api/src/types/artifact";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    PULL_REQUEST: "PULL_REQUEST",
    DEPLOYMENT: "DEPLOYMENT",
  },
}));

import { createMockEvaluationRow } from "../fixtures/evaluation";

describe("createMockEvaluationRow fixture (SS8.10)", () => {
  it("default row includes entityId, entityType = DOCUMENT, and organizationId", () => {
    const row = createMockEvaluationRow();

    expect(row.entityId).toBeDefined();
    expect(typeof row.entityId).toBe("string");
    expect(row.entityType).toBe(ArtifactType.Document);
    expect(row.organizationId).toBeDefined();
    expect(typeof row.organizationId).toBe("string");
  });

  it("artifactId defaults to the same value as entityId", () => {
    const row = createMockEvaluationRow();

    expect(row.documentId).toBe(row.entityId);
  });

  it("artifactId can be overridden to null for issue-only rows", () => {
    const row = createMockEvaluationRow({ documentId: null });

    expect(row.documentId).toBeNull();
    // entityId should still be set even when artifactId is null
    expect(row.entityId).toBeDefined();
  });
});
