import { GitHubPRState } from "@repo/api/src/types/github";
import { Prisma } from "@repo/database";

/**
 * Builds a correlated predicate over the same deterministic associated-PR
 * selection authority used by the response projection. The surrounding Branch
 * candidate query owns aliases `a` (Artifact) and `b` (BranchDetail); the
 * returned predicate exposes the selected row as `pr` to optional filters.
 */
export function selectedAssociatedPullRequestExists(
  extraPredicates: Prisma.Sql[] = []
): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM pull_request_detail pr
    WHERE pr.id = (
      SELECT candidate.id
      FROM pull_request_detail candidate
      LEFT JOIN github_installation_repositories candidate_repository
        ON candidate_repository.id = candidate.repository_id
      WHERE candidate.branch_artifact_id = a.id
        AND NOT EXISTS (
          SELECT 1
          FROM pull_request_detail invalid_candidate
          LEFT JOIN github_installation_repositories invalid_repository
            ON invalid_repository.id = invalid_candidate.repository_id
          WHERE invalid_candidate.branch_artifact_id = a.id
            AND (
              invalid_candidate.number <= 0
              OR COALESCE(
                invalid_repository.full_name,
                invalid_candidate.repository_full_name,
                b.repository_full_name
              ) IS NULL
              OR (
                invalid_candidate.is_draft = TRUE
                AND (
                  invalid_candidate.pr_state <> ${GitHubPRState.Open}::"GitHubPRState"
                  OR invalid_candidate.merged_at IS NOT NULL
                )
              )
            )
        )
        AND (
          (
            candidate.pr_state = ${GitHubPRState.Open}::"GitHubPRState"
            AND candidate.merged_at IS NULL
            AND 1 = (
              SELECT COUNT(DISTINCT (
                LOWER(COALESCE(
                  active_repository.full_name,
                  active_candidate.repository_full_name,
                  b.repository_full_name
                )),
                active_candidate.number
              ))
              FROM pull_request_detail active_candidate
              LEFT JOIN github_installation_repositories active_repository
                ON active_repository.id = active_candidate.repository_id
              WHERE active_candidate.branch_artifact_id = a.id
                AND active_candidate.pr_state = ${GitHubPRState.Open}::"GitHubPRState"
                AND active_candidate.merged_at IS NULL
            )
          )
          OR (
            NOT EXISTS (
              SELECT 1
              FROM pull_request_detail active_candidate
              WHERE active_candidate.branch_artifact_id = a.id
                AND active_candidate.pr_state = ${GitHubPRState.Open}::"GitHubPRState"
                AND active_candidate.merged_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1
              FROM pull_request_detail unranked_terminal
              WHERE unranked_terminal.branch_artifact_id = a.id
                AND unranked_terminal.merged_at IS NULL
                AND unranked_terminal.pr_state IN (
                  ${GitHubPRState.Merged}::"GitHubPRState",
                  ${GitHubPRState.Closed}::"GitHubPRState"
                )
                AND (
                  unranked_terminal.pr_state = ${GitHubPRState.Merged}::"GitHubPRState"
                  OR unranked_terminal.closed_at IS NULL
                )
            )
            AND (
              candidate.merged_at IS NOT NULL
              OR (
                candidate.pr_state = ${GitHubPRState.Closed}::"GitHubPRState"
                AND candidate.closed_at IS NOT NULL
              )
            )
          )
        )
      ORDER BY
        CASE
          WHEN candidate.pr_state = ${GitHubPRState.Open}::"GitHubPRState"
            AND candidate.merged_at IS NULL THEN 0
          ELSE 1
        END ASC,
        COALESCE(candidate.merged_at, candidate.closed_at) DESC NULLS LAST,
        LOWER(COALESCE(
          candidate_repository.full_name,
          candidate.repository_full_name,
          b.repository_full_name
        )) ASC,
        candidate.number ASC,
        candidate.id ASC
      LIMIT 1
    )
      ${extraPredicates.length > 0 ? Prisma.sql`AND ${Prisma.join(extraPredicates, " AND ")}` : Prisma.empty}
  )`;
}
