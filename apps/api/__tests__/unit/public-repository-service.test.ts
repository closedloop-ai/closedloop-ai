import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

import { publicRepositoryService } from "@/app/integrations/github/public-repositories/service";

const ORG_ID = "org-1";
const REPO_ID = "repo-1";

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
};

describe("publicRepositoryService.addPublicRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns Result.err(Status.BadRequest) for an unparseable URL", async () => {
    const result = await publicRepositoryService.addPublicRepository(
      ORG_ID,
      "not-a-valid-github-url"
    );

    expect(result).toEqual({ ok: false, error: Status.BadRequest });
  });

  it("does not call the GitHub API when the URL cannot be parsed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await publicRepositoryService.addPublicRepository(ORG_ID, "just-a-name");

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns Result.err(Status.NotFound) when GitHub returns 404", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      mockGitHubApiResponse(404, { message: "Not Found" })
    );

    const result = await publicRepositoryService.addPublicRepository(
      ORG_ID,
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
      "github.com/acme/my-repo"
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/my-repo",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
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
