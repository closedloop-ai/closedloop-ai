import { DocumentType } from "@repo/api/src/types/document";
import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import type {
  JudgeAggregateStats,
  JudgeDetailResponse,
  JudgeScoresResponse,
  JudgeStatsResponse,
} from "@repo/api/src/types/judges-analytics";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { liveAppShellRoutes } from "./live-app-fixtures";
import { myTasksDocumentsFixture } from "./my-tasks-fixtures";

// The Judges pages (`apps/app/.../judges-analytics/page.tsx` and
// `[metricName]/page.tsx`) read `GET /judges-analytics?reportType=…` once per
// report type, and for one judge `GET /judges-analytics/:prompt` and its
// `/scores`. These are those responses for a workspace whose plans, PRDs and
// code are all judged.

function judge(
  promptName: string,
  judgeName: string,
  mean: number,
  documentsEvaluated: number,
  humanMean: number | null
): JudgeAggregateStats {
  return {
    description: null,
    displayMetricName: judgeName,
    documentsEvaluated,
    humanMax: humanMean === null ? null : Math.min(1, humanMean + 0.2),
    humanMean,
    humanMin: humanMean === null ? null : Math.max(0, humanMean - 0.3),
    humanStdDev: humanMean === null ? null : 0.11,
    judgeName,
    max: Math.min(1, mean + 0.18),
    mean,
    metricName: promptName,
    min: Math.max(0, mean - 0.34),
    promptName,
    stdDev: 0.09,
  };
}

const STATS: Record<string, JudgeStatsResponse> = {
  [EvaluationReportType.Plan]: {
    groups: [
      {
        documentType: DocumentType.ImplementationPlan,
        humanCommentsCount: 31,
        humanRatingsCount: 118,
        judges: [
          judge("plan-completeness", "Plan completeness", 0.78, 142, 0.74),
          judge("plan-feasibility", "Feasibility", 0.71, 142, 0.69),
          judge("plan-test-strategy", "Test strategy", 0.63, 139, null),
        ],
      },
    ],
    reportType: EvaluationReportType.Plan,
  },
  [EvaluationReportType.Prd]: {
    groups: [
      {
        documentType: DocumentType.Prd,
        humanCommentsCount: 12,
        humanRatingsCount: 44,
        judges: [
          judge("prd-clarity", "Clarity", 0.82, 57, 0.79),
          judge("prd-scope", "Scope discipline", 0.69, 57, 0.72),
        ],
      },
    ],
    reportType: EvaluationReportType.Prd,
  },
  [EvaluationReportType.Code]: {
    groups: [
      {
        documentType: DocumentType.Feature,
        humanCommentsCount: 48,
        humanRatingsCount: 203,
        judges: [
          judge("code-correctness", "Correctness", 0.86, 311, 0.83),
          judge("code-test-coverage", "Test coverage", 0.67, 309, 0.61),
          judge("code-simplicity", "Simplicity", 0.74, 311, null),
        ],
      },
    ],
    reportType: EvaluationReportType.Code,
  },
};

export const JUDGE_PROMPT = "plan-completeness";

export const judgeDetailFixture: JudgeDetailResponse = {
  judge: {
    displayName: "Plan completeness",
    labels: ["Decisive", "Optimistic"],
    latestPromptId: "prompt_plan_completeness_v3",
    promptName: JUDGE_PROMPT,
    promptText: [
      "You are reviewing an implementation plan.",
      "Score 0-1 for how completely it covers the PRD's acceptance criteria:",
      "every criterion mapped to a step, every step with a verification.",
      "Explain the single biggest gap in one sentence.",
    ].join("\n"),
    promptVersions: [1, 2, 3].map((version) => ({
      createdAt: `2026-0${5 + version}-01T10:00:00.000Z`,
      max: 0.9 + version * 0.02,
      mean: 0.7 + version * 0.03,
      min: 0.3 + version * 0.05,
      promptId: `prompt_plan_completeness_v${version}`,
      radarAxes: {
        certainty: 0.6 + version * 0.08,
        optimism: 0.55 + version * 0.05,
        polarity: 0.4 - version * 0.05,
        stubbornness: 0.5 + version * 0.04,
      },
      scoreCount: 30 + version * 20,
      stdDev: 0.12 - version * 0.01,
      version,
    })),
    radarAxes: {
      certainty: 0.84,
      optimism: 0.7,
      polarity: 0.25,
      stubbornness: 0.62,
    },
    reportType: EvaluationReportType.Plan,
    scoreCount: 142,
    unknownVersionScoreCount: 6,
  },
};

export const judgeScoresFixture: JudgeScoresResponse = {
  coveragePct: 83,
  pagination: { page: 1, pageSize: 20, totalPages: 1, totalRows: 6 },
  ratedDocuments: 118,
  rows: myTasksDocumentsFixture.slice(0, 6).map((doc, index) => {
    const judgeScore = [0.92, 0.81, 0.77, 0.64, 0.58, 0.88][index] ?? 0.7;
    const avgUserRating = [0.9, 0.85, 0.7, 0.72, 0.4, 0.86][index] ?? 0.7;
    return {
      avgUserRating,
      delta: Number((judgeScore - avgUserRating).toFixed(2)),
      documentId: doc.id,
      documentSlug: doc.slug,
      documentTitle: doc.title,
      documentType: doc.type,
      evaluatedAt: doc.updatedAt.toISOString(),
      judgeScore,
      judgeScoreId: `js_${doc.id}`,
      metricName: JUDGE_PROMPT,
      userRatingCount: [4, 3, 2, 5, 1, 3][index] ?? 1,
    };
  }),
  totalDocuments: 142,
};

export const judgesApiRoutes: FixtureRoute[] = [
  ...liveAppShellRoutes,
  {
    method: "GET",
    path: "/judges-analytics",
    respond: ({ searchParams }) =>
      STATS[searchParams.get("reportType") ?? ""] ?? {
        groups: [],
        reportType: searchParams.get("reportType"),
      },
  },
  {
    method: "GET",
    path: "/judges-analytics/*",
    respond: ({ pathname }) =>
      pathname.endsWith("/scores") ? judgeScoresFixture : judgeDetailFixture,
  },
];
