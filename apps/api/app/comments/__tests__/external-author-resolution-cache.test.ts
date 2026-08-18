import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { beforeEach, describe, expect, it, vi } from "vitest";

const externalAuthorMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock("../external-authors", () => ({
  normalizeExternalGitHubAuthor: (
    author: { id?: number | null; actorType?: GitHubActorType } | null
  ) => ({
    providerUserId: String(author?.id ?? "ghost"),
    isGhost: author?.id == null,
    ...(author?.actorType ? { actorType: author.actorType } : {}),
  }),
  resolveExternalGitHubAuthorInTransaction: externalAuthorMocks.resolve,
}));

import { createExternalGitHubAuthorResolutionCache } from "../external-author-resolution-cache";

const SOURCE = {
  sourceKind: "issue_comment" as const,
  githubObjectId: "comment-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  externalAuthorMocks.resolve.mockResolvedValue({ marker: "resolved" });
});

describe("createExternalGitHubAuthorResolutionCache", () => {
  it.each([
    ["missing", undefined],
    ["unknown", GitHubActorType.Unknown],
  ])("re-resolves when %s evidence is followed by a known type", async (_label, initialActorType) => {
    const resolve = createExternalGitHubAuthorResolutionCache(
      {} as never,
      "org-1"
    );

    await resolve(githubAuthor(initialActorType), SOURCE);
    await resolve(githubAuthor(GitHubActorType.Bot), SOURCE);

    expect(externalAuthorMocks.resolve).toHaveBeenCalledTimes(2);
    expect(externalAuthorMocks.resolve).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.objectContaining({
        author: expect.objectContaining({ actorType: GitHubActorType.Bot }),
      })
    );
  });

  it("reuses a known resolution when later evidence is missing", async () => {
    const resolve = createExternalGitHubAuthorResolutionCache(
      {} as never,
      "org-1"
    );

    await resolve(githubAuthor(GitHubActorType.User), SOURCE);
    await resolve(githubAuthor(undefined), SOURCE);

    expect(externalAuthorMocks.resolve).toHaveBeenCalledTimes(1);
  });
});

function githubAuthor(actorType: GitHubActorType | undefined) {
  return {
    id: 501,
    login: "octocat",
    ...(actorType ? { actorType } : {}),
  };
}
