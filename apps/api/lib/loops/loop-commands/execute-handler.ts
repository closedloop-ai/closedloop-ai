import {
  ExecutionResultFileSchema,
  ExecutionResultV2Schema,
  parseExecutionResultFile,
  type RepoExecutionResult,
} from "@closedloop-ai/loops-api/execution-result";
import type { JsonObject } from "@repo/api/src/types/common";
import type { JudgesReport } from "@repo/api/src/types/evaluation";
import type { Loop } from "@repo/api/src/types/loop";
import type { PromptsSnapshot } from "@repo/api/src/types/prompt";
import { parsePromptsSnapshotFromMarkdownEntries } from "@repo/github/prompt-snapshot-parser";
import { log } from "@repo/observability/log";
import { z } from "zod";
import {
  type IngestionContext,
  ingestRepoExecutionResults,
} from "@/lib/loops/ingest-repo-execution-results";
import { parseJsonArtifact } from "@/lib/loops/loop-document-ingestion";
import {
  downloadArtifactFile,
  downloadPromptSnapshotMarkdownEntries,
} from "@/lib/loops/loop-state";
import { judgesReportSchema } from "../judges-report-schema";
import { defineHandler } from "./loop-command-handler";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed artifacts relevant to the EXECUTE command. */
export type ExecutionArtifacts = {
  executionResult: RepoExecutionResult[] | null;
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
export async function downloadExecutionArtifacts(
  stateKeyPrefix: string,
  loop: Loop
): Promise<ExecutionArtifacts> {
  const [executionResultBuf, codeJudgesReportBuf, promptMarkdownEntries] =
    await Promise.all([
      downloadArtifactFile(stateKeyPrefix, "execution-result.json"),
      downloadArtifactFile(stateKeyPrefix, "code-judges.json"),
      downloadPromptSnapshotMarkdownEntries(stateKeyPrefix),
    ]);

  let executionResult: RepoExecutionResult[] | null = null;

  if (executionResultBuf) {
    let rawData: unknown = null;
    try {
      rawData = JSON.parse(executionResultBuf.toString("utf-8"));
    } catch (err) {
      log.error(
        "[loop-document-ingestion] Malformed execution-result.json — skipping execution ingestion",
        {
          loopId: loop.id,
          error: err instanceof Error ? err.message : String(err),
        }
      );
    }

    if (rawData !== null) {
      const parsed = parseExecutionResultFile(rawData, loop.repo?.fullName);

      if (parsed.ok) {
        executionResult = parsed.results;
        log.info("[loop-document-ingestion] Parsed execution result file", {
          loopId: loop.id,
          schemaVersion: parsed.schemaVersion,
          repoCount: parsed.repoCount,
        });
      } else {
        log.error(
          "[loop-document-ingestion] Failed to parse execution result file",
          {
            loopId: loop.id,
            error: parsed.error,
            schemaVersion: parsed.schemaVersion,
          }
        );
      }
    }
  }

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

  return { executionResult, codeJudgesReport, promptsSnapshot };
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/**
 * Ingest execution artifacts into the platform.
 * Delegates to ingestRepoExecutionResults for all PR creation/dedup logic.
 */
export async function ingestExecutionArtifacts(
  loop: Loop,
  organizationId: string,
  artifacts: ExecutionArtifacts
): Promise<void> {
  if (!artifacts.executionResult) {
    log.info("[loop-document-ingestion] No execution result to ingest", {
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

  const ctx: IngestionContext = {
    organizationId,
    workstreamId: loop.workstreamId,
    documentId: loop.documentId,
    loopId: loop.id,
  };

  await ingestRepoExecutionResults(ctx, artifacts.executionResult, {
    codeJudgesReport: artifacts.codeJudgesReport,
    promptsSnapshot: artifacts.promptsSnapshot,
  });
}

// ---------------------------------------------------------------------------
// Upload-based loading (desktop path)
// ---------------------------------------------------------------------------

// FEAT-55: validate desktop execute uploads with a strict v1/v2 schema union so
// malformed payloads fail the command instead of being silently ignored.
const legacyExecutionUploadSchema = ExecutionResultFileSchema.extend({
  schemaVersion: z.never().optional(),
});

const executionUploadSchema = z.object({
  executionResult: z
    .union([ExecutionResultV2Schema, legacyExecutionUploadSchema])
    .optional(),
  codeJudges: judgesReportSchema.optional(),
});

const legacyV1ExecutionUploadSchema = z
  .object({
    schemaVersion: z.literal(1).optional(),
    base_ref: z.string().optional(),
    base_branch: z.string().optional(),
  })
  .passthrough();

export function executionArtifactsFromUpload(
  uploaded: JsonObject,
  loop: Loop
): ExecutionArtifacts {
  // Apply main's legacy base_ref→base_branch fallback before strict validation
  // so v1 desktop payloads that only carry base_branch still parse.
  const normalizedUploaded =
    uploaded.executionResult === undefined
      ? uploaded
      : {
          ...uploaded,
          executionResult: withLegacyUploadBaseRefFallback(
            uploaded.executionResult
          ),
        };

  const parsed = executionUploadSchema.parse(normalizedUploaded);
  const codeJudgesReport = (parsed.codeJudges as JudgesReport) ?? null;

  let executionResult: RepoExecutionResult[] | null = null;
  if (parsed.executionResult !== undefined) {
    const result = parseExecutionResultFile(
      parsed.executionResult,
      loop.repo?.fullName
    );
    if (result.ok) {
      executionResult = result.results;
    } else {
      log.error(
        "[loop-document-ingestion] Failed to parse execution result from upload",
        {
          loopId: loop.id,
          error: result.error,
          schemaVersion: result.schemaVersion,
          hasFullName: Boolean(loop.repo?.fullName),
        }
      );
    }
  }

  // Prompt snapshots not available in desktop upload path
  const promptsSnapshot: PromptsSnapshot | null = null;

  return { executionResult, codeJudgesReport, promptsSnapshot };
}

function withLegacyUploadBaseRefFallback(executionResult: unknown): unknown {
  const legacyUpload = legacyV1ExecutionUploadSchema.safeParse(executionResult);
  if (!legacyUpload.success || legacyUpload.data.base_ref !== undefined) {
    return executionResult;
  }

  return {
    ...legacyUpload.data,
    base_ref: legacyUpload.data.base_branch || "main",
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const executeHandler = defineHandler<ExecutionArtifacts>({
  requiresRepo: true,
  requiresParent: true,
  includePrimaryArtifact: true,

  downloadArtifacts(stateKeyPrefix: string, loop: Loop) {
    return downloadExecutionArtifacts(stateKeyPrefix, loop);
  },

  downloadFromUpload: executionArtifactsFromUpload,

  async ingest(
    loop: Loop,
    organizationId: string,
    artifacts: ExecutionArtifacts
  ) {
    await ingestExecutionArtifacts(loop, organizationId, artifacts);
  },
});
