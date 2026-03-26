/**
 * Unit tests for the EVALUATE_CODE command handler.
 *
 * Tests the ingestion logic: upserting ArtifactEvaluation with CODE report type,
 * fanning out judge scores, and guard clauses for missing artifactId or report.
 */
import { vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@repo/database", () => ({
  EvaluationReportType: {
    CODE: "CODE",
  },
  EntityType: {
    ARTIFACT: "ARTIFACT",
    FEATURE: "FEATURE",
    EXTERNAL_LINK: "EXTERNAL_LINK",
  },
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/loops/loop-artifact-ingestion", () => ({
  parseJsonArtifact: vi.fn(),
  upsertEvaluationWithJudgeScores: vi.fn(),
}));

vi.mock("@/lib/loops/loop-state", () => ({
  downloadArtifactFile: vi.fn(),
}));

vi.mock("@/lib/judge-score-fanout", () => ({
  fanOutJudgeScores: vi.fn().mockResolvedValue(undefined),
}));

// --- Imports (after mocks) ---

import type { JudgesReport } from "@repo/api/src/types/evaluation";
import { LoopCommand } from "@repo/api/src/types/loop";
import {
  EntityType,
  EvaluationReportType as PrismaEvaluationReportType,
} from "@repo/database";
import { beforeEach, describe, expect, it } from "vitest";
import {
  parseJsonArtifact,
  upsertEvaluationWithJudgeScores,
} from "@/lib/loops/loop-artifact-ingestion";
import { evaluateCodeHandler } from "@/lib/loops/loop-commands/evaluate-code-handler";
import { downloadArtifactFile } from "@/lib/loops/loop-state";
import { buildCaseScore } from "../fixtures/evaluation";
import { buildLoop } from "../fixtures/loop";
import { mockWithDbTx } from "../utils/db-helpers";

type MockFn = ReturnType<typeof vi.fn>;

const mockDownloadArtifactFile = downloadArtifactFile as MockFn;
const mockParseJsonArtifact = parseJsonArtifact as MockFn;
const mockUpsertEvaluationWithJudgeScores =
  upsertEvaluationWithJudgeScores as MockFn;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CODE_REPORT: JudgesReport = {
  report_id: "code-report-1",
  timestamp: "2026-03-17T00:00:00Z",
  stats: [buildCaseScore("correctness-judge", 0.92)],
};

function buildEvaluateCodeLoop(overrides: Record<string, unknown> = {}) {
  return buildLoop({
    command: LoopCommand.EvaluateCode,
    s3StateKey: "org/loops/loop-code/run-1",
    artifactId: "code-artifact-1",
    ...overrides,
  });
}

/**
 * Configure download mocks so the handler sees a valid report.
 * Mirrors the setupDownload helper pattern from evaluate-prd-handler.test.ts.
 */
function setupDownload(report: JudgesReport | null) {
  mockDownloadArtifactFile.mockResolvedValue(
    report ? Buffer.from(JSON.stringify(report)) : null
  );
  mockParseJsonArtifact.mockReturnValue(report);
}

function setupMockTx(extra: Record<string, unknown> = {}) {
  const mockTx = {
    artifactEvaluation: {
      upsert: vi.fn(),
    },
    ...extra,
  };
  mockWithDbTx(mockTx);
  return mockTx;
}

// ---------------------------------------------------------------------------
// downloadAndIngest: valid code-judges.json
// ---------------------------------------------------------------------------

describe("evaluateCodeHandler downloadAndIngest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertEvaluationWithJudgeScores.mockResolvedValue(undefined);
  });

  it("calls upsertEvaluationWithJudgeScores with CODE report type and correct identifiers", async () => {
    const loop = buildEvaluateCodeLoop();
    setupMockTx();
    setupDownload(CODE_REPORT);

    await evaluateCodeHandler.downloadAndIngest(
      loop.s3StateKey!,
      loop,
      "org-1"
    );

    expect(mockUpsertEvaluationWithJudgeScores).toHaveBeenCalledOnce();
    expect(mockUpsertEvaluationWithJudgeScores).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: "code-artifact-1",
        entityType: EntityType.ARTIFACT,
        artifactId: "code-artifact-1",
        loopId: loop.id,
        organizationId: "org-1",
        reportType: PrismaEvaluationReportType.CODE,
        report: expect.objectContaining({
          report_id: CODE_REPORT.report_id,
        }),
      })
    );
  });

  it("downloads code-judges.json from the state key prefix", async () => {
    const loop = buildEvaluateCodeLoop();
    setupMockTx();
    setupDownload(CODE_REPORT);

    await evaluateCodeHandler.downloadAndIngest(
      loop.s3StateKey!,
      loop,
      "org-1"
    );

    expect(mockDownloadArtifactFile).toHaveBeenCalledWith(
      loop.s3StateKey,
      "code-judges.json"
    );
  });

  it("calls upsertEvaluationWithJudgeScores with correct artifactId, organizationId, reportType, and report", async () => {
    const loop = buildEvaluateCodeLoop();
    setupMockTx();
    setupDownload(CODE_REPORT);

    await evaluateCodeHandler.downloadAndIngest(
      loop.s3StateKey!,
      loop,
      "org-1"
    );

    expect(mockUpsertEvaluationWithJudgeScores).toHaveBeenCalledOnce();
    expect(mockUpsertEvaluationWithJudgeScores).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: "code-artifact-1",
        entityType: EntityType.ARTIFACT,
        artifactId: "code-artifact-1",
        organizationId: "org-1",
        reportType: PrismaEvaluationReportType.CODE,
        report: expect.objectContaining({ report_id: CODE_REPORT.report_id }),
      })
    );
  });

  // ---------------------------------------------------------------------------
  // Early-return: null artifactId
  // ---------------------------------------------------------------------------

  it("does not call upsertEvaluationWithJudgeScores when loop.artifactId is null", async () => {
    const loop = buildEvaluateCodeLoop({ artifactId: null });
    setupMockTx();
    setupDownload(CODE_REPORT);

    await evaluateCodeHandler.downloadAndIngest(
      loop.s3StateKey!,
      loop,
      "org-1"
    );

    expect(mockUpsertEvaluationWithJudgeScores).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Null report guard
  // ---------------------------------------------------------------------------

  it("does not call upsertEvaluationWithJudgeScores when code-judges.json is absent (null buffer)", async () => {
    const loop = buildEvaluateCodeLoop();
    setupMockTx();
    setupDownload(null);

    await evaluateCodeHandler.downloadAndIngest(
      loop.s3StateKey!,
      loop,
      "org-1"
    );

    expect(mockUpsertEvaluationWithJudgeScores).not.toHaveBeenCalled();
  });

  it("does not call upsertEvaluationWithJudgeScores when code-judges.json is unparseable", async () => {
    const loop = buildEvaluateCodeLoop();
    setupMockTx();

    // downloadArtifactFile returns a buffer but parseJsonArtifact fails → null
    mockDownloadArtifactFile.mockResolvedValue(
      Buffer.from("not-valid-json{{{{")
    );
    mockParseJsonArtifact.mockReturnValue(null);

    await evaluateCodeHandler.downloadAndIngest(
      loop.s3StateKey!,
      loop,
      "org-1"
    );

    expect(mockUpsertEvaluationWithJudgeScores).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Stale-write guard — version-aware ingestion skip
  // ---------------------------------------------------------------------------

  it("skips ingestion when artifact.latestVersion is greater than loop.artifactVersion", async () => {
    const loop = buildEvaluateCodeLoop({ artifactVersion: 1 });
    setupDownload(CODE_REPORT);
    setupMockTx({
      artifact: { findUnique: vi.fn().mockResolvedValue({ latestVersion: 2 }) },
    });

    await evaluateCodeHandler.downloadAndIngest(
      loop.s3StateKey!,
      loop,
      "org-1"
    );

    expect(mockUpsertEvaluationWithJudgeScores).not.toHaveBeenCalled();
  });

  it("proceeds with ingestion when artifact.latestVersion equals loop.artifactVersion", async () => {
    const loop = buildEvaluateCodeLoop({ artifactVersion: 2 });
    setupDownload(CODE_REPORT);
    setupMockTx({
      artifact: { findUnique: vi.fn().mockResolvedValue({ latestVersion: 2 }) },
    });

    await evaluateCodeHandler.downloadAndIngest(
      loop.s3StateKey!,
      loop,
      "org-1"
    );

    expect(mockUpsertEvaluationWithJudgeScores).toHaveBeenCalledOnce();
  });

  it("proceeds with ingestion when loop.artifactVersion is null (backwards compat — no version check)", async () => {
    const loop = buildEvaluateCodeLoop({ artifactVersion: null });
    setupDownload(CODE_REPORT);
    setupMockTx();

    await evaluateCodeHandler.downloadAndIngest(
      loop.s3StateKey!,
      loop,
      "org-1"
    );

    expect(mockUpsertEvaluationWithJudgeScores).toHaveBeenCalledOnce();
  });

  it("proceeds with ingestion when artifact is not found during version check (best effort)", async () => {
    const loop = buildEvaluateCodeLoop({ artifactVersion: 1 });
    setupDownload(CODE_REPORT);
    setupMockTx({
      artifact: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    await evaluateCodeHandler.downloadAndIngest(
      loop.s3StateKey!,
      loop,
      "org-1"
    );

    expect(mockUpsertEvaluationWithJudgeScores).toHaveBeenCalledOnce();
  });

  // ---------------------------------------------------------------------------
  // Upsert idempotency — calling ingest twice does not throw
  // ---------------------------------------------------------------------------

  it("calling ingest twice upserts with identical where-clause keys and does not throw", async () => {
    const loop = buildEvaluateCodeLoop();

    setupMockTx();
    setupDownload(CODE_REPORT);
    await evaluateCodeHandler.downloadAndIngest(
      loop.s3StateKey!,
      loop,
      "org-1"
    );

    setupMockTx();
    setupDownload(CODE_REPORT);
    await evaluateCodeHandler.downloadAndIngest(
      loop.s3StateKey!,
      loop,
      "org-1"
    );

    expect(mockUpsertEvaluationWithJudgeScores).toHaveBeenCalledTimes(2);

    const [firstCall, secondCall] =
      mockUpsertEvaluationWithJudgeScores.mock.calls;

    // Both calls carry identical entityId + entityType + artifactId + reportType — the upsert composite key.
    expect(firstCall[0]).toMatchObject({
      entityId: "code-artifact-1",
      entityType: EntityType.ARTIFACT,
      artifactId: "code-artifact-1",
      reportType: PrismaEvaluationReportType.CODE,
      report: expect.objectContaining({ report_id: CODE_REPORT.report_id }),
    });
    expect(secondCall[0]).toMatchObject({
      entityId: "code-artifact-1",
      entityType: EntityType.ARTIFACT,
      artifactId: "code-artifact-1",
      reportType: PrismaEvaluationReportType.CODE,
      report: expect.objectContaining({ report_id: CODE_REPORT.report_id }),
    });

    // Neither call rejected — no unique constraint violation thrown.
    await expect(
      Promise.all([
        mockUpsertEvaluationWithJudgeScores.mock.results[0].value,
        mockUpsertEvaluationWithJudgeScores.mock.results[1].value,
      ])
    ).resolves.toEqual([undefined, undefined]);
  });
});
