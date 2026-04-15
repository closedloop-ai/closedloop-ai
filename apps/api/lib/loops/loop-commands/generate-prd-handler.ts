import { ArtifactStatus, ArtifactType } from "@repo/api/src/types/artifact";
import type { JsonObject } from "@repo/api/src/types/common";
import type { Loop } from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
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

  await artifactVersionService.createVersion(
    artifactId,
    organizationId,
    null,
    prdContent
  );

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
    waitUntil(resetArtifactRoom(updatedArtifact));
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

// `assertLoopBackendAllowed` correctly blocks PRDs pre-dating loop-based
// generation because requiresParent: true causes the orchestrator to call it
// before dispatching this handler. PRDs that were generated via GH Actions
// will be rejected there, so we never reach this ingest function for them.
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
    const artifact = loop.artifactId
      ? await withDb((db) =>
          db.artifact.findUnique({
            where: { id: loop.artifactId!, organizationId },
            select: { type: true },
          })
        )
      : null;

    if (artifact?.type !== ArtifactType.Prd) {
      throw new Error(
        `[request-prd-changes] Expected artifact type ${ArtifactType.Prd}, got ${artifact?.type ?? "none"} — marking loop failed`
      );
    }

    await ingestGeneratePrdArtifacts(loop, organizationId, artifacts);
  },
});
