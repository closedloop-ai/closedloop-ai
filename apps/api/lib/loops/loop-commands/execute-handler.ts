import {
  ExecutionResultV2Schema,
  normalizeV1ExecutionResult,
  parseExecutionResultFile,
  type RepoExecutionResult,
} from "@closedloop-ai/loops-api/execution-result";
import type { JsonObject } from "@repo/api/src/types/common";
import {
  EvaluationReportType,
  type JudgesReport,
} from "@repo/api/src/types/evaluation";
import type { Loop } from "@repo/api/src/types/loop";
import type { PromptsSnapshot } from "@repo/api/src/types/prompt";
import { EntityType, type TransactionClient, withDb } from "@repo/database";
import { parsePromptsSnapshotFromMarkdownEntries } from "@repo/github/prompt-snapshot-parser";
import { log } from "@repo/observability/log";
import { z } from "zod";
import {
  parseJsonArtifact,
  upsertEvaluationWithJudgeScores,
} from "@/lib/loops/loop-document-ingestion";
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

/**
 * Parsed artifacts relevant to the EXECUTE command.
 *
 * `repoResults` carries one entry per repo (primary plus every entry in
 * `loop.additionalRepos`). Both v1 and v2 envelopes are normalized into this
 * shape at the boundary so downstream ingestion never branches on schema
 * version.
 */
export type ExecutionArtifacts = {
  repoResults: RepoExecutionResult[];
  codeJudgesReport: JudgesReport | null;
  promptsSnapshot: PromptsSnapshot | null;
};

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * Normalize an arbitrary execution-result.json payload (v1 or v2) into a
 * `RepoExecutionResult[]`. Returns an empty array on parse failure so the
 * ingestion fan-out can simply iterate.
 */
function normalizeExecutionResultPayload(
  payload: unknown,
  primaryFullName: string
): RepoExecutionResult[] {
  const asObject = payload as Record<string, unknown> | null;

  if (asObject?.schemaVersion === 2) {
    const v2Parse = ExecutionResultV2Schema.safeParse(asObject);
    if (!v2Parse.success) {
      log.warn(
        "[loop-document-ingestion] Failed to parse v2 execution-result.json",
        { issues: v2Parse.error.issues }
      );
      return [];
    }
    return v2Parse.data.results;
  }

  const v1 = parseExecutionResultFile(payload);
  if (!v1) {
    return [];
  }
  return normalizeV1ExecutionResult(v1, primaryFullName);
}

/**
 * Download and parse artifacts relevant to execute commands from S3.
 * Only fetches execution-result.json, code-judges.json, and prompt snapshots.
 */
export async function downloadExecutionArtifacts(
  stateKeyPrefix: string,
  primaryFullName: string
): Promise<ExecutionArtifacts> {
  const [executionResultBuf, codeJudgesReportBuf, promptMarkdownEntries] =
    await Promise.all([
      downloadArtifactFile(stateKeyPrefix, "execution-result.json"),
      downloadArtifactFile(stateKeyPrefix, "code-judges.json"),
      downloadPromptSnapshotMarkdownEntries(stateKeyPrefix),
    ]);

  const repoResults =
    (parseJsonArtifact<RepoExecutionResult[] | null>(
      executionResultBuf,
      "execution-result.json",
      (parsed) => normalizeExecutionResultPayload(parsed, primaryFullName)
    ) as RepoExecutionResult[] | null) ?? [];

  const codeJudgesReport = parseJsonArtifact<JudgesReport>(
    codeJudgesReportBuf,
    "code-judges.json",
    (p) => p
  ) as JudgesReport | null;

  const promptsSnapshot: PromptsSnapshot | null =
    parsePromptsSnapshotFromMarkdownEntries(
      promptMarkdownEntries,
      "[loop-document-ingestion]"
    );

  return { repoResults, codeJudgesReport, promptsSnapshot };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Upsert a GitHubPullRequest row, returning the effective row so the caller
 * always has the correct artifactId for linkage — even if a concurrent
 * webhook or workflow-completion handler won the insert race.
 */
async function upsertPrRow(
  tx: TransactionClient,
  data: {
    workstreamId: string;
    organizationId: string;
    repositoryId: string;
    documentId: string;
    githubId: string;
    number: number;
    title: string;
    htmlUrl: string;
    headBranch: string;
    baseBranch: string;
  },
  loopId: string
): Promise<{ id: string; documentId: string | null }> {
  const row = await tx.gitHubPullRequest.upsert({
    where: {
      repositoryId_number: {
        repositoryId: data.repositoryId,
        number: data.number,
      },
    },
    create: { ...data, state: "OPEN" },
    // Don't overwrite fields that a concurrent handler may have set
    // more accurately (e.g. state from a webhook).
    update: {},
    select: { id: true, documentId: true },
  });

  if (row.documentId && row.documentId !== data.documentId) {
    log.warn(
      "[loop-document-ingestion] PR row already linked to a different artifact via upsert race",
      {
        loopId,
        repositoryId: data.repositoryId,
        prNumber: data.number,
        existingArtifactId: row.documentId,
        requestedArtifactId: data.documentId,
      }
    );
  }

  return row;
}

/**
 * Resolve the active `GitHubInstallationRepository` row for a repo full name
 * within an organization. Returns null when the install is missing or
 * inactive — callers should log and skip the entry.
 */
async function findInstallationRepoId(
  organizationId: string,
  repoFullName: string
): Promise<string | null> {
  const row = await withDb((db) =>
    db.gitHubInstallationRepository.findFirst({
      where: {
        fullName: repoFullName,
        installation: { organizationId, status: "ACTIVE" },
      },
      select: { id: true },
    })
  );
  return row?.id ?? null;
}

/**
 * Ingest a single `success` repo result: upsert the PR row, ensure linkage,
 * and emit a `GITHUB_PR_CREATED` workstream event.
 */
async function ingestSuccessRepoResult(
  tx: TransactionClient,
  loop: Loop,
  result: Extract<RepoExecutionResult, { status: "success" }>,
  installationRepoId: string,
  artifact: { organizationId: string; projectId: string | null; slug: string }
): Promise<void> {
  const prTitle =
    result.prTitle ??
    `ClosedLoop: ${result.branchName || `PR #${result.prNumber}`}`;
  const githubId = String(result.githubId ?? result.prNumber);

  // Check if a PR record already exists (may have been created by the
  // pull_request webhook or workflow-completion handler racing with this handler).
  const existingPr = await tx.gitHubPullRequest.findUnique({
    where: {
      repositoryId_number: {
        repositoryId: installationRepoId,
        number: result.prNumber,
      },
    },
    select: { id: true, documentId: true },
  });

  // Determine the effective artifactId for linkage. If the PR row already
  // exists with a different artifact, respect the existing link to avoid
  // creating contradictory entity-link edges.
  let effectiveArtifactId = loop.documentId!;

  if (existingPr) {
    if (!existingPr.documentId) {
      // PR exists without an artifact link — claim it
      await tx.gitHubPullRequest.update({
        where: { id: existingPr.id },
        data: { documentId: loop.documentId! },
      });
    } else if (existingPr.documentId !== loop.documentId) {
      // PR is already linked to a different artifact — don't overwrite
      effectiveArtifactId = existingPr.documentId;
      log.warn(
        "[loop-document-ingestion] PR already linked to a different artifact",
        {
          existingArtifactId: existingPr.documentId,
          requestedArtifactId: loop.documentId,
          loopId: loop.id,
          prNumber: result.prNumber,
          repoFullName: result.fullName,
        }
      );
    }
    log.info(
      "[loop-document-ingestion] PR already exists; skipping duplicate PR row create",
      {
        loopId: loop.id,
        repositoryId: installationRepoId,
        prNumber: result.prNumber,
        pullRequestId: existingPr.id,
        repoFullName: result.fullName,
      }
    );
  } else {
    const upsertedPr = await upsertPrRow(
      tx,
      {
        workstreamId: loop.workstreamId!,
        organizationId: loop.organizationId,
        repositoryId: installationRepoId,
        documentId: loop.documentId!,
        githubId,
        number: result.prNumber,
        title: prTitle,
        htmlUrl: result.prUrl,
        headBranch: result.branchName,
        baseBranch: result.baseBranch,
      },
      loop.id
    );
    if (upsertedPr.documentId && upsertedPr.documentId !== loop.documentId) {
      effectiveArtifactId = upsertedPr.documentId;
    }
  }

  if (!artifact.projectId) {
    log.warn(
      "[loop-document-ingestion] Document missing projectId; skipping PR linkage",
      {
        loopId: loop.id,
        documentId: loop.documentId,
        repoFullName: result.fullName,
      }
    );
    return;
  }

  await ensurePrLinkageRecords(tx, {
    organizationId: artifact.organizationId,
    workstreamId: loop.workstreamId!,
    projectId: artifact.projectId,
    documentId: effectiveArtifactId,
    prUrl: result.prUrl,
    prTitle,
    prNumber: result.prNumber,
    githubId,
    headBranch: result.branchName,
    baseBranch: result.baseBranch,
    commitSha: result.commitSha ?? null,
  });

  await tx.workstreamEvent.create({
    data: {
      workstreamId: loop.workstreamId!,
      type: "GITHUB_PR_CREATED",
      actorType: "system",
      data: {
        loopId: loop.id,
        repoFullName: result.fullName,
        prNumber: result.prNumber,
        prUrl: result.prUrl,
        prTitle,
        branch: result.branchName,
        documentId: loop.documentId!,
        slug: artifact.slug,
      },
    },
  });
}

/**
 * Emit a `GITHUB_ACTION_COMPLETED` event for a non-success peer outcome.
 * Skipped/failed peers do not produce a PR, so no linkage records are created.
 */
async function ingestNonSuccessRepoResult(
  tx: TransactionClient,
  loop: Loop,
  result: Exclude<RepoExecutionResult, { status: "success" }>
): Promise<void> {
  const eventData =
    result.status === "skipped"
      ? {
          loopId: loop.id,
          command: "execute",
          repoFullName: result.fullName,
          status: result.status,
          hasChanges: false,
          reason: result.reason,
        }
      : {
          loopId: loop.id,
          command: "execute",
          repoFullName: result.fullName,
          status: result.status,
          hasChanges: false,
          error: result.error,
        };

  await tx.workstreamEvent.create({
    data: {
      workstreamId: loop.workstreamId!,
      type: "GITHUB_ACTION_COMPLETED",
      actorType: "system",
      data: eventData,
    },
  });
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/**
 * Ingest execution artifacts into the platform.
 *
 * Iterates every `RepoExecutionResult` in `artifacts.repoResults` and:
 * - on `success`, creates a PR record, ExternalLink, EntityLink, and a
 *   `GITHUB_PR_CREATED` workstream event scoped to that repo.
 * - on `skipped`/`failed`, emits a `GITHUB_ACTION_COMPLETED` workstream event
 *   recording the outcome (no PR, no linkage).
 *
 * The `codeJudgesReport` and prompts snapshot are plan-level (not per-repo),
 * so they are persisted exactly once.
 *
 * Mirrors handleExecutionSuccess() in workflow-completion-handler.ts.
 */
export async function ingestExecutionArtifacts(
  loop: Loop,
  artifacts: ExecutionArtifacts
): Promise<void> {
  if (artifacts.repoResults.length === 0) {
    log.info("[loop-document-ingestion] No repo results to ingest", {
      loopId: loop.id,
    });
    return;
  }

  if (!(loop.workstreamId && loop.documentId)) {
    log.warn(
      "[loop-document-ingestion] Loop missing workstreamId or artifactId",
      {
        loopId: loop.id,
      }
    );
    return;
  }

  // Resolve installationRepo ids per success entry up-front so the transaction
  // body stays focused on writes. Skipped/failed entries do not need a lookup.
  const successEntries = artifacts.repoResults.filter(
    (r): r is Extract<RepoExecutionResult, { status: "success" }> =>
      r.status === "success"
  );
  const installationRepoIds = new Map<string, string>();
  for (const entry of successEntries) {
    const id = await findInstallationRepoId(
      loop.organizationId,
      entry.fullName
    );
    if (id) {
      installationRepoIds.set(entry.fullName, id);
    } else {
      log.warn(
        "[loop-document-ingestion] GitHubInstallationRepository not found; skipping repo result",
        {
          loopId: loop.id,
          repoFullName: entry.fullName,
        }
      );
    }
  }

  await upsertFromSnapshot(loop.organizationId, artifacts.promptsSnapshot);

  await withDb.tx(async (tx) => {
    const artifact = await tx.document.findUnique({
      where: { id: loop.documentId!, organizationId: loop.organizationId },
      select: { organizationId: true, projectId: true, slug: true },
    });

    if (!artifact) {
      log.warn(
        "[loop-document-ingestion] Artifact not found for PR record creation",
        {
          documentId: loop.documentId,
          loopId: loop.id,
        }
      );
      return;
    }

    if (artifacts.codeJudgesReport) {
      await upsertEvaluationWithJudgeScores({
        entityId: loop.documentId!,
        entityType: EntityType.DOCUMENT,
        documentId: loop.documentId!,
        loopId: loop.id,
        organizationId: loop.organizationId,
        reportType: EvaluationReportType.Code,
        report: artifacts.codeJudgesReport,
        tx,
      });

      log.info("[loop-document-ingestion] Persisted code judges report", {
        documentId: loop.documentId,
        loopId: loop.id,
        reportId: artifacts.codeJudgesReport.report_id,
        judgesCount: artifacts.codeJudgesReport.stats.length,
      });
    }

    for (const result of artifacts.repoResults) {
      if (result.status === "success") {
        const installationRepoId = installationRepoIds.get(result.fullName);
        if (!installationRepoId) {
          continue;
        }
        await ingestSuccessRepoResult(tx, loop, result, installationRepoId, {
          organizationId: artifact.organizationId,
          projectId: artifact.projectId,
          slug: artifact.slug ?? "",
        });
      } else {
        await ingestNonSuccessRepoResult(tx, loop, result);
      }
    }
  });

  log.info("[loop-document-ingestion] Execution artifacts ingested", {
    loopId: loop.id,
    repoCount: artifacts.repoResults.length,
    successCount: successEntries.length,
  });
}

// ---------------------------------------------------------------------------
// Upload-based loading (desktop path)
// ---------------------------------------------------------------------------

const executionUploadSchema = z.object({
  executionResult: z.record(z.string(), z.unknown()).optional(),
  codeJudges: judgesReportSchema.optional(),
});

function executionArtifactsFromUpload(
  uploaded: JsonObject
): ExecutionArtifacts {
  const parsed = executionUploadSchema.parse(uploaded);
  // Desktop uploads currently carry a single repo's result. The v1 normalizer
  // tags the resulting RepoExecutionResult with this primaryFullName; the
  // desktop client always reports the loop's primary repo, and the empty
  // fallback is acceptable because validation only enforces fullName presence
  // for "success" entries, where the repo url already encodes it.
  const repoResults = parsed.executionResult
    ? normalizeExecutionResultPayload(parsed.executionResult, "")
    : [];
  const codeJudgesReport = (parsed.codeJudges as JudgesReport) ?? null;
  // Prompt snapshots not available in desktop upload path
  const promptsSnapshot: PromptsSnapshot | null = null;

  return { repoResults, codeJudgesReport, promptsSnapshot };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const executeHandler = defineHandler<ExecutionArtifacts>({
  requiresRepo: true,
  requiresParent: true,
  includePrimaryArtifact: true,

  downloadArtifacts(stateKeyPrefix: string, loop: Loop) {
    // requiresRepo: true guarantees loop.repo is present at this entry point.
    // Fail loudly rather than silently passing an empty primaryFullName, which
    // would tag any v1 envelope with "" and break downstream lookups.
    const primaryFullName = loop.repo?.fullName;
    if (!primaryFullName) {
      throw new Error(
        `executeHandler.downloadArtifacts: loop ${loop.id} has no primary repo fullName`
      );
    }
    return downloadExecutionArtifacts(stateKeyPrefix, primaryFullName);
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
