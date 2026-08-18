/**
 * Unit tests for judges-analytics service query structure.
 *
 * After FEA-2809 `getAggregateStats` aggregates DB-side via `$queryRaw`
 * (power sums grouped by subtype/metric/prompt/case). These tests assert that
 * the raw aggregation query is scoped to the caller's organization and
 * reportType — org-A scores never bleed into an org-B request.
 */
import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { judgesAnalyticsService } from "@/app/judges-analytics/service";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (values: unknown[]) => ({ join: values }),
  },
  PromptType: { JUDGE: "JUDGE" },
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
  ArtifactSubtype: {
    PRD: "PRD",
    IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN",
    TEMPLATE: "TEMPLATE",
    FEATURE: "FEATURE",
  },
}));

const ORG_A = "org-alpha";
const START = new Date("2026-01-01");
const END = new Date("2026-01-31");

/**
 * Wire a `$queryRaw` mock: the first call is the judge-description lookup
 * (returns []), the second is the aggregate power-sum groups query.
 */
function makeDb(groupRows: unknown[] = []) {
  const queryRaw = vi
    .fn()
    // getJudgeDescriptionByPromptName
    .mockResolvedValueOnce([])
    // getAggregateJudgeScoreGroups
    .mockResolvedValueOnce(groupRows);
  const db = {
    prompt: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: queryRaw,
    artifact: { findMany: vi.fn().mockResolvedValue([]) },
    artifactRating: { findMany: vi.fn().mockResolvedValue([]) },
    artifactLink: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return { db, queryRaw };
}

describe("judgesAnalyticsService — query structure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scopes the aggregate query to the caller's organizationId and reportType", async () => {
    const { db, queryRaw } = makeDb();

    vi.mocked(withDb).mockImplementation((callback) =>
      Promise.resolve(
        callback(db as unknown as Parameters<Parameters<typeof withDb>[0]>[0])
      )
    );

    await judgesAnalyticsService.getAggregateStats(
      ORG_A,
      START,
      END,
      EvaluationReportType.Plan
    );

    // The second $queryRaw call is the aggregate groups query. Its interpolated
    // values must carry the org, the reportType and the date window.
    const aggregateCall = queryRaw.mock.calls[1][0] as { values: unknown[] };
    expect(aggregateCall.values).toContain(ORG_A);
    expect(aggregateCall.values).toContain(EvaluationReportType.Plan);
    expect(aggregateCall.values).toContain(START);
    expect(aggregateCall.values).toContain(END);
  });

  it("does not surface scores when the aggregate query returns none for the org", async () => {
    // Empty group result → empty response, and no cross-org leakage is possible
    // because the org filter is applied inside the SQL, not in app memory.
    const { db, queryRaw } = makeDb([]);

    vi.mocked(withDb).mockImplementation((callback) =>
      Promise.resolve(
        callback(db as unknown as Parameters<Parameters<typeof withDb>[0]>[0])
      )
    );

    const result = await judgesAnalyticsService.getAggregateStats(
      ORG_A,
      START,
      END,
      EvaluationReportType.Plan
    );

    expect(result).toEqual({
      reportType: EvaluationReportType.Plan,
      groups: [],
    });
    const aggregateCall = queryRaw.mock.calls[1][0] as { values: unknown[] };
    expect(aggregateCall.values).toContain(ORG_A);
  });
});
