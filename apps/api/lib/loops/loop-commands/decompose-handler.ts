import { LinkType } from "@repo/api/src/types/artifact";
import type { JsonObject } from "@repo/api/src/types/common";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import type {
  DecomposeFeature,
  DecomposeResult,
  DecomposeUserStory,
  Loop,
} from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { artifactLinksService } from "@/app/artifact-links/service";
import { documentsService } from "@/app/documents/service";
import { parseJsonArtifact } from "@/lib/loops/loop-document-ingestion";
import { downloadArtifactFile } from "@/lib/loops/loop-state";
import { defineHandler } from "./loop-command-handler";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DecomposeArtifacts = {
  result: DecomposeResult | null;
};

// ---------------------------------------------------------------------------
// Priority mapping
// ---------------------------------------------------------------------------

const PRIORITY_MAP: Record<string, Priority> = {
  HIGH: Priority.High,
  MEDIUM: Priority.Medium,
  LOW: Priority.Low,
};

// ---------------------------------------------------------------------------
// Description assembly
// ---------------------------------------------------------------------------

/** Format a single user story with its acceptance criteria as markdown. */
function formatUserStory(story: DecomposeUserStory): string {
  const lines = [`### ${story.id}: ${story.story}`];

  const acs = story.acceptanceCriteria ?? [];
  if (acs.length) {
    lines.push("");
    for (const ac of acs) {
      lines.push(`- **${ac.id}:** ${ac.criterion}`);
    }
  }

  return lines.join("\n");
}

/** Merge user stories into the description markdown. */
function buildFullDescription(feature: DecomposeFeature): string {
  const { description, userStories } = feature;
  if (!userStories?.length) {
    return description;
  }
  const storiesMd = userStories.map(formatUserStory).join("\n\n");
  return `${description}\n\n## User Stories\n\n${storiesMd}`;
}

// ---------------------------------------------------------------------------
// Shared schema
// ---------------------------------------------------------------------------

const decomposeResultSchema = z.object({
  features: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      priority: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
      userStories: z
        .array(
          z.object({
            id: z.string(),
            story: z.string(),
            acceptanceCriteria: z.array(
              z.object({
                id: z.string(),
                criterion: z.string(),
              })
            ),
          })
        )
        .optional(),
    })
  ),
});

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

async function downloadDecomposeArtifacts(
  stateKeyPrefix: string
): Promise<DecomposeArtifacts> {
  const buf = await downloadArtifactFile(stateKeyPrefix, "features.json");

  const result = parseJsonArtifact<DecomposeResult>(
    buf,
    "features.json",
    (r) => {
      const parsed = decomposeResultSchema.safeParse(r);
      if (!parsed.success) {
        log.warn(
          "[loop-document-ingestion] features.json failed schema validation",
          { error: parsed.error.message }
        );
        return null;
      }
      return parsed.data;
    }
  ) as DecomposeResult | null;

  return { result };
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

async function ingestDecomposeArtifacts(
  loop: Loop,
  organizationId: string,
  artifacts: DecomposeArtifacts
): Promise<void> {
  const { result } = artifacts;

  if (!(result?.features?.length && loop.documentId)) {
    log.info("[loop-document-ingestion] No features to ingest", {
      documentId: loop.documentId,
      featureCount: result?.features?.length ?? 0,
    });
    return;
  }

  // Resolve projectId from the source PRD artifact
  const prd = await documentsService.findByIdSimple(
    loop.documentId,
    organizationId
  );

  if (!prd?.projectId) {
    log.warn(
      "[loop-document-ingestion] PRD has no projectId, skipping ingestion",
      {
        documentId: loop.documentId,
      }
    );
    return;
  }

  let created = 0;

  await withDb.tx(async () => {
    for (const feature of result.features) {
      const createdFeature = await documentsService.create(
        organizationId,
        loop.userId,
        {
          projectId: prd.projectId!,
          type: DocumentType.Feature,
          title: feature.title,
          content: buildFullDescription(feature),
          priority:
            PRIORITY_MAP[feature.priority ?? "MEDIUM"] ?? Priority.Medium,
          status: DocumentStatus.Draft,
        }
      );

      if (!createdFeature) {
        continue;
      }

      await artifactLinksService.createLink(organizationId, {
        sourceId: loop.documentId!,
        targetId: createdFeature.id,
        linkType: LinkType.Produces,
      });

      created++;
    }
  });

  log.info("[loop-document-ingestion] Features ingested", {
    documentId: loop.documentId,
    featuresCreated: created,
  });
}

// ---------------------------------------------------------------------------
// Upload-based loading (desktop path)
// ---------------------------------------------------------------------------

const decomposeUploadSchema = z.object({
  features: decomposeResultSchema.optional(),
});

function decomposeArtifactsFromUpload(
  uploaded: JsonObject
): DecomposeArtifacts {
  const parsed = decomposeUploadSchema.safeParse(uploaded);
  if (!parsed.success) {
    log.warn(
      "[loop-document-ingestion] Decompose upload failed schema validation",
      { error: parsed.error.message }
    );
    return { result: null };
  }
  const result = parsed.data?.features ?? null;
  return { result };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const decomposeHandler = defineHandler<DecomposeArtifacts>({
  requiresRepo: false,
  requiresParent: false,
  includePrimaryArtifact: true,
  downloadArtifacts: downloadDecomposeArtifacts,
  downloadFromUpload: decomposeArtifactsFromUpload,
  ingest: ingestDecomposeArtifacts,
});
