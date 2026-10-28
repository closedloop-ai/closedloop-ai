/**
 * ISS-11212 (PLN-2122 Step 3, acceptance criterion 7): `applyExternal`'s
 * ordering and terminal-delete rules, its sync state, review summaries, anchors
 * and organization scoping, against a real Postgres.
 */
import {
  CodeCommentSide,
  CommentAnchorState,
} from "@repo/api/src/types/comment-anchor";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import { CommentSyncStatus } from "@repo/api/src/types/comment-thread-dto";
import { GitHubCommentThreadKind, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { log } from "@repo/observability/log";
import { describe, expect, it, vi } from "vitest";
import {
  applyInput,
  at,
  externalComment,
  GITHUB_TEST_COMMIT_SHA,
  GITHUB_TEST_REPOSITORY,
  type GitHubCommentScope,
  issueCommentEvent,
  reviewThreadEvent,
  seedGitHubCommentScope,
  storedComment,
} from "@/__tests__/support/comments/github-apply-external.test-fixtures";
import {
  autoRollbackTransaction,
  createTestOrganization,
} from "@/__tests__/utils/db-helpers";
import {
  COMMENTS_DATA_INVALID_EVENT,
  CommentDataInvalidReason,
} from "@/app/comments/comment-data-invalid";
import { applyExternal } from "./apply-external";
import {
  ApplyExternalOutcome,
  GitHubExternalEventKind,
} from "./apply-external-events";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

async function seed(): Promise<GitHubCommentScope> {
  return await seedGitHubCommentScope(await createTestOrganization());
}

async function outcome(
  scope: GitHubCommentScope,
  event: Parameters<typeof applyInput>[1][number]
) {
  const result = await applyExternal(applyInput(scope, [event]));
  return result.outcomes[0];
}

function deleteEvent(githubCommentId: number, providerUpdatedAt: Date) {
  return {
    kind: GitHubExternalEventKind.CommentDelete,
    threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
    githubCommentId,
    providerUpdatedAt,
  } as const;
}

describeIfDb("applyExternal — ordering (decision 1)", () => {
  it("applies a newer edit and confirms its sync state at the new key", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      await outcome(scope, issueCommentEvent(1, { providerUpdatedAt: at(1) }));

      expect(
        await outcome(
          scope,
          issueCommentEvent(1, {
            bodyMarkdown: "edited",
            providerUpdatedAt: at(2),
          })
        )
      ).toBe(ApplyExternalOutcome.Applied);

      const stored = await storedComment(scope, 1);
      expect(stored?.comment.plainText).toBe("edited");
      expect(stored?.comment.revision).toBe(1);
      expect(stored?.comment.syncStates).toEqual([
        {
          state: CommentSyncStatus.Synced,
          providerUpdatedAt: at(2),
          syncedRevision: 1,
        },
      ]);
    });
  });

  it("ignores an edited delivery older than the stored key, leaving the body", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      await outcome(
        scope,
        issueCommentEvent(1, {
          bodyMarkdown: "newest",
          providerUpdatedAt: at(5),
        })
      );

      expect(
        await outcome(
          scope,
          issueCommentEvent(1, {
            bodyMarkdown: "stale",
            providerUpdatedAt: at(3),
          })
        )
      ).toBe(ApplyExternalOutcome.RejectedOlder);
      expect((await storedComment(scope, 1))?.comment.plainText).toBe("newest");
    });
  });

  it("treats an equal key with an identical body as a no-op that changes no thread", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      await outcome(scope, issueCommentEvent(1, { providerUpdatedAt: at(1) }));

      const result = await applyExternal(
        applyInput(scope, [issueCommentEvent(1, { providerUpdatedAt: at(1) })])
      );

      expect(result).toEqual({
        outcomes: [ApplyExternalOutcome.Unchanged],
        changedThreadIds: [],
      });
      expect((await storedComment(scope, 1))?.comment.revision).toBe(0);
    });
  });

  it("applies an equal key with a different body", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      await outcome(scope, issueCommentEvent(1, { providerUpdatedAt: at(1) }));

      expect(
        await outcome(
          scope,
          issueCommentEvent(1, {
            bodyMarkdown: "same key",
            providerUpdatedAt: at(1),
          })
        )
      ).toBe(ApplyExternalOutcome.Applied);
      expect((await storedComment(scope, 1))?.comment.plainText).toBe(
        "same key"
      );
    });
  });

  it("rejects a key past the trusted future boundary and reports it", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      const errorSpy = vi.spyOn(log, "error");
      try {
        const farFuture = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
        expect(
          await outcome(
            scope,
            issueCommentEvent(1, { providerUpdatedAt: farFuture })
          )
        ).toBe(ApplyExternalOutcome.RejectedFuture);
        expect(await storedComment(scope, 1)).toBeNull();
        expect(errorSpy).toHaveBeenCalledWith(
          COMMENTS_DATA_INVALID_EVENT,
          expect.objectContaining({
            reason: CommentDataInvalidReason.ProviderTimestampInFuture,
            organizationId: scope.organizationId,
            providerObjectId: "1",
          })
        );
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});

describeIfDb("applyExternal — terminal delete (decision 2)", () => {
  it("records the payload's updated_at as the delete's key", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      await outcome(scope, issueCommentEvent(1, { providerUpdatedAt: at(1) }));

      expect(await outcome(scope, deleteEvent(1, at(4)))).toBe(
        ApplyExternalOutcome.Applied
      );

      const stored = await storedComment(scope, 1);
      expect(stored?.comment.deletedAt).not.toBeNull();
      expect(stored?.githubDeletedAt).not.toBeNull();
      expect(stored?.comment.syncStates[0]?.providerUpdatedAt).toEqual(at(4));
    });
  });

  it("keeps a deleted comment deleted when a late created or edited delivery arrives", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      await outcome(scope, issueCommentEvent(1, { providerUpdatedAt: at(1) }));
      await outcome(scope, deleteEvent(1, at(2)));

      expect(
        await outcome(
          scope,
          issueCommentEvent(1, {
            bodyMarkdown: "late",
            providerUpdatedAt: at(9),
          })
        )
      ).toBe(ApplyExternalOutcome.RejectedDeleted);

      const stored = await storedComment(scope, 1);
      expect(stored?.comment.deletedAt).not.toBeNull();
      expect(stored?.comment.plainText).toBe("body 1");
    });
  });

  it("revives a deleted comment from a complete reconcile list that still holds it", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      await outcome(scope, issueCommentEvent(1, { providerUpdatedAt: at(1) }));
      await outcome(scope, deleteEvent(1, at(2)));
      const listedAfterDelete = new Date(Date.now() + 1000);

      expect(
        await outcome(
          scope,
          issueCommentEvent(1, { providerUpdatedAt: at(2) }, listedAfterDelete)
        )
      ).toBe(ApplyExternalOutcome.Applied);

      const stored = await storedComment(scope, 1);
      expect(stored?.comment.deletedAt).toBeNull();
      expect(stored?.githubDeletedAt).toBeNull();
      expect(stored?.threadProjection.deletedAt).toBeNull();
    });
  });
});

describeIfDb("applyExternal — review summaries (decision 6)", () => {
  function summaryEvent(reviewId: number, body: string, submittedAt: Date) {
    return {
      kind: GitHubExternalEventKind.ReviewSummaryUpsert,
      reviewId,
      comment: externalComment(reviewId, {
        bodyMarkdown: body,
        providerUpdatedAt: submittedAt,
        createdAt: submittedAt,
      }),
    } as const;
  }

  it("stores a review body as its own thread with an artifact anchor, updated in place on edit", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      await outcome(scope, summaryEvent(70, "first", at(1)));
      await outcome(scope, summaryEvent(70, "edited", at(1)));

      const stored = await storedComment(scope, 70);
      expect(stored?.threadProjection.threadKind).toBe(
        GitHubCommentThreadKind.REVIEW_SUMMARY
      );
      expect(stored?.comment.plainText).toBe("edited");
      expect(stored?.threadProjection.thread).toEqual(
        expect.objectContaining({
          anchor: { v: 1, kind: CommentAnchorKind.Artifact },
          anchorState: CommentAnchorState.Anchored,
        })
      );
    });
  });

  it("stores two reviews from one reviewer as two threads", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await seed();
      await outcome(scope, summaryEvent(71, "one", at(1)));
      await outcome(scope, summaryEvent(72, "two", at(2)));

      const threads = await withDb((db) =>
        db.gitHubCommentThreadProjection.count({
          where: {
            branchArtifactId: scope.branchArtifactId,
            threadKind: GitHubCommentThreadKind.REVIEW_SUMMARY,
          },
        })
      );
      expect(threads).toBe(2);
    });
  });
});

describeIfDb(
  "applyExternal — code anchors (decision 7) and the C5 bridge",
  () => {
    it("stores a review comment GitHub no longer places on a line as OUTDATED at its original line", async () => {
      await autoRollbackTransaction(async () => {
        const scope = await seed();
        await outcome(
          scope,
          reviewThreadEvent(80, { line: null, originalLine: 12 })
        );

        const thread = (await storedComment(scope, 80))?.threadProjection
          .thread;
        expect(thread?.anchorState).toBe(CommentAnchorState.Outdated);
        expect(thread?.anchor).toEqual({
          v: 1,
          kind: CommentAnchorKind.Code,
          repository: GITHUB_TEST_REPOSITORY,
          commitSha: GITHUB_TEST_COMMIT_SHA,
          path: "src/app.ts",
          side: CodeCommentSide.Right,
          endLine: null,
          originalEndLine: 12,
        });
      });
    });

    it("ends with the anchor the service wrote when a later event moves the comment", async () => {
      await autoRollbackTransaction(async () => {
        const scope = await seed();
        await outcome(
          scope,
          reviewThreadEvent(81, { line: 10, originalLine: 10 })
        );
        // The service's rule (decision 7) calls a comment with no line
        // OUTDATED only when it has an original line, so this move stays
        // ANCHORED.
        await outcome(
          scope,
          reviewThreadEvent(81, { line: null, originalLine: null })
        );

        const thread = (await storedComment(scope, 81))?.threadProjection
          .thread;
        expect(thread?.anchorState).toBe(CommentAnchorState.Anchored);
        expect(thread?.anchor).toEqual(
          expect.objectContaining({
            kind: CommentAnchorKind.Code,
            endLine: null,
          })
        );
        expect(thread?.anchor).not.toHaveProperty("originalEndLine");
      });
    });
  }
);

describeIfDb("applyExternal — organization scoping", () => {
  it("never touches another organization's rows with the same GitHub ids", async () => {
    await autoRollbackTransaction(async () => {
      const orgA = await seed();
      const orgB = await seed();
      await outcome(orgB, issueCommentEvent(1, { bodyMarkdown: "org B" }));

      // A comment's external id is unique across organizations, so org A's
      // write of the same id is refused and its delete finds nothing to delete.
      expect(
        await outcome(
          orgA,
          issueCommentEvent(1, {
            bodyMarkdown: "org A",
            providerUpdatedAt: at(1),
          })
        )
      ).toBe(ApplyExternalOutcome.NoWrite);
      expect(await outcome(orgA, deleteEvent(1, at(2)))).toBe(
        ApplyExternalOutcome.NotFound
      );

      const inB = await storedComment(orgB, 1);
      expect(inB?.comment.plainText).toBe("org B");
      expect(inB?.comment.deletedAt).toBeNull();
    });
  });

  it("writes nothing when the branch and pull request are not this organization's", async () => {
    await autoRollbackTransaction(async () => {
      const orgA = await seed();
      const orgB = await seed();

      const result = await applyExternal(
        applyInput({ ...orgB, organizationId: orgA.organizationId }, [
          issueCommentEvent(1),
        ])
      );

      expect(result.outcomes).toEqual([ApplyExternalOutcome.NotFound]);
      expect(await storedComment(orgB, 1)).toBeNull();
    });
  });
});
