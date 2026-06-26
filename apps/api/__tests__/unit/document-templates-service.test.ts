/**
 * Unit tests for `documentTemplatesService`.
 *
 * Covers:
 *  - `findOrgTemplate` — read-only template lookup, returns null when missing.
 *  - `ensureDefaultTemplates` — lazy-creates the PRD template when missing,
 *    skips creation when present, seeds the initial version content.
 *  - `resolveTemplatesSentinelProjectId` — returns existing sentinel,
 *    auto-creates one when none exists.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
  DocumentStatus: {
    Draft: "DRAFT",
  },
}));

vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: {
    getLatest: vi.fn(),
    createVersion: vi.fn(),
  },
}));

import { withDb } from "@repo/database";
import { documentVersionService } from "@/app/documents/document-version-service";
import {
  documentTemplatesService,
  resolveTemplatesSentinelProjectId,
} from "@/app/templates/service";

const mockWithDb = withDb as unknown as Mock;
const mockGetLatest = documentVersionService.getLatest as Mock;
const mockCreateVersion = documentVersionService.createVersion as Mock;

// Helper: install a mocked db client that exposes the methods the service
// hits. The service calls `withDb(callback)` so we run the callback against
// our mock db.
function mockDb(db: Record<string, unknown>) {
  mockWithDb.mockImplementation(
    async (fn: (db: Record<string, unknown>) => unknown) => fn(db)
  );
}

describe("documentTemplatesService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("findOrgTemplate", () => {
    it("returns the template document when one exists for the type", async () => {
      mockDb({
        artifact: {
          findFirst: vi.fn().mockResolvedValue({
            id: "tmpl-1",
            organizationId: "org-1",
            type: "DOCUMENT",
            subtype: "TEMPLATE",
            name: "PRD Template",
            slug: "tmpl-prd",
            status: "DRAFT",
            createdById: "u-1",
            assigneeId: null,
            sortOrder: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            assignee: null,
            document: {
              templateForType: "PRD",
              latestVersion: 1,
              fileName: null,
              approverId: null,
              approver: null,
            },
          }),
        },
      });

      const result = await documentTemplatesService.findOrgTemplate(
        "org-1",
        "PRD" as never
      );

      expect(result).not.toBeNull();
      expect(result?.id).toBe("tmpl-1");
      expect(result?.title).toBe("PRD Template");
    });

    it("returns null when no template exists for the type", async () => {
      mockDb({
        artifact: { findFirst: vi.fn().mockResolvedValue(null) },
      });

      const result = await documentTemplatesService.findOrgTemplate(
        "org-1",
        "PRD" as never
      );

      expect(result).toBeNull();
    });

    it("scopes the query by organizationId + DOCUMENT type + templateForType", async () => {
      const findFirst = vi.fn().mockResolvedValue(null);
      mockDb({ artifact: { findFirst } });

      await documentTemplatesService.findOrgTemplate("org-1", "PRD" as never);

      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: "DOCUMENT",
            organizationId: "org-1",
            document: { templateForType: "PRD" },
          }),
        })
      );
    });
  });

  describe("ensureDefaultTemplates", () => {
    it("skips creation when a PRD template already exists, but seeds the version when missing", async () => {
      const findFirstDetail = vi.fn().mockResolvedValue({
        artifactId: "tmpl-existing",
      });
      const createArtifact = vi.fn();

      mockDb({
        documentDetail: { findFirst: findFirstDetail },
        artifact: { create: createArtifact },
      });

      // No existing version yet — should seed PRD_TEMPLATE.
      mockGetLatest.mockResolvedValue(null);
      mockCreateVersion.mockResolvedValue({ id: "ver-1" });

      await documentTemplatesService.ensureDefaultTemplates("org-1", "user-1");

      expect(findFirstDetail).toHaveBeenCalled();
      expect(createArtifact).not.toHaveBeenCalled();
      expect(mockCreateVersion).toHaveBeenCalledWith(
        "tmpl-existing",
        "org-1",
        null,
        expect.any(String)
      );
    });

    it("does not seed a version when one already exists", async () => {
      mockDb({
        documentDetail: {
          findFirst: vi.fn().mockResolvedValue({ artifactId: "tmpl-1" }),
        },
        artifact: { create: vi.fn() },
      });

      mockGetLatest.mockResolvedValue({
        id: "ver-1",
        content: "existing",
      });

      await documentTemplatesService.ensureDefaultTemplates("org-1", "user-1");

      expect(mockCreateVersion).not.toHaveBeenCalled();
    });

    it("creates the template + sentinel project + initial version when none exists", async () => {
      // Sequence:
      //   1. documentDetail.findFirst → null (no template)
      //   2. project.findFirst → null (no sentinel)
      //   3. project.create → sentinel project
      //   4. artifact.create → new template artifact
      //   5. documentVersionService.getLatest → null (no version)
      //   6. documentVersionService.createVersion → seed version
      const findFirstDetail = vi.fn().mockResolvedValue(null);
      const findFirstProject = vi.fn().mockResolvedValue(null);
      const createProject = vi.fn().mockResolvedValue({ id: "sentinel-1" });
      const createArtifact = vi.fn().mockResolvedValue({ id: "tmpl-new" });

      mockDb({
        documentDetail: { findFirst: findFirstDetail },
        project: {
          findFirst: findFirstProject,
          create: createProject,
        },
        artifact: { create: createArtifact },
      });

      mockGetLatest.mockResolvedValue(null);
      mockCreateVersion.mockResolvedValue({ id: "ver-1" });

      await documentTemplatesService.ensureDefaultTemplates("org-1", "user-1");

      expect(createProject).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: "org-1",
            isTemplatesSentinel: true,
            createdById: "user-1",
          }),
        })
      );
      expect(createArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "DOCUMENT",
            subtype: "TEMPLATE",
            organizationId: "org-1",
            projectId: "sentinel-1",
            createdById: "user-1",
          }),
        })
      );
      expect(mockCreateVersion).toHaveBeenCalledWith(
        "tmpl-new",
        "org-1",
        null,
        expect.any(String)
      );
    });
  });

  describe("resolveTemplatesSentinelProjectId", () => {
    it("returns the existing sentinel project id when one exists", async () => {
      const findFirst = vi.fn().mockResolvedValue({ id: "sentinel-1" });
      const create = vi.fn();
      mockDb({ project: { findFirst, create } });

      const id = await resolveTemplatesSentinelProjectId("org-1", "user-1");

      expect(id).toBe("sentinel-1");
      expect(create).not.toHaveBeenCalled();
    });

    it("creates a new sentinel project when none exists", async () => {
      const findFirst = vi.fn().mockResolvedValue(null);
      const create = vi.fn().mockResolvedValue({ id: "sentinel-new" });
      mockDb({ project: { findFirst, create } });

      const id = await resolveTemplatesSentinelProjectId("org-2", "user-2");

      expect(id).toBe("sentinel-new");
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: "org-2",
            isTemplatesSentinel: true,
            createdById: "user-2",
            slug: expect.stringContaining("templates-"),
          }),
        })
      );
    });
  });
});
