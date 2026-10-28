/**
 * ISS-12135: the Acme branch replay sends each base-seed session's activity
 * and its pull request's review conversation, the two steps that give those
 * branch pages cost, a trace and comments.
 */
import type { PrismaClient } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACME_SESSION_PLANS,
  replayAcmeBranches,
} from "../vibe-seed/github/acme-branches";
import { replayAcmeSessionActivity } from "../vibe-seed/github/acme-session-activity";
import { replayReviewConversation } from "../vibe-seed/github/review-comments";
import { readSeededBranches } from "../vibe-seed/github/seeded-branches";
import type { VibeSeedContext } from "../vibe-seed/stage";

vi.mock("../vibe-seed/github/acme-session-activity", () => ({
  replayAcmeSessionActivity: vi.fn(() => Promise.resolve()),
}));
vi.mock("../vibe-seed/github/review-comments", () => ({
  replayReviewConversation: vi.fn(() => Promise.resolve()),
}));
vi.mock("../vibe-seed/github/seeded-branches", () => ({
  readSeededBranches: vi.fn(),
}));
vi.mock("../vibe-seed/github/branch-evidence", () => ({
  replayBranchEvidence: vi.fn(() => Promise.resolve()),
}));
vi.mock("../vibe-seed/github/pr-reviews", () => ({
  replayPullRequestReviews: vi.fn(() => Promise.resolve(0)),
}));
vi.mock("../vibe-seed/github/branch-owner", () => ({
  assignBranchOwner: vi.fn(() => Promise.resolve()),
}));

const NOW = new Date("2026-10-07T12:00:00.000Z");

describe("replayAcmeBranches", () => {
  beforeEach(() => {
    vi.mocked(readSeededBranches).mockResolvedValue(
      ACME_SESSION_PLANS.map((plan, index) => ({
        artifactId: `branch-${index}`,
        projectId: null,
        repositoryId: "repository-1",
        repositoryGitHubId: 731_264_058,
        repositoryFullName: "acme-co/acme-web",
        branchName: plan.branchName,
        currentPullRequestDetailId: null,
        pullRequestIdsByNumber: new Map(),
      }))
    );
  });

  it("replays every plan's session activity and review conversation", async () => {
    await replayAcmeBranches(context());

    expect(
      vi
        .mocked(replayAcmeSessionActivity)
        .mock.calls.map(([, plan]) => plan.sessionName)
    ).toEqual(ACME_SESSION_PLANS.map((plan) => plan.sessionName));
    expect(
      vi
        .mocked(replayReviewConversation)
        .mock.calls.map(([, branch, work]) => [
          branch.branchName,
          work.branchName,
        ])
    ).toEqual(
      ACME_SESSION_PLANS.map((plan) => [plan.branchName, plan.branchName])
    );
  });
});

/** A context whose reads find each plan's session and nothing else. */
function context(): VibeSeedContext {
  const delegate = new Proxy(
    {},
    {
      get: (_target, method) => () =>
        Promise.resolve(answerFor(String(method))),
    }
  );
  const prisma = new Proxy({}, { get: () => delegate });
  return {
    prisma: prisma as PrismaClient,
    organizationId: "org-1",
    userId: "user-1",
    desktopStorePath: null,
    corpusShiftMs: 0,
    desktopAuth: null,
    now: NOW,
    log: () => undefined,
  };
}

function answerFor(method: string): unknown {
  if (method === "findMany") {
    return [];
  }
  if (method === "findFirst") {
    return { id: "session-1" };
  }
  if (method === "findUnique") {
    return null;
  }
  return { count: 0 };
}
