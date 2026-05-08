import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/github", () => ({
  getSinglePullRequest: vi.fn(),
  listPullRequestFiles: vi.fn(),
  listPullRequestIssueComments: vi.fn(),
  listPullRequestReviewComments: vi.fn(),
  listPullRequestReviews: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { buildStaleCommentDeleteWhere } from "./service";

describe("buildStaleCommentDeleteWhere", () => {
  it("deletes all comment rows when GitHub returns no comments", () => {
    expect(buildStaleCommentDeleteWhere("pr-1", new Set())).toEqual({
      pullRequestId: "pr-1",
    });
  });

  it("deletes only rows missing from the live GitHub comment set", () => {
    expect(
      buildStaleCommentDeleteWhere("pr-1", new Set(["101", "202"]))
    ).toEqual({
      pullRequestId: "pr-1",
      githubCommentId: { notIn: ["101", "202"] },
    });
  });
});
