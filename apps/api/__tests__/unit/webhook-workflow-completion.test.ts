/**
 * Unit tests for workflow completion handler functions.
 *
 * Tests the following from the commands handler registry:
 * - planSuccessHandler: Processes successful plan/chat/request_changes runs
 * - executeSuccessHandler: Processes successful execute runs (PR creation)
 * - workflowFailureHandler: Processes failed workflow runs
 * - processWorkflowCompletion: Main entry point (integration-level)
 *
 * These are pure unit tests with mocked external dependencies:
 * - @repo/database (Prisma client)
 * - @repo/github (downloadWorkflowArtifacts)
 * - @repo/aws (uploadArtifact, getArtifactUrl)
 * - @repo/observability/log (logging)
 */
import type { WorkflowRunCompletedEvent } from "@octokit/webhooks-types";
import type { JudgesReport } from "@repo/api/src/types/evaluation";
import { ExternalLinkType } from "@repo/api/src/types/external-link";
import { type Mock, vi } from "vitest";
import { buildZipWithEntries } from "../fixtures/zip-helpers";
import {
  asTx,
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "../utils/db-helpers";

// Mock all external dependencies before importing
vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

vi.mock("@repo/github", () => ({
  downloadWorkflowArtifacts: vi.fn(),
}));

vi.mock("@repo/aws", () => ({
  uploadArtifact: vi.fn(),
  getArtifactUrl: vi.fn((key: string) => `https://s3.example.com/${key}`),
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

vi.mock("@/app/artifacts/artifact-version-service", () => ({
  artifactVersionService: {
    createVersion: vi.fn().mockResolvedValue({ id: "version-1", version: 2 }),
  },
}));

// Import after mocking
import { uploadArtifact } from "@repo/aws";
import { downloadWorkflowArtifacts } from "@repo/github";
import { artifactVersionService } from "@/app/artifacts/artifact-version-service";
import { CONTENT_KEYS } from "@/app/webhooks/github/extractors/keys";
import { ZipContentBag } from "@/app/webhooks/github/extractors/types";
import { executeSuccessHandler } from "@/app/webhooks/github/handlers/commands/execute-handler";
import { workflowFailureHandler } from "@/app/webhooks/github/handlers/commands/failure-handler";
import { planSuccessHandler } from "@/app/webhooks/github/handlers/commands/plan-handler";
import { processWorkflowCompletion } from "@/app/webhooks/github/handlers/workflow-completion-handler";
import type { WorkflowContext } from "@/app/webhooks/github/types";
import { findActionRunByCorrelationId } from "@/app/webhooks/github/webhook-service";

// Type aliases for mocked functions
const mockWithDb = getMockWithDb();
const mockDownloadWorkflowArtifacts =
  downloadWorkflowArtifacts as unknown as Mock;
const mockUploadArtifact = uploadArtifact as unknown as Mock;
const mockFindActionRunByCorrelationId =
  findActionRunByCorrelationId as unknown as Mock;
const mockCreateVersion =
  artifactVersionService.createVersion as unknown as Mock;

// ---------------------------------------------------------------------------
// planSuccessHandler
// ---------------------------------------------------------------------------

describe("planSuccessHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates artifact with plan content from bag", async () => {
    const correlationId = "test-correlation-123";
    const artifactId = "artifact-123";
    const workstreamId = "ws-123";
    const runId = 1_234_567_890;

    const ctx: WorkflowContext = {
      correlationId,
      artifactId,
      workstreamId,
      runId,
      htmlUrl: "https://github.com/actions/runs/1234567890",
      conclusion: "success",
      command: "plan",
    };

    const planContent = "# Implementation Plan\n\nThis is the plan content.";
    const bag = new ZipContentBag();
    bag.set(CONTENT_KEYS.planContent, planContent);

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "test-org-id",
        }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: artifactId,
          latestVersion: 1,
          organizationId: "test-org-id",
        }),
        update: vi.fn().mockResolvedValue({
          id: artifactId,
          status: "DRAFT",
        }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-123" }),
      },
    };

    await planSuccessHandler.handle(asTx(mockDb), ctx, bag);

    expect(mockDb.workstream.findUnique).toHaveBeenCalledWith({
      where: { id: workstreamId },
      select: { organizationId: true },
    });
    expect(mockCreateVersion).toHaveBeenCalledWith(
      artifactId,
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
          artifactId,
          runId,
          conclusion: "success",
        }),
      },
    });
  });

  it("persists judges report when available", async () => {
    const correlationId = "test-correlation-789";
    const artifactId = "artifact-789";
    const workstreamId = "ws-789";
    const runId = 1_111_111_111;
    const actionRunId = "action-run-789";

    const ctx: WorkflowContext = {
      correlationId,
      artifactId,
      workstreamId,
      runId,
      actionRunId,
      htmlUrl: "https://github.com/actions/runs/1111111111",
      conclusion: "success",
    };

    const planContent = "# Implementation Plan\n\nWith judges report.";
    const judgesReport: JudgesReport = {
      report_id: "judges-report-789",
      timestamp: "2026-02-06T00:00:00Z",
      stats: [
        {
          type: "case_score",
          case_id: "test-judge",
          final_status: 3,
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

    const bag = new ZipContentBag();
    bag.set(CONTENT_KEYS.planContent, planContent);
    bag.set(CONTENT_KEYS.judgesReport, judgesReport);

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "test-org-id",
        }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: artifactId,
          latestVersion: 1,
          organizationId: "test-org-id",
        }),
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

    await planSuccessHandler.handle(asTx(mockDb), ctx, bag);

    expect(mockDb.workstream.findUnique).toHaveBeenCalledWith({
      where: { id: workstreamId },
      select: { organizationId: true },
    });
    expect(mockDb.artifactEvaluation.upsert).toHaveBeenCalledWith({
      where: {
        artifactId_reportId: {
          artifactId,
          reportId: judgesReport.report_id,
        },
      },
      create: {
        artifactId,
        actionRunId,
        reportId: judgesReport.report_id,
        reportData: judgesReport,
      },
      update: {
        reportData: judgesReport,
      },
    });
  });

  it("throws error when workstream does not exist", async () => {
    const correlationId = "test-correlation-no-workstream";
    const artifactId = "artifact-no-workstream";
    const workstreamId = "ws-no-workstream";
    const runId = 8_888_888_888;

    const ctx: WorkflowContext = {
      correlationId,
      artifactId,
      workstreamId,
      runId,
      htmlUrl: "https://github.com/actions/runs/8888888888",
      conclusion: "success",
    };

    const bag = new ZipContentBag();
    bag.set(CONTENT_KEYS.planContent, "# Plan");

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };

    await expect(
      planSuccessHandler.handle(asTx(mockDb), ctx, bag)
    ).rejects.toThrow(`Workstream ${workstreamId} not found`);
  });

  it("throws error when artifact does not exist", async () => {
    const correlationId = "test-correlation-nonexistent";
    const artifactId = "artifact-nonexistent";
    const workstreamId = "ws-nonexistent";
    const runId = 9_999_999_999;

    const ctx: WorkflowContext = {
      correlationId,
      artifactId,
      workstreamId,
      runId,
      htmlUrl: "https://github.com/actions/runs/9999999999",
      conclusion: "success",
    };

    const bag = new ZipContentBag();
    bag.set(CONTENT_KEYS.planContent, "# Plan");

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

    await expect(
      planSuccessHandler.handle(asTx(mockDb), ctx, bag)
    ).rejects.toThrow(`Artifact ${artifactId} not found in organization`);
  });

  it("persists perf summary when perf.jsonl is present in bag", async () => {
    const correlationId = "test-correlation-perf";
    const artifactId = "artifact-perf";
    const workstreamId = "ws-perf";
    const runId = 5_555_555_000;
    const actionRunId = "action-run-perf";

    const ctx: WorkflowContext = {
      correlationId,
      artifactId,
      workstreamId,
      runId,
      actionRunId,
      htmlUrl: "https://github.com/actions/runs/5555555000",
      conclusion: "success",
    };

    const perfSummary = {
      totalIterations: 1,
      totalDurationS: 42.5,
      agentBreakdown: [],
      pipelineStepBreakdown: [],
    };

    const bag = new ZipContentBag();
    bag.set(CONTENT_KEYS.planContent, "# Plan with perf");
    bag.set(CONTENT_KEYS.perfSummary, perfSummary);

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "test-org-id",
        }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: artifactId,
          latestVersion: 1,
          organizationId: "test-org-id",
        }),
        update: vi.fn().mockResolvedValue({ id: artifactId, status: "DRAFT" }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-perf" }),
      },
      gitHubActionRunPerformance: {
        upsert: vi.fn().mockResolvedValue({ id: "perf-record-1" }),
      },
    };

    await planSuccessHandler.handle(asTx(mockDb), ctx, bag);

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

  it("does not persist perf summary when absent from bag", async () => {
    const correlationId = "test-correlation-no-perf";
    const artifactId = "artifact-no-perf";
    const workstreamId = "ws-no-perf";
    const runId = 5_555_555_001;

    const ctx: WorkflowContext = {
      correlationId,
      artifactId,
      workstreamId,
      runId,
      htmlUrl: "https://github.com/actions/runs/5555555001",
      conclusion: "success",
    };

    const bag = new ZipContentBag();
    bag.set(CONTENT_KEYS.planContent, "# Plan without perf");

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "test-org-id",
        }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: artifactId,
          latestVersion: 1,
          organizationId: "test-org-id",
        }),
        update: vi.fn().mockResolvedValue({ id: artifactId, status: "DRAFT" }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-no-perf" }),
      },
      gitHubActionRunPerformance: {
        upsert: vi.fn(),
      },
    };

    await planSuccessHandler.handle(asTx(mockDb), ctx, bag);

    expect(mockDb.gitHubActionRunPerformance.upsert).not.toHaveBeenCalled();
  });

  it("logs error and returns early when artifactId is missing", async () => {
    const ctx: WorkflowContext = {
      correlationId: "test-correlation-no-artifact",
      artifactId: "",
      workstreamId: "ws-no-artifact",
      runId: 8_888_888_888,
      htmlUrl: "https://github.com/actions/runs/8888888888",
      conclusion: "success",
      command: "plan",
    };

    const bag = new ZipContentBag();
    bag.set(CONTENT_KEYS.planContent, "# Plan");

    const mockTx = {
      workstream: { findUnique: vi.fn() },
      artifact: { findUnique: vi.fn(), update: vi.fn() },
    };

    await planSuccessHandler.handle(asTx(mockTx), ctx, bag);

    // Returns early — no DB calls should be made
    expect(mockTx.workstream.findUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// executeSuccessHandler
// ---------------------------------------------------------------------------

describe("executeSuccessHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates PR record and artifact when execution has changes", async () => {
    const correlationId = "exec-correlation-123";
    const artifactId = "plan-artifact-123";
    const workstreamId = "ws-123";
    const repositoryId = "repo-123";
    const runId = 5_555_555_555;

    const ctx: WorkflowContext = {
      correlationId,
      artifactId,
      workstreamId,
      repositoryId,
      runId,
      htmlUrl: "https://github.com/actions/runs/5555555555",
      conclusion: "success",
      command: "execute",
    };

    const executionResult = {
      has_changes: true,
      pr_url: "https://github.com/owner/repo/pull/42",
      pr_number: "42",
      pr_title: "Symphony: Implement feature",
      branch_name: "symphony/feature-branch",
      base_ref: "main",
      github_id: 123_456_789,
    };

    const bag = new ZipContentBag();
    bag.set(CONTENT_KEYS.executionResult, executionResult);

    const mockTx = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({ organizationId: "org-123" }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: artifactId,
          organizationId: "org-123",
          projectId: "project-123",
          generatedBy: "user-123",
          slug: undefined,
        }),
      },
      gitHubPullRequest: {
        create: vi.fn().mockResolvedValue({
          id: "pr-123",
          number: 42,
        }),
      },
      externalLink: {
        create: vi.fn().mockResolvedValue({ id: "ext-link-123" }),
      },
      entityLink: {
        create: vi.fn().mockResolvedValue({ id: "entity-link-123" }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-exec-123" }),
      },
    };

    mockWithDbTx(mockTx);

    await executeSuccessHandler.handle(asTx({}), ctx, bag);

    expect(mockTx.gitHubPullRequest.create).toHaveBeenCalledWith({
      data: {
        workstreamId,
        organizationId: "org-123",
        repositoryId,
        artifactId: "plan-artifact-123",
        githubId: executionResult.github_id,
        number: 42,
        title: executionResult.pr_title,
        htmlUrl: executionResult.pr_url,
        headBranch: executionResult.branch_name,
        baseBranch: executionResult.base_ref,
        state: "OPEN",
      },
    });

    expect(mockTx.externalLink.create).toHaveBeenCalledWith({
      data: {
        organizationId: "org-123",
        workstreamId,
        projectId: "project-123",
        type: ExternalLinkType.PullRequest,
        title: executionResult.pr_title,
        externalUrl: executionResult.pr_url,
        metadata: {
          number: 42,
          githubId: executionResult.github_id,
          headBranch: executionResult.branch_name,
          baseBranch: executionResult.base_ref,
          state: "OPEN",
        },
      },
    });

    expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith({
      data: {
        workstreamId,
        type: "GITHUB_PR_CREATED",
        actorType: "system",
        data: {
          artifactId: "plan-artifact-123",
          correlationId,
          prNumber: 42,
          prUrl: executionResult.pr_url,
          prTitle: executionResult.pr_title,
          branch: executionResult.branch_name,
          runId,
          slug: undefined,
        },
      },
    });
  });

  it("handles pr_number as string and converts to number", async () => {
    const ctx: WorkflowContext = {
      correlationId: "exec-correlation-456",
      artifactId: "plan-artifact-456",
      workstreamId: "ws-456",
      repositoryId: "repo-456",
      runId: 6_666_666_666,
      htmlUrl: "https://github.com/actions/runs/6666666666",
      conclusion: "success",
    };

    const executionResult = {
      has_changes: true,
      pr_url: "https://github.com/owner/repo/pull/99",
      pr_number: "99", // String from GitHub Actions
      branch_name: "symphony/another-feature",
      base_ref: "develop",
    };

    const bag = new ZipContentBag();
    bag.set(CONTENT_KEYS.executionResult, executionResult);

    const mockTx = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({ organizationId: "org-456" }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: ctx.artifactId,
          organizationId: "org-456",
          projectId: "project-456",
          generatedBy: "user-456",
          slug: undefined,
        }),
      },
      gitHubPullRequest: {
        create: vi.fn().mockResolvedValue({ id: "pr-456" }),
      },
      externalLink: {
        create: vi.fn().mockResolvedValue({ id: "ext-link-456" }),
      },
      entityLink: {
        create: vi.fn().mockResolvedValue({ id: "entity-link-456" }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-exec-456" }),
      },
    };

    mockWithDbTx(mockTx);

    await executeSuccessHandler.handle(asTx({}), ctx, bag);

    expect(mockTx.gitHubPullRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-456",
        number: 99, // Converted to number
        githubId: 99,
      }),
    });
  });

  it("provides default PR title when not in execution result", async () => {
    const ctx: WorkflowContext = {
      correlationId: "exec-correlation-789",
      artifactId: "plan-artifact-789",
      workstreamId: "ws-789",
      repositoryId: "repo-789",
      runId: 7_777_777_777,
      htmlUrl: "https://github.com/actions/runs/7777777777",
      conclusion: "success",
    };

    const executionResult = {
      has_changes: true,
      pr_url: "https://github.com/owner/repo/pull/10",
      pr_number: 10,
      branch_name: "symphony/no-title-feature",
    };

    const bag = new ZipContentBag();
    bag.set(CONTENT_KEYS.executionResult, executionResult);

    const mockTx = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({ organizationId: "org-789" }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: ctx.artifactId,
          organizationId: "org-789",
          projectId: "project-789",
          generatedBy: "user-789",
          slug: undefined,
        }),
      },
      gitHubPullRequest: {
        create: vi.fn().mockResolvedValue({ id: "pr-789" }),
      },
      externalLink: {
        create: vi.fn().mockResolvedValue({ id: "ext-link-789" }),
      },
      entityLink: {
        create: vi.fn().mockResolvedValue({ id: "entity-link-789" }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-exec-789" }),
      },
    };

    mockWithDbTx(mockTx);

    await executeSuccessHandler.handle(asTx({}), ctx, bag);

    expect(mockTx.externalLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: "Symphony: symphony/no-title-feature",
      }),
    });
  });

  it("creates workstream event when execution has no changes", async () => {
    const ctx: WorkflowContext = {
      correlationId: "exec-correlation-no-changes",
      artifactId: "plan-artifact-no-changes",
      workstreamId: "ws-no-changes",
      runId: 4_444_444_444,
      htmlUrl: "https://github.com/actions/runs/4444444444",
      conclusion: "success",
    };

    const executionResult = {
      has_changes: false,
      pr_url: "",
      pr_number: 0,
      branch_name: "symphony/no-changes",
    };

    const bag = new ZipContentBag();
    bag.set(CONTENT_KEYS.executionResult, executionResult);

    const mockDb = {
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-no-changes" }),
      },
    };

    mockWithDbCall(mockDb);

    await executeSuccessHandler.handle(asTx({}), ctx, bag);

    expect(mockDb.workstreamEvent.create).toHaveBeenCalledWith({
      data: {
        workstreamId: ctx.workstreamId,
        type: "GITHUB_ACTION_COMPLETED",
        actorType: "system",
        data: {
          correlationId: ctx.correlationId,
          runId: ctx.runId,
          command: "execute",
          conclusion: "success",
          hasChanges: false,
          message: "Execution completed - no changes to commit",
        },
      },
    });
  });

  it("logs and returns early when execution result is absent from bag", async () => {
    const ctx: WorkflowContext = {
      correlationId: "exec-correlation-empty-bag",
      artifactId: "plan-artifact-empty-bag",
      workstreamId: "ws-empty-bag",
      runId: 3_333_333_333,
      htmlUrl: "https://github.com/actions/runs/3333333333",
      conclusion: "success",
    };

    const bag = new ZipContentBag(); // empty — no executionResult

    await executeSuccessHandler.handle(asTx({}), ctx, bag);

    // Should return early without any DB calls
    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("logs error and returns when repositoryId is missing", async () => {
    const ctx: WorkflowContext = {
      correlationId: "exec-correlation-no-repo",
      artifactId: "plan-artifact-no-repo",
      workstreamId: "ws-no-repo",
      runId: 3_333_333_333,
      htmlUrl: "https://github.com/actions/runs/3333333333",
      conclusion: "success",
    };

    const executionResult = {
      has_changes: true,
      pr_url: "https://github.com/owner/repo/pull/50",
      pr_number: 50,
      branch_name: "symphony/no-repo",
    };

    const bag = new ZipContentBag();
    bag.set(CONTENT_KEYS.executionResult, executionResult);

    await executeSuccessHandler.handle(asTx({}), ctx, bag);

    // Should return early without attempting database operations
    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("throws error when plan artifact is not found", async () => {
    const ctx: WorkflowContext = {
      correlationId: "exec-correlation-bad-artifact",
      artifactId: "nonexistent-artifact",
      workstreamId: "ws-bad-artifact",
      repositoryId: "repo-bad-artifact",
      runId: 2_222_222_222,
      htmlUrl: "https://github.com/actions/runs/2222222222",
      conclusion: "success",
    };

    const executionResult = {
      has_changes: true,
      pr_url: "https://github.com/owner/repo/pull/25",
      pr_number: 25,
      branch_name: "symphony/bad-artifact",
      base_ref: "main",
    };

    const bag = new ZipContentBag();
    bag.set(CONTENT_KEYS.executionResult, executionResult);

    const mockTx = {
      workstream: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ organizationId: "org-bad-artifact" }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };

    mockWithDbTx(mockTx);

    await expect(
      executeSuccessHandler.handle(asTx({}), ctx, bag)
    ).rejects.toThrow(
      `Implementation plan artifact ${ctx.artifactId} not found`
    );
  });
});

// ---------------------------------------------------------------------------
// workflowFailureHandler
// ---------------------------------------------------------------------------

describe("workflowFailureHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates workstream event without modifying artifact content", async () => {
    const correlationId = "fail-correlation-123";
    const artifactId = "artifact-fail-123";
    const workstreamId = "ws-fail-123";
    const runId = 1_010_101_010;
    const htmlUrl = "https://github.com/owner/repo/actions/runs/1010101010";

    const ctx: WorkflowContext = {
      correlationId,
      artifactId,
      workstreamId,
      runId,
      htmlUrl,
      conclusion: "failure",
      command: "plan",
    };

    const mockTx = {
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-fail-123" }),
      },
    };

    await workflowFailureHandler.handle(asTx(mockTx), ctx, new ZipContentBag());

    expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith({
      data: {
        workstreamId,
        type: "GITHUB_ACTION_COMPLETED",
        actorType: "system",
        data: {
          correlationId,
          artifactId,
          runId,
          command: "plan",
          conclusion: "failure",
          htmlUrl,
        },
      },
    });

    // Verify artifact is NOT updated
    expect(mockTx).not.toHaveProperty("artifact");
  });

  it("handles failure without command in context", async () => {
    const correlationId = "fail-correlation-456";
    const artifactId = "artifact-fail-456";
    const workstreamId = "ws-fail-456";
    const runId = 2_020_202_020;
    const htmlUrl = "https://github.com/owner/repo/actions/runs/2020202020";

    const ctx: WorkflowContext = {
      correlationId,
      artifactId,
      workstreamId,
      runId,
      htmlUrl,
      conclusion: "failure",
    };

    const mockTx = {
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-fail-456" }),
      },
    };

    await workflowFailureHandler.handle(asTx(mockTx), ctx, new ZipContentBag());

    expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith({
      data: {
        workstreamId,
        type: "GITHUB_ACTION_COMPLETED",
        actorType: "system",
        data: {
          correlationId,
          artifactId,
          runId,
          command: undefined,
          conclusion: "failure",
          htmlUrl,
        },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// processWorkflowCompletion (integration-level)
// ---------------------------------------------------------------------------

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
        artifactId,
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
    mockUploadArtifact.mockResolvedValue(undefined);

    const event: WorkflowRunCompletedEvent = {
      action: "completed",
      workflow_run: {
        id: runId,
        conclusion: "success",
        html_url: `https://github.com/owner/repo/actions/runs/${runId}`,
      },
    } as WorkflowRunCompletedEvent;

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "test-org-id",
        }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: artifactId,
          latestVersion: 1,
          organizationId: "test-org-id",
        }),
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

    const response = await processWorkflowCompletion(
      event,
      correlationId,
      true
    );

    expect(mockFindActionRunByCorrelationId).toHaveBeenCalledWith(
      correlationId,
      false
    );
    expect(mockDownloadWorkflowArtifacts).toHaveBeenCalledWith(runId);
    expect(mockUploadArtifact).toHaveBeenCalled();
    expect(mockDb.gitHubActionRun.update).toHaveBeenCalledWith({
      where: { id: mockActionRun.id },
      data: {
        runId: BigInt(runId),
        status: "SUCCESS",
        conclusion: "success",
        htmlUrl: event.workflow_run.html_url,
        completedAt: expect.any(Date),
      },
    });

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
        artifactId,
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
    } as WorkflowRunCompletedEvent;

    const mockDb = {
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

    const response = await processWorkflowCompletion(
      event,
      correlationId,
      false
    );

    // Failure handler reads htmlUrl from ctx — no artifact download
    expect(mockDownloadWorkflowArtifacts).not.toHaveBeenCalled();
    expect(mockDb.workstreamEvent.create).toHaveBeenCalledWith({
      data: {
        workstreamId,
        type: "GITHUB_ACTION_COMPLETED",
        actorType: "system",
        data: {
          correlationId,
          artifactId,
          runId,
          command: "plan",
          conclusion: "failure",
          htmlUrl: event.workflow_run.html_url,
        },
      },
    });
    expect(mockDb.gitHubActionRun.update).toHaveBeenCalledWith({
      where: { id: mockActionRun.id },
      data: {
        runId: BigInt(runId),
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
    } as WorkflowRunCompletedEvent;

    const response = await processWorkflowCompletion(
      event,
      correlationId,
      true
    );

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

  it("routes execute command to executeSuccessHandler via registry", async () => {
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
        artifactId,
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
    } as WorkflowRunCompletedEvent;

    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({
          id: workstreamId,
          organizationId: "org-exec",
        }),
      },
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: artifactId,
          organizationId: "org-exec",
          projectId: "project-exec",
          generatedBy: "user-exec",
          slug: undefined,
        }),
      },
      gitHubPullRequest: {
        create: vi.fn().mockResolvedValue({ id: "pr-exec" }),
      },
      externalLink: {
        create: vi.fn().mockResolvedValue({ id: "ext-link-exec" }),
      },
      entityLink: {
        create: vi.fn().mockResolvedValue({ id: "entity-link-exec" }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-exec" }),
      },
      gitHubActionRun: {
        update: vi.fn().mockResolvedValue({
          id: mockActionRun.id,
          status: "SUCCESS",
        }),
      },
    };

    mockWithDbTx(mockDb);

    const response = await processWorkflowCompletion(
      event,
      correlationId,
      true
    );

    expect(mockDb.gitHubPullRequest.create).toHaveBeenCalled();
    expect(mockDb.externalLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: ExternalLinkType.PullRequest,
      }),
    });

    const responseData = await response.json();
    expect(responseData).toEqual({ result: "processed", ok: true });
  });
});
