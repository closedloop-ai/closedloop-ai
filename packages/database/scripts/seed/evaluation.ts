import { EvalStatus, EvaluationReportType } from "../../generated/client";
import type { TransactionClient } from "../../generated/internal/prismaNamespace";
import type { CoreSeedResult } from "./core";
import {
  createUpsertCounts,
  deterministicUuid,
  logUpsertSummary,
  seedLog,
  upsertRow,
} from "./helpers";
import type { SeedContext } from "./index";
import { resolveSeedRunPlan, type SeedRunPlan } from "./profiles";

/**
 * Seeds ArtifactEvaluation, JudgeScore, and JudgeHumanScore rows.
 *
 * One ArtifactEvaluation is created per EvaluationReportType (PLAN, CODE, PRD,
 * FEATURE), each linked to a different seeded artifact. Each evaluation gets at
 * least one JudgeScore row and at least one JudgeHumanScore row. JudgeScore and
 * JudgeHumanScore are scoped to the org via FK joins through ArtifactEvaluation.
 *
 * All operations are idempotent — re-running the seed updates in place.
 *
 * @param prisma - Initialized PrismaClient connected to the target database.
 * @param context - Resolved organization and user identifiers.
 * @param coreResult - Artifact IDs returned by the core seed step.
 */
export async function seedEvaluationEntities(
  prisma: TransactionClient,
  context: SeedContext,
  coreResult: CoreSeedResult,
  _plan: SeedRunPlan = resolveSeedRunPlan()
): Promise<void> {
  const { organizationId, userId } = context;
  const { artifactIds } = coreResult;
  const counts = createUpsertCounts();

  seedLog(
    "Seeding evaluation entities (ArtifactEvaluation, JudgeScore, JudgeHumanScore)…"
  );

  // ---------------------------------------------------------------------------
  // Evaluation definitions — one per EvaluationReportType.
  //
  // Artifact index assignments:
  //   PLAN    → artifactIds[1]  (IMPLEMENTATION_PLAN status=IN_PROGRESS doc)
  //   CODE    → artifactIds[0]  (PRD status=DRAFT — stands in for code artifact)
  //   PRD     → artifactIds[3]  (PRD status=APPROVED doc)
  //   FEATURE → artifactIds[7]  (FEATURE status=DRAFT doc, from featureDefinitions)
  //
  // Guard against a seed database with fewer artifacts than expected by falling
  // back to artifactIds[0], which is always present.
  // ---------------------------------------------------------------------------

  const pick = (index: number): string => artifactIds[index] ?? artifactIds[0];

  type EvaluationDefinition = {
    reportType: EvaluationReportType;
    reportId: string;
    artifactId: string;
    judgeScores: JudgeScoreDefinition[];
  };

  type JudgeScoreDefinition = {
    caseId: string;
    metricName: string;
    threshold: number;
    score: number;
    justification: string;
    finalStatus: EvalStatus;
  };

  const evaluationDefinitions: EvaluationDefinition[] = [
    {
      reportType: EvaluationReportType.PLAN,
      reportId: `seed-report-plan-${organizationId}`,
      artifactId: pick(1),
      judgeScores: [
        {
          caseId: "completeness",
          metricName: "Plan Completeness",
          threshold: 0.7,
          score: 0.85,
          justification:
            "The implementation plan covers all required milestones and acceptance criteria with sufficient detail.",
          finalStatus: EvalStatus.PASSED,
        },
        {
          caseId: "feasibility",
          metricName: "Technical Feasibility",
          threshold: 0.6,
          score: 0.72,
          justification:
            "Proposed architecture is sound. Minor concerns around timeline estimates for the data migration step.",
          finalStatus: EvalStatus.PASSED,
        },
      ],
    },
    {
      reportType: EvaluationReportType.CODE,
      reportId: `seed-report-code-${organizationId}`,
      artifactId: pick(0),
      judgeScores: [
        {
          caseId: "correctness",
          metricName: "Code Correctness",
          threshold: 0.8,
          score: 0.9,
          justification:
            "All acceptance criteria are satisfied by the implementation. Unit test coverage is adequate.",
          finalStatus: EvalStatus.PASSED,
        },
        {
          caseId: "quality",
          metricName: "Code Quality",
          threshold: 0.75,
          score: 0.65,
          justification:
            "Several functions exceed cognitive complexity threshold. Recommend extracting helpers before merge.",
          finalStatus: EvalStatus.NEEDS_IMPROVEMENT,
        },
      ],
    },
    {
      reportType: EvaluationReportType.PRD,
      reportId: `seed-report-prd-${organizationId}`,
      artifactId: pick(3),
      judgeScores: [
        {
          caseId: "clarity",
          metricName: "Requirements Clarity",
          threshold: 0.7,
          score: 0.55,
          justification:
            "Several acceptance criteria are ambiguous. Success metrics lack measurable thresholds.",
          finalStatus: EvalStatus.FAILED,
        },
        {
          caseId: "scope",
          metricName: "Scope Definition",
          threshold: 0.7,
          score: 0.8,
          justification:
            "In-scope and out-of-scope boundaries are clearly stated. Edge cases are identified.",
          finalStatus: EvalStatus.PASSED,
        },
      ],
    },
    {
      reportType: EvaluationReportType.FEATURE,
      reportId: `seed-report-feature-${organizationId}`,
      artifactId: pick(7),
      judgeScores: [
        {
          caseId: "ux-consistency",
          metricName: "UX Consistency",
          threshold: 0.75,
          score: 0.88,
          justification:
            "Component interactions align with the design system. Keyboard navigation is fully supported.",
          finalStatus: EvalStatus.PASSED,
        },
        {
          caseId: "accessibility",
          metricName: "Accessibility Compliance",
          threshold: 0.8,
          score: 0.76,
          justification:
            "WCAG AA criteria are met. One missing aria-label on the icon button — low severity.",
          finalStatus: EvalStatus.NEEDS_IMPROVEMENT,
        },
      ],
    },
  ];

  for (const evalDef of evaluationDefinitions) {
    // -------------------------------------------------------------------------
    // ArtifactEvaluation
    // -------------------------------------------------------------------------

    const evaluationId = deterministicUuid(
      `artifact-evaluation:${organizationId}:${evalDef.reportType}`
    );

    await upsertRow({
      model: "ArtifactEvaluation",
      id: evaluationId,
      upsert: () =>
        prisma.artifactEvaluation.upsert({
          where: {
            artifactId_reportId: {
              artifactId: evalDef.artifactId,
              reportId: evalDef.reportId,
            },
          },
          create: {
            id: evaluationId,
            organizationId,
            artifactId: evalDef.artifactId,
            reportType: evalDef.reportType,
            reportId: evalDef.reportId,
          },
          update: {
            reportType: evalDef.reportType,
          },
        }),
      counts,
    });

    // -------------------------------------------------------------------------
    // JudgeScore rows for this evaluation
    // -------------------------------------------------------------------------

    for (const scoreDef of evalDef.judgeScores) {
      const judgeScoreId = deterministicUuid(
        `judge-score:${organizationId}:${evalDef.reportType}:${scoreDef.caseId}`
      );

      await upsertRow({
        model: "JudgeScore",
        id: judgeScoreId,
        upsert: () =>
          prisma.judgeScore.upsert({
            where: {
              evaluationId_caseId_metricName: {
                evaluationId,
                caseId: scoreDef.caseId,
                metricName: scoreDef.metricName,
              },
            },
            create: {
              id: judgeScoreId,
              evaluationId,
              caseId: scoreDef.caseId,
              metricName: scoreDef.metricName,
              threshold: scoreDef.threshold,
              score: scoreDef.score,
              justification: scoreDef.justification,
              finalStatus: scoreDef.finalStatus,
            },
            update: {
              score: scoreDef.score,
              justification: scoreDef.justification,
              finalStatus: scoreDef.finalStatus,
            },
          }),
        counts,
      });

      // -----------------------------------------------------------------------
      // JudgeHumanScore — one per JudgeScore, attributed to the seed user
      // -----------------------------------------------------------------------

      const humanScoreId = deterministicUuid(
        `judge-human-score:${organizationId}:${evalDef.reportType}:${scoreDef.caseId}:${userId}`
      );

      await upsertRow({
        model: "JudgeHumanScore",
        id: humanScoreId,
        upsert: () =>
          prisma.judgeHumanScore.upsert({
            where: {
              judgeScoreId_userId_organizationId: {
                judgeScoreId,
                userId,
                organizationId,
              },
            },
            create: {
              id: humanScoreId,
              evaluationId,
              judgeScoreId,
              userId,
              organizationId,
              score: scoreDef.score,
            },
            update: {
              score: scoreDef.score,
            },
          }),
        counts,
      });
    }
  }

  logUpsertSummary(counts);
}
