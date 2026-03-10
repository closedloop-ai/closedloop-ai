import { Priority } from "@repo/api/src/types/common";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import { IssueStatus } from "@repo/api/src/types/issue";
import type {
  DecomposeFeature,
  DecomposeResult,
  Loop,
} from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { artifactsService } from "@/app/artifacts/service";
import { entityLinksService } from "@/app/entity-links/service";
import { issuesService } from "@/app/issues/service";
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

/** Merge acceptance criteria into the description markdown. */
function buildFullDescription(feature: DecomposeFeature): string {
  const { description, acceptanceCriteria } = feature;
  if (!acceptanceCriteria?.length) {
    return description;
  }
  const acList = acceptanceCriteria.map((ac) => `- ${ac}`).join("\n");
  return `${description}\n\n## Acceptance Criteria\n\n${acList}`;
}

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
    (r) => r
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
      const issue = await issuesService.create(organizationId, loop.userId, {
        projectId: prd.projectId!,
        title: feature.title,
        description: buildFullDescription(feature),
        priority: PRIORITY_MAP[feature.priority ?? "MEDIUM"] ?? Priority.Medium,
        status: IssueStatus.NotStarted,
      });

      await entityLinksService.createLink(organizationId, {
        sourceId: loop.artifactId!,
        sourceType: EntityType.Artifact,
        targetId: issue.id,
        targetType: EntityType.Issue,
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
// Handler
// ---------------------------------------------------------------------------

export const decomposeHandler = defineHandler<DecomposeArtifacts>({
  requiresRepo: false,
  requiresParent: false,
  includePrimaryArtifact: true,

  downloadArtifacts(stateKeyPrefix: string) {
    return downloadDecomposeArtifacts(stateKeyPrefix);
  },

  async ingest(
    loop: Loop,
    organizationId: string,
    artifacts: DecomposeArtifacts
  ) {
    await ingestDecomposeArtifacts(loop, organizationId, artifacts);
  },
});
