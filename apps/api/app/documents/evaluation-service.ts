import {
  type BatchJudgeScoresResponse,
  type DocumentJudgeScores,
  EvaluationReportType,
  type JudgesFeedbackResponse,
} from "@repo/api/src/types/evaluation";
import type { DocumentRatingSummary } from "@repo/api/src/types/rating";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { ArtifactType, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { documentWhere } from "@/lib/artifact-adapters";

/**
 * Document evaluation service - ratings + judge feedback for DOCUMENT artifacts.
 *
 * Owns:
 *  - Per-user rating reads + upserts (`artifactRating` rows scoped to the
 *    document artifact).
 *  - Latest evaluation feedback by report type (`artifactEvaluation` +
 *    `judgeScore` joins).
 *
 * Fallible writes (`upsertRating`) return `Result<T, StatusCode>` so the route
 * layer can map `Status.NotFound` → 404 without try/catch boilerplate.
 */
export const documentEvaluationService = {
  /**
   * Get rating summary for a document (org-scoped). Returns aggregate
   * statistics and the current user's rating if one exists. Returns an empty
   * summary (zeros, null userRating) when the document has no ratings.
   */
  async getRating(
    documentId: string,
    userId: string,
    organizationId: string
  ): Promise<DocumentRatingSummary> {
    const userRating = await withDb((db) =>
      db.artifactRating.findUnique({
        where: {
          artifactId_userId_organizationId: {
            artifactId: documentId,
            userId,
            organizationId,
          },
        },
      })
    );

    // Aggregate filter MUST scope by both artifactId AND organizationId for
    // multi-tenant isolation.
    const [avgResult, count] = await Promise.all([
      withDb((db) =>
        db.artifactRating.aggregate({
          where: { artifactId: documentId, organizationId },
          _avg: { score: true },
        })
      ),
      withDb((db) =>
        db.artifactRating.count({
          where: { artifactId: documentId, organizationId },
        })
      ),
    ]);

    return {
      average: avgResult._avg?.score ?? 0,
      count,
      userRating: userRating
        ? {
            id: userRating.id,
            userId: userRating.userId,
            score: userRating.score,
            comment: userRating.comment ?? undefined,
            documentVersion: userRating.artifactVersion ?? 0,
            createdAt: userRating.createdAt,
            updatedAt: userRating.updatedAt,
          }
        : null,
    };
  },

  /**
   * Upsert a rating for a document (org-scoped). Captures the current
   * `latestVersion` from `documentDetail` atomically so the rating row
   * traces back to the document version it was given against.
   *
   * Returns `Result.err(Status.NotFound)` when no DOCUMENT artifact with this
   * id exists in the caller's organization (defence in depth — also blocks
   * cross-org access).
   */
  upsertRating(
    documentId: string,
    userId: string,
    organizationId: string,
    score: number,
    comment?: string
  ): Promise<Result<DocumentRatingSummary, StatusCode>> {
    return withDb.tx(async (tx) => {
      const currentDetail = await tx.documentDetail.findFirst({
        where: {
          artifactId: documentId,
          artifact: { organizationId, type: ArtifactType.DOCUMENT },
        },
        select: { latestVersion: true },
      });

      if (!currentDetail) {
        return Result.err(Status.NotFound);
      }

      const rating = await tx.artifactRating.upsert({
        where: {
          artifactId_userId_organizationId: {
            artifactId: documentId,
            userId,
            organizationId,
          },
        },
        update: {
          score,
          comment,
          artifactVersion: currentDetail.latestVersion,
          updatedAt: new Date(),
        },
        create: {
          artifactId: documentId,
          userId,
          organizationId,
          score,
          comment,
          artifactVersion: currentDetail.latestVersion,
        },
      });

      const [avgResult, count] = await Promise.all([
        tx.artifactRating.aggregate({
          where: { artifactId: documentId, organizationId },
          _avg: { score: true },
        }),
        tx.artifactRating.count({
          where: { artifactId: documentId, organizationId },
        }),
      ]);

      return Result.ok({
        average: avgResult._avg?.score ?? 0,
        count,
        userRating: {
          id: rating.id,
          userId: rating.userId,
          score: rating.score,
          comment: rating.comment ?? undefined,
          documentVersion: rating.artifactVersion ?? 0,
          createdAt: rating.createdAt,
          updatedAt: rating.updatedAt,
        },
      });
    });
  },

  /**
   * Get evaluation feedback for an artifact by report type. Returns the most
   * recent evaluation of the given type. Wraps domain status (`success` /
   * `not_found` / `error`) rather than `Result` because callers expect to
   * render the not-found and error cases as content, not as 404/500.
   */
  async getEvaluationFeedback(
    documentId: string,
    organizationId: string,
    reportType: EvaluationReportType
  ): Promise<JudgesFeedbackResponse> {
    try {
      const evaluation = await withDb((db) =>
        db.artifactEvaluation.findFirst({
          where: {
            artifactId: documentId,
            organizationId,
            reportType,
          },
          include: {
            judgeScores: { include: { prompt: { select: { name: true } } } },
          },
          orderBy: { createdAt: "desc" },
        })
      );

      if (!evaluation) {
        return { status: "not_found", data: null };
      }

      const data = evaluation.judgeScores.map((js) => ({
        judgeScoreId: js.id,
        caseId: js.caseId,
        metricName: js.metricName,
        score: js.score,
        threshold: js.threshold,
        justification: js.justification,
        finalStatus: js.finalStatus,
        promptName: js.prompt?.name ?? null,
      }));
      return { status: "success", data };
    } catch (error) {
      log.error(`[documents-evaluation] Failed to get ${reportType} feedback`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  /**
   * Batch-fetch the latest judge scores for all DOCUMENT artifacts in a
   * project, restricted to the provided report types. Returns a map
   * `documentId → { plan, prd, code }` where each value is the most recent
   * evaluation of that report type, or `null` if none exists.
   */
  async getBatchJudgeScores(
    projectId: string,
    organizationId: string,
    reportTypes: EvaluationReportType[]
  ): Promise<BatchJudgeScoresResponse> {
    const projectArtifacts = await withDb((db) =>
      db.artifact.findMany({
        where: documentWhere({ projectId, organizationId }),
        select: { id: true },
      })
    );

    const evaluations = await withDb((db) =>
      db.artifactEvaluation.findMany({
        where: {
          organizationId,
          artifactId: { in: projectArtifacts.map((a) => a.id) },
          reportType: { in: reportTypes },
        },
        include: {
          judgeScores: { include: { prompt: { select: { name: true } } } },
        },
        orderBy: { createdAt: "desc" },
      })
    );

    // Group by (artifactId, reportType), keep only the latest per combination.
    const latestByDocumentAndType = new Map<
      string,
      (typeof evaluations)[number]
    >();
    for (const evaluation of evaluations) {
      const key = `${evaluation.artifactId}:${evaluation.reportType}`;
      if (!latestByDocumentAndType.has(key)) {
        latestByDocumentAndType.set(key, evaluation);
      }
    }

    const result: BatchJudgeScoresResponse = {};
    for (const evaluation of latestByDocumentAndType.values()) {
      const { artifactId, reportType } = evaluation;
      if (!result[artifactId]) {
        result[artifactId] = Object.fromEntries(
          Object.values(EvaluationReportType).map((t) => [t, null])
        ) as DocumentJudgeScores;
      }
      result[artifactId][reportType] = evaluation.judgeScores.map((js) => ({
        judgeScoreId: js.id,
        caseId: js.caseId,
        metricName: js.metricName,
        score: js.score,
        threshold: js.threshold,
        justification: js.justification,
        finalStatus: js.finalStatus,
        promptName: js.prompt?.name ?? null,
      }));
    }

    return result;
  },
};
