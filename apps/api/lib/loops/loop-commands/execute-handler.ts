import type { JsonObject } from "@repo/api/src/types/common";
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
import { z } from "zod";
import type { ExecutionResult } from "@/app/webhooks/github/types";
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

/** Parsed artifacts relevant to the EXECUTE command. */
export type ExecutionArtifacts = {
  executionResult: ExecutionResult | null;
  codeJudgesReport: JudgesReport | null;
  promptsSnapshot: PromptsSnapshot | null;
};

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * Download and parse artifacts relevant to execute commands from S3.
 * Only fetches execution-result.json, code-judges.json, and prompt snapshots.
 */
async function downloadExecutionArtifacts(
  stateKeyPrefix: string
): Promise<ExecutionArtifacts> {
  const [executionResultBuf, codeJudgesReportBuf, promptMarkdownEntries] =
    await Promise.all([
      downloadArtifactFile(stateKeyPrefix, "execution-result.json"),
      downloadArtifactFile(stateKeyPrefix, "code-judges.json"),
      downloadPromptSnapshotMarkdownEntries(stateKeyPrefix),
    ]);

  const executionResult = parseJsonArtifact<ExecutionResult>(
    executionResultBuf,
    "execution-result.json",
    (p) => p
  ) as ExecutionResult | null;

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

  return { executionResult, codeJudgesReport, promptsSnapshot };
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/**
 * Ingest execution artifacts into the platform.
 * Creates PR record, ExternalLinks, EntityLinks, and WorkstreamEvent.
 * Mirrors handleExecutionSuccess() in workflow-completion-handler.ts.
 */
export async function ingestExecutionArtifacts(
  loop: Loop,
  artifacts: ExecutionArtifacts
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
      {
        loopId: loop.id,
      }
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

  await upsertFromSnapshot(loop.organizationId, artifacts.promptsSnapshot);

  await withDb.tx(async (tx) => {
    const artifact = await tx.artifact.findUnique({
      where: { id: loop.artifactId!, organizationId: loop.organizationId },
      select: { organizationId: true, projectId: true, slug: true },
    });

    if (!artifact) {
      log.warn(
        "[loop-artifact-ingestion] Artifact not found for PR record creation",
        {
          artifactId: loop.artifactId,
          loopId: loop.id,
        }
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
        projectId: artifact.projectId!,
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
        projectId: artifact.projectId!,
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

// ---------------------------------------------------------------------------
// Upload-based loading (desktop path)
// ---------------------------------------------------------------------------

const executionResultSchema = z.object({
  has_changes: z.boolean(),
  pr_url: z.string(),
  pr_number: z.union([z.string(), z.number()]),
  pr_title: z.string().optional(),
  branch_name: z.string(),
  base_ref: z.string().optional(),
  base_branch: z.string().optional(),
  github_id: z.number().optional(),
  commit_sha: z.string().optional(),
});

const codeJudgesReportSchema = z.object({
  report_id: z.string(),
  timestamp: z.string(),
  stats: z.array(
    z.object({
      type: z.literal("case_score"),
      case_id: z.string(),
      final_status: z.enum(["FAILED", "NEEDS_IMPROVEMENT", "PASSED"]),
      metrics: z.array(
        z.object({
          metric_name: z.string(),
          threshold: z.number(),
          score: z.number(),
          justification: z.string(),
        })
      ),
    })
  ),
});

const executionUploadSchema = z.object({
  executionResult: executionResultSchema.optional(),
  codeJudges: codeJudgesReportSchema.optional(),
});

function executionArtifactsFromUpload(
  uploaded: JsonObject
): ExecutionArtifacts {
  const parsed = executionUploadSchema.parse(uploaded);
  const executionResult = (parsed.executionResult as ExecutionResult) ?? null;
  const codeJudgesReport = (parsed.codeJudges as JudgesReport) ?? null;
  // Prompt snapshots not available in desktop upload path
  const promptsSnapshot: PromptsSnapshot | null = null;

  return { executionResult, codeJudgesReport, promptsSnapshot };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const executeHandler = defineHandler<ExecutionArtifacts>({
  requiresRepo: true,
  requiresParent: true,
  includePrimaryArtifact: true,

  downloadArtifacts(stateKeyPrefix: string) {
    return downloadExecutionArtifacts(stateKeyPrefix);
  },

  downloadFromUpload: executionArtifactsFromUpload,

  async ingest(
    loop: Loop,
    _organizationId: string,
    artifacts: ExecutionArtifacts
  ) {
    await ingestExecutionArtifacts(loop, artifacts);
  },
});
