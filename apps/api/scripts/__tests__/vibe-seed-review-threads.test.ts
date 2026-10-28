/**
 * ISS-12135: the review thread on each seeded pull request is a comment and
 * the author's reply to that comment, not a reply picked for another one.
 */
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { VIBE_SEED_SIGNED_IN_LOGIN } from "@repo/api/src/vibe-seed-corpus";
import { describe, expect, it } from "vitest";
import { GitHubExternalEventKind } from "@/app/comments/service/github/apply-external-events";
import { reviewThread } from "../vibe-seed/github/review-comments";
import { FileChangeStatus } from "../vibe-seed/github/store-edits";
import { gitHubPerson } from "../vibe-seed/github/store-work";

const OPENED_AT = new Date("2026-10-01T09:00:00.000Z");
const NOW = new Date("2026-10-07T00:00:00.000Z");
const AUTHOR = gitHubPerson(VIBE_SEED_SIGNED_IN_LOGIN);
const REVIEWER = gitHubPerson("tlindqvist");
const REPOSITORY = "acme-co/acme-web";
const BRANCH = "feat/local-verify-command";

/** What the author says back to each review comment. */
const REPLY_TO: Readonly<Record<string, string>> = {
  "Could this get a focused test? The new path here isn't covered by the existing suite.":
    "Good call, added a test that goes through the new path.",
  "Nit: this reads more clearly as an early return.":
    "Done, it's an early return now.",
  "Is this safe when the value is unset? The caller upstream can pass it through empty.":
    "It can't be empty here (the parser rejects it first), but I added a guard so that's explicit.",
  "Can we keep the old name as an alias for one release so installed clients keep working?":
    "Kept the old name as an alias, with a note to remove it next release.",
  "This looks like the helper we already have in the shared module; worth importing that one instead?":
    "Yes, switched to the shared helper and deleted this copy.",
};

describe("reviewThread", () => {
  it("answers each review comment with the reply written for it", () => {
    const seen = new Set<string>();
    for (const number of [5504, 5505, 5506, 5507, 5508, 5509]) {
      const [thread] = reviewThread(conversation(number));
      if (thread?.event.kind !== GitHubExternalEventKind.ReviewThreadUpsert) {
        throw new Error(`#${number} has no review thread`);
      }
      const [comment, reply] = thread.event.comments;
      const body = comment?.bodyMarkdown ?? "";
      seen.add(body);
      expect(comment?.author?.login).toBe(REVIEWER.login);
      expect(reply?.author?.login).toBe(AUTHOR.login);
      expect(reply?.githubInReplyToCommentId).toBe(comment?.githubCommentId);
      expect(reply?.bodyMarkdown).toBe(REPLY_TO[body]);
    }
    expect(seen).toEqual(new Set(Object.keys(REPLY_TO)));
  });
});

function conversation(number: number) {
  return {
    branch: {
      artifactId: "branch-1",
      projectId: null,
      repositoryId: null,
      repositoryGitHubId: null,
      repositoryFullName: REPOSITORY,
      branchName: BRANCH,
      currentPullRequestDetailId: "pr-detail-1",
      pullRequestIdsByNumber: new Map([[number, "pr-detail-1"]]),
    },
    work: {
      repositoryFullName: REPOSITORY,
      branchName: BRANCH,
      author: AUTHOR,
      baseBranch: "main",
      commits: [],
      pushes: [],
      files: [
        {
          path: "scripts/verify.ts",
          status: FileChangeStatus.Added,
          additions: 12,
          deletions: 0,
          patch: "",
        },
      ],
      pullRequests: [],
    },
    pullRequest: {
      number,
      openedAt: OPENED_AT,
      facts: {
        title: "ACME-1772: Add a verify command that matches the PR checks",
        state: GitHubPRState.Open,
        isDraft: false,
        baseRef: "main",
      },
    },
    pullRequestDetailId: "pr-detail-1",
    reviewer: REVIEWER,
    now: NOW,
  };
}
