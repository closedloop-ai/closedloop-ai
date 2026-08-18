import type { ReviewDecision } from "@repo/api/src/types/branch-checks";
import { Prisma, type TransactionClient } from "@repo/database";
import { v7 as uuidv7 } from "uuid";

type ReviewFetchProvenanceData = {
  fetchCredentialType?: string | null;
  fetchCredentialOwnerId?: string | null;
  fetchMechanism?: string | null;
  fetchTrigger?: string | null;
  fetchObservedAt?: Date | null;
  fetchResultReason?: string | null;
};

export type PersistLatestGitHubPRReviewInput = ReviewFetchProvenanceData & {
  pullRequestId: string;
  githubReviewId: string;
  authorLogin: string;
  authorAvatarUrl: string | null;
  state: ReviewDecision;
  body: string | null;
  htmlUrl: string;
  submittedAt: Date;
};

/** Persists one reviewer's latest PR review without letting stale replay win. */
export async function persistLatestGitHubPRReview(
  tx: TransactionClient,
  input: PersistLatestGitHubPRReviewInput
): Promise<void> {
  const reviewRowId = uuidv7();

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "github_pr_reviews" (
      "id",
      "pull_request_id",
      "github_review_id",
      "author_login",
      "author_avatar_url",
      "state",
      "body",
      "html_url",
      "submitted_at",
      "fetch_credential_type",
      "fetch_credential_owner_id",
      "fetch_mechanism",
      "fetch_trigger",
      "fetch_observed_at",
      "fetch_result_reason",
      "updated_at"
    )
    VALUES (
      ${reviewRowId}::uuid,
      ${input.pullRequestId}::uuid,
      ${input.githubReviewId},
      ${input.authorLogin},
      ${input.authorAvatarUrl},
      ${input.state}::"ReviewDecision",
      ${input.body},
      ${input.htmlUrl},
      ${input.submittedAt},
      ${input.fetchCredentialType ?? null},
      ${input.fetchCredentialOwnerId ?? null}::uuid,
      ${input.fetchMechanism ?? null},
      ${input.fetchTrigger ?? null},
      ${input.fetchObservedAt ?? null},
      ${input.fetchResultReason ?? null},
      NOW()
    )
    ON CONFLICT ("pull_request_id", "author_login") DO UPDATE SET
      "github_review_id" = EXCLUDED."github_review_id",
      "author_avatar_url" = EXCLUDED."author_avatar_url",
      "state" = EXCLUDED."state",
      "body" = EXCLUDED."body",
      "html_url" = EXCLUDED."html_url",
      "submitted_at" = EXCLUDED."submitted_at",
      "fetch_credential_type" = EXCLUDED."fetch_credential_type",
      "fetch_credential_owner_id" = EXCLUDED."fetch_credential_owner_id",
      "fetch_mechanism" = EXCLUDED."fetch_mechanism",
      "fetch_trigger" = EXCLUDED."fetch_trigger",
      "fetch_observed_at" = EXCLUDED."fetch_observed_at",
      "fetch_result_reason" = EXCLUDED."fetch_result_reason",
      "updated_at" = NOW()
    WHERE
      "github_pr_reviews"."submitted_at" < EXCLUDED."submitted_at"
      OR (
        "github_pr_reviews"."submitted_at" = EXCLUDED."submitted_at"
        AND (
          "github_pr_reviews"."state" <> 'DISMISSED'::"ReviewDecision"
          OR EXCLUDED."state" = 'DISMISSED'::"ReviewDecision"
        )
      )
  `);
}
