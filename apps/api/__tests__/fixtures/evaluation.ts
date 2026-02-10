import type { JudgesReport } from "@repo/api/src/types/evaluation";

/**
 * Factory for creating mock ArtifactEvaluation DB row.
 * Used to mock Prisma database queries in tests.
 *
 * @param overrides - Optional overrides for fields
 */
export function createMockEvaluationRow(overrides?: {
  id?: string;
  artifactId?: string;
  actionRunId?: string;
  reportId?: string;
  reportData?: JudgesReport;
  createdAt?: Date;
}) {
  const defaultReport: JudgesReport = {
    report_id: "test-report",
    timestamp: new Date().toISOString(),
    stats: [],
  };

  return {
    id: "eval-123",
    artifactId: "artifact-123",
    actionRunId: "action-run-123",
    reportId: "test-report",
    reportData: defaultReport,
    createdAt: new Date(),
    ...overrides,
  };
}
