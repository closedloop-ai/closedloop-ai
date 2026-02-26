/**
 * Loop artifact ingestion — downloads artifacts from S3 and writes them to the DB.
 *
 * NOTE: The plan ingestion (ingestPlanArtifacts) and execution ingestion
 * (ingestExecutionArtifacts) intentionally duplicate DB logic from the GitHub
 * Actions webhook path (workflow-completion-handler.ts). This is deliberate —
 * the webhook path has its own test coverage and transaction semantics, and
 * coupling them introduced brittleness. A follow-up PR will extract shared
 * helpers once both paths are stable and well-tested independently.
 * See: workflow-completion-handler.ts handleWorkflowSuccess / handleExecutionSuccess
 */

import type { PlanJson } from "@repo/api/src/types/artifact";
import type { JudgesReport } from "@repo/api/src/types/evaluation";
import {
  ExternalLinkType,
  type PreviewDeploymentMetadata,
} from "@repo/api/src/types/external-link";
import type { Loop } from "@repo/api/src/types/loop";
import type { PromptsSnapshot } from "@repo/api/src/types/prompt";
import {
  EvaluationReportType as PrismaEvaluationReportType,
  withDb,
} from "@repo/database";
import { parsePromptsSnapshotFromMarkdownEntries } from "@repo/github/prompt-snapshot-parser";
import { log } from "@repo/observability/log";
import { artifactVersionService } from "@/app/artifacts/artifact-version-service";
import { updateArtifactRoomVersion } from "@/app/artifacts/room-utils";
import { fanOutJudgeScores } from "@/lib/judge-score-fanout";
import { upsertFromSnapshot } from "@/lib/prompts-service";
import type { ExecutionResult } from "../app/webhooks/github/types";
import {
  downloadArtifactFile,
  downloadPromptSnapshotMarkdownEntries,
} from "./loop-state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed artifacts downloaded from a loop's S3 state. */
export type LoopArtifacts = {
  planContent: string | null;
  questionsContent: string | null;
  executionResult: ExecutionResult | null;
  judgesReport: JudgesReport | null;
  codeJudgesReport: JudgesReport | null;
  promptsSnapshot: PromptsSnapshot | null;
  // NOTE: perf.jsonl is uploaded to S3 but not ingested here.
  // GitHubActionRunPerformance requires a non-nullable actionRunId
  // (loops don't have action runs). Needs a schema change to support
  // loop-based perf data — deferred to follow-up.
};

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

/**
 * Download and parse key artifact files from a loop's S3 state.
 */
export async function downloadLoopArtifacts(
  stateKeyPrefix: string
): Promise<LoopArtifacts> {
  const [
    planJsonBuf,
    questionsBuf,
    executionResultBuf,
    codeJudgesReportBuf,
    judgesReportBuf,
    promptMarkdownEntries,
  ] = await Promise.all([
    downloadArtifactFile(stateKeyPrefix, "plan.json"),
    downloadArtifactFile(stateKeyPrefix, "open-questions.md"),
    downloadArtifactFile(stateKeyPrefix, "execution-result.json"),
    downloadArtifactFile(stateKeyPrefix, "code-judges.json"),
    downloadArtifactFile(stateKeyPrefix, "judges.json"),
    downloadPromptSnapshotMarkdownEntries(stateKeyPrefix),
  ]);

  const planContent = parseJsonArtifact<PlanJson>(
    planJsonBuf,
    "plan.json",
    (p) => p.content
  ) as string | null;

  // Fall back to open-questions.md if plan.json has no content
  // (mirrors zip-parser.ts questionsContent fallback)
  const questionsContent = questionsBuf ? questionsBuf.toString("utf-8") : null;

  const executionResult = parseJsonArtifact<ExecutionResult>(
    executionResultBuf,
    "execution-result.json",
    (p) => p
  ) as ExecutionResult | null;

  const judgesReport = parseJsonArtifact<JudgesReport>(
    judgesReportBuf,
    "judges.json",
    (p) => p
  ) as JudgesReport | null;

  const codeJudgesReport = parseJsonArtifact<JudgesReport>(
    codeJudgesReportBuf,
    "code-judges.json",
    (p) => p
  ) as JudgesReport | null;

  const promptsSnapshot: PromptsSnapshot | null =
    parsePromptsSnapshotFromMarkdownEntries(
      promptMarkdownEntries,
      "[loop-artifact-ingestion]"
    );

  return {
    planContent,
    questionsContent,
    executionResult,
    judgesReport,
    codeJudgesReport,
    promptsSnapshot,
  };
}

// ---------------------------------------------------------------------------
// Plan ingestion (PLAN / REQUEST_CHANGES commands)
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
  artifacts: LoopArtifacts
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
      select: { slug: true, latestVersion: true },
    })
  );

  // Update the Liveblocks room metadata with the new version number.
  // The frontend seeding logic compares the editor content with the API
  // content and re-seeds when they differ, so the room is preserved
  // (keeping comments) while stale Yjs content gets replaced.
  if (updatedArtifact.slug) {
    await updateArtifactRoomVersion(
      organizationId,
      updatedArtifact.slug,
      updatedArtifact.latestVersion
    );
  }

  // Persist prompt registry entries from snapshot (idempotent upsert)
  try {
    await upsertFromSnapshot(organizationId, artifacts.promptsSnapshot);
  } catch (error) {
    log.warn(
      "[loop-artifact-ingestion] Prompt registry upsert failed, continuing",
      { organizationId, artifactId, error }
    );
  }

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
// Execution ingestion (EXECUTE command)
// ---------------------------------------------------------------------------

/**
 * Ingest execution artifacts into the platform.
 * Creates PR record, ExternalLinks, EntityLinks, and WorkstreamEvent.
 * Mirrors handleExecutionSuccess() in workflow-completion-handler.ts.
 */
export async function ingestExecutionArtifacts(
  loop: Loop,
  artifacts: LoopArtifacts
): Promise<void> {
  const executionResult = artifacts.executionResult;

  if (!executionResult) {
    log.info("[loop-artifact-ingestion] No execution result to ingest", {
      loopId: loop.id,
    });
    return;
  }

  if (!(executionResult.has_changes && executionResult.pr_url)) {
    log.info("[loop-artifact-ingestion] Execution completed with no changes", {
      loopId: loop.id,
    });
    return;
  }

  if (!(loop.workstreamId && loop.artifactId)) {
    log.warn(
      "[loop-artifact-ingestion] Loop missing workstreamId or artifactId",
      { loopId: loop.id }
    );
    return;
  }

  const repoFullName = loop.repo?.fullName;
  if (!repoFullName) {
    log.warn("[loop-artifact-ingestion] Loop missing repo.fullName", {
      loopId: loop.id,
    });
    return;
  }

  // Look up via GitHubInstallationRepository (the canonical repo table).
  // The old Repository table is deprecated and being removed.
  const installationRepo = await withDb((db) =>
    db.gitHubInstallationRepository.findFirst({
      where: {
        fullName: repoFullName,
        installation: { organizationId: loop.organizationId, status: "ACTIVE" },
      },
      select: { id: true },
    })
  );

  if (!installationRepo) {
    log.warn(
      "[loop-artifact-ingestion] GitHubInstallationRepository not found",
      {
        loopId: loop.id,
        repoFullName,
      }
    );
    return;
  }

  const prNumber =
    typeof executionResult.pr_number === "string"
      ? Number.parseInt(executionResult.pr_number, 10)
      : executionResult.pr_number;

  if (Number.isNaN(prNumber)) {
    log.warn(
      "[loop-artifact-ingestion] Invalid pr_number, skipping execution ingestion",
      { loopId: loop.id, raw: executionResult.pr_number }
    );
    return;
  }

  const prTitle =
    executionResult.pr_title ||
    `Symphony: ${executionResult.branch_name || `PR #${prNumber}`}`;
  const baseBranch =
    executionResult.base_branch || executionResult.base_ref || "main";

  await withDb.tx(async (tx) => {
    try {
      await upsertFromSnapshot(
        loop.organizationId,
        artifacts.promptsSnapshot,
        tx
      );
    } catch (error) {
      log.warn(
        "[loop-artifact-ingestion] Prompt registry upsert failed, continuing",
        { organizationId: loop.organizationId, loopId: loop.id, error }
      );
    }

    const artifact = await tx.artifact.findUnique({
      where: { id: loop.artifactId!, organizationId: loop.organizationId },
      select: { organizationId: true, projectId: true, slug: true },
    });

    if (!artifact) {
      log.warn(
        "[loop-artifact-ingestion] Artifact not found for PR record creation",
        { artifactId: loop.artifactId, loopId: loop.id }
      );
      return;
    }

    if (artifacts.codeJudgesReport) {
      const evaluation = await tx.artifactEvaluation.upsert({
        where: {
          artifactId_reportId: {
            artifactId: loop.artifactId!,
            reportId: artifacts.codeJudgesReport.report_id,
          },
        },
        create: {
          artifactId: loop.artifactId!,
          loopId: loop.id,
          reportType: PrismaEvaluationReportType.CODE,
          reportId: artifacts.codeJudgesReport.report_id,
          reportData: artifacts.codeJudgesReport,
        },
        update: {
          loopId: loop.id,
          reportType: PrismaEvaluationReportType.CODE,
          reportData: artifacts.codeJudgesReport,
        },
      });

      await fanOutJudgeScores({
        evaluationId: evaluation.id,
        organizationId: loop.organizationId,
        report: artifacts.codeJudgesReport,
        tx,
      });

      log.info("[loop-artifact-ingestion] Persisted code judges report", {
        artifactId: loop.artifactId,
        loopId: loop.id,
        reportId: artifacts.codeJudgesReport.report_id,
        judgesCount: artifacts.codeJudgesReport.stats.length,
      });
    }

    const existingPr = await tx.gitHubPullRequest.findUnique({
      where: {
        repositoryId_number: {
          repositoryId: installationRepo.id,
          number: prNumber,
        },
      },
      select: { id: true },
    });

    if (existingPr) {
      log.info(
        "[loop-artifact-ingestion] PR already exists; skipping replayed execution artifact creates",
        {
          loopId: loop.id,
          repositoryId: installationRepo.id,
          prNumber,
          pullRequestId: existingPr.id,
        }
      );
      return;
    }

    // Create GitHubPullRequest record
    await tx.gitHubPullRequest.create({
      data: {
        workstreamId: loop.workstreamId!,
        organizationId: loop.organizationId,
        repositoryId: installationRepo.id,
        artifactId: loop.artifactId!,
        githubId: executionResult.github_id ?? prNumber,
        number: prNumber,
        title: prTitle,
        htmlUrl: executionResult.pr_url,
        headBranch: executionResult.branch_name,
        baseBranch,
        state: "OPEN",
      },
    });

    // Create ExternalLink for the PR
    const prLink = await tx.externalLink.create({
      data: {
        organizationId: artifact.organizationId,
        workstreamId: loop.workstreamId!,
        projectId: artifact.projectId,
        type: ExternalLinkType.PullRequest,
        title: prTitle,
        externalUrl: executionResult.pr_url,
        metadata: {
          number: prNumber,
          githubId: executionResult.github_id ?? prNumber,
          headBranch: executionResult.branch_name,
          baseBranch,
          state: "OPEN",
        },
      },
    });

    // Create EntityLink: artifact -> PRODUCES -> PR link
    await tx.entityLink.create({
      data: {
        organizationId: artifact.organizationId,
        sourceId: loop.artifactId!,
        sourceType: "ARTIFACT",
        targetId: prLink.id,
        targetType: "EXTERNAL_LINK",
        linkType: "PRODUCES",
      },
    });

    // Create skeleton ExternalLink for preview deployment
    const previewMetadata: PreviewDeploymentMetadata = {
      ref: executionResult.branch_name,
      sha: executionResult.commit_sha ?? null,
      environment: "preview",
      state: null,
    };

    const previewLink = await tx.externalLink.create({
      data: {
        organizationId: artifact.organizationId,
        workstreamId: loop.workstreamId!,
        projectId: artifact.projectId,
        type: ExternalLinkType.PreviewDeployment,
        title: `Preview: ${executionResult.branch_name}`,
        externalUrl: "",
        metadata: previewMetadata,
      },
    });

    // Create EntityLink: PR -> PRODUCES -> preview deployment
    await tx.entityLink.create({
      data: {
        organizationId: artifact.organizationId,
        sourceId: prLink.id,
        sourceType: "EXTERNAL_LINK",
        targetId: previewLink.id,
        targetType: "EXTERNAL_LINK",
        linkType: "PRODUCES",
      },
    });

    // Create workstream event
    await tx.workstreamEvent.create({
      data: {
        workstreamId: loop.workstreamId!,
        type: "GITHUB_PR_CREATED",
        actorType: "system",
        data: {
          loopId: loop.id,
          prNumber,
          prUrl: executionResult.pr_url,
          prTitle,
          branch: executionResult.branch_name,
          artifactId: loop.artifactId!,
          slug: artifact.slug,
        },
      },
    });
  });

  log.info("[loop-artifact-ingestion] Execution artifacts ingested", {
    loopId: loop.id,
    prUrl: executionResult.pr_url,
    prNumber,
  });
}

function parseJsonArtifact<T>(
  buf: Buffer | null,
  artifactName: string,
  extract: (parsed: T) => unknown
): unknown {
  if (!buf) {
    return null;
  }
  try {
    const parsed = JSON.parse(buf.toString("utf-8")) as T;
    return extract(parsed);
  } catch (err) {
    log.warn(`[loop-artifact-ingestion] Failed to parse ${artifactName}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
