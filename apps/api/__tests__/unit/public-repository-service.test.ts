import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { RepositoryDefaultAvailability } from "@repo/api/src/types/repository-default-identity";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall } from "../utils/db-helpers";

const { mockGetGitHubClient } = vi.hoisted(() => ({
  mockGetGitHubClient: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@/lib/github/github-client-resolver", () => ({
  getGitHubClient: mockGetGitHubClient,
}));

import {
  AddPublicRepositoryErrorCode,
  publicRepositoryService,
} from "@/app/integrations/github/public-repositories/service";
import { GitHubAccessIntent } from "@/lib/github/github-access";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const REPO_ID = "repo-1";
const REPOSITORY_REST_OBSERVATION_KEY_PATTERN = /^repository_rest:/;

function mockGitHubApiResponse(
  status: number,
  body: unknown
): ReturnType<typeof global.fetch> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

function mockGitHubHtmlResponse(
  status: number,
  body: string
): ReturnType<typeof global.fetch> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  } as Response);
}

function buildGitHubBranchesPageHtml({
  page = 1,
  hasMore = false,
  defaultBranch = "main",
  branches,
}: {
  page?: number;
  hasMore?: boolean;
  defaultBranch?: string;
  branches: Array<{
    name: string;
    authoredDate: string;
    isDefault: boolean;
  }>;
}) {
  return `<html><body><script type="application/json" data-target="react-app.embeddedData">${JSON.stringify(
    {
      payload: {
        current_page: page,
        has_more: hasMore,
        per_page: 20,
        branches,
      },
      appPayload: {
        repo: {
          defaultBranch,
        },
      },
    }
  )}</script></body></html>`;
}

const GITHUB_REPO_RESPONSE = {
  id: 12_345,
  full_name: "acme/my-repo",
  name: "my-repo",
  owner: { login: "acme" },
  html_url: "https://github.com/acme/my-repo",
  private: false,
  default_branch: "trunk",
};

describe("publicRepositoryService.addPublicRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no usable user credential — the resolver denies and the service
    // falls back to the unauthenticated read (behavior-preserving path).
    mockGetGitHubClient.mockResolvedValue({
      ok: false,
      error: { reason: GitHubAccessDenialReason.NotConnected },
    });
  });

  it("returns Result.err(Status.BadRequest) for an unparseable URL", async () => {
    const result = await publicRepositoryService.addPublicRepository(
      ORG_ID,
      USER_ID,
      "not-a-valid-github-url"
    );

    expect(result).toEqual({ ok: false, error: Status.BadRequest });
  });

  it("does not call GitHub or the resolver when the URL cannot be parsed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await publicRepositoryService.addPublicRepository(
      ORG_ID,
      USER_ID,
      "just-a-name"
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockGetGitHubClient).not.toHaveBeenCalled();
  });

  it("returns Result.err(Status.NotFound) when GitHub returns 404", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockGitHubApiResponse(404, { message: "Not Found" })
    );

    const result = await publicRepositoryService.addPublicRepository(
      ORG_ID,
      USER_ID,
      "https://github.com/acme/nonexistent-repo"
    );

    expect(result).toEqual({ ok: false, error: Status.NotFound });
  });

  it("returns Result.err(Status.Error) when GitHub returns a non-404 error", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockGitHubApiResponse(500, { message: "Internal Server Error" })
    );

    const result = await publicRepositoryService.addPublicRepository(
      ORG_ID,
      USER_ID,
      "https://github.com/acme/my-repo"
    );

    expect(result).toEqual({ ok: false, error: Status.Error });
  });

  it("creates a DB record and returns Result.ok(repo) when GitHub returns 200", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockGitHubApiResponse(200, GITHUB_REPO_RESPONSE)
    );

    const createdRepo = {
      id: REPO_ID,
      organizationId: ORG_ID,
      githubRepoId: "12345",
      fullName: "acme/my-repo",
      name: "my-repo",
      owner: "acme",
      htmlUrl: "https://github.com/acme/my-repo",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockDb = {
      publicRepository: {
        create: vi.fn().mockResolvedValue(createdRepo),
      },
    };
    mockWithDbCall(mockDb);

    const result = await publicRepositoryService.addPublicRepository(
      ORG_ID,
      USER_ID,
      "https://github.com/acme/my-repo"
    );

    expect(result).toEqual({ ok: true, value: createdRepo });
    expect(mockDb.publicRepository.create).toHaveBeenCalledWith({
      data: {
        organizationId: ORG_ID,
        githubRepoId: "12345",
        fullName: "acme/my-repo",
        name: "my-repo",
        owner: "acme",
        htmlUrl: "https://github.com/acme/my-repo",
        defaultBranchName: "trunk",
        defaultBranchAvailability: RepositoryDefaultAvailability.Available,
        defaultBranchCompleteness: "complete",
        defaultBranchReason: null,
        defaultBranchSource: "repository_rest",
        defaultBranchMechanism: "rest",
        defaultBranchTrigger: "user_action",
        defaultBranchCredentialType: "unauthenticated",
        defaultBranchCredentialOwnerId: null,
        defaultBranchObservationKey: expect.stringMatching(
          REPOSITORY_REST_OBSERVATION_KEY_PATTERN
        ),
        defaultBranchObservedAt: expect.any(Date),
        defaultBranchEventAt: null,
      },
    });
  });

  it("calls the GitHub API with the correct headers and endpoint", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValue(mockGitHubApiResponse(200, GITHUB_REPO_RESPONSE));

    const mockDb = {
      publicRepository: {
        create: vi.fn().mockResolvedValue({ id: REPO_ID } as any),
      },
    };
    mockWithDbCall(mockDb);

    await publicRepositoryService.addPublicRepository(
      ORG_ID,
      USER_ID,
      "github.com/acme/my-repo"
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/my-repo",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
      }
    );
  });

  it("reads through the requesting user's resolver client when one resolves", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const mockReposGet = vi.fn().mockResolvedValue({
      data: {
        id: 12_345,
        full_name: "acme/my-repo",
        name: "my-repo",
        owner: { login: "acme" },
        html_url: "https://github.com/acme/my-repo",
        private: false,
        default_branch: "trunk",
      },
    });
    mockGetGitHubClient.mockResolvedValue({
      ok: true,
      value: { octokit: { rest: { repos: { get: mockReposGet } } } },
    });

    const createdRepo = { id: REPO_ID };
    const mockDb = {
      publicRepository: {
        create: vi.fn().mockResolvedValue(createdRepo),
      },
    };
    mockWithDbCall(mockDb);

    const result = await publicRepositoryService.addPublicRepository(
      ORG_ID,
      USER_ID,
      "https://github.com/acme/my-repo"
    );

    expect(result).toEqual({ ok: true, value: createdRepo });
    expect(mockGetGitHubClient).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      userId: USER_ID,
      target: { owner: "acme", repo: "my-repo" },
      intent: GitHubAccessIntent.ReadAsUser,
    });
    expect(mockReposGet).toHaveBeenCalledWith({
      owner: "acme",
      repo: "my-repo",
      headers: { "X-GitHub-Api-Version": "2026-03-10" },
    });
    // The authenticated path never touches the unauthenticated 60/hr budget.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a private repo on the unauthenticated lane with the not-public code", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockGitHubApiResponse(200, { ...GITHUB_REPO_RESPONSE, private: true })
    );

    const result = await publicRepositoryService.addPublicRepository(
      ORG_ID,
      USER_ID,
      "https://github.com/acme/my-repo"
    );

    expect(result).toEqual({
      ok: false,
      error: AddPublicRepositoryErrorCode.RepositoryNotPublic,
    });
  });

  it("refuses a private repo visible to the user's credential", async () => {
    const mockReposGet = vi.fn().mockResolvedValue({
      data: {
        id: 999,
        full_name: "acme/secret-repo",
        name: "secret-repo",
        owner: { login: "acme" },
        html_url: "https://github.com/acme/secret-repo",
        private: true,
      },
    });
    mockGetGitHubClient.mockResolvedValue({
      ok: true,
      value: { octokit: { rest: { repos: { get: mockReposGet } } } },
    });

    const result = await publicRepositoryService.addPublicRepository(
      ORG_ID,
      USER_ID,
      "https://github.com/acme/secret-repo"
    );

    // Distinct from the unparseable-URL failure above: the URL was fine, the
    // repository was not.
    expect(result).toEqual({
      ok: false,
      error: AddPublicRepositoryErrorCode.RepositoryNotPublic,
    });
  });

  it("maps a user-lane 404 to NotFound without falling back", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockGetGitHubClient.mockResolvedValue({
      ok: true,
      value: {
        octokit: {
          rest: {
            repos: {
              get: vi
                .fn()
                .mockRejectedValue(
                  Object.assign(new Error("Not Found"), { status: 404 })
                ),
            },
          },
        },
      },
    });

    const result = await publicRepositoryService.addPublicRepository(
      ORG_ID,
      USER_ID,
      "https://github.com/acme/gone-repo"
    );

    expect(result).toEqual({ ok: false, error: Status.NotFound });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("publicRepositoryService.removePublicRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls deleteMany scoped to the organization and record id", async () => {
    const mockDb = {
      publicRepository: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockWithDbCall(mockDb);

    await publicRepositoryService.removePublicRepository(ORG_ID, REPO_ID);

    expect(mockDb.publicRepository.deleteMany).toHaveBeenCalledWith({
      where: { id: REPO_ID, organizationId: ORG_ID },
    });
  });
});

describe("publicRepositoryService.getPublicRepositories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns repositories ordered by createdAt descending", async () => {
    const repos = [
      { id: "r2", organizationId: ORG_ID, fullName: "acme/b" },
      { id: "r1", organizationId: ORG_ID, fullName: "acme/a" },
    ];

    const mockDb = {
      publicRepository: {
        findMany: vi.fn().mockResolvedValue(repos),
      },
    };
    mockWithDbCall(mockDb);

    const result = await publicRepositoryService.getPublicRepositories(ORG_ID);

    expect(result).toEqual(repos);
    expect(mockDb.publicRepository.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID },
      orderBy: { createdAt: "desc" },
    });
  });

  it("returns an empty array when no repositories exist for the organization", async () => {
    const mockDb = {
      publicRepository: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    mockWithDbCall(mockDb);

    const result = await publicRepositoryService.getPublicRepositories(ORG_ID);

    expect(result).toEqual([]);
  });
});

describe("publicRepositoryService.getBranches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns active public branches with the default branch pinned first", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockGitHubHtmlResponse(
        200,
        buildGitHubBranchesPageHtml({
          defaultBranch: "main",
          branches: [
            {
              name: "feature",
              authoredDate: "2026-05-12T10:00:00.000Z",
              isDefault: false,
            },
            {
              name: "main",
              authoredDate: "2026-05-10T10:00:00.000Z",
              isDefault: true,
            },
          ],
        })
      )
    );

    const mockDb = {
      publicRepository: {
        findFirst: vi.fn().mockResolvedValue({
          id: REPO_ID,
          organizationId: ORG_ID,
          owner: "acme",
          name: "my-repo",
          fullName: "acme/my-repo",
        }),
      },
    };
    mockWithDbCall(mockDb);

    const result = await publicRepositoryService.getBranches(REPO_ID, ORG_ID);

    expect(result).toEqual({
      branches: [
        {
          name: "main",
          committedDate: "2026-05-10T10:00:00.000Z",
          isDefault: true,
        },
        {
          name: "feature",
          committedDate: "2026-05-12T10:00:00.000Z",
          isDefault: false,
        },
      ],
    });
  });

  it("fetches additional pages when the requested limit exceeds the first page", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      .mockReturnValueOnce(
        mockGitHubHtmlResponse(
          200,
          buildGitHubBranchesPageHtml({
            page: 1,
            hasMore: true,
            defaultBranch: "main",
            branches: Array.from({ length: 20 }, (_, index) => ({
              name: `branch-${index + 1}`,
              authoredDate: `2026-05-12T${String(index).padStart(
                2,
                "0"
              )}:00:00.000Z`,
              isDefault: false,
            })),
          })
        )
      )
      .mockReturnValueOnce(
        mockGitHubHtmlResponse(
          200,
          buildGitHubBranchesPageHtml({
            page: 2,
            hasMore: false,
            defaultBranch: "main",
            branches: [
              {
                name: "main",
                authoredDate: "2026-05-01T10:00:00.000Z",
                isDefault: true,
              },
              {
                name: "branch-21",
                authoredDate: "2026-05-01T09:00:00.000Z",
                isDefault: false,
              },
            ],
          })
        )
      );

    const mockDb = {
      publicRepository: {
        findFirst: vi.fn().mockResolvedValue({
          id: REPO_ID,
          organizationId: ORG_ID,
          owner: "acme",
          name: "my-repo",
          fullName: "acme/my-repo",
        }),
      },
    };
    mockWithDbCall(mockDb);

    const result = await publicRepositoryService.getBranches(
      REPO_ID,
      ORG_ID,
      21
    );

    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "https://github.com/acme/my-repo/branches/active?page=1",
      {
        headers: {
          Accept: "text/html,application/xhtml+xml",
        },
      }
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "https://github.com/acme/my-repo/branches/active?page=2",
      {
        headers: {
          Accept: "text/html,application/xhtml+xml",
        },
      }
    );
    expect(result.branches).toHaveLength(21);
    expect(result.branches[0]).toEqual({
      name: "main",
      committedDate: "2026-05-01T10:00:00.000Z",
      isDefault: true,
    });
  });

  it("throws when the public repository record does not belong to the organization", async () => {
    const mockDb = {
      publicRepository: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    mockWithDbCall(mockDb);

    await expect(
      publicRepositoryService.getBranches(REPO_ID, ORG_ID)
    ).rejects.toThrow("Repository not found");
  });
});
