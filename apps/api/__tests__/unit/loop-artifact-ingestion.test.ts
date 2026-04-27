/**
 * Unit tests for loop artifact ingestion functions.
 *
 * Tests:
 * - ingestPlanArtifacts: fanOutJudgeScores is called when judgesReport is present
 * - ingestPlanArtifacts: reportData dual-write is preserved in the upsert
 * - ingestExecutionArtifacts: fanOutJudgeScores is called when codeJudgesReport is present
 * - ingestExecutionArtifacts: reportData dual-write is preserved in the upsert
 */
import { vi } from "vitest";
import {
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "../utils/db-helpers";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import("../fixtures/mock-modules");
  return createDatabaseMockModule();
});

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import("../fixtures/mock-modules");
  return createLogMockModule();
});

vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: {
    createVersion: vi.fn().mockResolvedValue({ id: "version-1", version: 2 }),
  },
}));

vi.mock("@/app/documents/room-utils", () => ({
  resetDocumentRoom: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/judge-score-fanout", () => ({
  fanOutJudgeScores: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/prompts-service", async () => {
  const { createPromptsServiceMockModule } = await import(
    "../fixtures/mock-modules"
  );
  return createPromptsServiceMockModule();
});

vi.mock("@/lib/loops/loop-document-ingestion", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/loops/loop-document-ingestion")
    >();
  return {
    ...actual,
    parseJsonArtifact: vi.fn(),
  };
});

vi.mock("@/lib/pr-linkage", async () => {
  const { createPrLinkageMockModule } = await import(
    "../fixtures/mock-modules"
  );
  return createPrLinkageMockModule();
});

import { fanOutJudgeScores } from "@/lib/judge-score-fanout";
import type { ExecutionArtifacts } from "@/lib/loops/loop-commands/execute-handler";
import { ingestExecutionArtifacts } from "@/lib/loops/loop-commands/execute-handler";
import type { PlanArtifacts } from "@/lib/loops/loop-commands/plan-handler";
import { ingestPlanArtifacts } from "@/lib/loops/loop-commands/plan-handler";
// Imports after mocks
import {
  makeCodeJudgesReport,
  makeJudgesReport,
} from "../fixtures/ingestion-helpers";
import { buildLoop } from "../fixtures/loop";

const _mockWithDb = getMockWithDb();
const mockFanOutJudgeScores = fanOutJudgeScores as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const JUDGES_REPORT = makeJudgesReport({
  report_id: "report-plan-1",
  timestamp: "2026-02-25T00:00:00Z",
});

const CODE_JUDGES_REPORT = makeCodeJudgesReport({
  timestamp: "2026-02-25T01:00:00Z",
});

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
    executionResult: [
      {
        status: "success",
        fullName: "org/repo",
        prUrl: "https://github.com/org/repo/pull/42",
        prNumber: 42,
        prTitle: "Symphony: feature",
        branchName: "symphony/feature",
        baseBranch: "main",
        hasChanges: true,
        githubId: 999,
        commitSha: "abc123",
      },
    ],
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
          artifactId: loop.documentId,
          reportId: JUDGES_REPORT.report_id,
        }),
      },
      workstreamEvent: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "event-1" }),
      },
    };
    mockWithDbTx(mockTx);

    // withDb (non-transactional) used for artifact.update, entity validation, and workstreamEvent checks
    const mockDb = {
      artifact: {
        update: vi.fn().mockResolvedValue({
          id: loop.documentId,
          organizationId: "org-1",
          slug: "my-artifact",
          subtype: "PRD",
          document: { latestVersion: 2 },
        }),
        findFirst: vi.fn().mockResolvedValue({ id: loop.documentId }),
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
          artifactId: loop.documentId,
          reportId: JUDGES_REPORT.report_id,
        }),
      },
    };
    mockWithDbTx(mockTx);

    const mockDb = {
      artifact: {
        update: vi.fn().mockResolvedValue({
          id: loop.documentId,
          organizationId: "org-1",
          slug: "my-artifact",
          subtype: "PRD",
          document: { latestVersion: 2 },
        }),
        findFirst: vi.fn().mockResolvedValue({ id: loop.documentId }),
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

    // withDb (non-transactional) used for entity validation
    const mockDb = {
      artifact: {
        findFirst: vi.fn().mockResolvedValue({ id: loop.documentId }),
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
          artifactId: loop.documentId,
          reportId: CODE_JUDGES_REPORT.report_id,
        }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-exec-1" }),
      },
    };
    mockWithDbTx(mockTx);

    await ingestExecutionArtifacts(loop, loop.organizationId, artifacts);

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
      artifact: {
        findFirst: vi.fn().mockResolvedValue({ id: loop.documentId }),
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
          artifactId: loop.documentId,
          reportId: CODE_JUDGES_REPORT.report_id,
        }),
      },
      workstreamEvent: {
        create: vi.fn().mockResolvedValue({ id: "event-exec-2" }),
      },
    };
    mockWithDbTx(mockTx);

    await ingestExecutionArtifacts(loop, loop.organizationId, artifacts);

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
