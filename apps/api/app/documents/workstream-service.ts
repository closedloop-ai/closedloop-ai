import { LinkType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import { ArtifactType, withDb } from "@repo/database";
import { artifactLinksService } from "../artifact-links/service";
import {
  type DocumentWithRegenerationContext,
  documentIncludeWithUser,
  type SourceContext,
  toDocument,
  workstreamToWithDocuments,
} from "./document-utils";
import { documentVersionService } from "./document-version-service";

/**
 * Document workstream service. Owns the "wire a document into a workstream"
 * flows: resolve the source PRD/Feature via artifact links, attach the
 * document to that source's workstream (or auto-create one).
 *
 * Used by the generation/execution flows that need a workstream + source PRD
 * before triggering a workflow.
 */
export const documentWorkstreamService = {
  /**
   * Find the source entity (PRD or Feature) for a document via artifact
   * links. Returns a SourceContext with the source's content, or null if no
   * source link exists.
   */
  async findSourceWithContent(
    artifact: NonNullable<DocumentWithRegenerationContext>
  ): Promise<SourceContext | null> {
    const sourceLinks = await artifactLinksService.findSourceLinks(
      artifact.organizationId,
      artifact.id,
      LinkType.Produces
    );
    if (!sourceLinks.length) {
      return null;
    }

    const sourceArtifacts = await withDb((db) =>
      db.artifact.findMany({
        where: {
          id: { in: sourceLinks.map((link) => link.sourceId) },
          organizationId: artifact.organizationId,
          type: ArtifactType.DOCUMENT,
          subtype: { in: [DocumentType.Prd, DocumentType.Feature] },
        },
        include: documentIncludeWithUser,
      })
    );

    if (sourceArtifacts.length === 0) {
      return null;
    }

    const sourceDocuments = sourceArtifacts.map(toDocument);
    const prdSource = sourceDocuments.find(
      (doc) => doc.type === DocumentType.Prd
    );
    const sourceDocument = prdSource ?? sourceDocuments[0];

    const latestVersion = await documentVersionService.getLatest(
      sourceDocument.id
    );
    return {
      id: sourceDocument.id,
      type: ArtifactType.DOCUMENT,
      title: sourceDocument.title,
      content: latestVersion?.content ?? null,
      targetRepo: sourceDocument.targetRepo,
      targetBranch: sourceDocument.targetBranch,
      workstreamId: sourceDocument.workstreamId,
    };
  },

  /**
   * Find or create a workstream for the document.
   * - If the document has a workstream, returns it with the source resolved
   *   via artifact links.
   * - Otherwise, finds the source (entity links → title fallback), then
   *   either attaches to the source's workstream or auto-creates one.
   */
  async findOrCreateWorkstream(
    organizationId: string,
    artifact: NonNullable<DocumentWithRegenerationContext>,
    userId: string
  ): Promise<{
    workstream: NonNullable<typeof artifact.workstream> | null;
    source: SourceContext | null;
  }> {
    if (artifact.workstream) {
      const source = await this.findSourceWithContent(artifact);
      return {
        workstream: artifact.workstream,
        source,
      };
    }

    if (!artifact.projectId) {
      return { workstream: null, source: null };
    }

    let foundSource = await this.findSourceWithContent(artifact);

    if (!foundSource?.content) {
      const titleFallback = artifact.title
        .replace("Implementation Plan: ", "")
        .replace("Plan: ", "");
      const matchedArtifact = await withDb((db) =>
        db.artifact.findFirst({
          where: {
            type: ArtifactType.DOCUMENT,
            organizationId,
            projectId: artifact.projectId ?? undefined,
            subtype: DocumentType.Prd,
            name: titleFallback,
          },
          include: documentIncludeWithUser,
        })
      );
      if (matchedArtifact) {
        const matchedDocument = toDocument(matchedArtifact);
        const latestVersion = await documentVersionService.getLatest(
          matchedDocument.id
        );
        foundSource = {
          id: matchedDocument.id,
          type: ArtifactType.DOCUMENT,
          title: matchedDocument.title,
          content: latestVersion?.content ?? null,
          targetRepo: matchedDocument.targetRepo,
          targetBranch: matchedDocument.targetBranch,
          workstreamId: matchedDocument.workstreamId,
        };

        await artifactLinksService.createLink(organizationId, {
          sourceId: matchedDocument.id,
          targetId: artifact.id,
          linkType: LinkType.Produces,
        });
      }
    }

    if (!foundSource?.content) {
      return { workstream: null, source: foundSource };
    }

    if (foundSource.workstreamId) {
      return withDb.tx(async (tx) => {
        await tx.artifact.update({
          where: { id: artifact.id, organizationId },
          data: { workstreamId: foundSource.workstreamId },
        });

        const workstream = await tx.workstream.findUnique({
          where: { id: foundSource.workstreamId as string },
          include: {
            project: true,
            artifacts: {
              where: {
                type: ArtifactType.DOCUMENT,
                subtype: DocumentType.Prd,
              },
              include: documentIncludeWithUser,
              take: 1,
            },
          },
        });

        return {
          workstream: workstreamToWithDocuments(workstream),
          source: foundSource,
        };
      });
    }

    return withDb.tx(async (tx) => {
      const newWorkstream = await tx.workstream.create({
        data: {
          organizationId,
          projectId: artifact.projectId as string,
          title: foundSource.title,
          description: `Auto-created for: ${foundSource.title}`,
          type: "FEATURE_DELIVERY",
          createdById: userId,
        },
      });

      await tx.artifact.updateMany({
        where: {
          id: { in: [foundSource.id, artifact.id] },
          organizationId,
          type: ArtifactType.DOCUMENT,
        },
        data: { workstreamId: newWorkstream.id },
      });

      const workstream = await tx.workstream.findUnique({
        where: { id: newWorkstream.id },
        include: {
          project: true,
          artifacts: {
            where: {
              type: ArtifactType.DOCUMENT,
              subtype: DocumentType.Prd,
            },
            include: documentIncludeWithUser,
            take: 1,
          },
        },
      });

      return {
        workstream: workstreamToWithDocuments(workstream),
        source: foundSource,
      };
    });
  },
};
