import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveExternalGitHubAuthorInTransaction = vi.hoisted(() => vi.fn());
vi.mock("@/app/comments/external-authors", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveExternalGitHubAuthorInTransaction,
}));

import { ExternalGitHubCollaboratorSourceKind } from "@/app/comments/external-authors";
import { ensurePullRequestAuthorIdentity } from "./pull-request-author-identity";

const tx = {} as Parameters<typeof ensurePullRequestAuthorIdentity>[0];
const input = {
  organizationId: "org-1",
  githubId: "pr-1",
  authorProviderUserId: "123",
  authorLogin: "alice",
  authorActorType: GitHubActorType.User,
} as const;

describe("ensurePullRequestAuthorIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps a measured PR author through the commenter identity owner", async () => {
    await ensurePullRequestAuthorIdentity(tx, input);

    expect(resolveExternalGitHubAuthorInTransaction).toHaveBeenCalledWith(tx, {
      organizationId: "org-1",
      author: {
        id: "123",
        login: "alice",
        actorType: GitHubActorType.User,
      },
      source: {
        sourceKind: ExternalGitHubCollaboratorSourceKind.PullRequestAuthor,
        githubObjectId: "pr-1",
      },
    });
  });

  it.each([
    { authorProviderUserId: undefined },
    { authorProviderUserId: "not-an-id" },
    { authorActorType: undefined },
    { authorActorType: GitHubActorType.Bot },
    { authorActorType: GitHubActorType.Unknown },
  ])("does not materialize an untrusted author %j", async (change) => {
    await ensurePullRequestAuthorIdentity(tx, { ...input, ...change });

    expect(resolveExternalGitHubAuthorInTransaction).not.toHaveBeenCalled();
  });
});
