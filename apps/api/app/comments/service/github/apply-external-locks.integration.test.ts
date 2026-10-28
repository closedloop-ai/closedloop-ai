/**
 * ISS-11212 against a real Postgres: writers of one review thread serialize on
 * its root comment's lock, and a unique violation the pg adapter raises is one
 * the comment-write retry recognizes. Locks need separate connections, so this
 * suite commits and cleans up its organizations.
 */
import { ThreadSource, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyInput,
  externalComment,
  reviewThreadEvent,
  seedGitHubCommentScope,
  storedComment,
} from "@/__tests__/support/comments/github-apply-external.test-fixtures";
import {
  backendPid,
  PendingCallState,
  untilSettledOrBlockedBy,
} from "@/__tests__/support/comments/lock-wait.test-fixtures";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { applyExternal } from "./apply-external";
import { lockGitHubComments } from "./apply-external-context";
import { ApplyExternalOutcome } from "./apply-external-events";
import { isRetryableGitHubCommentWriteError } from "./github-comment-write-retry";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const organizations = createCommittedTestOrganizationTracker();

describeIfDb("applyExternal — review-thread locks", () => {
  afterEach(async () => {
    await organizations.cleanup();
  });

  it("queues a reply behind a writer holding its root's lock", async () => {
    const scope = await seedGitHubCommentScope(await organizations.create());
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: (pid: number) => void = () => undefined;
    const holding = new Promise<number>((resolve) => {
      locked = resolve;
    });
    const holder = withDb.tx(async (tx) => {
      await lockGitHubComments(tx, scope.organizationId, ["501"]);
      locked(await backendPid(tx));
      await released;
    });
    const holderPid = await holding;

    const reply = applyExternal(
      applyInput(scope, [
        {
          ...reviewThreadEvent(501, {
            comments: [externalComment(502, { githubInReplyToCommentId: 501 })],
          }),
          reviewThreadId: null,
          threadFieldsFromReply: true,
        },
      ])
    );
    const state = await untilSettledOrBlockedBy(reply, holderPid);
    release();
    await holder;

    expect(state).toBe(PendingCallState.Blocked);
    expect((await reply).outcomes).toEqual([ApplyExternalOutcome.Applied]);
    expect(await storedComment(scope, 502)).not.toBeNull();
  });
});

describeIfDb(
  "isRetryableGitHubCommentWriteError against the pg adapter",
  () => {
    afterEach(async () => {
      await organizations.cleanup();
    });

    it("recognizes a real duplicate thread external id", async () => {
      const scope = await seedGitHubCommentScope(await organizations.create());
      const thread = {
        organizationId: scope.organizationId,
        source: ThreadSource.GITHUB,
        externalId: "github-pr-thread:duplicate",
        artifactId: scope.branchArtifactId,
      };
      await withDb((db) =>
        db.commentThread.create({ data: thread, select: { id: true } })
      );

      const error = await withDb((db) =>
        db.commentThread.create({ data: thread, select: { id: true } })
      ).then(
        () => null,
        (caught: unknown) => caught
      );

      expect(error).not.toBeNull();
      expect(isRetryableGitHubCommentWriteError(error)).toBe(true);
    });
  }
);
