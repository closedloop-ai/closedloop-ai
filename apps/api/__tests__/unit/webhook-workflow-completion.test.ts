/**
 * Unit tests for workflow completion handler functions.
 *
 * Tests the following functions from workflow-completion-handler.ts:
 * - processWorkflowCompletion: Main entry point for workflow_run.completed events
 * - handleWorkflowSuccess: Processes successful workflow runs (plan generation)
 * - handleWorkflowFailure: Processes failed workflow runs
 * - handleExecutionSuccess: Processes successful execution workflows (PR creation)
 *
 * These are pure unit tests with mocked external dependencies:
 * - @repo/database (Prisma client, post-artifact-cutover)
 * - @repo/github (downloadWorkflowArtifacts)
 * - @repo/observability/log (logging)
 */
import type { WorkflowRunCompletedEvent } from "@octokit/webhooks-types";
import type { JudgesReport } from "@repo/api/src/types/evaluation";
import {
  EvalStatus,
  EvaluationReportType,
} from "@repo/api/src/types/evaluation";
import type { TransactionClient } from "@repo/database";
import { type Mock, vi } from "vitest";
import { RAW_V1_EXECUTION_RESULT } from "../../../../packages/loops-api/__tests__/fixtures/execution-result-fixtures";
import { buildZipWithEntries } from "../fixtures/zip-helpers";
import {
  asTx,
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "../utils/db-helpers";

// Mock all external dependencies before importing
vi.mock("@repo/database", () => ({
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    PULL_REQUEST: "PULL_REQUEST",
    DEPLOYMENT: "DEPLOYMENT",
  },
  EvaluationReportType: {
    PLAN: "PLAN",
    CODE: "CODE",
  },
  GitHubPRState: {
    OPEN: "OPEN",
    MERGED: "MERGED",
    CLOSED: "CLOSED",
  },
  PromptType: {
    AGENT: "AGENT",
    JUDGE: "JUDGE",
  },
  withDb: vi.fn(),
}));

vi.mock("@repo/github", () => ({
  downloadWorkflowArtifacts: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/app/webhooks/github/webhook-service", () => ({
  findActionRunByCorrelationId: vi.fn(),
}));

vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: {
    createVersion: vi.fn().mockResolvedValue({ id: "version-1", version: 2 }),
  },
}));

vi.mock("@/lib/artifact-adapters", () => ({
  documentWhere: (where: any) => ({ ...where, type: "DOCUMENT" }),
}));

vi.mock("@/lib/prompts-service", () => ({
  upsertFromSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/judge-score-fanout", () => ({
  fanOutJudgeScores: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@closedloop-ai/loops-api/execution-result", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@closedloop-ai/loops-api/execution-result")
    >();
  return {
    ...actual,
    parseExecutionResultFile: vi.fn(),
  };
});

vi.mock("@/lib/loops/ingest-repo-execution-results", () => ({
  ingestRepoExecutionResults: vi.fn().mockResolvedValue(undefined),
}));

import { parseExecutionResultFile } from "@closedloop-ai/loops-api/execution-result";
import { downloadWorkflowArtifacts } from "@repo/github";
// Import after mocking
import { documentVersionService } from "@/app/documents/document-version-service";
import {
  handleExecutionSuccess,
  handleWorkflowFailure,
  handleWorkflowSuccess,
  processWorkflowCompletion,
} from "@/app/webhooks/github/handlers/workflow-completion-handler";
import type { WorkflowContext } from "@/app/webhooks/github/types";
import { findActionRunByCorrelationId } from "@/app/webhooks/github/webhook-service";
import { fanOutJudgeScores } from "@/lib/judge-score-fanout";
import { ingestRepoExecutionResults } from "@/lib/loops/ingest-repo-execution-results";
import { upsertFromSnapshot } from "@/lib/prompts-service";

// Type aliases for mocked functions
const mockWithDb = getMockWithDb();
const mockDownloadWorkflowArtifacts =
  downloadWorkflowArtifacts as unknown as Mock;
const mockFindActionRunByCorrelationId =
  findActionRunByCorrelationId as unknown as Mock;
const mockCreateVersion =
  documentVersionService.createVersion as unknown as Mock;
const mockUpsertFromSnapshot = upsertFromSnapshot as unknown as Mock;
const mockFanOutJudgeScores = fanOutJudgeScores as unknown as Mock;
const mockParseExecutionResultFile =
  parseExecutionResultFile as unknown as Mock;
const mockIngestRepoExecutionResults =
  ingestRepoExecutionResults as unknown as Mock;

/**
 * Helper to build a plan artifact row as returned by tx.artifact.findUnique
 * with the documentIncludeWithUser-like shape used by handleWorkflowSuccess.
 * The handler reads `existingDocument.document?.latestVersion`, so the
 * relation key is `document` (DocumentDetail), not `documentDetail`.
 */
function makeDocumentArtifactRow(partial: {
  id: string;
  organizationId: string;
  latestVersion?: number;
}) {
  return {
    id: partial.id,
    organizationId: partial.organizationId,
    document: {
      latestVersion: partial.latestVersion ?? 1,
    },
  };
}

const FAILED_TO_PARSE_EXECUTION_RESULT_RE =
  /Failed to parse execution result file/;

describe("handleWorkflowSuccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates artifact with plan content from downloaded artifacts", async () => {
    const correlationId = "test-correlation-123";
    const artifactId = "artifact-123";
    const workstreamId = "ws-123";
    const runId = "1234567890";

    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId,
      documentId: artifactId,
      workstreamId,
      runId,
      command: "plan",
    };

    const planContent = "# Implementation Plan\n\nThis is the plan content.";
    const zipBuffer = buildZipWithEntries([
      {
        name: "plan.json",
        content: JSON.stringify({
          content: planContent,
          acceptanceCriteria: [],
          pendingTasks: [],
          completedTasks: [],
          openQuestions: [],
          answeredQuestions: [],
          gaps: [],
        }),
      },
    ]);

    mockDownloadWorkflowArtifacts.mockResolvedValue([
      { name: "artifact.zip", data: zipBuffer },
    ]);

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "test-org-id",
        }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue(
          makeDocumentArtifactRow({
            id: artifactId,
            organizationId: "test-org-id",
          })
        ),
        update: vi.fn().mockResolvedValue({
          id: artifactId,
          status: "DRAFT",
        }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-123" }),
      },
    };

    await handleWorkflowSuccess(asTx(mockDb), ctx);

    expect(mockDb.workstream.findUnique).toHaveBeenCalledWith({
      where: { id: workstreamId },
      select: { organizationId: true },
    });
    expect(mockDownloadWorkflowArtifacts).toHaveBeenCalledWith(runId);
    expect(mockCreateVersion).toHaveBeenCalledWith(
      artifactId,
      "test-org-id",
      null,
      planContent
    );
    expect(mockDb.artifact.update).toHaveBeenCalledWith({
      where: { id: artifactId, organizationId: "test-org-id" },
      data: {
        status: "DRAFT",
      },
    });
    expect(mockDb.workstreamEvent.create).toHaveBeenCalledWith({
      data: {
        workstreamId,
        type: "GITHUB_ACTION_COMPLETED",
        actorType: "system",
        data: expect.objectContaining({
          correlationId,
          documentId: artifactId,
          runId,
          conclusion: "success",
        }),
      },
    });
  });

  it("extracts plan content without artifacts having been uploaded to S3", async () => {
    const correlationId = "test-correlation-456";
    const artifactId = "artifact-456";
    const workstreamId = "ws-456";
    const runId = "9876543210";

    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId,
      documentId: artifactId,
      workstreamId,
      runId,
    };

    const planContent = "# Implementation Plan\n\nNo S3 upload.";
    const zipBuffer = buildZipWithEntries([
      {
        name: "plan.json",
        content: JSON.stringify({
          content: planContent,
          acceptanceCriteria: [],
          pendingTasks: [],
          completedTasks: [],
          openQuestions: [],
          answeredQuestions: [],
          gaps: [],
        }),
      },
    ]);

    mockDownloadWorkflowArtifacts.mockResolvedValue([
      { name: "artifact.zip", data: zipBuffer },
    ]);

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "test-org-id",
        }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue(
          makeDocumentArtifactRow({
            id: artifactId,
            organizationId: "test-org-id",
          })
        ),
        update: vi.fn().mockResolvedValue({
          id: artifactId,
          status: "DRAFT",
        }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-456" }),
      },
    };

    await handleWorkflowSuccess(asTx(mockDb), ctx);

    expect(mockDb.workstream.findUnique).toHaveBeenCalledWith({
      where: { id: workstreamId },
      select: { organizationId: true },
    });
    expect(mockDownloadWorkflowArtifacts).toHaveBeenCalledWith(runId);
    expect(mockCreateVersion).toHaveBeenCalledWith(
      artifactId,
      "test-org-id",
      null,
      planContent
    );
    expect(mockDb.artifact.update).toHaveBeenCalledWith({
      where: { id: artifactId, organizationId: "test-org-id" },
      data: {
        status: "DRAFT",
      },
    });
  });

  it("persists judges report when available", async () => {
    const correlationId = "test-correlation-789";
    const artifactId = "artifact-789";
    const workstreamId = "ws-789";
    const runId = "1111111111";
    const actionRunId = "action-run-789";

    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId,
      documentId: artifactId,
      workstreamId,
      runId,
      actionRunId,
    };

    const planContent = "# Implementation Plan\n\nWith judges report.";
    const judgesReport: JudgesReport = {
      report_id: "judges-report-789",
      timestamp: "2026-02-06T00:00:00Z",
      stats: [
        {
          type: "case_score",
          case_id: "test-judge",
          final_status: EvalStatus.Passed,
          metrics: [
            {
              metric_name: "test_score",
              threshold: 0.8,
              score: 0.95,
              justification: "Test passed",
            },
          ],
        },
      ],
    };

    const zipBuffer = buildZipWithEntries([
      {
        name: "plan.json",
        content: JSON.stringify({
          content: planContent,
          acceptanceCriteria: [],
          pendingTasks: [],
          completedTasks: [],
          openQuestions: [],
          answeredQuestions: [],
          gaps: [],
        }),
      },
      { name: "judges.json", content: JSON.stringify(judgesReport) },
    ]);

    mockDownloadWorkflowArtifacts.mockResolvedValue([
      { name: "artifact.zip", data: zipBuffer },
    ]);

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "test-org-id",
        }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue(
          makeDocumentArtifactRow({
            id: artifactId,
            organizationId: "test-org-id",
          })
        ),
        update: vi.fn().mockResolvedValue({
          id: artifactId,
          status: "DRAFT",
        }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-789" }),
      },
      artifactEvaluation: {
        upsert: vi.fn().mockResolvedValue({
          id: "eval-789",
          artifactId,
          reportId: judgesReport.report_id,
        }),
      },
    };

    await handleWorkflowSuccess(asTx(mockDb), ctx);

    expect(mockDb.workstream.findUnique).toHaveBeenCalledWith({
      where: { id: workstreamId },
      select: { organizationId: true },
    });
    // Post-cutover: where clause uses artifactId_reportId
    // create block sets artifactId (no more entityId/entityType/documentId split)
    expect(mockDb.artifactEvaluation.upsert).toHaveBeenCalledWith({
      where: {
        artifactId_reportId: {
          artifactId,
          reportId: judgesReport.report_id,
        },
      },
      create: {
        organizationId: "test-org-id",
        artifactId,
        actionRunId,
        reportType: EvaluationReportType.Plan,
        reportId: judgesReport.report_id,
        reportData: judgesReport,
      },
      update: {
        actionRunId,
        reportType: EvaluationReportType.Plan,
        reportData: judgesReport,
      },
    });
  });

  it("throws error when workstream does not exist", async () => {
    const correlationId = "test-correlation-no-workstream";
    const artifactId = "artifact-no-workstream";
    const workstreamId = "ws-no-workstream";
    const runId = "8888888888";

    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId,
      documentId: artifactId,
      workstreamId,
      runId,
    };

    const zipBuffer = buildZipWithEntries([
      {
        name: "plan.json",
        content: JSON.stringify({
          content: "# Plan",
          acceptanceCriteria: [],
          pendingTasks: [],
          completedTasks: [],
          openQuestions: [],
          answeredQuestions: [],
          gaps: [],
        }),
      },
    ]);

    mockDownloadWorkflowArtifacts.mockResolvedValue([
      { name: "artifact.zip", data: zipBuffer },
    ]);

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };

    await expect(handleWorkflowSuccess(asTx(mockDb), ctx)).rejects.toThrow(
      `Workstream ${workstreamId} not found - cannot update artifact`
    );
  });

  it("throws error when artifact does not exist", async () => {
    const correlationId = "test-correlation-nonexistent";
    const artifactId = "artifact-nonexistent";
    const workstreamId = "ws-nonexistent";
    const runId = "9999999999";

    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId,
      documentId: artifactId,
      workstreamId,
      runId,
    };

    const zipBuffer = buildZipWithEntries([
      {
        name: "plan.json",
        content: JSON.stringify({
          content: "# Plan",
          acceptanceCriteria: [],
          pendingTasks: [],
          completedTasks: [],
          openQuestions: [],
          answeredQuestions: [],
          gaps: [],
        }),
      },
    ]);

    mockDownloadWorkflowArtifacts.mockResolvedValue([
      { name: "artifact.zip", data: zipBuffer },
    ]);

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "test-org-id",
        }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };

    await expect(handleWorkflowSuccess(asTx(mockDb), ctx)).rejects.toThrow(
      `Artifact ${artifactId} not found in organization - cannot update with workflow results`
    );
  });

  it("persists perf summary when perf.jsonl is present in zip", async () => {
    const correlationId = "test-correlation-perf";
    const artifactId = "artifact-perf";
    const workstreamId = "ws-perf";
    const runId = "5555555000";
    const actionRunId = "action-run-perf";

    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId,
      documentId: artifactId,
      workstreamId,
      runId,
      actionRunId,
    };

    const planContent = "# Plan with perf";
    const perfLine = JSON.stringify({
      event: "iteration",
      run_id: "run-1",
      iteration: 1,
      duration_s: 42.5,
      status: "success",
      started_at: "2026-01-01T00:00:00Z",
      ended_at: "2026-01-01T00:00:42Z",
      claude_exit_code: 0,
    });

    const zipBuffer = buildZipWithEntries([
      {
        name: "plan.json",
        content: JSON.stringify({
          content: planContent,
          acceptanceCriteria: [],
          pendingTasks: [],
          completedTasks: [],
          openQuestions: [],
          answeredQuestions: [],
          gaps: [],
        }),
      },
      { name: "perf.jsonl", content: perfLine },
    ]);

    mockDownloadWorkflowArtifacts.mockResolvedValue([
      { name: "artifact.zip", data: zipBuffer },
    ]);

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "test-org-id",
        }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue(
          makeDocumentArtifactRow({
            id: artifactId,
            organizationId: "test-org-id",
          })
        ),
        update: vi.fn().mockResolvedValue({ id: artifactId, status: "DRAFT" }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-perf" }),
      },
      gitHubActionRunPerformance: {
        upsert: vi.fn().mockResolvedValue({ id: "perf-record-1" }),
      },
    };

    await handleWorkflowSuccess(asTx(mockDb), ctx);

    expect(mockDb.gitHubActionRunPerformance.upsert).toHaveBeenCalledWith({
      where: {
        artifactId_actionRunId: {
          artifactId,
          actionRunId,
        },
      },
      create: {
        artifactId,
        actionRunId,
        summaryData: expect.objectContaining({ totalIterations: 1 }),
      },
      update: {
        summaryData: expect.objectContaining({ totalIterations: 1 }),
      },
    });
  });

  it("does not persist perf summary when perf.jsonl is absent", async () => {
    const correlationId = "test-correlation-no-perf";
    const artifactId = "artifact-no-perf";
    const workstreamId = "ws-no-perf";
    const runId = "5555555001";

    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId,
      documentId: artifactId,
      workstreamId,
      runId,
    };

    const zipBuffer = buildZipWithEntries([
      {
        name: "plan.json",
        content: JSON.stringify({
          content: "# Plan without perf",
          acceptanceCriteria: [],
          pendingTasks: [],
          completedTasks: [],
          openQuestions: [],
          answeredQuestions: [],
          gaps: [],
        }),
      },
    ]);

    mockDownloadWorkflowArtifacts.mockResolvedValue([
      { name: "artifact.zip", data: zipBuffer },
    ]);

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "test-org-id",
        }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue(
          makeDocumentArtifactRow({
            id: artifactId,
            organizationId: "test-org-id",
          })
        ),
        update: vi.fn().mockResolvedValue({ id: artifactId, status: "DRAFT" }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-no-perf" }),
      },
      gitHubActionRunPerformance: {
        upsert: vi.fn(),
      },
    };

    await handleWorkflowSuccess(asTx(mockDb), ctx);

    expect(mockDb.gitHubActionRunPerformance.upsert).not.toHaveBeenCalled();
  });

  it("logs error when artifactId is missing in context", async () => {
    const correlationId = "test-correlation-no-artifact";
    const workstreamId = "ws-no-artifact";
    const runId = "8888888888";

    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId,
      documentId: "",
      workstreamId,
      runId,
      command: "plan",
    };

    const zipBuffer = buildZipWithEntries([
      {
        name: "plan.json",
        content: JSON.stringify({
          content: "# Plan",
          acceptanceCriteria: [],
          pendingTasks: [],
          completedTasks: [],
          openQuestions: [],
          answeredQuestions: [],
          gaps: [],
        }),
      },
    ]);

    mockDownloadWorkflowArtifacts.mockResolvedValue([
      { name: "artifact.zip", data: zipBuffer },
    ]);

    const mockTx = {
      workstream: { findUnique: vi.fn() },
      artifact: { findUnique: vi.fn(), update: vi.fn() },
    };

    await handleWorkflowSuccess(asTx(mockTx), ctx);

    // Should not throw, but should log error and return early without DB calls
    expect(mockTx.workstream.findUnique).not.toHaveBeenCalled();
  });

  it("calls upsertFromSnapshot with organizationId when agents-snapshot entries are present", async () => {
    const correlationId = "test-correlation-prompts";
    const artifactId = "artifact-prompts";
    const workstreamId = "ws-prompts";
    const runId = "1234000001";

    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId,
      documentId: artifactId,
      workstreamId,
      runId,
      command: "plan",
    };

    const agentFrontmatter = `---
name: my-planner
model: claude-opus-4-6
description: A planning agent
tools: bash, read
---

Plan the work carefully.
`;

    const zipBuffer = buildZipWithEntries([
      {
        name: "plan.json",
        content: JSON.stringify({
          content: "# Plan with snapshot",
          acceptanceCriteria: [],
          pendingTasks: [],
          completedTasks: [],
          openQuestions: [],
          answeredQuestions: [],
          gaps: [],
        }),
      },
      {
        name: "agents-snapshot/my-planner.md",
        content: agentFrontmatter,
      },
    ]);

    mockDownloadWorkflowArtifacts.mockResolvedValue([
      { name: "artifact.zip", data: zipBuffer },
    ]);

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "org-prompts",
        }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue(
          makeDocumentArtifactRow({
            id: artifactId,
            organizationId: "org-prompts",
          })
        ),
        update: vi.fn().mockResolvedValue({ id: artifactId, status: "DRAFT" }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-prompts" }),
      },
    };

    const tx = asTx(mockDb);
    await handleWorkflowSuccess(tx, ctx);

    expect(mockUpsertFromSnapshot).toHaveBeenCalledWith(
      "org-prompts",
      expect.objectContaining({
        prompts: expect.arrayContaining([
          expect.objectContaining({ name: "my-planner" }),
        ]),
      })
    );
  });

  it("calls upsertFromSnapshot with null when no agents-snapshot entries are present", async () => {
    const correlationId = "test-correlation-no-prompts";
    const artifactId = "artifact-no-prompts";
    const workstreamId = "ws-no-prompts";
    const runId = "1234000002";

    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId,
      documentId: artifactId,
      workstreamId,
      runId,
      command: "plan",
    };

    const zipBuffer = buildZipWithEntries([
      {
        name: "plan.json",
        content: JSON.stringify({
          content: "# Plan without snapshot",
          acceptanceCriteria: [],
          pendingTasks: [],
          completedTasks: [],
          openQuestions: [],
          answeredQuestions: [],
          gaps: [],
        }),
      },
    ]);

    mockDownloadWorkflowArtifacts.mockResolvedValue([
      { name: "artifact.zip", data: zipBuffer },
    ]);

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "org-no-prompts",
        }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue(
          makeDocumentArtifactRow({
            id: artifactId,
            organizationId: "org-no-prompts",
          })
        ),
        update: vi.fn().mockResolvedValue({ id: artifactId, status: "DRAFT" }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-no-prompts" }),
      },
    };

    const tx = asTx(mockDb);
    await handleWorkflowSuccess(tx, ctx);

    expect(mockUpsertFromSnapshot).toHaveBeenCalledWith("org-no-prompts", null);
  });
});

describe("handleExecutionSuccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes v1 executionResult with fullName from context", async () => {
    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId: "exec-correlation-123",
      documentId: "plan-artifact-123",
      workstreamId: "ws-123",
      repositoryId: "repo-123",
      runId: "5555555555",
      command: "execute",
      fullName: "owner/repo",
    };

    const rawResult = {
      has_changes: false,
      pr_url: "",
      pr_number: 0,
      branch_name: "",
      base_ref: "",
    };

    mockParseExecutionResultFile.mockReturnValue({
      ok: true,
      results: [
        { status: "skipped", fullName: "owner/repo", reason: "no_changes" },
      ],
      schemaVersion: 1,
      repoCount: 1,
    });

    await handleExecutionSuccess(ctx, rawResult, null, null);

    expect(mockParseExecutionResultFile).toHaveBeenCalledWith(
      rawResult,
      "owner/repo"
    );
    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("logs error and throws when v1 normalization fails", async () => {
    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId: "exec-parse-fail",
      documentId: "plan-artifact-fail",
      workstreamId: "ws-fail",
      runId: "1111111111",
      fullName: "owner/repo",
    };

    mockParseExecutionResultFile.mockReturnValue({
      ok: false,
      error: "Invalid v1 execution result",
      schemaVersion: 1,
    });

    await expect(
      handleExecutionSuccess(ctx, RAW_V1_EXECUTION_RESULT, null, null)
    ).rejects.toThrow(FAILED_TO_PARSE_EXECUTION_RESULT_RE);

    expect(mockIngestRepoExecutionResults).not.toHaveBeenCalled();
    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("calls ingestRepoExecutionResults with IngestionContext built from WorkflowContext", async () => {
    const correlationId = "exec-correlation-ingest";
    const documentId = "plan-artifact-ingest";
    const workstreamId = "ws-ingest";
    const actionRunId = "action-run-ingest";
    const fullName = "owner/repo";

    const ctx: WorkflowContext = {
      organizationId: "org-ingest",
      correlationId,
      documentId,
      workstreamId,
      repositoryId: "repo-ingest",
      runId: "2222222222",
      actionRunId,
      command: "execute",
      fullName,
    };

    const parsedResults = [
      {
        status: "success" as const,
        fullName,
        prUrl: "https://github.com/owner/repo/pull/42",
        prNumber: 42,
        branchName: "symphony/feature",
        baseBranch: "main",
        hasChanges: true,
      },
    ];

    mockParseExecutionResultFile.mockReturnValue({
      ok: true,
      results: parsedResults,
      schemaVersion: 1,
      repoCount: 1,
    });

    const codeJudgesReport: JudgesReport | null = null;
    const promptsSnapshot: null = null;

    await handleExecutionSuccess(
      ctx,
      RAW_V1_EXECUTION_RESULT,
      codeJudgesReport,
      promptsSnapshot
    );

    expect(mockIngestRepoExecutionResults).toHaveBeenCalledWith(
      {
        organizationId: "org-ingest",
        workstreamId,
        documentId,
        correlationId,
        actionRunId,
      },
      parsedResults,
      {
        codeJudgesReport,
        promptsSnapshot,
        tx: undefined,
      }
    );
  });

  it("passes opts.tx to ingestRepoExecutionResults when provided", async () => {
    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId: "exec-tx-test",
      documentId: "plan-tx-test",
      workstreamId: "ws-tx-test",
      runId: "3333333333",
      fullName: "owner/repo",
    };

    mockParseExecutionResultFile.mockReturnValue({
      ok: true,
      results: [],
      schemaVersion: 1,
      repoCount: 0,
    });

    const fakeTx = {} as TransactionClient;
    await handleExecutionSuccess(ctx, RAW_V1_EXECUTION_RESULT, null, null, {
      tx: fakeTx,
    });

    expect(mockIngestRepoExecutionResults).toHaveBeenCalledWith(
      expect.any(Object),
      [],
      expect.objectContaining({ tx: fakeTx })
    );
  });

  it("does not look up workstream when parsing succeeds", async () => {
    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId: "exec-no-workstream-lookup",
      documentId: "plan-no-workstream-lookup",
      workstreamId: "ws-no-lookup",
      runId: "4444444444",
      fullName: "owner/repo",
    };

    mockParseExecutionResultFile.mockReturnValue({
      ok: true,
      results: [],
      schemaVersion: 1,
      repoCount: 0,
    });

    await handleExecutionSuccess(ctx, RAW_V1_EXECUTION_RESULT, null, null);

    expect(mockWithDb).not.toHaveBeenCalled();
    expect(mockIngestRepoExecutionResults).toHaveBeenCalled();
  });
});

describe("handleWorkflowFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates workstream event without modifying artifact content", async () => {
    const correlationId = "fail-correlation-123";
    const artifactId = "artifact-fail-123";
    const workstreamId = "ws-fail-123";
    const runId = "1010101010";
    const htmlUrl = "https://github.com/owner/repo/actions/runs/1010101010";

    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId,
      documentId: artifactId,
      workstreamId,
      runId,
      command: "plan",
    };

    const mockTx = {
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-fail-123" }),
      },
    };

    await handleWorkflowFailure(asTx(mockTx), ctx, htmlUrl);

    expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith({
      data: {
        workstreamId,
        type: "GITHUB_ACTION_COMPLETED",
        actorType: "system",
        data: {
          correlationId,
          documentId: artifactId,
          runId,
          command: "plan",
          conclusion: "failure",
          htmlUrl,
        },
      },
    });

    expect(mockTx).not.toHaveProperty("artifact");
  });

  it("handles failure without command in context", async () => {
    const correlationId = "fail-correlation-456";
    const artifactId = "artifact-fail-456";
    const workstreamId = "ws-fail-456";
    const runId = "2020202020";
    const htmlUrl = "https://github.com/owner/repo/actions/runs/2020202020";

    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId,
      documentId: artifactId,
      workstreamId,
      runId,
    };

    const mockTx = {
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-fail-456" }),
      },
    };

    await handleWorkflowFailure(asTx(mockTx), ctx, htmlUrl);

    expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith({
      data: {
        workstreamId,
        type: "GITHUB_ACTION_COMPLETED",
        actorType: "system",
        data: {
          correlationId,
          documentId: artifactId,
          runId,
          command: undefined,
          conclusion: "failure",
          htmlUrl,
        },
      },
    });
  });
});

describe("handleWorkflowSuccess fan-out", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls fanOutJudgeScores with the evaluationId returned by upsert", async () => {
    const correlationId = "fanout-correlation-plan";
    const artifactId = "fanout-artifact-plan";
    const workstreamId = "fanout-ws-plan";
    const runId = "1234000001";
    const actionRunId = "fanout-action-run-plan";

    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId,
      documentId: artifactId,
      workstreamId,
      runId,
      actionRunId,
    };

    const judgesReport: JudgesReport = {
      report_id: "fanout-report-plan",
      timestamp: "2026-02-06T00:00:00Z",
      stats: [
        {
          type: "case_score",
          case_id: "quality",
          final_status: EvalStatus.Passed,
          metrics: [
            {
              metric_name: "quality_score",
              threshold: 0.8,
              score: 0.9,
              justification: "Looks good",
            },
          ],
        },
      ],
    };

    const zipBuffer = buildZipWithEntries([
      {
        name: "plan.json",
        content: JSON.stringify({
          content: "# Plan",
          acceptanceCriteria: [],
          pendingTasks: [],
          completedTasks: [],
          openQuestions: [],
          answeredQuestions: [],
          gaps: [],
        }),
      },
      { name: "judges.json", content: JSON.stringify(judgesReport) },
    ]);

    mockDownloadWorkflowArtifacts.mockResolvedValue([
      { name: "artifact.zip", data: zipBuffer },
    ]);

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "fanout-org-plan",
        }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue(
          makeDocumentArtifactRow({
            id: artifactId,
            organizationId: "fanout-org-plan",
          })
        ),
        update: vi.fn().mockResolvedValue({ id: artifactId, status: "DRAFT" }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-fanout-plan" }),
      },
      artifactEvaluation: {
        upsert: vi.fn().mockResolvedValue({ id: "eval-123" }),
      },
    };

    await handleWorkflowSuccess(asTx(mockDb), ctx);

    expect(mockDb.artifactEvaluation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          reportData: judgesReport,
        }),
      })
    );

    expect(mockFanOutJudgeScores).toHaveBeenCalledWith({
      evaluationId: "eval-123",
      organizationId: "fanout-org-plan",
      report: judgesReport,
      tx: asTx(mockDb),
    });
  });

  it("writes reportData on PLAN upsert with correct shape", async () => {
    const correlationId = "fanout-correlation-plan-2";
    const artifactId = "fanout-artifact-plan-2";
    const workstreamId = "fanout-ws-plan-2";
    const runId = "1234000002";
    const actionRunId = "fanout-action-run-plan-2";

    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId,
      documentId: artifactId,
      workstreamId,
      runId,
      actionRunId,
    };

    const judgesReport: JudgesReport = {
      report_id: "fanout-report-plan-2",
      timestamp: "2026-02-07T00:00:00Z",
      stats: [
        {
          type: "case_score",
          case_id: "completeness",
          final_status: EvalStatus.Passed,
          metrics: [
            {
              metric_name: "completeness_score",
              threshold: 0.7,
              score: 0.85,
              justification: "Complete",
            },
          ],
        },
      ],
    };

    const zipBuffer = buildZipWithEntries([
      {
        name: "plan.json",
        content: JSON.stringify({
          content: "# Plan content",
          acceptanceCriteria: [],
          pendingTasks: [],
          completedTasks: [],
          openQuestions: [],
          answeredQuestions: [],
          gaps: [],
        }),
      },
      { name: "judges.json", content: JSON.stringify(judgesReport) },
    ]);

    mockDownloadWorkflowArtifacts.mockResolvedValue([
      { name: "artifact.zip", data: zipBuffer },
    ]);

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "fanout-org-plan-2",
        }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue(
          makeDocumentArtifactRow({
            id: artifactId,
            organizationId: "fanout-org-plan-2",
          })
        ),
        update: vi.fn().mockResolvedValue({ id: artifactId, status: "DRAFT" }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-fanout-plan-2" }),
      },
      artifactEvaluation: {
        upsert: vi.fn().mockResolvedValue({ id: "eval-123" }),
      },
    };

    await handleWorkflowSuccess(asTx(mockDb), ctx);

    expect(mockDb.artifactEvaluation.upsert).toHaveBeenCalledWith({
      where: {
        artifactId_reportId: {
          artifactId,
          reportId: judgesReport.report_id,
        },
      },
      create: {
        organizationId: "fanout-org-plan-2",
        artifactId,
        actionRunId,
        reportType: EvaluationReportType.Plan,
        reportId: judgesReport.report_id,
        reportData: judgesReport,
      },
      update: {
        actionRunId,
        reportType: EvaluationReportType.Plan,
        reportData: judgesReport,
      },
    });
  });
});

describe("handleExecutionSuccess — ingestRepoExecutionResults delegation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes codeJudgesReport to ingestRepoExecutionResults", async () => {
    const codeJudgesReport: JudgesReport = {
      report_id: "fanout-report-code",
      timestamp: "2026-02-08T00:00:00Z",
      stats: [
        {
          type: "case_score",
          case_id: "correctness",
          final_status: EvalStatus.Passed,
          metrics: [
            {
              metric_name: "correctness_score",
              threshold: 0.75,
              score: 0.88,
              justification: "Code is correct",
            },
          ],
        },
      ],
    };

    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId: "fanout-exec",
      documentId: "fanout-doc",
      workstreamId: "fanout-ws",
      runId: "2234000001",
      fullName: "owner/repo",
    };

    mockParseExecutionResultFile.mockReturnValue({
      ok: true,
      results: [],
      schemaVersion: 1,
      repoCount: 0,
    });

    await handleExecutionSuccess(
      ctx,
      RAW_V1_EXECUTION_RESULT,
      codeJudgesReport,
      null
    );

    expect(mockIngestRepoExecutionResults).toHaveBeenCalledWith(
      expect.any(Object),
      [],
      expect.objectContaining({ codeJudgesReport })
    );
  });

  it("does not call ingestRepoExecutionResults when v1 normalization fails", async () => {
    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId: "fanout-fail",
      documentId: "fanout-fail-doc",
      workstreamId: "fanout-fail-ws",
      runId: "2234000002",
      fullName: "owner/repo",
    };

    mockParseExecutionResultFile.mockReturnValue({
      ok: false,
      error: "parse failed",
    });

    await expect(
      handleExecutionSuccess(ctx, RAW_V1_EXECUTION_RESULT, null, null)
    ).rejects.toThrow(FAILED_TO_PARSE_EXECUTION_RESULT_RE);

    expect(mockIngestRepoExecutionResults).not.toHaveBeenCalled();
    expect(mockFanOutJudgeScores).not.toHaveBeenCalled();
  });

  it("parses v2 payloads through the shared parser", async () => {
    const v2Results = [
      {
        status: "skipped" as const,
        fullName: "owner/repo",
        reason: "no_changes",
      },
    ];
    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId: "fanout-v2",
      documentId: "fanout-v2-doc",
      workstreamId: "fanout-v2-ws",
      runId: "2234000003",
      fullName: "owner/repo",
    };

    mockParseExecutionResultFile.mockReturnValue({
      ok: true,
      results: v2Results,
      schemaVersion: 2,
      repoCount: v2Results.length,
    });

    await handleExecutionSuccess(
      ctx,
      {
        schemaVersion: 2,
        results: v2Results,
      },
      null,
      null
    );

    expect(mockParseExecutionResultFile).toHaveBeenCalledWith(
      {
        schemaVersion: 2,
        results: v2Results,
      },
      "owner/repo"
    );
    expect(mockIngestRepoExecutionResults).toHaveBeenCalledWith(
      expect.any(Object),
      v2Results,
      expect.objectContaining({ tx: undefined })
    );
  });
});

describe("handleWorkflowSuccess — PLAN upsert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PLAN upsert sets artifactId and organizationId on create", async () => {
    const artifactId = "ss83-artifact-plan";
    const workstreamId = "ss83-ws-plan";
    const actionRunId = "ss83-action-run-plan";
    const runId = "8300001001";

    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId: "ss83-correlation-1",
      documentId: artifactId,
      workstreamId,
      runId,
      actionRunId,
    };

    const judgesReport: JudgesReport = {
      report_id: "ss83-report-1",
      timestamp: "2026-03-24T00:00:00Z",
      stats: [
        {
          type: "case_score",
          case_id: "ss83-case",
          final_status: EvalStatus.Passed,
          metrics: [
            {
              metric_name: "score",
              threshold: 0.8,
              score: 0.95,
              justification: "Good",
            },
          ],
        },
      ],
    };

    const zipBuffer = buildZipWithEntries([
      {
        name: "plan.json",
        content: JSON.stringify({
          content: "# SS8.3 Plan",
          acceptanceCriteria: [],
          pendingTasks: [],
          completedTasks: [],
          openQuestions: [],
          answeredQuestions: [],
          gaps: [],
        }),
      },
      { name: "judges.json", content: JSON.stringify(judgesReport) },
    ]);

    mockDownloadWorkflowArtifacts.mockResolvedValue([
      { name: "artifact.zip", data: zipBuffer },
    ]);

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "ss83-org",
        }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue(
          makeDocumentArtifactRow({
            id: artifactId,
            organizationId: "ss83-org",
          })
        ),
        update: vi.fn().mockResolvedValue({ id: artifactId, status: "DRAFT" }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "ss83-evt" }),
      },
      artifactEvaluation: {
        upsert: vi.fn().mockResolvedValue({ id: "ss83-eval" }),
      },
    };

    await handleWorkflowSuccess(asTx(mockDb), ctx);

    const upsertCall = mockDb.artifactEvaluation.upsert.mock.calls[0][0];
    expect(upsertCall.create).toMatchObject({
      artifactId,
      organizationId: "ss83-org",
    });
  });

  it("PLAN upsert where clause uses artifactId_reportId", async () => {
    const artifactId = "ss83-artifact-plan-2";
    const workstreamId = "ss83-ws-plan-2";
    const actionRunId = "ss83-action-run-plan-2";
    const runId = "8300001002";

    const ctx: WorkflowContext = {
      organizationId: "test-org-id",
      correlationId: "ss83-correlation-2",
      documentId: artifactId,
      workstreamId,
      runId,
      actionRunId,
    };

    const judgesReport: JudgesReport = {
      report_id: "ss83-report-2",
      timestamp: "2026-03-24T00:00:00Z",
      stats: [
        {
          type: "case_score",
          case_id: "ss83-case-2",
          final_status: EvalStatus.Passed,
          metrics: [
            {
              metric_name: "score",
              threshold: 0.8,
              score: 0.9,
              justification: "Good",
            },
          ],
        },
      ],
    };

    const zipBuffer = buildZipWithEntries([
      {
        name: "plan.json",
        content: JSON.stringify({
          content: "# SS8.3 Plan 2",
          acceptanceCriteria: [],
          pendingTasks: [],
          completedTasks: [],
          openQuestions: [],
          answeredQuestions: [],
          gaps: [],
        }),
      },
      { name: "judges.json", content: JSON.stringify(judgesReport) },
    ]);

    mockDownloadWorkflowArtifacts.mockResolvedValue([
      { name: "artifact.zip", data: zipBuffer },
    ]);

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "ss83-org-2",
        }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue(
          makeDocumentArtifactRow({
            id: artifactId,
            organizationId: "ss83-org-2",
          })
        ),
        update: vi.fn().mockResolvedValue({ id: artifactId, status: "DRAFT" }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "ss83-evt-2" }),
      },
      artifactEvaluation: {
        upsert: vi.fn().mockResolvedValue({ id: "ss83-eval-2" }),
      },
    };

    await handleWorkflowSuccess(asTx(mockDb), ctx);

    expect(mockDb.artifactEvaluation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          artifactId_reportId: {
            artifactId,
            reportId: judgesReport.report_id,
          },
        },
      })
    );
  });
});

describe("processWorkflowCompletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes successful workflow and updates artifact", async () => {
    const correlationId = "proc-correlation-123";
    const artifactId = "proc-artifact-123";
    const workstreamId = "proc-ws-123";
    const runId = 9_090_909_090;

    const mockActionRun = {
      id: "action-run-123",
      workstreamId,
      repositoryId: "repo-123",
      triggerData: {
        correlationId,
        documentId: artifactId,
        command: "plan",
      },
    };

    mockFindActionRunByCorrelationId.mockResolvedValue(mockActionRun);

    const planContent = "# Processed Plan Content";
    const zipBuffer = buildZipWithEntries([
      {
        name: "plan.json",
        content: JSON.stringify({
          content: planContent,
          acceptanceCriteria: [],
          pendingTasks: [],
          completedTasks: [],
          openQuestions: [],
          answeredQuestions: [],
          gaps: [],
        }),
      },
    ]);

    mockDownloadWorkflowArtifacts.mockResolvedValue([
      { name: "artifact.zip", data: zipBuffer },
    ]);

    const event: WorkflowRunCompletedEvent = {
      action: "completed",
      workflow_run: {
        id: runId,
        conclusion: "success",
        html_url: `https://github.com/owner/repo/actions/runs/${runId}`,
      },
      repository: { full_name: "owner/repo" },
    } as WorkflowRunCompletedEvent;

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "test-org-id",
        }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue(
          makeDocumentArtifactRow({
            id: artifactId,
            organizationId: "test-org-id",
          })
        ),
        update: vi.fn().mockResolvedValue({
          id: artifactId,
          status: "DRAFT",
        }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-proc-123" }),
      },
      gitHubActionRun: {
        update: vi.fn().mockResolvedValue({
          id: mockActionRun.id,
          status: "SUCCESS",
        }),
      },
    };

    mockWithDbTx(mockDb);
    mockWithDbCall(mockDb);

    const response = await processWorkflowCompletion(event, correlationId);

    expect(mockFindActionRunByCorrelationId).toHaveBeenCalledWith(
      correlationId,
      false
    );
    expect(mockDownloadWorkflowArtifacts).toHaveBeenCalledWith(String(runId));
    expect(mockDb.gitHubActionRun.update).toHaveBeenCalledWith({
      where: { id: mockActionRun.id },
      data: {
        runId: String(runId),
        status: "SUCCESS",
        conclusion: "success",
        htmlUrl: event.workflow_run.html_url,
        completedAt: expect.any(Date),
      },
    });

    expect(mockUpsertFromSnapshot).toHaveBeenCalledWith("test-org-id", null);

    // Call ordering: createVersion must run before gitHubActionRun.update
    expect(mockCreateVersion).toHaveBeenCalledTimes(1);
    expect(mockDb.gitHubActionRun.update).toHaveBeenCalled();
    expect(mockCreateVersion.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.gitHubActionRun.update.mock.invocationCallOrder[0]
    );

    expect(getMockWithDb().tx).toHaveBeenCalledTimes(1);

    const responseData = await response.json();
    expect(responseData).toEqual({ result: "processed", ok: true });
  });

  it("processes failed workflow and creates failure event", async () => {
    const correlationId = "proc-correlation-fail";
    const artifactId = "proc-artifact-fail";
    const workstreamId = "proc-ws-fail";
    const runId = 8_080_808_080;

    const mockActionRun = {
      id: "action-run-fail",
      workstreamId,
      repositoryId: "repo-fail",
      triggerData: {
        correlationId,
        documentId: artifactId,
        command: "plan",
      },
    };

    mockFindActionRunByCorrelationId.mockResolvedValue(mockActionRun);

    const event: WorkflowRunCompletedEvent = {
      action: "completed",
      workflow_run: {
        id: runId,
        conclusion: "failure",
        html_url: `https://github.com/owner/repo/actions/runs/${runId}`,
      },
      repository: { full_name: "owner/repo" },
    } as WorkflowRunCompletedEvent;

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "test-org-id",
        }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-proc-fail" }),
      },
      gitHubActionRun: {
        update: vi.fn().mockResolvedValue({
          id: mockActionRun.id,
          status: "FAILURE",
        }),
      },
    };

    mockWithDbTx(mockDb);
    mockWithDbCall(mockDb);

    const response = await processWorkflowCompletion(event, correlationId);

    expect(mockDb.workstreamEvent.create).toHaveBeenCalledWith({
      data: {
        workstreamId,
        type: "GITHUB_ACTION_COMPLETED",
        actorType: "system",
        data: {
          correlationId,
          documentId: artifactId,
          runId: String(runId),
          command: "plan",
          conclusion: "failure",
          htmlUrl: event.workflow_run.html_url,
        },
      },
    });
    expect(mockDb.gitHubActionRun.update).toHaveBeenCalledWith({
      where: { id: mockActionRun.id },
      data: {
        runId: String(runId),
        status: "FAILURE",
        conclusion: "failure",
        htmlUrl: event.workflow_run.html_url,
        completedAt: expect.any(Date),
      },
    });

    const responseData = await response.json();
    expect(responseData).toEqual({ result: "processed", ok: true });
  });

  it("returns early when no matching action run is found", async () => {
    const correlationId = "proc-correlation-notfound";
    const runId = 7_070_707_070;

    mockFindActionRunByCorrelationId.mockResolvedValue(null);

    const event: WorkflowRunCompletedEvent = {
      action: "completed",
      workflow_run: {
        id: runId,
        conclusion: "success",
        html_url: `https://github.com/owner/repo/actions/runs/${runId}`,
      },
      repository: { full_name: "owner/repo" },
    } as WorkflowRunCompletedEvent;

    const response = await processWorkflowCompletion(event, correlationId);

    expect(mockFindActionRunByCorrelationId).toHaveBeenCalledWith(
      correlationId,
      false
    );
    expect(mockWithDb).not.toHaveBeenCalled();

    const responseData = await response.json();
    expect(responseData).toEqual({
      message: "No matching action run found",
      ok: true,
    });
  });

  it("delegates v1 execute payloads through normalization", async () => {
    const correlationId = "proc-correlation-exec";
    const artifactId = "proc-artifact-exec";
    const workstreamId = "proc-ws-exec";
    const repositoryId = "proc-repo-exec";
    const runId = 6_060_606_060;

    const mockActionRun = {
      id: "action-run-exec",
      workstreamId,
      repositoryId,
      triggerData: {
        correlationId,
        documentId: artifactId,
        command: "execute",
      },
    };

    mockFindActionRunByCorrelationId.mockResolvedValue(mockActionRun);

    const executionResult = {
      has_changes: true,
      pr_url: "https://github.com/owner/repo/pull/75",
      pr_number: "75",
      branch_name: "symphony/exec-feature",
      base_ref: "main",
    };

    const zipBuffer = buildZipWithEntries([
      {
        name: "execution-result.json",
        content: JSON.stringify(executionResult),
      },
    ]);

    mockDownloadWorkflowArtifacts.mockResolvedValue([
      { name: "artifact.zip", data: zipBuffer },
    ]);

    const event: WorkflowRunCompletedEvent = {
      action: "completed",
      workflow_run: {
        id: runId,
        conclusion: "success",
        html_url: `https://github.com/owner/repo/actions/runs/${runId}`,
      },
      repository: {
        full_name: "owner/repo",
      },
    } as WorkflowRunCompletedEvent;

    mockParseExecutionResultFile.mockReturnValue({
      ok: true,
      results: [],
      schemaVersion: 1,
      repoCount: 0,
    });

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "org-exec",
        }),
      },
      gitHubActionRun: {
        update: vi.fn().mockResolvedValue({
          id: mockActionRun.id,
          status: "SUCCESS",
        }),
      },
    };

    mockWithDbTx(mockDb);
    // mockWithDb (non-tx) resolves WorkflowContext.organizationId and updates the action run.
    mockWithDbCall(mockDb);

    const response = await processWorkflowCompletion(event, correlationId);

    expect(mockParseExecutionResultFile).toHaveBeenCalledWith(
      expect.any(Object),
      "owner/repo"
    );
    expect(mockIngestRepoExecutionResults).toHaveBeenCalled();

    const responseData = await response.json();
    expect(responseData).toEqual({ result: "processed", ok: true });
  });

  it("marks execute workflows successful even when execution-result.json is missing", async () => {
    const correlationId = "proc-correlation-exec-missing-result";
    const artifactId = "proc-artifact-exec-missing-result";
    const workstreamId = "proc-ws-exec-missing-result";
    const repositoryId = "proc-repo-exec-missing-result";
    const runId = 6_160_606_060;

    const mockActionRun = {
      id: "action-run-exec-missing-result",
      workstreamId,
      repositoryId,
      triggerData: {
        correlationId,
        documentId: artifactId,
        command: "execute",
      },
    };

    mockFindActionRunByCorrelationId.mockResolvedValue(mockActionRun);

    const zipBuffer = buildZipWithEntries([
      {
        name: "plan.json",
        content: JSON.stringify({
          content: "# Not used for execute",
          acceptanceCriteria: [],
          pendingTasks: [],
          completedTasks: [],
          openQuestions: [],
          answeredQuestions: [],
          gaps: [],
        }),
      },
    ]);

    mockDownloadWorkflowArtifacts.mockResolvedValue([
      { name: "artifact.zip", data: zipBuffer },
    ]);

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "org-exec-missing-result",
        }),
      },
      gitHubActionRun: {
        update: vi.fn().mockResolvedValue({
          id: mockActionRun.id,
          status: "SUCCESS",
        }),
      },
    };

    mockWithDbCall(mockDb);

    const event: WorkflowRunCompletedEvent = {
      action: "completed",
      workflow_run: {
        id: runId,
        conclusion: "success",
        html_url: `https://github.com/owner/repo/actions/runs/${runId}`,
      },
      repository: {
        full_name: "owner/repo",
      },
    } as WorkflowRunCompletedEvent;

    const response = await processWorkflowCompletion(event, correlationId);

    expect(mockParseExecutionResultFile).not.toHaveBeenCalled();
    expect(mockIngestRepoExecutionResults).not.toHaveBeenCalled();
    expect(mockDb.gitHubActionRun.update).toHaveBeenCalledWith({
      where: { id: mockActionRun.id },
      data: {
        runId: String(runId),
        status: "SUCCESS",
        conclusion: "success",
        htmlUrl: event.workflow_run.html_url,
        completedAt: expect.any(Date),
      },
    });
    expect(getMockWithDb().tx).not.toHaveBeenCalled();

    const responseData = await response.json();
    expect(responseData).toEqual({ result: "processed", ok: true });
  });

  it("updates action run to FAILURE when execute success ingestion throws", async () => {
    const correlationId = "proc-correlation-exec-parse-fail";
    const artifactId = "proc-artifact-exec-parse-fail";
    const workstreamId = "proc-ws-exec-parse-fail";
    const repositoryId = "proc-repo-exec-parse-fail";
    const runId = 6_260_606_060;

    const mockActionRun = {
      id: "action-run-exec-parse-fail",
      workstreamId,
      repositoryId,
      triggerData: {
        correlationId,
        documentId: artifactId,
        command: "execute",
      },
    };

    mockFindActionRunByCorrelationId.mockResolvedValue(mockActionRun);

    const zipBuffer = buildZipWithEntries([
      {
        name: "execution-result.json",
        content: JSON.stringify({
          has_changes: true,
          pr_url: "https://github.com/owner/repo/pull/88",
          pr_number: 88,
          branch_name: "symphony/parse-fail",
          base_ref: "main",
        }),
      },
    ]);
    mockDownloadWorkflowArtifacts.mockResolvedValue([
      { name: "artifact.zip", data: zipBuffer },
    ]);

    mockParseExecutionResultFile.mockReturnValue({
      ok: false,
      error: "Invalid execution payload",
      schemaVersion: 1,
    });

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "org-exec-parse-fail",
        }),
      },
      gitHubActionRun: {
        update: vi.fn().mockResolvedValue({
          id: mockActionRun.id,
          status: "FAILURE",
        }),
      },
    };
    mockWithDbCall(mockDb);

    const event: WorkflowRunCompletedEvent = {
      action: "completed",
      workflow_run: {
        id: runId,
        conclusion: "success",
        html_url: `https://github.com/owner/repo/actions/runs/${runId}`,
      },
      repository: { full_name: "owner/repo" },
    } as WorkflowRunCompletedEvent;

    await expect(
      processWorkflowCompletion(event, correlationId)
    ).rejects.toThrow(FAILED_TO_PARSE_EXECUTION_RESULT_RE);

    expect(mockDb.gitHubActionRun.update).toHaveBeenCalledWith({
      where: { id: mockActionRun.id },
      data: {
        runId: String(runId),
        status: "FAILURE",
        conclusion: "success",
        htmlUrl: event.workflow_run.html_url,
        completedAt: expect.any(Date),
      },
    });
    expect(getMockWithDb().tx).not.toHaveBeenCalled();
  });
});
