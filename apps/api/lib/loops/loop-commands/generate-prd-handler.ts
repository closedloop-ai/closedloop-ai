import { ArtifactStatus } from "@repo/api/src/types/artifact";
import type { JsonObject } from "@repo/api/src/types/common";
import type { Loop } from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { artifactVersionService } from "@/app/artifacts/artifact-version-service";
import { resetArtifactRoom } from "@/app/artifacts/room-utils";
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
  const artifactId = loop.artifactId;
  if (!artifactId) {
    return;
  }

  const { prdContent } = artifacts;
  if (!prdContent) {
    log.info("[loop-artifact-ingestion] No PRD content to ingest", {
      artifactId,
    });
    return;
  }

  await artifactVersionService.createVersion(artifactId, null, prdContent);

  const updatedArtifact = await withDb((db) =>
    db.artifact.update({
      where: { id: artifactId, organizationId },
      data: { status: ArtifactStatus.Draft },
      select: {
        id: true,
        organizationId: true,
        slug: true,
        type: true,
        latestVersion: true,
      },
    })
  );

  // Reset the Liveblocks room so any stale Y.Doc content is cleared.
  if (updatedArtifact.slug) {
    await resetArtifactRoom(updatedArtifact);
  }

  // Create workstream completion event (idempotent — skip if already exists)
  if (loop.workstreamId) {
    await withDb(async (db) => {
      const existing = await db.workstreamEvent.findFirst({
        where: {
          workstreamId: loop.workstreamId!,
          type: "LOOP_COMPLETED",
          data: { path: ["loopId"], equals: loop.id },
        },
      });
      if (!existing) {
        await db.workstreamEvent.create({
          data: {
            workstreamId: loop.workstreamId!,
            type: "LOOP_COMPLETED",
            actorType: "system",
            data: {
              loopId: loop.id,
              artifactId,
              command: loop.command,
              conclusion: "success",
            },
          },
        });
      }
    });
  }

  log.info("[loop-artifact-ingestion] PRD content ingested", {
    artifactId,
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
      "[loop-artifact-ingestion] Generate PRD upload failed schema validation",
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
