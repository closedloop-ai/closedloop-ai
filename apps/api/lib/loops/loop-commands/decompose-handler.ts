import type { JsonObject } from "@repo/api/src/types/common";
import { Priority } from "@repo/api/src/types/common";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import { FeatureStatus } from "@repo/api/src/types/feature";
import type {
  DecomposeFeature,
  DecomposeResult,
  DecomposeUserStory,
  Loop,
} from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { artifactsService } from "@/app/artifacts/service";
import { entityLinksService } from "@/app/entity-links/service";
import { featuresService } from "@/app/features/service";
import { parseJsonArtifact } from "@/lib/loops/loop-artifact-ingestion";
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
          "[loop-artifact-ingestion] features.json failed schema validation",
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

  if (!(result?.features?.length && loop.artifactId)) {
    log.info("[loop-artifact-ingestion] No features to ingest", {
      artifactId: loop.artifactId,
      featureCount: result?.features?.length ?? 0,
    });
    return;
  }

  // Resolve projectId from the source PRD artifact
  const prd = await artifactsService.findByIdSimple(
    loop.artifactId,
    organizationId
  );

  if (!prd?.projectId) {
    log.warn(
      "[loop-artifact-ingestion] PRD has no projectId, skipping ingestion",
      {
        artifactId: loop.artifactId,
      }
    );
    return;
  }

  let created = 0;

  await withDb.tx(async () => {
    for (const feature of result.features) {
      const createdFeature = await featuresService.create(
        organizationId,
        loop.userId,
        {
          projectId: prd.projectId!,
          title: feature.title,
          description: buildFullDescription(feature),
          priority:
            PRIORITY_MAP[feature.priority ?? "MEDIUM"] ?? Priority.Medium,
          status: FeatureStatus.NotStarted,
        }
      );

      await entityLinksService.createLink(organizationId, {
        sourceId: loop.artifactId!,
        sourceType: EntityType.Artifact,
        targetId: createdFeature.id,
        targetType: EntityType.Feature,
        linkType: LinkType.Produces,
      });

      created++;
    }
  });

  log.info("[loop-artifact-ingestion] Features ingested", {
    artifactId: loop.artifactId,
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
      "[loop-artifact-ingestion] Decompose upload failed schema validation",
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
