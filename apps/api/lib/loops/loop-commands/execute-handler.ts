import type { JsonObject } from "@repo/api/src/types/common";
import type { JudgesReport } from "@repo/api/src/types/evaluation";
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
import {
  parseJsonArtifact,
  upsertEvaluationWithJudgeScores,
} from "@/lib/loops/loop-artifact-ingestion";
import {
  downloadArtifactFile,
  downloadPromptSnapshotMarkdownEntries,
} from "@/lib/loops/loop-state";
import { ensurePrLinkageRecords } from "@/lib/pr-linkage";
import { upsertFromSnapshot } from "@/lib/prompts-service";
import { judgesReportSchema } from "../judges-report-schema";
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
    `ClosedLoop: ${executionResult.branch_name || `PR #${prNumber}`}`;
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
      await upsertEvaluationWithJudgeScores({
        artifactId: loop.artifactId!,
        loopId: loop.id,
        organizationId: loop.organizationId,
        reportType: PrismaEvaluationReportType.CODE,
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

    // Check if a PR record already exists (may have been created by the
    // pull_request webhook or workflow-completion handler racing with this handler).
    const existingPr = await tx.gitHubPullRequest.findUnique({
      where: {
        repositoryId_number: {
          repositoryId: installationRepo.id,
          number: prNumber,
        },
      },
      select: { id: true, artifactId: true },
    });

    // Determine the effective artifactId for linkage. If the PR row already
    // exists with a different artifact, respect the existing link to avoid
    // creating contradictory entity-link edges.
    let effectiveArtifactId = loop.artifactId!;

    if (existingPr) {
      if (!existingPr.artifactId) {
        // PR exists without an artifact link — claim it
        await tx.gitHubPullRequest.update({
          where: { id: existingPr.id },
          data: { artifactId: loop.artifactId! },
        });
      } else if (existingPr.artifactId !== loop.artifactId) {
        // PR is already linked to a different artifact — don't overwrite
        effectiveArtifactId = existingPr.artifactId;
        log.warn(
          "[loop-artifact-ingestion] PR already linked to a different artifact",
          {
            existingArtifactId: existingPr.artifactId,
            requestedArtifactId: loop.artifactId,
            loopId: loop.id,
            prNumber,
          }
        );
      }
      log.info(
        "[loop-artifact-ingestion] PR already exists; skipping duplicate PR row create",
        {
          loopId: loop.id,
          repositoryId: installationRepo.id,
          prNumber,
          pullRequestId: existingPr.id,
        }
      );
    } else {
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
    }

    // Create ExternalLink, EntityLink, and preview deployment records (with dedup)
    await ensurePrLinkageRecords(tx, {
      organizationId: artifact.organizationId,
      workstreamId: loop.workstreamId!,
      projectId: artifact.projectId!,
      artifactId: effectiveArtifactId,
      prUrl: executionResult.pr_url,
      prTitle,
      prNumber,
      githubId: executionResult.github_id ?? prNumber,
      headBranch: executionResult.branch_name,
      baseBranch,
      commitSha: executionResult.commit_sha ?? null,
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

const executionUploadSchema = z.object({
  executionResult: executionResultSchema.optional(),
  codeJudges: judgesReportSchema.optional(),
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
