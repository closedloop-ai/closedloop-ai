/**
 * Mock evaluation data for testing CaseScore visualization components.
 *
 * This file provides sample data matching the types defined in apps/app/types/evaluation.ts.
 * The mock includes a single plan evaluation with multiple metrics showing a mix of scores.
 *
 * @see apps/app/types/evaluation.ts for type definitions
 * @see https://linear.app/closedloop-ai/issue/AI-216/view-evaluation-results-us-001
 */

import { createMockMetricStatistics } from "@/__tests__/fixtures/evaluation";
import type { CaseScore, EvalStatus } from "@/types/evaluation";

/**
 * Helper to create a metric with a specific name, score, and justification.
 * Delegates to the shared fixture factory.
 */
function createMetric(
  name: string,
  score: EvalStatus,
  justification: string[]
) {
  return createMockMetricStatistics({
    metric_name: name,
    score,
    justification,
  });
}

const poorMetricMock = createMetric("Completeness", 1, [
  "Plan is missing implementation details for the data migration step",
  "No rollback strategy defined for production deployment",
  "Test coverage requirements are not specified",
  "Missing acceptance criteria for 3 out of 5 user stories",
]);

const needsImprovementMetricMock = createMetric("Clarity", 2, [
  "Task descriptions are generally clear but could be more specific",
  "Technical terminology is used consistently",
  "Dependencies between tasks could be better documented",
]);

const greatMetricMock = createMetric("Technical Accuracy", 3, [
  "All API endpoints follow RESTful conventions correctly",
  "Database schema changes align with Prisma best practices",
  "Authentication flow properly implements OAuth 2.0 standards",
  "Error handling follows established patterns in the codebase",
]);

const mixedMetricMock = createMetric("Feasibility", 2, [
  "Timeline is reasonable for most tasks",
  "Resource allocation may be tight during Q4",
  "Dependencies on external teams are identified but not fully coordinated",
]);

const standardsMetricMock = createMetric("Code Standards Adherence", 3, [
  "Component structure follows established patterns in apps/app/components",
  "Type definitions are properly organized in packages/api/src/types",
  "Data access pattern correctly uses TanStack Query hooks",
]);

/**
 * Mock CaseScore for a single plan evaluation.
 *
 * This evaluation shows a mix of results:
 * - 2 metrics with score 3 (great)
 * - 2 metrics with score 2 (needs improvement)
 * - 1 metric with score 1 (poor)
 *
 * Weighted score: 2.2 (calculated as (1*1 + 2*2 + 3*1 + 2*1 + 3*1) / 5)
 * Final status: 2 (needs improvement)
 */
export const mockPlanEvaluation: CaseScore = {
  weighted_score: 2.2,
  metrics: [
    poorMetricMock,
    needsImprovementMetricMock,
    greatMetricMock,
    mixedMetricMock,
    standardsMetricMock,
  ],
  type: "case_score",
  case_id: "plan-eval-001",
  eval_set_id: "eval-set-2024-01",
  final_status: 2,
};

export const mockExcellentEvaluation: CaseScore = {
  weighted_score: 3.0,
  metrics: [
    createMetric("Completeness", 3, [
      "All user stories have comprehensive acceptance criteria",
      "Implementation plan covers all edge cases",
      "Rollback and monitoring strategies are well-defined",
    ]),
    createMetric("Clarity", 3, [
      "Task descriptions are clear and actionable",
      "Technical requirements are precisely specified",
      "Dependencies are explicitly documented with clear rationale",
    ]),
    createMetric("Technical Accuracy", 3, [
      "API design follows RESTful best practices",
      "Database schema is properly normalized",
      "Security considerations are thoroughly addressed",
    ]),
  ],
  type: "case_score",
  case_id: "plan-eval-excellent-001",
  eval_set_id: "eval-set-2024-01",
  final_status: 3,
};

export const mockPoorEvaluation: CaseScore = {
  weighted_score: 1.0,
  metrics: [
    createMetric("Completeness", 1, [
      "Plan is missing critical implementation details",
      "No testing strategy defined",
      "Deployment approach is not specified",
    ]),
    createMetric("Clarity", 1, [
      "Task descriptions are vague and lack actionable details",
      "Technical terminology is inconsistent",
      "Dependencies are not clearly identified",
    ]),
    createMetric("Technical Accuracy", 1, [
      "Proposed API design violates REST principles",
      "Database schema has normalization issues",
      "Security vulnerabilities not addressed",
    ]),
  ],
  type: "case_score",
  case_id: "plan-eval-poor-001",
  eval_set_id: "eval-set-2024-01",
  final_status: 1,
};

/**
 * Array of all mock evaluations for testing different scenarios
 */
export const mockEvaluations = [
  mockPlanEvaluation,
  mockExcellentEvaluation,
  mockPoorEvaluation,
];
