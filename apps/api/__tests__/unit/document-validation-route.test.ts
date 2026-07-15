/**
 * Unit tests for createDocumentValidator and updateDocumentValidator.
 *
 * These Zod schemas are the enforcement boundary for the document create/update
 * routes. Tests verify that read-only and unknown fields are rejected (both
 * validators are .strict()) and that all accepted optional fields parse cleanly.
 *
 * For status validation against the document subtype, createDocumentValidator
 * has a .refine() that checks the status against statusOptionsForSubtype.
 * updateDocumentValidator defers that check to the service layer (it only
 * validates the schema shape here).
 */

import { Priority } from "@repo/api/src/types/common";
import {
  DocumentStatus,
  DocumentType,
  FeatureStatus,
} from "@repo/api/src/types/document";
import { describe, expect, it } from "vitest";
import {
  createDocumentValidator,
  updateDocumentValidator,
} from "@/app/documents/validators";

// A valid UUID accepted by both z.uuid() and uuidOrSlug().
const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

// Minimum valid input for createDocumentValidator.
const VALID_CREATE_BASE = {
  projectId: "PRD-42",
  type: DocumentType.Prd,
  title: "Test Document",
  content: "Test content",
};

// ---------------------------------------------------------------------------
// createDocumentValidator
// ---------------------------------------------------------------------------

describe("createDocumentValidator", () => {
  describe("strict — rejects read-only and unknown fields", () => {
    it.each([
      ["id", { id: VALID_UUID }],
      ["slug", { slug: "PRD-1" }],
      ["tokenUsage", { tokenUsage: 100 }],
      ["createdById", { createdById: VALID_UUID }],
      ["latestVersion", { latestVersion: 1 }],
      ["repositorySnapshot", { repositorySnapshot: {} }],
      ["arbitrary unknown key", { randomField: "value" }],
    ])("rejects %s in create body", (_, extra) => {
      const result = createDocumentValidator.safeParse({
        ...VALID_CREATE_BASE,
        ...extra,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("status cross-field validation against document type", () => {
    it("rejects FEATURE type with a DocumentStatus value (DRAFT)", () => {
      const result = createDocumentValidator.safeParse({
        ...VALID_CREATE_BASE,
        type: DocumentType.Feature,
        status: DocumentStatus.Draft,
      });
      expect(result.success).toBe(false);
    });

    it("rejects PRD type with a FeatureStatus value (TRIAGE)", () => {
      const result = createDocumentValidator.safeParse({
        ...VALID_CREATE_BASE,
        type: DocumentType.Prd,
        status: FeatureStatus.Triage,
      });
      expect(result.success).toBe(false);
    });

    it("accepts FEATURE type with a valid FeatureStatus (TRIAGE)", () => {
      const result = createDocumentValidator.safeParse({
        ...VALID_CREATE_BASE,
        type: DocumentType.Feature,
        status: FeatureStatus.Triage,
      });
      expect(result.success).toBe(true);
    });

    it("accepts PRD type with a valid DocumentStatus (DRAFT)", () => {
      const result = createDocumentValidator.safeParse({
        ...VALID_CREATE_BASE,
        type: DocumentType.Prd,
        status: DocumentStatus.Draft,
      });
      expect(result.success).toBe(true);
    });
  });

  describe("accepts all supported optional fields", () => {
    it("parses a create body with every accepted optional field present", () => {
      const result = createDocumentValidator.safeParse({
        ...VALID_CREATE_BASE,
        priority: Priority.High,
        approverId: VALID_UUID,
        fileName: "spec.md",
        status: DocumentStatus.InReview,
        assigneeId: VALID_UUID,
        repositorySelection: {
          primary: { fullName: "owner/repo" },
        },
      });
      expect(result.success).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// updateDocumentValidator
// ---------------------------------------------------------------------------

describe("updateDocumentValidator", () => {
  describe("strict — rejects read-only and unknown fields", () => {
    it.each([
      ["id", { id: VALID_UUID }],
      ["slug", { slug: "PRD-1" }],
      ["tokenUsage", { tokenUsage: 100 }],
      ["createdById", { createdById: VALID_UUID }],
      ["latestVersion", { latestVersion: 1 }],
      ["repositorySnapshot", { repositorySnapshot: {} }],
      ["arbitrary unknown key", { randomField: "value" }],
    ])("rejects %s in update body", (_, input) => {
      const result = updateDocumentValidator.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe("accepts valid inputs", () => {
    it("parses an empty update body (all fields optional)", () => {
      const result = updateDocumentValidator.safeParse({});
      expect(result.success).toBe(true);
    });

    it("parses a body with all accepted optional fields present", () => {
      const result = updateDocumentValidator.safeParse({
        title: "Updated title",
        fileName: "updated.md",
        approverId: VALID_UUID,
        status: DocumentStatus.InReview,
        priority: Priority.Low,
        projectId: "PRD-42",
        assigneeId: VALID_UUID,
        sortOrder: 5,
      });
      expect(result.success).toBe(true);
    });
  });
});
