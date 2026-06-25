import type { JsonObject } from "@repo/api/src/types/common";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import type { Loop } from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { z } from "zod";
import { documentVersionService } from "@/app/documents/document-version-service";
import { resetDocumentRoom } from "@/app/documents/room-utils";
import { documentWhere } from "@/lib/artifact-adapters";
import { downloadArtifactFile } from "@/lib/loops/loop-state";
import { defineHandler } from "./loop-command-handler";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GeneratePrdArtifacts = {
  prdContent: string | null;
};

// ---------------------------------------------------------------------------
// Download (ECS / S3 path)
// ---------------------------------------------------------------------------

async function downloadGeneratePrdArtifacts(
  stateKeyPrefix: string
): Promise<GeneratePrdArtifacts> {
  const buf = await downloadArtifactFile(stateKeyPrefix, "prd.md");
  const prdContent = buf ? buf.toString("utf-8") : null;
  return { prdContent };
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export async function ingestGeneratePrdArtifacts(
  loop: Loop,
  organizationId: string,
  artifacts: GeneratePrdArtifacts
): Promise<void> {
  const documentId = loop.documentId;
  if (!documentId) {
    return;
  }

  const { prdContent } = artifacts;
  if (!prdContent) {
    log.info("[loop-document-ingestion] No PRD content to ingest", {
      documentId,
    });
    return;
  }

  await documentVersionService.createVersion(
    documentId,
    organizationId,
    null,
    prdContent
  );

  const updatedArtifact = await withDb((db) =>
    db.artifact.update({
      where: documentWhere({ id: documentId, organizationId }),
      data: { status: DocumentStatus.Draft },
      select: {
        id: true,
        organizationId: true,
        slug: true,
        subtype: true,
        document: { select: { latestVersion: true } },
      },
    })
  );

  // Reset the Liveblocks room so any stale Y.Doc content is cleared.
  if (updatedArtifact.slug) {
    waitUntil(
      resetDocumentRoom({
        id: updatedArtifact.id,
        organizationId: updatedArtifact.organizationId,
        slug: updatedArtifact.slug,
        type: updatedArtifact.subtype as DocumentType,
        latestVersion: updatedArtifact.document?.latestVersion ?? 1,
      })
    );
  }

  log.info("[loop-document-ingestion] PRD content ingested", {
    documentId,
    contentLength: prdContent.length,
  });
}

// ---------------------------------------------------------------------------
// Upload-based loading (desktop path)
// ---------------------------------------------------------------------------

const generatePrdUploadSchema = z.object({
  prd: z.object({ content: z.string() }).optional(),
});

function generatePrdArtifactsFromUpload(
  uploaded: JsonObject
): GeneratePrdArtifacts {
  const parsed = generatePrdUploadSchema.safeParse(uploaded);
  if (!parsed.success) {
    log.warn(
      "[loop-document-ingestion] Generate PRD upload failed schema validation",
      { error: parsed.error.message }
    );
    return { prdContent: null };
  }
  const prdContent = parsed.data.prd?.content ?? null;
  return { prdContent };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const generatePrdHandler = defineHandler<GeneratePrdArtifacts>({
  requiresRepo: true,
  requiresParent: false,
  includePrimaryArtifact: true,
  downloadArtifacts: downloadGeneratePrdArtifacts,
  downloadFromUpload: generatePrdArtifactsFromUpload,
  ingest: ingestGeneratePrdArtifacts,
});

export const requestPrdChangesHandler = defineHandler<GeneratePrdArtifacts>({
  requiresRepo: true,
  requiresParent: true,
  includePrimaryArtifact: true,
  downloadArtifacts: downloadGeneratePrdArtifacts,
  downloadFromUpload: generatePrdArtifactsFromUpload,
  async ingest(
    loop: Loop,
    organizationId: string,
    artifacts: GeneratePrdArtifacts
  ) {
    // Defense-in-depth: re-fetch the artifact type from the DB rather than
    // trusting the dispatch-time type. The Loop type does not carry
    // artifactType, and the defineHandler pattern has no allowedArtifactTypes
    // field, so this DB lookup is the only way to guard against a misrouted
    // loop reaching this handler with a non-PRD artifact.
    const artifact = loop.documentId
      ? await withDb((db) =>
          db.artifact.findUnique({
            where: documentWhere({ id: loop.documentId!, organizationId }),
            select: { subtype: true },
          })
        )
      : null;

    if (artifact?.subtype !== DocumentType.Prd) {
      throw new Error(
        `[request-prd-changes] Expected artifact type ${DocumentType.Prd}, got ${artifact?.subtype ?? "none"} — marking loop failed`
      );
    }

    await ingestGeneratePrdArtifacts(loop, organizationId, artifacts);
  },
});
