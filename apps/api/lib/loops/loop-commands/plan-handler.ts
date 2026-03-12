import type { PlanJson } from "@repo/api/src/types/artifact";
import type { JudgesReport } from "@repo/api/src/types/evaluation";
import type { Loop } from "@repo/api/src/types/loop";
import type { PromptsSnapshot } from "@repo/api/src/types/prompt";
import {
  EvaluationReportType as PrismaEvaluationReportType,
  withDb,
} from "@repo/database";
import { parsePromptsSnapshotFromMarkdownEntries } from "@repo/github/prompt-snapshot-parser";
import { log } from "@repo/observability/log";
import { artifactVersionService } from "@/app/artifacts/artifact-version-service";
import { resetArtifactRoom } from "@/app/artifacts/room-utils";
import { fanOutJudgeScores } from "@/lib/judge-score-fanout";
import { parseJsonArtifact } from "@/lib/loops/loop-artifact-ingestion";
import {
  downloadArtifactFile,
  downloadPromptSnapshotMarkdownEntries,
} from "@/lib/loops/loop-state";
import { upsertFromSnapshot } from "@/lib/prompts-service";
import { defineHandler } from "./loop-command-handler";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed artifacts relevant to PLAN / REQUEST_CHANGES commands. */
export type PlanArtifacts = {
  planContent: string | null;
  questionsContent: string | null;
  judgesReport: JudgesReport | null;
  promptsSnapshot: PromptsSnapshot | null;
};

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * Download and parse artifacts relevant to plan commands from S3.
 * Only fetches plan.json, open-questions.md, judges.json, and prompt snapshots.
 */
export async function downloadPlanArtifacts(
  stateKeyPrefix: string
): Promise<PlanArtifacts> {
  const [planJsonBuf, questionsBuf, judgesReportBuf, promptMarkdownEntries] =
    await Promise.all([
      downloadArtifactFile(stateKeyPrefix, "plan.json"),
      downloadArtifactFile(stateKeyPrefix, "open-questions.md"),
      downloadArtifactFile(stateKeyPrefix, "judges.json"),
      downloadPromptSnapshotMarkdownEntries(stateKeyPrefix),
    ]);

  const planContent = parseJsonArtifact<PlanJson>(
    planJsonBuf,
    "plan.json",
    (p) => p.content
  ) as string | null;

  const questionsContent = questionsBuf ? questionsBuf.toString("utf-8") : null;

  const judgesReport = parseJsonArtifact<JudgesReport>(
    judgesReportBuf,
    "judges.json",
    (p) => p
  ) as JudgesReport | null;

  const promptsSnapshot: PromptsSnapshot | null =
    parsePromptsSnapshotFromMarkdownEntries(
      promptMarkdownEntries,
      "[loop-artifact-ingestion]"
    );

  return { planContent, questionsContent, judgesReport, promptsSnapshot };
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/**
 * Ingest plan artifacts into the platform.
 * Creates a new artifact version with the plan content and updates status to DRAFT.
 * Falls back to questionsContent if no plan content (mirrors handleWorkflowSuccess).
 * Also persists judges report and creates a workstream completion event.
 */
export async function ingestPlanArtifacts(
  loop: Loop,
  organizationId: string,
  artifacts: PlanArtifacts
): Promise<void> {
  const artifactId = loop.artifactId;
  if (!artifactId) {
    return;
  }

  // Fall back to questions content if no plan (same as webhook path)
  const finalContent = artifacts.planContent ?? artifacts.questionsContent;
  if (!finalContent) {
    log.info(
      "[loop-artifact-ingestion] No plan or questions content to ingest",
      {
        artifactId,
      }
    );
    return;
  }

  await artifactVersionService.createVersion(artifactId, null, finalContent);

  const updatedArtifact = await withDb((db) =>
    db.artifact.update({
      where: { id: artifactId, organizationId },
      data: { status: "DRAFT" },
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

  // Persist prompt registry entries from snapshot (idempotent upsert)
  await upsertFromSnapshot(organizationId, artifacts.promptsSnapshot);

  // Persist judges report if available (upsert for idempotency)
  if (artifacts.judgesReport) {
    await withDb.tx(async (tx) => {
      const evaluation = await tx.artifactEvaluation.upsert({
        where: {
          artifactId_reportId: {
            artifactId,
            reportId: artifacts.judgesReport!.report_id,
          },
        },
        create: {
          artifactId,
          loopId: loop.id,
          reportType: PrismaEvaluationReportType.PLAN,
          reportId: artifacts.judgesReport!.report_id,
          reportData: artifacts.judgesReport!,
        },
        update: {
          loopId: loop.id,
          reportType: PrismaEvaluationReportType.PLAN,
          reportData: artifacts.judgesReport!,
        },
      });

      await fanOutJudgeScores({
        evaluationId: evaluation.id,
        organizationId,
        report: artifacts.judgesReport!,
        tx,
      });
    });

    log.info("[loop-artifact-ingestion] Persisted judges report", {
      artifactId,
      reportId: artifacts.judgesReport.report_id,
    });
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

  log.info("[loop-artifact-ingestion] Plan content ingested", {
    artifactId,
    contentLength: finalContent.length,
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const planHandler = defineHandler<PlanArtifacts>({
  requiresRepo: true,
  requiresParent: false,
  includePrimaryArtifact: false,

  downloadArtifacts(stateKeyPrefix: string) {
    return downloadPlanArtifacts(stateKeyPrefix);
  },

  async ingest(loop: Loop, organizationId: string, artifacts: PlanArtifacts) {
    await ingestPlanArtifacts(loop, organizationId, artifacts);
  },
});

export const requestChangesHandler = defineHandler<PlanArtifacts>({
  requiresRepo: true,
  requiresParent: true,
  includePrimaryArtifact: true,

  downloadArtifacts(stateKeyPrefix: string) {
    return downloadPlanArtifacts(stateKeyPrefix);
  },

  async ingest(loop: Loop, organizationId: string, artifacts: PlanArtifacts) {
    await ingestPlanArtifacts(loop, organizationId, artifacts);
  },
});
