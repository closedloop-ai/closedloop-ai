/**
 * ISS-12135: the review conversation the vibe seed replays on a pull request
 * shows each commenter with their seeded avatar, never a real GitHub
 * account's picture.
 */
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyExternal } from "@/app/comments/service/github/apply-external";
import {
  ApplyExternalOutcome,
  type GitHubExternalComment,
  type GitHubExternalEvent,
  GitHubExternalEventKind,
} from "@/app/comments/service/github/apply-external-events";
import { vibeSeedAvatar } from "../vibe-seed/core/person-avatars";
import { replayReviewConversation } from "../vibe-seed/github/review-comments";
import type { SeededBranch } from "../vibe-seed/github/seeded-branches";
import { FileChangeStatus } from "../vibe-seed/github/store-edits";
import { type BranchWork, gitHubPerson } from "../vibe-seed/github/store-work";
import type { VibeSeedContext } from "../vibe-seed/stage";

vi.mock("@/app/comments/service/github/apply-external", () => ({
  applyExternal: vi.fn(),
}));
vi.mock("../vibe-seed/github/branch-activity", () => ({
  deliverBranchActivity: vi.fn(),
  seedDeliveryId: (...parts: readonly (string | number)[]) => parts.join(":"),
}));

const NOW = new Date("2026-10-07T00:00:00.000Z");
const OPENED_AT = new Date("2026-10-01T09:00:00.000Z");
const AUTHOR = gitHubPerson("dreyes");
const REVIEWER = gitHubPerson("gracechen");
const PULL_REQUEST_NUMBER = 4925;
const DETAIL_ID = "detail-1";

const CONTEXT = {
  organizationId: "org-1",
  now: NOW,
} as unknown as VibeSeedContext;

const BRANCH: SeededBranch = {
  artifactId: "branch-1",
  projectId: null,
  repositoryId: null,
  repositoryGitHubId: null,
  repositoryFullName: "acme-co/acme-web",
  branchName: "feat/shared-sync-order",
  currentPullRequestDetailId: DETAIL_ID,
  pullRequestIdsByNumber: new Map([[PULL_REQUEST_NUMBER, DETAIL_ID]]),
};

const WORK: BranchWork = {
  repositoryFullName: BRANCH.repositoryFullName,
  branchName: BRANCH.branchName,
  author: AUTHOR,
  baseBranch: "main",
  commits: [],
  pushes: [],
  files: [
    {
      path: "src/sync/order.ts",
      status: FileChangeStatus.Modified,
      additions: 12,
      deletions: 3,
      patch: "@@ -1 +1 @@",
    },
  ],
  pullRequests: [
    {
      number: PULL_REQUEST_NUMBER,
      openedAt: OPENED_AT,
      facts: {
        title: "Shared sync order",
        state: GitHubPRState.Open,
        isDraft: false,
        baseRef: "main",
      },
    },
  ],
};

describe("replayReviewConversation", () => {
  beforeEach(() => {
    vi.mocked(applyExternal).mockImplementation((input) =>
      Promise.resolve({
        outcomes: input.events.map(() => ApplyExternalOutcome.Applied),
        changedThreadIds: [],
      })
    );
  });

  it("gives every commenter their seeded avatar", async () => {
    await replayReviewConversation(CONTEXT, BRANCH, WORK, [AUTHOR, REVIEWER]);

    expect(applyExternal).toHaveBeenCalledTimes(1);
    const authors = (vi.mocked(applyExternal).mock.calls[0]?.[0].events ?? [])
      .flatMap(eventComments)
      .map((comment) => comment.author);
    expect(authors.map((author) => author?.login)).toEqual(
      expect.arrayContaining([AUTHOR.login, REVIEWER.login])
    );
    for (const author of authors) {
      expect(author?.avatar_url).toBe(vibeSeedAvatar(author?.login ?? ""));
      expect(author?.avatar_url).not.toBeNull();
    }
  });
});

function eventComments(event: GitHubExternalEvent): GitHubExternalComment[] {
  switch (event.kind) {
    case GitHubExternalEventKind.ReviewThreadUpsert:
      return event.comments;
    case GitHubExternalEventKind.IssueCommentUpsert:
    case GitHubExternalEventKind.ReviewSummaryUpsert:
      return [event.comment];
    default:
      return [];
  }
}
