/**
 * Unit tests for documentService.update status-validation logic.
 *
 * Documents (PRD/IMPLEMENTATION_PLAN/TEMPLATE) and Features share the same
 * Artifact.status column but carry disjoint status vocabularies (PRD-495).
 * The update path enforces the correct subset after loading the artifact's
 * subtype from the DB. These tests verify that cross-vocabulary statuses
 * are rejected and valid ones pass.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall } from "../utils/db-helpers";

// --- Mocks (must come before imports) ---

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { JsonNull: "DbNull" },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  scheduleLogFlush: vi.fn(),
}));

// --- Imports (after mocks) ---

import {
  DocumentStatus,
  DocumentType,
  FeatureStatus,
} from "@repo/api/src/types/document";
import { documentService } from "@/app/documents/document-service";

const ORG_ID = "org-1";
const ARTIFACT_ID = "artifact-uuid-1";

/** Minimal artifact row that satisfies toDocument(). */
function makeMockArtifact(subtype: string, status: string) {
  return {
    id: ARTIFACT_ID,
    organizationId: ORG_ID,
    projectId: null,
    subtype,
    name: "Test Artifact",
    slug: "FEA-1",
    status,
    priority: null,
    createdById: null,
    createdBy: null,
    assigneeId: null,
    assignee: null,
    sortOrder: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    document: null,
  };
}

describe("documentService.update — status validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("invalid cross-vocabulary statuses are rejected", () => {
    it("rejects DRAFT when artifact subtype is FEATURE", async () => {
      mockWithDbCall({
        artifact: {
          findUnique: vi
            .fn()
            .mockResolvedValue({ subtype: DocumentType.Feature }),
          update: vi.fn(),
        },
      });

      await expect(
        documentService.update(ARTIFACT_ID, ORG_ID, {
          status: DocumentStatus.Draft,
        })
      ).rejects.toThrow('Status "DRAFT" is not valid for this FEATURE');
    });

    it("rejects TRIAGE when artifact subtype is PRD", async () => {
      mockWithDbCall({
        artifact: {
          findUnique: vi.fn().mockResolvedValue({ subtype: DocumentType.Prd }),
          update: vi.fn(),
        },
      });

      await expect(
        documentService.update(ARTIFACT_ID, ORG_ID, {
          status: FeatureStatus.Triage,
        })
      ).rejects.toThrow('Status "TRIAGE" is not valid for this PRD');
    });

    it("rejects IN_PROGRESS when artifact subtype is IMPLEMENTATION_PLAN", async () => {
      mockWithDbCall({
        artifact: {
          findUnique: vi.fn().mockResolvedValue({
            subtype: DocumentType.ImplementationPlan,
          }),
          update: vi.fn(),
        },
      });

      await expect(
        documentService.update(ARTIFACT_ID, ORG_ID, {
          status: FeatureStatus.InProgress,
        })
      ).rejects.toThrow(
        'Status "IN_PROGRESS" is not valid for this IMPLEMENTATION_PLAN'
      );
    });
  });

  describe("valid subtype statuses pass", () => {
    it("accepts IN_PROGRESS for a FEATURE artifact", async () => {
      mockWithDbCall({
        artifact: {
          findUnique: vi
            .fn()
            .mockResolvedValue({ subtype: DocumentType.Feature }),
          update: vi
            .fn()
            .mockResolvedValue(
              makeMockArtifact(DocumentType.Feature, FeatureStatus.InProgress)
            ),
        },
      });

      const result = await documentService.update(ARTIFACT_ID, ORG_ID, {
        status: FeatureStatus.InProgress,
      });

      expect(result.status).toBe(FeatureStatus.InProgress);
    });

    it("accepts APPROVED for a PRD artifact", async () => {
      mockWithDbCall({
        artifact: {
          findUnique: vi.fn().mockResolvedValue({ subtype: DocumentType.Prd }),
          update: vi
            .fn()
            .mockResolvedValue(
              makeMockArtifact(DocumentType.Prd, DocumentStatus.Approved)
            ),
        },
      });

      const result = await documentService.update(ARTIFACT_ID, ORG_ID, {
        status: DocumentStatus.Approved,
      });

      expect(result.status).toBe(DocumentStatus.Approved);
    });
  });

  it("throws when artifact is not found in the organization", async () => {
    mockWithDbCall({
      artifact: {
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
      },
    });

    await expect(
      documentService.update(ARTIFACT_ID, ORG_ID, {
        status: DocumentStatus.Draft,
      })
    ).rejects.toThrow("Document not found in this organization");
  });
});
