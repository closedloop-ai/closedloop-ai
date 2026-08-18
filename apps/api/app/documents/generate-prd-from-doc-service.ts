import { LinkType } from "@repo/api/src/types/artifact";
import {
  type CreateDocumentInput,
  type Document,
  DocumentStatus,
  DocumentType,
} from "@repo/api/src/types/document";
import { Result, Status } from "@repo/api/src/types/result";
import { ArtifactType, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  createDocumentRecord,
  indexDocumentProjection,
} from "./document-service";
import { documentVersionService } from "./document-version-service";
import { createDocumentRoom } from "./room-utils";

export type GeneratePrdFromDocumentInput = {
  /** Source evergreen Document (DocumentType.Doc) to seed the PRD from. */
  documentId: string;
  /** Target project the new DRAFT PRD lands in. */
  projectId: string;
  /** Optional title for the new PRD; falls back to the source Document title. */
  title?: string;
};

export type GeneratePrdFromDocumentError =
  | typeof Status.NotFound
  | typeof Status.BadRequest;

/**
 * Create a DRAFT PRD from an evergreen Document (DocumentType.Doc).
 *
 * Reuses the existing GENERATE_PRD generation engine: this only lands the
 * seed artifact (a DRAFT PRD whose version-1 content is the source Document's
 * content, in the caller-chosen project) plus a provenance link back to the
 * source Document. The caller then dispatches `RunLoopCommand.GeneratePrd`
 * against the returned PRD, which picks up that seeded content as the primary
 * artifact in the context pack (see `apps/api/lib/loops/loop-context-pack.ts`).
 *
 * Provenance uses `LinkType.RelatesTo` (source Document → new PRD), matching
 * the sibling attach feature (FEA-3951 / #3738). The `createDocumentRecord`
 * `sourceId` path is deliberately NOT reused for the link because it hardcodes
 * `LinkType.Produces`, and would also inherit the source's repository snapshot,
 * which a project-less evergreen Document does not carry.
 *
 * Org-scoped at every read/write: the source Document is looked up under
 * `organizationId`, and the link is created inside the same transaction with
 * the same `organizationId`, so a cross-org source can never seed a PRD.
 */
async function generatePrdFromDocument(
  organizationId: string,
  userId: string,
  input: GeneratePrdFromDocumentInput
): Promise<Result<Document, GeneratePrdFromDocumentError>> {
  const sourceDocument = await withDb((db) =>
    db.artifact.findUnique({
      where: { id: input.documentId, organizationId },
      select: { id: true, type: true, subtype: true, name: true },
    })
  );
  if (
    !sourceDocument ||
    sourceDocument.type !== ArtifactType.DOCUMENT ||
    sourceDocument.subtype !== DocumentType.Doc
  ) {
    return Result.err(Status.NotFound);
  }

  const project = await withDb((db) =>
    db.project.findUnique({
      where: { id: input.projectId, organizationId },
      select: { id: true },
    })
  );
  if (!project) {
    return Result.err(Status.BadRequest);
  }

  const latestVersion = await documentVersionService.getLatest(
    sourceDocument.id
  );
  const seedContent = latestVersion?.content ?? "";

  const trimmedTitle = input.title?.trim();
  const createInput: CreateDocumentInput = {
    projectId: input.projectId,
    type: DocumentType.Prd,
    title: trimmedTitle || sourceDocument.name,
    content: seedContent,
    status: DocumentStatus.Draft,
  };

  const createdPrd = await withDb.tx(async (tx) => {
    const prd = await createDocumentRecord(
      tx,
      organizationId,
      userId,
      createInput
    );
    if (!prd) {
      return null;
    }
    await tx.artifactLink.create({
      data: {
        organizationId,
        sourceId: sourceDocument.id,
        targetId: prd.id,
        linkType: LinkType.RelatesTo,
      },
      select: { id: true },
    });
    return prd;
  });

  if (!createdPrd) {
    return Result.err(Status.BadRequest);
  }

  await createDocumentRoom(createdPrd);

  // Best-effort, post-commit search projection so the seeded PRD is findable in
  // unified search immediately, matching the normal `documentService.create`
  // path. Index the same seed content stored as the PRD's version-1 body.
  indexDocumentProjection(createdPrd, seedContent);

  log.info("[generate-prd-from-doc] Seeded DRAFT PRD from Document", {
    organizationId,
    sourceDocumentId: sourceDocument.id,
    prdId: createdPrd.id,
    projectId: input.projectId,
    seedContentLength: seedContent.length,
  });

  return Result.ok(createdPrd);
}

export const generatePrdFromDocumentService = {
  generatePrdFromDocument,
};
