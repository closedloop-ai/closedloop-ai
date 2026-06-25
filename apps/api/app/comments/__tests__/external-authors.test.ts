import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const databaseMocks = vi.hoisted(() => {
  const withDb = vi.fn() as Mock & { tx: Mock };
  withDb.tx = vi.fn();

  return { withDb };
});

vi.mock("@repo/database", () => ({
  ExternalCommentProvider: { GITHUB: "GITHUB" },
  withDb: databaseMocks.withDb,
}));

import { ExternalCommentProvider } from "@repo/database";
import {
  normalizeExternalGitHubAuthor,
  type ResolveExternalGitHubAuthorInput,
  resolveExternalGitHubAuthor,
} from "../external-authors";

const ORGANIZATION_ID = "org-1";
const SOURCE = {
  sourceKind: "issue_comment",
  githubObjectId: "9001",
  repositoryId: "repo-1",
  pullNumber: 42,
} satisfies ResolveExternalGitHubAuthorInput["source"];

type MockDb = ReturnType<typeof makeMockDb>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("normalizeExternalGitHubAuthor", () => {
  it("normalizes numeric GitHub ids and login casing", () => {
    const identity = normalizeExternalGitHubAuthor(
      {
        id: " 12345 ",
        node_id: "MDQ6VXNlcjE=",
        login: " OctoCat ",
        avatar_url: " https://avatars.example/octocat.png ",
        html_url: " https://github.com/OctoCat ",
      },
      SOURCE
    );

    expect(identity).toEqual({
      provider: ExternalCommentProvider.GITHUB,
      providerUserId: "12345",
      providerNodeId: "MDQ6VXNlcjE=",
      providerLogin: "OctoCat",
      normalizedLogin: "octocat",
      displayName: "OctoCat",
      avatarUrl: "https://avatars.example/octocat.png",
      profileUrl: "https://github.com/OctoCat",
      isGhost: false,
    });
  });

  it("falls back to the GitHub node id when the numeric id is missing", () => {
    const identity = normalizeExternalGitHubAuthor(
      {
        id: null,
        node_id: "node-123",
        login: "Mona",
        avatar_url: null,
        html_url: null,
      },
      SOURCE
    );

    expect(identity).toMatchObject({
      providerUserId: "node:node-123",
      providerNodeId: "node-123",
      providerLogin: "Mona",
      normalizedLogin: "mona",
      isGhost: false,
    });
  });

  it("uses non-empty string GitHub ids before node fallback", () => {
    const identity = normalizeExternalGitHubAuthor(
      {
        id: "opaque-github-id",
        node_id: "node-123",
        login: "Mona",
        avatar_url: null,
        html_url: null,
      },
      SOURCE
    );

    expect(identity).toMatchObject({
      providerUserId: "opaque-github-id",
      providerNodeId: "node-123",
      providerLogin: "Mona",
      normalizedLogin: "mona",
      isGhost: false,
    });
  });

  it("builds a source-scoped ghost identity for nullable GitHub users", () => {
    const identity = normalizeExternalGitHubAuthor(null, {
      sourceKind: "review",
      githubObjectId: "review-1",
    });

    expect(identity).toEqual({
      provider: ExternalCommentProvider.GITHUB,
      providerUserId: "ghost:review:review-1",
      providerNodeId: null,
      providerLogin: "unknown-github-user",
      normalizedLogin: "unknown-github-user",
      displayName: "Unknown GitHub user",
      avatarUrl: null,
      profileUrl: null,
      isGhost: true,
    });
  });
});

describe("resolveExternalGitHubAuthor", () => {
  it("uses an active GitHub user connection before creating shadows", async () => {
    const linkedUser = makeUser({ id: "linked-user", active: true });
    const db = makeMockDb();
    db.gitHubUserConnection.findFirst.mockResolvedValue({
      user: linkedUser,
    });
    db.externalCommentAuthor.upsert.mockResolvedValue(
      makeExternalAuthor({ userId: linkedUser.id, user: linkedUser })
    );
    installDb(db);

    const result = await resolveExternalGitHubAuthor({
      organizationId: ORGANIZATION_ID,
      author: githubAuthor({ id: 123, login: "OctoCat" }),
      source: SOURCE,
    });

    expect(result.source).toBe("github_user_connection");
    expect(result.user).toEqual(linkedUser);
    expect(db.gitHubUserConnection.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ORGANIZATION_ID,
        revokedAt: null,
        user: { active: true },
        OR: [{ githubUserId: "123" }],
      },
      select: { user: { select: expect.any(Object) } },
    });
    expect(db.user.upsert).not.toHaveBeenCalled();
  });

  it("creates a deterministic inactive shadow user when no trusted match exists", async () => {
    const db = makeMockDb();
    const shadowUser = makeShadowUser("123", "octocat");
    db.user.upsert.mockResolvedValue(shadowUser);
    db.externalCommentAuthor.upsert.mockResolvedValue(
      makeExternalAuthor({ userId: shadowUser.id, user: shadowUser })
    );
    installDb(db);

    const result = await resolveExternalGitHubAuthor({
      organizationId: ORGANIZATION_ID,
      author: githubAuthor({
        id: 123,
        login: "OctoCat",
        avatar_url: "https://avatars.example/octocat.png",
      }),
      source: SOURCE,
    });

    expect(result.source).toBe("shadow_user");
    expect(db.user.upsert).toHaveBeenCalledWith({
      where: {
        clerkId_organizationId: {
          clerkId: "github-shadow:org-1:123",
          organizationId: ORGANIZATION_ID,
        },
      },
      create: expect.objectContaining({
        clerkId: "github-shadow:org-1:123",
        email: "github-shadow+org-1+123@invalid.closedloop.local",
        active: false,
        role: "ENGINEER",
        firstName: "OctoCat",
        lastName: "GitHub",
        githubUsername: "octocat",
        avatarUrl: "https://avatars.example/octocat.png",
      }),
      update: expect.objectContaining({
        active: false,
        firstName: "OctoCat",
        githubUsername: "octocat",
      }),
      select: expect.any(Object),
    });
    expect(result.user).toEqual(shadowUser);
  });

  it("does not trust ambiguous username-only local matches", async () => {
    const db = makeMockDb();
    db.user.findMany = vi
      .fn()
      .mockResolvedValue([
        makeUser({ id: "local-user-1", githubUsername: "octocat" }),
        makeUser({ id: "local-user-2", githubUsername: "octocat" }),
      ]);
    const shadowUser = makeShadowUser("123", "octocat");
    db.user.upsert.mockResolvedValue(shadowUser);
    db.externalCommentAuthor.upsert.mockResolvedValue(
      makeExternalAuthor({ userId: shadowUser.id, user: shadowUser })
    );
    installDb(db);

    const result = await resolveExternalGitHubAuthor({
      organizationId: ORGANIZATION_ID,
      author: githubAuthor({ id: 123, login: "octocat" }),
      source: SOURCE,
    });

    expect(result.source).toBe("shadow_user");
    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(db.user.upsert).toHaveBeenCalled();
  });

  it("creates a shadow when a linked GitHub identity is inactive", async () => {
    const db = makeMockDb();
    const shadowUser = makeShadowUser("123", "octocat");
    db.user.upsert.mockResolvedValue(shadowUser);
    db.externalCommentAuthor.upsert.mockResolvedValue(
      makeExternalAuthor({ userId: shadowUser.id, user: shadowUser })
    );
    installDb(db);

    await resolveExternalGitHubAuthor({
      organizationId: ORGANIZATION_ID,
      author: githubAuthor({ id: 123, login: "octocat" }),
      source: SOURCE,
    });

    const [connectionArgs] = db.gitHubUserConnection.findFirst.mock.calls[0];
    expect(connectionArgs).toMatchObject({
      where: {
        organizationId: ORGANIZATION_ID,
        revokedAt: null,
        user: { active: true },
        OR: [{ githubUserId: "123" }],
      },
    });
    expect(db.user.upsert).toHaveBeenCalled();
  });

  it("persists node fallback identity fields on the external author", async () => {
    const db = makeMockDb();
    const shadowUser = makeShadowUser("node:node-123", "mona");
    db.user.upsert.mockResolvedValue(shadowUser);
    db.externalCommentAuthor.upsert.mockResolvedValue(
      makeExternalAuthor({
        providerUserId: "node:node-123",
        providerNodeId: "node-123",
        userId: shadowUser.id,
        user: shadowUser,
      })
    );
    installDb(db);

    await resolveExternalGitHubAuthor({
      organizationId: ORGANIZATION_ID,
      author: githubAuthor({ id: null, node_id: "node-123", login: "Mona" }),
      source: SOURCE,
    });

    expect(db.externalCommentAuthor.upsert).toHaveBeenCalledWith({
      where: {
        organizationId_provider_providerUserId: {
          organizationId: ORGANIZATION_ID,
          provider: ExternalCommentProvider.GITHUB,
          providerUserId: "node:node-123",
        },
      },
      create: expect.objectContaining({
        providerUserId: "node:node-123",
        providerNodeId: "node-123",
        providerLogin: "Mona",
        normalizedProviderLogin: "mona",
      }),
      update: expect.objectContaining({
        providerUserId: "node:node-123",
        providerNodeId: "node-123",
        lastSeenAt: expect.any(Date),
      }),
      select: expect.any(Object),
    });
  });

  it("matches node fallback authors against OAuth githubNodeId", async () => {
    const linkedUser = makeUser({ id: "linked-user", active: true });
    const db = makeMockDb();
    db.gitHubUserConnection.findFirst.mockResolvedValue({
      user: linkedUser,
    });
    db.externalCommentAuthor.upsert.mockResolvedValue(
      makeExternalAuthor({
        providerUserId: "node:node-123",
        providerNodeId: "node-123",
        userId: linkedUser.id,
        user: linkedUser,
      })
    );
    installDb(db);

    const result = await resolveExternalGitHubAuthor({
      organizationId: ORGANIZATION_ID,
      author: githubAuthor({ id: null, node_id: "node-123", login: "Mona" }),
      source: SOURCE,
    });

    expect(result.source).toBe("github_user_connection");
    expect(db.gitHubUserConnection.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ORGANIZATION_ID,
        revokedAt: null,
        user: { active: true },
        OR: [{ githubUserId: "node:node-123" }, { githubNodeId: "node-123" }],
      },
      select: { user: { select: expect.any(Object) } },
    });
    expect(result.user).toEqual(linkedUser);
  });

  it("creates a deterministic ghost shadow for nullable authors", async () => {
    const db = makeMockDb();
    const shadowUser = makeShadowUser(
      "ghost:review_comment:comment-123",
      "unknown-github-user"
    );
    db.user.upsert.mockResolvedValue(shadowUser);
    db.externalCommentAuthor.upsert.mockResolvedValue(
      makeExternalAuthor({
        providerUserId: "ghost:review_comment:comment-123",
        providerLogin: "unknown-github-user",
        displayName: "Unknown GitHub user",
        userId: shadowUser.id,
        user: shadowUser,
      })
    );
    installDb(db);

    await resolveExternalGitHubAuthor({
      organizationId: ORGANIZATION_ID,
      author: null,
      source: {
        sourceKind: "review_comment",
        githubObjectId: "comment-123",
      },
    });

    expect(db.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clerkId_organizationId: {
            clerkId: "github-shadow:org-1:ghost:review_comment:comment-123",
            organizationId: ORGANIZATION_ID,
          },
        },
        create: expect.objectContaining({
          email:
            "github-shadow+org-1+ghost:review_comment:comment-123@invalid.closedloop.local",
          active: false,
          firstName: "unknown-github-user",
          githubUsername: "unknown-github-user",
          avatarUrl: null,
        }),
      })
    );
    expect(db.externalCommentAuthor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          providerUserId: "ghost:review_comment:comment-123",
          providerLogin: "unknown-github-user",
          normalizedProviderLogin: "unknown-github-user",
          displayName: "Unknown GitHub user",
          avatarUrl: null,
          profileUrl: null,
        }),
      })
    );
  });

  it("reuses an existing external comment author deterministically", async () => {
    const existingUser = makeShadowUser("123", "octocat");
    const existingAuthor = makeExternalAuthor({
      providerUserId: "123",
      userId: existingUser.id,
      user: existingUser,
    });
    const db = makeMockDb();
    db.externalCommentAuthor.findUnique.mockResolvedValue(existingAuthor);
    db.externalCommentAuthor.upsert.mockResolvedValue(existingAuthor);
    installDb(db);

    const result = await resolveExternalGitHubAuthor({
      organizationId: ORGANIZATION_ID,
      author: githubAuthor({ id: 123, login: "octocat" }),
      source: SOURCE,
    });

    expect(result.source).toBe("external_comment_author");
    expect(result.externalAuthor).toEqual(existingAuthor);
    expect(result.user).toEqual(existingUser);
    expect(db.user.upsert).not.toHaveBeenCalled();
    expect(db.externalCommentAuthor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          userId: existingUser.id,
          lastSeenAt: expect.any(Date),
        }),
      })
    );
  });

  it("repoints existing inactive real-user authors to deterministic shadow users", async () => {
    const inactiveRealUser = makeUser({
      id: "inactive-real-user",
      active: false,
      clerkId: "clerk-former-user",
      githubUsername: "octocat",
    });
    const shadowUser = makeShadowUser("123", "octocat");
    const existingAuthor = makeExternalAuthor({
      providerUserId: "123",
      userId: inactiveRealUser.id,
      user: inactiveRealUser,
    });
    const db = makeMockDb();
    db.externalCommentAuthor.findUnique.mockResolvedValue(existingAuthor);
    db.user.upsert.mockResolvedValue(shadowUser);
    db.externalCommentAuthor.upsert.mockResolvedValue(
      makeExternalAuthor({
        providerUserId: "123",
        userId: shadowUser.id,
        user: shadowUser,
      })
    );
    installDb(db);

    const result = await resolveExternalGitHubAuthor({
      organizationId: ORGANIZATION_ID,
      author: githubAuthor({ id: 123, login: "octocat" }),
      source: SOURCE,
    });

    expect(result.source).toBe("shadow_user");
    expect(result.user).toEqual(shadowUser);
    expect(db.user.upsert).toHaveBeenCalled();
    expect(db.externalCommentAuthor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ userId: shadowUser.id }),
      })
    );
  });

  it("does not let a local githubUsername impersonate an external author", async () => {
    const db = makeMockDb();
    db.user.findFirst = vi
      .fn()
      .mockResolvedValue(
        makeUser({ id: "local-user", githubUsername: "mona" })
      );
    const shadowUser = makeShadowUser("456", "mona");
    db.user.upsert.mockResolvedValue(shadowUser);
    db.externalCommentAuthor.upsert.mockResolvedValue(
      makeExternalAuthor({ userId: shadowUser.id, user: shadowUser })
    );
    installDb(db);

    const result = await resolveExternalGitHubAuthor({
      organizationId: ORGANIZATION_ID,
      author: githubAuthor({ id: 456, login: "mona" }),
      source: SOURCE,
    });

    expect(result.source).toBe("shadow_user");
    expect(db.user.findFirst).not.toHaveBeenCalled();
    expect(result.user.id).toBe(shadowUser.id);
  });
});

function installDb(db: MockDb) {
  databaseMocks.withDb.tx.mockImplementation((fn: (tx: MockDb) => unknown) =>
    fn(db)
  );
}

function makeMockDb() {
  return {
    gitHubUserConnection: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    externalCommentAuthor: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
    },
    user: {
      upsert: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  };
}

function githubAuthor(
  overrides: Partial<NonNullable<ResolveExternalGitHubAuthorInput["author"]>>
) {
  return {
    id: 123,
    node_id: "node-123",
    login: "octocat",
    avatar_url: "https://avatars.example/user.png",
    html_url: "https://github.com/octocat",
    ...overrides,
  };
}

function makeUser(
  overrides: Partial<{
    id: string;
    clerkId: string;
    organizationId: string;
    active: boolean;
    email: string;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
    githubUsername: string | null;
  }> = {}
) {
  return {
    id: "user-1",
    clerkId: "clerk-user-1",
    organizationId: ORGANIZATION_ID,
    active: true,
    email: "user@example.com",
    firstName: "User",
    lastName: "One",
    avatarUrl: null,
    githubUsername: null,
    ...overrides,
  };
}

function makeShadowUser(providerUserId: string, githubUsername: string) {
  return makeUser({
    id: `shadow-${providerUserId}`,
    clerkId: `github-shadow:${ORGANIZATION_ID}:${providerUserId}`,
    active: false,
    email: `github-shadow+${ORGANIZATION_ID}+${providerUserId}@invalid.closedloop.local`,
    firstName: githubUsername,
    lastName: "GitHub",
    githubUsername,
  });
}

function makeExternalAuthor(
  overrides: Partial<{
    id: string;
    organizationId: string;
    provider: typeof ExternalCommentProvider.GITHUB;
    providerUserId: string;
    providerNodeId: string | null;
    providerLogin: string;
    normalizedProviderLogin: string;
    displayName: string;
    avatarUrl: string | null;
    profileUrl: string | null;
    userId: string;
    user: ReturnType<typeof makeUser> | null;
  }> = {}
) {
  return {
    id: "external-author-1",
    organizationId: ORGANIZATION_ID,
    provider: ExternalCommentProvider.GITHUB,
    providerUserId: "123",
    providerNodeId: "node-123",
    providerLogin: "octocat",
    normalizedProviderLogin: "octocat",
    displayName: "octocat",
    avatarUrl: "https://avatars.example/user.png",
    profileUrl: "https://github.com/octocat",
    userId: "user-1",
    user: null,
    ...overrides,
  };
}
