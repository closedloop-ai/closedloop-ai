/**
 * ISS-11212 against a real Postgres: a review summary's key is `submitted_at`,
 * which every edit keeps, so its order comes from the delivery: a `submitted`
 * body never replaces an edit's, an edit that restores a blanked body brings
 * the summary back, and a list cleanup never deletes a summary written after
 * the list was read.
 */
import { GitHubCommentThreadKind } from "@repo/database";
import { keys } from "@repo/database/keys";
import { GitHubProviderResultStatus } from "@repo/github/provider-result";
import { describe, expect, it } from "vitest";
import {
  applyInput,
  at,
  externalComment,
  type GitHubCommentScope,
  providerReview,
  seedGitHubCommentScope,
  storedComment,
} from "@/__tests__/support/comments/github-apply-external.test-fixtures";
import {
  autoRollbackTransaction,
  autoRollbackTransactionJoining,
  createTestOrganization,
} from "@/__tests__/utils/db-helpers";
import { backfillFetchProvenance } from "@/lib/github-fetch-provenance";
import { applyExternal } from "./apply-external";
import {
  ApplyExternalOutcome,
  type GitHubExternalEvent,
  GitHubExternalEventKind,
  type GitHubReviewSummaryUpsertEvent,
} from "./apply-external-events";
import { reconcilePullRequestComments } from "./github-comment-reconcile";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const joinAmbientTransaction = autoRollbackTransactionJoining(
  "the case asserts the stored summary after a reconcile, not its per-chunk transaction boundary"
);

const REVIEW_ID = 71;

async function seed(): Promise<GitHubCommentScope> {
  return await seedGitHubCommentScope(await createTestOrganization());
}

async function outcome(scope: GitHubCommentScope, event: GitHubExternalEvent) {
  const result = await applyExternal(applyInput(scope, [event]));
  return result.outcomes[0];
}

function summaryEvent(body: string): GitHubReviewSummaryUpsertEvent {
  return {
    kind: GitHubExternalEventKind.ReviewSummaryUpsert,
    reviewId: REVIEW_ID,
    comment: externalComment(REVIEW_ID, {
      bodyMarkdown: body,
      providerUpdatedAt: at(0),
      createdAt: at(0),
    }),
  };
}

/** The handler's `submitted` delivery. */
function submitted(body: string): GitHubReviewSummaryUpsertEvent {
  return { ...summaryEvent(body), asSubmitted: true };
}

/** The handler's non-blank `edited` delivery. */
function edited(body: string): GitHubReviewSummaryUpsertEvent {
  return { ...summaryEvent(body), reviveDeletedBefore: new Date() };
}

const blankEdit = {
  kind: GitHubExternalEventKind.CommentDelete,
  threadKind: GitHubCommentThreadKind.REVIEW_SUMMARY,
  githubCommentId: REVIEW_ID,
  providerUpdatedAt: at(0),
} as const;

function completeList<T>(items: T[]) {
  return {
    status: GitHubProviderResultStatus.Success,
    value: { items, complete: true },
  } as const;
}

describeIfDb("applyExternal — review summary deliveries", () => {
  it("keeps an edit's body when the submitted delivery arrives after it", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      await outcome(scope, edited("edited body"));

      expect(await outcome(scope, submitted("submitted body"))).toBe(
        ApplyExternalOutcome.RejectedOlder
      );

      expect((await storedComment(scope, REVIEW_ID))?.comment.plainText).toBe(
        "edited body"
      );
    });
  });

  it("brings back a summary whose body an edit blanked and a later edit restored", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      await outcome(scope, submitted("first"));
      await outcome(scope, blankEdit);
      expect(
        (await storedComment(scope, REVIEW_ID))?.comment.deletedAt
      ).not.toBeNull();

      expect(await outcome(scope, edited("restored"))).toBe(
        ApplyExternalOutcome.Applied
      );

      const stored = await storedComment(scope, REVIEW_ID);
      expect(stored?.comment.deletedAt).toBeNull();
      expect(stored?.githubDeletedAt).toBeNull();
      expect(stored?.threadProjection.deletedAt).toBeNull();
      expect(stored?.comment.plainText).toBe("restored");
    });
  });

  it("keeps a blanked summary deleted when the submitted delivery arrives late", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      await outcome(scope, submitted("first"));
      await outcome(scope, blankEdit);

      expect(await outcome(scope, submitted("first"))).toBe(
        ApplyExternalOutcome.RejectedDeleted
      );
    });
  });
});

describeIfDb("reconcile cleanup — review summaries", () => {
  it("keeps a summary an edit stored after the list was read", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seed();
      const listedAt = new Date();
      await outcome(scope, edited("body added after the list"));

      await reconcilePullRequestComments({
        pullRequestDetailId: scope.pullRequestDetailId,
        prefetched: {
          issueComments: completeList([]),
          reviewComments: completeList([]),
          reviews: completeList([providerReview(REVIEW_ID, "")]),
          listedAt,
          fetchProvenance: backfillFetchProvenance(),
        },
      });

      const stored = await storedComment(scope, REVIEW_ID);
      expect(stored?.comment.deletedAt).toBeNull();
      expect(stored?.comment.plainText).toBe("body added after the list");
    });
  });
});
