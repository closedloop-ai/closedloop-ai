/**
 * Shared test factory for EVALUATE_* command handler tests.
 *
 * All three evaluation handlers (PRD, PLAN, CODE) share identical behavior
 * via createEvaluationHandler. This factory produces the full test suite
 * parameterized by { handler, reportType, documentId, fileName, reportId, command }.
 *
 * Usage (in each test file, after vi.mock() declarations):
 *
 *   import { registerEvaluationHandlerTests } from "../utils/evaluation-handler-test-factory";
 *   registerEvaluationHandlerTests({ handler: evaluatePrdHandler, ... });
 */

import type {
  EvaluationReportType as EvaluationReportTypeValue,
  JudgesReport,
} from "@repo/api/src/types/evaluation";
import type { Loop, LoopCommand } from "@repo/api/src/types/loop";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseJsonArtifact,
  upsertEvaluationWithJudgeScores,
} from "@/lib/loops/loop-document-ingestion";
import { downloadArtifactFile } from "@/lib/loops/loop-state";
import { buildCaseScore } from "../fixtures/evaluation";
import { buildLoop } from "../fixtures/loop";
import { mockWithDbTx } from "../utils/db-helpers";

type MockFn = ReturnType<typeof vi.fn>;

type EvaluationHandlerTestConfig = {
  handler: {
    downloadAndIngest: (
      s3Key: string,
      loop: Loop,
      orgId: string
    ) => Promise<void>;
  };
  /** Persisted discriminator — use e.g. `EvaluationReportType.Prd`. */
  reportType: EvaluationReportTypeValue;
  documentId: string;
  fileName: string;
  reportId: string;
  judgeName: string;
  judgeScore: number;
  command: (typeof LoopCommand)[keyof typeof LoopCommand];
  s3StateKey: string;
};

function setupMocks() {
  const mockDownloadArtifactFile = downloadArtifactFile as MockFn;
  const mockParseJsonArtifact = parseJsonArtifact as MockFn;
  const mockUpsertEvaluationWithJudgeScores =
    upsertEvaluationWithJudgeScores as MockFn;
  return {
    mockDownloadArtifactFile,
    mockParseJsonArtifact,
    mockUpsertEvaluationWithJudgeScores,
  };
}

function setupDownload(
  report: JudgesReport | null,
  mocks: ReturnType<typeof setupMocks>
) {
  mocks.mockDownloadArtifactFile.mockResolvedValue(
    report ? Buffer.from(JSON.stringify(report)) : null
  );
  mocks.mockParseJsonArtifact.mockReturnValue(report);
}

function setupMockTx(extra: Record<string, unknown> = {}) {
  const mockTx = {
    artifactEvaluation: { upsert: vi.fn() },
    ...extra,
  };
  mockWithDbTx(mockTx);
  return mockTx;
}

export function registerEvaluationHandlerTests(
  config: EvaluationHandlerTestConfig
) {
  const {
    handler,
    reportType,
    documentId,
    fileName,
    reportId,
    judgeName,
    judgeScore,
    command,
    s3StateKey,
  } = config;

  const report: JudgesReport = {
    report_id: reportId,
    timestamp: "2026-03-17T00:00:00Z",
    stats: [buildCaseScore(judgeName, judgeScore)],
  };

  function buildTestLoop(overrides: Record<string, unknown> = {}) {
    return buildLoop({
      command,
      s3StateKey,
      documentId,
      ...overrides,
    });
  }

  describe(`${reportType} evaluation handler downloadAndIngest`, () => {
    const mocks = setupMocks();

    beforeEach(() => {
      vi.clearAllMocks();
      mocks.mockUpsertEvaluationWithJudgeScores.mockResolvedValue(undefined);
    });

    it("calls upsertEvaluationWithJudgeScores with correct report type and identifiers", async () => {
      const loop = buildTestLoop();
      setupMockTx();
      setupDownload(report, mocks);

      await handler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

      expect(mocks.mockUpsertEvaluationWithJudgeScores).toHaveBeenCalledOnce();
      expect(mocks.mockUpsertEvaluationWithJudgeScores).toHaveBeenCalledWith(
        expect.objectContaining({
          artifactId: documentId,
          loopId: loop.id,
          organizationId: "org-1",
          reportType,
          report: expect.objectContaining({ report_id: reportId }),
        })
      );
    });

    it(`downloads ${fileName} from the state key prefix`, async () => {
      const loop = buildTestLoop();
      setupMockTx();
      setupDownload(report, mocks);

      await handler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

      expect(mocks.mockDownloadArtifactFile).toHaveBeenCalledWith(
        loop.s3StateKey,
        fileName
      );
    });

    it("does not call upsertEvaluationWithJudgeScores when loop.documentId is null", async () => {
      const loop = buildTestLoop({ documentId: null });
      setupMockTx();
      setupDownload(report, mocks);

      await handler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

      expect(mocks.mockUpsertEvaluationWithJudgeScores).not.toHaveBeenCalled();
    });

    it(`does not call upsertEvaluationWithJudgeScores when ${fileName} is absent (null buffer)`, async () => {
      const loop = buildTestLoop();
      setupMockTx();
      setupDownload(null, mocks);

      await handler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

      expect(mocks.mockUpsertEvaluationWithJudgeScores).not.toHaveBeenCalled();
    });

    it(`does not call upsertEvaluationWithJudgeScores when ${fileName} is unparseable`, async () => {
      const loop = buildTestLoop();
      setupMockTx();

      mocks.mockDownloadArtifactFile.mockResolvedValue(
        Buffer.from("not-valid-json{{{{")
      );
      mocks.mockParseJsonArtifact.mockReturnValue(null);

      await handler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

      expect(mocks.mockUpsertEvaluationWithJudgeScores).not.toHaveBeenCalled();
    });

    it("skips ingestion when artifact.latestVersion is greater than loop.documentVersion", async () => {
      const loop = buildTestLoop({ documentVersion: 1 });
      setupDownload(report, mocks);
      setupMockTx({
        artifact: {
          findUnique: vi.fn().mockResolvedValue({
            document: { latestVersion: 2 },
          }),
        },
      });

      await handler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

      expect(mocks.mockUpsertEvaluationWithJudgeScores).not.toHaveBeenCalled();
    });

    it("proceeds with ingestion when artifact.latestVersion equals loop.documentVersion", async () => {
      const loop = buildTestLoop({ documentVersion: 2 });
      setupDownload(report, mocks);
      setupMockTx({
        artifact: {
          findUnique: vi.fn().mockResolvedValue({
            document: { latestVersion: 2 },
          }),
        },
      });

      await handler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

      expect(mocks.mockUpsertEvaluationWithJudgeScores).toHaveBeenCalledOnce();
    });

    it("proceeds with ingestion when loop.documentVersion is null (backwards compat — no version check)", async () => {
      const loop = buildTestLoop({ documentVersion: null });
      setupDownload(report, mocks);
      setupMockTx();

      await handler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

      expect(mocks.mockUpsertEvaluationWithJudgeScores).toHaveBeenCalledOnce();
    });

    it("proceeds with ingestion when artifact is not found during version check (best effort)", async () => {
      const loop = buildTestLoop({ documentVersion: 1 });
      setupDownload(report, mocks);
      setupMockTx({
        artifact: { findUnique: vi.fn().mockResolvedValue(null) },
      });

      await handler.downloadAndIngest(loop.s3StateKey!, loop, "org-1");

      expect(mocks.mockUpsertEvaluationWithJudgeScores).toHaveBeenCalledOnce();
    });
  });
}
