import {
  type Document,
  DocumentStatus,
  DocumentType,
} from "@repo/api/src/types/document";
import { ArtifactType, withDb } from "@repo/database";
import {
  documentIncludeWithUser,
  generateSlug,
  toDocument,
} from "@/app/documents/document-utils";
import { documentVersionService } from "@/app/documents/document-version-service";
import { PRD_TEMPLATE } from "@/app/documents/template-seeds";

/**
 * Document templates service. Owns reads + lazy-creation of organization
 * templates (DOCUMENT artifacts with `subtype: TEMPLATE` + a `templateForType`
 * tag). Templates live on a hidden per-org sentinel project; this service
 * lazily creates that sentinel on first template write.
 */

/**
 * Resolve the organization's templates-sentinel project id, creating the
 * sentinel lazily on the first template write for orgs that were skipped by
 * the 2a backfill (zero-user orgs at migration time).
 *
 * Exported for `documentService.create` so a TEMPLATE-typed create can route
 * to the sentinel without going through this service's higher-level helpers.
 */
export async function resolveTemplatesSentinelProjectId(
  organizationId: string,
  userId: string
): Promise<string> {
  const existing = await withDb((db) =>
    db.project.findFirst({
      where: { organizationId, isTemplatesSentinel: true },
      select: { id: true },
    })
  );
  if (existing) {
    return existing.id;
  }
  const created = await withDb((db) =>
    db.project.create({
      data: {
        organizationId,
        name: "Templates",
        slug: `templates-${organizationId.slice(0, 8)}`,
        createdById: userId,
        isTemplatesSentinel: true,
      },
      select: { id: true },
    })
  );
  return created.id;
}

export const documentTemplatesService = {
  /**
   * Find the organization template for a specific document type. Returns
   * null if no template exists. Pure read — does NOT auto-create templates.
   */
  async findOrgTemplate(
    organizationId: string,
    templateForType: DocumentType
  ): Promise<Document | null> {
    const artifact = await withDb((db) =>
      db.artifact.findFirst({
        where: {
          type: ArtifactType.DOCUMENT,
          organizationId,
          document: { templateForType },
        },
        include: documentIncludeWithUser,
      })
    );
    if (!artifact) {
      return null;
    }
    return toDocument(artifact);
  },

  /**
   * Ensure default templates exist for an organization. Creates/upserts the
   * PRD template if missing.
   */
  async ensureDefaultTemplates(
    organizationId: string,
    userId: string
  ): Promise<void> {
    const existing = await withDb((db) =>
      db.documentDetail.findFirst({
        where: {
          templateForType: DocumentType.Prd,
          artifact: { organizationId, type: ArtifactType.DOCUMENT },
        },
        select: { artifactId: true },
      })
    );

    let templateId: string;
    if (existing) {
      templateId = existing.artifactId;
    } else {
      const sentinelProjectId = await resolveTemplatesSentinelProjectId(
        organizationId,
        userId
      );
      const created = await withDb((db) =>
        db.artifact.create({
          data: {
            type: ArtifactType.DOCUMENT,
            subtype: DocumentType.Template,
            organizationId,
            projectId: sentinelProjectId,
            createdById: userId,
            name: "Product Requirements Document Template",
            slug: generateSlug(),
            status: DocumentStatus.Draft,
            document: {
              create: { templateForType: DocumentType.Prd, latestVersion: 1 },
            },
          },
          select: { id: true },
        })
      );
      templateId = created.id;
    }

    const existingVersion = await documentVersionService.getLatest(templateId);
    if (!existingVersion) {
      await documentVersionService.createVersion(
        templateId,
        organizationId,
        null,
        PRD_TEMPLATE
      );
    }
  },
};
