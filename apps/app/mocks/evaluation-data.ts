/**
 * Mock evaluation data for testing CaseScore visualization components.
 *
 * This file provides sample data matching the types defined in apps/app/types/evaluation.ts.
 * The mock includes a single plan evaluation with multiple metrics showing a mix of scores.
 *
 * @see apps/app/types/evaluation.ts for type definitions
 * @see https://linear.app/closedloop-ai/issue/AI-216/view-evaluation-results-us-001
 */

import {
  type CaseScore,
  EvalStatus,
  type JudgesReport,
} from "@repo/api/src/types/evaluation";
import {
  createMockCaseScore,
  createMockMetricStatistics,
} from "@/__tests__/fixtures/evaluation";

/**
 * Helper to create a metric with a specific name, score, and justification.
 * Delegates to the shared fixture factory.
 */
function createMetric(name: string, score: number, justification: string) {
  return createMockMetricStatistics({
    metric_name: name,
    score,
    justification,
  });
}

const poorMetricMock = createMetric(
  "Completeness",
  0.3,
  "Plan is missing implementation details for the data migration step. No rollback strategy defined for production deployment. Test coverage requirements are not specified. Missing acceptance criteria for 3 out of 5 user stories."
);

const needsImprovementMetricMock = createMetric(
  "Clarity",
  0.65,
  "Task descriptions are generally clear but could be more specific. Technical terminology is used consistently. Dependencies between tasks could be better documented."
);

const greatMetricMock = createMetric(
  "Technical Accuracy",
  0.95,
  "All API endpoints follow RESTful conventions correctly. Database schema changes align with Prisma best practices. Authentication flow properly implements OAuth 2.0 standards. Error handling follows established patterns in the codebase."
);

const mixedMetricMock = createMetric(
  "Feasibility",
  0.7,
  "Timeline is reasonable for most tasks. Resource allocation may be tight during Q4. Dependencies on external teams are identified but not fully coordinated."
);

const standardsMetricMock = createMetric(
  "Code Standards Adherence",
  0.92,
  "Component structure follows established patterns in apps/app/components. Type definitions are properly organized in packages/api/src/types. Data access pattern correctly uses TanStack Query hooks."
);

/**
 * Mock CaseScore for a single plan evaluation.
 *
 * This evaluation shows a mix of results:
 * - 2 metrics with high scores (0.95, 0.92)
 * - 2 metrics with medium scores (0.70, 0.65)
 * - 1 metric with low score (0.3)
 *
 * Final status: NeedsImprovement (2)
 */
export const mockPlanEvaluation: CaseScore = {
  metrics: [
    poorMetricMock,
    needsImprovementMetricMock,
    greatMetricMock,
    mixedMetricMock,
    standardsMetricMock,
  ],
  type: "case_score",
  case_id: "plan-eval-001",
  final_status: EvalStatus.NeedsImprovement,
};

export const mockExcellentEvaluation: CaseScore = {
  metrics: [
    createMetric(
      "Completeness",
      0.98,
      "All user stories have comprehensive acceptance criteria. Implementation plan covers all edge cases. Rollback and monitoring strategies are well-defined."
    ),
    createMetric(
      "Clarity",
      0.95,
      "Task descriptions are clear and actionable. Technical requirements are precisely specified. Dependencies are explicitly documented with clear rationale."
    ),
    createMetric(
      "Technical Accuracy",
      0.97,
      "API design follows RESTful best practices. Database schema is properly normalized. Security considerations are thoroughly addressed."
    ),
  ],
  type: "case_score",
  case_id: "plan-eval-excellent-001",
  final_status: EvalStatus.Passed,
};

export const mockPoorEvaluation: CaseScore = {
  metrics: [
    createMetric(
      "Completeness",
      0.25,
      "Plan is missing critical implementation details. No testing strategy defined. Deployment approach is not specified."
    ),
    createMetric(
      "Clarity",
      0.3,
      "Task descriptions are vague and lack actionable details. Technical terminology is inconsistent. Dependencies are not clearly identified."
    ),
    createMetric(
      "Technical Accuracy",
      0.2,
      "Proposed API design violates REST principles. Database schema has normalization issues. Security vulnerabilities not addressed."
    ),
  ],
  type: "case_score",
  case_id: "plan-eval-poor-001",
  final_status: EvalStatus.Failed,
};

/**
 * Array of all mock evaluations for testing different scenarios
 */
export const mockEvaluations = [
  mockPlanEvaluation,
  mockExcellentEvaluation,
  mockPoorEvaluation,
];

/**
 * Mock JudgesReport for testing judges feedback visualization.
 *
 * This report contains 3 CaseScore entries representing different judges:
 * - DRY (Don't Repeat Yourself) judge
 * - SSOT (Single Source of Truth) judge
 * - KISS (Keep It Simple, Stupid) judge
 *
 * All judges show passing scores (>= 0.8 threshold) with score of 0.92.
 */
export const mockJudgesReport: JudgesReport = {
  report_id: "work-judges",
  timestamp: "2026-02-04T21:45:30Z",
  stats: [
    createMockCaseScore({
      case_id: "dry-judge",
      metrics: [
        {
          metric_name: "dry_score",
          threshold: 0.8,
          score: 0.92,
          justification:
            "The plan demonstrates strong DRY adherence by reusing existing components from the design system, sharing common validation logic across forms, and extracting repeated business rules into utility functions. No significant code duplication detected.",
        },
      ],
    }),
    createMockCaseScore({
      case_id: "ssot-judge",
      metrics: [
        {
          metric_name: "ssot_score",
          threshold: 0.8,
          score: 0.92,
          justification:
            "The plan demonstrates strong SSOT adherence by centralizing type definitions in packages/api/src/types/, using Prisma schema as the single source for database models, and maintaining API contracts in one location. No duplicate type definitions or conflicting sources of truth found.",
        },
      ],
    }),
    createMockCaseScore({
      case_id: "kiss-judge",
      metrics: [
        {
          metric_name: "kiss_score",
          threshold: 0.8,
          score: 0.92,
          justification:
            "The implementation plan demonstrates excellent simplicity by using established patterns from the codebase, avoiding over-engineering, and breaking down complex features into straightforward incremental steps. The solution is appropriately simple without sacrificing necessary functionality.",
        },
      ],
    }),
  ],
};
