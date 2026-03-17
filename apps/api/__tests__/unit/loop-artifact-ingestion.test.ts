/**
 * Unit tests for loop artifact ingestion functions.
 *
 * Tests:
 * - ingestPlanArtifacts: fanOutJudgeScores is called when judgesReport is present
 * - ingestPlanArtifacts: reportData dual-write is preserved in the upsert
 * - ingestExecutionArtifacts: fanOutJudgeScores is called when codeJudgesReport is present
 * - ingestExecutionArtifacts: reportData dual-write is preserved in the upsert
 */
import { EvalStatus, type JudgesReport } from "@repo/api/src/types/evaluation";
import { vi } from "vitest";
import {
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  EvaluationReportType: {
    PLAN: "PLAN",
    CODE: "CODE",
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/app/artifacts/artifact-version-service", () => ({
  artifactVersionService: {
    createVersion: vi.fn().mockResolvedValue({ id: "version-1", version: 2 }),
  },
}));

vi.mock("@/app/artifacts/room-utils", () => ({
  resetArtifactRoom: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/judge-score-fanout", () => ({
  fanOutJudgeScores: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/prompts-service", () => ({
  upsertFromSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/loops/loop-artifact-ingestion", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/loops/loop-artifact-ingestion")
    >();
  return {
    ...actual,
    parseJsonArtifact: vi.fn(),
  };
});

import { fanOutJudgeScores } from "@/lib/judge-score-fanout";
import type { ExecutionArtifacts } from "@/lib/loops/loop-commands/execute-handler";
import { ingestExecutionArtifacts } from "@/lib/loops/loop-commands/execute-handler";
import type { PlanArtifacts } from "@/lib/loops/loop-commands/plan-handler";
import { ingestPlanArtifacts } from "@/lib/loops/loop-commands/plan-handler";
// Imports after mocks
import { buildLoop } from "../fixtures/loop";

const _mockWithDb = getMockWithDb();
const mockFanOutJudgeScores = fanOutJudgeScores as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const JUDGES_REPORT: JudgesReport = {
  report_id: "report-plan-1",
  timestamp: "2026-02-25T00:00:00Z",
  stats: [
    {
      type: "case_score",
      case_id: "clarity-judge",
      final_status: EvalStatus.Passed,
      metrics: [
        {
          metric_name: "clarity",
          threshold: 0.8,
          score: 0.92,
          justification: "Clear and concise.",
        },
      ],
    },
  ],
};

const CODE_JUDGES_REPORT: JudgesReport = {
  report_id: "report-code-1",
  timestamp: "2026-02-25T01:00:00Z",
  stats: [
    {
      type: "case_score",
      case_id: "security-judge",
      final_status: EvalStatus.Passed,
      metrics: [
        {
          metric_name: "security",
          threshold: 0.9,
          score: 0.95,
          justification: "No vulnerabilities found.",
        },
      ],
    },
  ],
};

function buildPlanArtifacts(
  overrides: Partial<PlanArtifacts> = {}
): PlanArtifacts {
  return {
    planContent: "# Plan content",
    questionsContent: null,
    judgesReport: null,
    promptsSnapshot: null,
    ...overrides,
  };
}

function buildExecutionArtifacts(
  overrides: Partial<ExecutionArtifacts> = {}
): ExecutionArtifacts {
  return {
    executionResult: {
      has_changes: true,
      pr_url: "https://github.com/org/repo/pull/42",
      pr_number: 42,
      pr_title: "Symphony: feature",
      branch_name: "symphony/feature",
      base_branch: "main",
      base_ref: "main",
      github_id: 999,
      commit_sha: "abc123",
    },
    codeJudgesReport: null,
    promptsSnapshot: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ingestPlanArtifacts
// ---------------------------------------------------------------------------

describe("ingestPlanArtifacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls fanOutJudgeScores when judgesReport is present", async () => {
    const loop = buildLoop();
    const artifacts = buildPlanArtifacts({ judgesReport: JUDGES_REPORT });
    const evaluationId = "eval-plan-1";

    // withDb.tx callback receives a mock tx; upsert returns an evaluation row
    const mockTx = {
      artifactEvaluation: {
        upsert: vi.fn().mockResolvedValue({
          id: evaluationId,
          artifactId: loop.artifactId,
          reportId: JUDGES_REPORT.report_id,
        }),
      },
      workstreamEvent: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "event-1" }),
      },
    };
    mockWithDbTx(mockTx);

    // withDb (non-transactional) used for artifact.update and workstreamEvent checks
    const mockDb = {
      artifact: {
        update: vi
          .fn()
          .mockResolvedValue({ slug: "my-artifact", latestVersion: 2 }),
      },
      workstreamEvent: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "event-1" }),
      },
    };
    mockWithDbCall(mockDb);

    await ingestPlanArtifacts(loop, "org-1", artifacts);

    expect(mockFanOutJudgeScores).toHaveBeenCalledWith({
      evaluationId,
      organizationId: "org-1",
      report: JUDGES_REPORT,
      tx: mockTx,
    });
  });

  it("writes reportData in the upsert (dual-write preserved)", async () => {
    const loop = buildLoop();
    const artifacts = buildPlanArtifacts({ judgesReport: JUDGES_REPORT });

    const mockTx = {
      artifactEvaluation: {
        upsert: vi.fn().mockResolvedValue({
          id: "eval-plan-2",
          artifactId: loop.artifactId,
          reportId: JUDGES_REPORT.report_id,
        }),
      },
    };
    mockWithDbTx(mockTx);

    const mockDb = {
      artifact: {
        update: vi
          .fn()
          .mockResolvedValue({ slug: "my-artifact", latestVersion: 2 }),
      },
      workstreamEvent: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "event-2" }),
      },
    };
    mockWithDbCall(mockDb);

    await ingestPlanArtifacts(loop, "org-1", artifacts);

    expect(mockTx.artifactEvaluation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          reportData: JUDGES_REPORT,
        }),
        update: expect.objectContaining({
          reportData: JUDGES_REPORT,
        }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// ingestExecutionArtifacts
// ---------------------------------------------------------------------------

describe("ingestExecutionArtifacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls fanOutJudgeScores when codeJudgesReport is present", async () => {
    const loop = buildLoop({ command: "EXECUTE" });
    const artifacts = buildExecutionArtifacts({
      codeJudgesReport: CODE_JUDGES_REPORT,
    });
    const evaluationId = "eval-code-1";

    // withDb (non-transactional) used for gitHubInstallationRepository.findFirst
    const mockDb = {
      gitHubInstallationRepository: {
        findFirst: vi.fn().mockResolvedValue({ id: "install-repo-1" }),
      },
    };
    mockWithDbCall(mockDb);

    // withDb.tx callback receives a mock tx
    const mockTx = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          organizationId: "org-1",
          projectId: "project-1",
          slug: "my-artifact",
        }),
      },
      artifactEvaluation: {
        upsert: vi.fn().mockResolvedValue({
          id: evaluationId,
          artifactId: loop.artifactId,
          reportId: CODE_JUDGES_REPORT.report_id,
        }),
      },
      gitHubPullRequest: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "pr-1" }),
      },
      externalLink: {
        create: vi.fn().mockResolvedValue({ id: "ext-link-1" }),
      },
      entityLink: {
        create: vi.fn().mockResolvedValue({ id: "entity-link-1" }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-exec-1" }),
      },
    };
    mockWithDbTx(mockTx);

    await ingestExecutionArtifacts(loop, artifacts);

    expect(mockFanOutJudgeScores).toHaveBeenCalledWith({
      evaluationId,
      organizationId: "org-1",
      report: CODE_JUDGES_REPORT,
      tx: mockTx,
    });
  });

  it("writes reportData in the upsert (dual-write preserved)", async () => {
    const loop = buildLoop({ command: "EXECUTE" });
    const artifacts = buildExecutionArtifacts({
      codeJudgesReport: CODE_JUDGES_REPORT,
    });

    const mockDb = {
      gitHubInstallationRepository: {
        findFirst: vi.fn().mockResolvedValue({ id: "install-repo-2" }),
      },
    };
    mockWithDbCall(mockDb);

    const mockTx = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          organizationId: "org-1",
          projectId: "project-1",
          slug: "my-artifact",
        }),
      },
      artifactEvaluation: {
        upsert: vi.fn().mockResolvedValue({
          id: "eval-code-2",
          artifactId: loop.artifactId,
          reportId: CODE_JUDGES_REPORT.report_id,
        }),
      },
      gitHubPullRequest: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "pr-2" }),
      },
      externalLink: {
        create: vi.fn().mockResolvedValue({ id: "ext-link-2" }),
      },
      entityLink: {
        create: vi.fn().mockResolvedValue({ id: "entity-link-2" }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-exec-2" }),
      },
    };
    mockWithDbTx(mockTx);

    await ingestExecutionArtifacts(loop, artifacts);

    expect(mockTx.artifactEvaluation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          reportData: CODE_JUDGES_REPORT,
        }),
        update: expect.objectContaining({
          reportData: CODE_JUDGES_REPORT,
        }),
      })
    );
  });
});
