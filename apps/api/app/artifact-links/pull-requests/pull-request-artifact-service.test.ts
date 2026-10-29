import { GitHubPRState } from "@repo/api/src/types/github";
import {
  GitHubActorType,
  type GitHubActorType as GitHubActorTypeValue,
} from "@repo/api/src/types/github-actor";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import type {
  CreatePrArtifactInput,
  PullRequestArtifactLinkResult,
} from "@repo/api/src/types/pull-request-artifact-link";
import { PullRequestLabelSyncStatus } from "@repo/api/src/types/pull-request-label-sync-status";
import {
  type RepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
  repositoryDefaultAuthorityValidator,
} from "@repo/api/src/types/repository-default-identity";
import { Result, Status } from "@repo/api/src/types/result";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { GitHubInstallationStatus } from "@repo/database";
import type * as GitHubModule from "@repo/github";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findAssertionMismatch,
  PullRequestAssertionField,
  pullRequestArtifactLinkService,
} from "./pull-request-artifact-service";
import {
  isSafeRepositorySegment,
  parseGitHubPullRequestUrl,
} from "./pull-request-url";

const {
  mockBranchService,
  mockGetInstallationOctokit,
  mockGetSinglePullRequest,
  mockLoadProjectPrLinkRepositories,
  mockOctokit,
  mockSyncPullRequestLabelsFromArtifactTags,
  mockWithDb,
} = vi.hoisted(() => ({
  mockBranchService: {
    upsertBranchArtifact: vi.fn(),
  },
  mockGetInstallationOctokit: vi.fn(),
  mockGetSinglePullRequest: vi.fn(),
  mockLoadProjectPrLinkRepositories: vi.fn(),
  mockOctokit: { marker: "installation-octokit" },
  mockSyncPullRequestLabelsFromArtifactTags: vi.fn(),
  mockWithDb: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  GitHubInstallationStatus: {
    ACTIVE: "ACTIVE",
  },
  withDb: mockWithDb,
}));

vi.mock("@repo/github", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubModule>();
  return {
    getSinglePullRequest: mockGetSinglePullRequest,
    // Real classifier and status const: the client acquisition behind this
    // service folds a failed mint through them.
    GitHubProviderResultStatus: actual.GitHubProviderResultStatus,
  };
});

vi.mock("@repo/github/installation-auth", () => ({
  // Spy wrapper (not a bare vi.fn implementation) so restore/reset passes can
  // never strip the marker client the service threads into the PR read.
  getInstallationOctokit: (installationId: string) =>
    mockGetInstallationOctokit(installationId) ?? Promise.resolve(mockOctokit),
}));

vi.mock("@/app/branches/branch-service", () => ({
  branchService: mockBranchService,
}));

vi.mock("@/app/projects/repository-resolver", () => ({
  loadProjectPrLinkRepositories: mockLoadProjectPrLinkRepositories,
}));

vi.mock("@/lib/github/pull-request-label-sync", () => ({
  syncPullRequestLabelsFromArtifactTags:
    mockSyncPullRequestLabelsFromArtifactTags,
}));

// ---------------------------------------------------------------------------
// parseGitHubPullRequestUrl
// ---------------------------------------------------------------------------

describe("parseGitHubPullRequestUrl", () => {
  it.each([
    [
      "canonical PR URL",
      "https://github.com/acme/my-repo/pull/42",
      { owner: "acme", repo: "my-repo", number: 42, fullName: "acme/my-repo" },
    ],
    [
      "PR with trailing slash is accepted",
      "https://github.com/acme/my-repo/pull/1/",
      { owner: "acme", repo: "my-repo", number: 1, fullName: "acme/my-repo" },
    ],
    [
      "owner/repo with dots and hyphens",
      "https://github.com/my-org/repo.name/pull/99",
      {
        owner: "my-org",
        repo: "repo.name",
        number: 99,
        fullName: "my-org/repo.name",
      },
    ],
    [
      "PR number 1 (smallest valid)",
      "https://github.com/org/repo/pull/1",
      { owner: "org", repo: "repo", number: 1, fullName: "org/repo" },
    ],
  ])("parses valid %s", (_label, input, expected) => {
    expect(parseGitHubPullRequestUrl(input)).toEqual(expected);
  });

  it.each([
    ["http (non-https)", "http://github.com/acme/repo/pull/1"],
    ["non-github host", "https://gitlab.com/acme/repo/pull/1"],
    [
      "embedded userinfo (SSRF)",
      "https://user:pass@github.com/acme/repo/pull/1",
    ],
    ["embedded username only", "https://user@github.com/acme/repo/pull/1"],
    ["PR number zero", "https://github.com/acme/repo/pull/0"],
    ["missing /pull/ segment", "https://github.com/acme/repo/issues/1"],
    ["too many path segments", "https://github.com/acme/repo/pull/1/files"],
    ["missing repo segment", "https://github.com/acme/pull/1"],
    ["percent-encoded owner", "https://github.com/ac%2Fme/repo/pull/1"],
    ["empty string", ""],
    ["not a URL", "not-a-url"],
    ["javascript: scheme", "javascript:alert(1)"],
    ["data: URI", "data:text/html,<h1>xss</h1>"],
    ["ftp scheme", "ftp://github.com/acme/repo/pull/1"],
  ])("returns null for %s", (_label, input) => {
    expect(parseGitHubPullRequestUrl(input)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isSafeRepositorySegment
// ---------------------------------------------------------------------------

describe("isSafeRepositorySegment", () => {
  it.each([
    ["simple name", "acme"],
    ["name with hyphen", "my-org"],
    ["name with underscore", "my_repo"],
    ["name with dot", "repo.js"],
    ["name with digits", "org123"],
    ["mixed alphanumeric", "Abc-Def_123.ghi"],
  ])("accepts %s", (_label, input) => {
    expect(isSafeRepositorySegment(input)).toBe(true);
  });

  it.each([
    ["percent-encoded slash", "ac%2Fme"],
    ["percent-encoded dot", "re%2Eme"],
    ["percent-encoded at-sign", "re%40me"],
    ["forward slash", "ac/me"],
    ["control character NUL", "abc\x00def"],
    ["control character DEL (0x7F)", "abc\x7fdef"],
    ["control character 0x01", "abc\x01def"],
    ["empty string", ""],
    ["invalid percent sequence", "%GG"],
    ["space", "my org"],
    ["at-sign", "@org"],
  ])("rejects %s", (_label, input) => {
    expect(isSafeRepositorySegment(input)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findAssertionMismatch
// ---------------------------------------------------------------------------

type LivePR = {
  githubId: string;
  number: number;
  title: string;
  htmlUrl: string;
  headBranch: string;
  baseBranch: string;
  state: (typeof GitHubPRState)[keyof typeof GitHubPRState];
  createdAt: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  authorLogin: string | null;
  authorProviderUserId?: string;
  authorActorType?: GitHubActorTypeValue;
  isDraft: boolean;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  headRepository?: RepositoryDefaultAuthority;
};

function makeLivePr(overrides: Partial<LivePR> = {}): LivePR {
  return {
    githubId: "PR_kwDOA1234",
    number: 42,
    title: "feat: add thing",
    htmlUrl: "https://github.com/acme/repo/pull/42",
    headBranch: "feature-branch",
    baseBranch: "main",
    state: GitHubPRState.Open,
    createdAt: null,
    mergedAt: null,
    closedAt: null,
    authorLogin: "alice",
    authorProviderUserId: "123",
    authorActorType: GitHubActorType.User,
    isDraft: false,
    headSha: "deadbeef",
    baseSha: "cafebabe",
    mergeCommitSha: null,
    headRepository: repositoryAuthority(),
    ...overrides,
  };
}

function repositoryAuthority(
  overrides: { providerRepositoryId?: string; fullName?: string } = {}
): RepositoryDefaultAuthority {
  return repositoryDefaultAuthorityValidator.parse({
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: overrides.providerRepositoryId ?? "123",
      fullName: overrides.fullName ?? "acme/repo",
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Available,
      completeness: RepositoryDefaultCompleteness.Complete,
      defaultBranch: "main",
    },
    provenance: {
      source: RepositoryDefaultSource.PullRequestRest,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.UserAction,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey: "manual-link-authority",
      observedAt: "2026-08-11T12:00:00.000Z",
    },
  });
}

function makeBody(
  overrides: Partial<CreatePrArtifactInput> = {}
): CreatePrArtifactInput {
  return {
    projectId: "00000000-0000-0000-0000-000000000001",
    title: "feat: add thing",
    externalUrl: "https://github.com/acme/repo/pull/42",
    number: 42,
    githubId: "PR_kwDOA1234",
    headBranch: "feature-branch",
    baseBranch: "main",
    state: GitHubPRState.Open,
    headSha: "deadbeef",
    isDraft: false,
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    ...overrides,
  };
}

describe("findAssertionMismatch", () => {
  it("returns null when all required and optional fields match", () => {
    expect(findAssertionMismatch(makeBody(), makeLivePr())).toBeNull();
  });

  it("returns 'githubId' when required githubId does not match", () => {
    expect(
      findAssertionMismatch(makeBody({ githubId: "WRONG_ID" }), makeLivePr())
    ).toBe("githubId");
  });

  it("returns 'number' when required number does not match", () => {
    expect(findAssertionMismatch(makeBody({ number: 99 }), makeLivePr())).toBe(
      "number"
    );
  });

  it("returns 'state' when required state does not match", () => {
    expect(
      findAssertionMismatch(
        makeBody({ state: GitHubPRState.Closed }),
        makeLivePr({ state: GitHubPRState.Open })
      )
    ).toBe("state");
  });

  it("returns 'headSha' when optional headSha is provided and does not match", () => {
    expect(
      findAssertionMismatch(
        makeBody({ headSha: "wrongsha" }),
        makeLivePr({ headSha: "deadbeef" })
      )
    ).toBe("headSha");
  });

  it("returns null when optional headSha is undefined (not asserted)", () => {
    const body = makeBody();
    const { headSha: _removed, ...bodyWithoutHeadSha } = body;
    expect(
      findAssertionMismatch(
        bodyWithoutHeadSha as CreatePrArtifactInput,
        makeLivePr({ headSha: "anything" })
      )
    ).toBeNull();
  });

  it("returns 'isDraft' when optional isDraft does not match", () => {
    expect(
      findAssertionMismatch(
        makeBody({ isDraft: true }),
        makeLivePr({ isDraft: false })
      )
    ).toBe("isDraft");
  });

  it("returns 'closedAt' when optional closedAt iso strings do not match", () => {
    expect(
      findAssertionMismatch(
        makeBody({ closedAt: "2024-01-01T00:00:00.000Z" }),
        makeLivePr({ closedAt: "2024-06-01T00:00:00.000Z" })
      )
    ).toBe("closedAt");
  });

  it("returns null when closedAt strings represent the same instant in different formats", () => {
    // Both normalize to the same ISO string via new Date().toISOString()
    expect(
      findAssertionMismatch(
        makeBody({ closedAt: "2024-01-01T00:00:00.000Z" }),
        makeLivePr({ closedAt: "2024-01-01T00:00:00.000Z" })
      )
    ).toBeNull();
  });

  it("returns 'mergeCommitSha' when optional mergeCommitSha does not match", () => {
    expect(
      findAssertionMismatch(
        makeBody({ mergeCommitSha: "aaaaaa" }),
        makeLivePr({ mergeCommitSha: "bbbbbb" })
      )
    ).toBe("mergeCommitSha");
  });

  it("checks required fields before optional fields (githubId mismatch shadows headSha mismatch)", () => {
    expect(
      findAssertionMismatch(
        makeBody({ githubId: "WRONG", headSha: "alsowrong" }),
        makeLivePr()
      )
    ).toBe("githubId");
  });
});

describe("pullRequestArtifactLinkService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithDb.mockResolvedValue({
      id: "project-1",
      settings: {},
    });
    mockLoadProjectPrLinkRepositories.mockResolvedValue([
      {
        installationRepositoryId: "repo-1",
        fullName: "acme/repo",
      },
    ]);
    mockBranchService.upsertBranchArtifact.mockResolvedValue(
      Result.ok(branchUpsertValue())
    );
  });

  it("rejects tombstoned repositories before live PR fetch and artifact creation", async () => {
    const repositoryDb = {
      gitHubInstallationRepository: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    mockWithDb
      .mockResolvedValueOnce({ id: "project-1", settings: {} })
      .mockImplementationOnce((callback) => callback(repositoryDb));

    const result =
      await pullRequestArtifactLinkService.createPullRequestArtifact({
        body: makeBody(),
        createdById: "user-1",
        organizationId: "org-1",
      });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(Status.NotFound);
    }
    expect(
      repositoryDb.gitHubInstallationRepository.findFirst
    ).toHaveBeenCalledWith({
      where: {
        id: "repo-1",
        fullName: "acme/repo",
        removedAt: null,
        installation: {
          organizationId: "org-1",
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: {
        id: true,
        githubRepoId: true,
        fullName: true,
        owner: true,
        name: true,
        installation: { select: { installationId: true } },
      },
    });
    expect(mockGetSinglePullRequest).not.toHaveBeenCalled();
    expect(mockBranchService.upsertBranchArtifact).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ISS-4664 — implementing artifact's tags propagate onto the linked PR
// ---------------------------------------------------------------------------

describe("pullRequestArtifactLinkService label propagation", () => {
  const SOURCE_ARTIFACT_ID = "00000000-0000-0000-0000-0000000000aa";
  /**
   * ISS-4759: the link owner is a DIFFERENT artifact from the tag source — the
   * plan owns the produces-relationship while the implementing issue owns the
   * tags — so the fixtures must not collapse them into one id.
   */
  const LINK_SOURCE_ARTIFACT_ID = "00000000-0000-0000-0000-0000000000bb";

  function installHappyPath() {
    const repositoryDb = {
      gitHubInstallationRepository: {
        findFirst: vi.fn().mockResolvedValue({
          id: "repo-1",
          githubRepoId: "123",
          fullName: "acme/repo",
          owner: "acme",
          name: "repo",
          installation: { installationId: "install-9" },
        }),
      },
    };
    mockWithDb
      .mockResolvedValueOnce({ id: "project-1", settings: {} })
      .mockImplementationOnce((callback) => callback(repositoryDb));
    mockLoadProjectPrLinkRepositories.mockResolvedValue([
      { installationRepositoryId: "repo-1", fullName: "acme/repo" },
    ]);
    mockGetSinglePullRequest.mockResolvedValue(makeLivePr());
    mockBranchService.upsertBranchArtifact.mockResolvedValue(
      Result.ok(branchUpsertValue())
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockSyncPullRequestLabelsFromArtifactTags.mockResolvedValue({
      status: PullRequestLabelSyncStatus.Applied,
      createdLabels: [],
      addedLabels: ["infra"],
      droppedLabels: [],
    });
  });

  it("applies the source artifact's tags synchronously at link creation", async () => {
    installHappyPath();

    const result =
      await pullRequestArtifactLinkService.createPullRequestArtifact({
        body: makeBody({ sourceArtifactId: SOURCE_ARTIFACT_ID }),
        createdById: "user-1",
        organizationId: "org-1",
      });

    expect(result.ok).toBe(true);
    expect(mockSyncPullRequestLabelsFromArtifactTags).toHaveBeenCalledWith({
      organizationId: "org-1",
      // ISS-4759: the project travels with the request so the tag source can be
      // constrained to it rather than to the org alone.
      projectId: "00000000-0000-0000-0000-000000000001",
      artifactId: SOURCE_ARTIFACT_ID,
      installationId: "install-9",
      owner: "acme",
      repo: "repo",
      repositoryFullName: "acme/repo",
      pullNumber: 42,
    });
    expect(mockGetSinglePullRequest).toHaveBeenCalledWith(
      mockOctokit,
      "acme",
      "repo",
      42,
      expect.objectContaining({
        trigger: GitHubFetchTrigger.UserAction,
        credentialType: GitHubFetchCredentialType.GitHubApp,
      })
    );
  });

  /**
   * ISS-10995: `body.projectId` is the project the USER picked in the Select-PR
   * dialog, so this producer files the branch unconditionally — the fill-only
   * rule the 2026-10-12 ruling set is the SYNC's. With `projectFillOnly` here,
   * selecting a PR whose head branch is already filed elsewhere would answer
   * 200 for a move the service dropped.
   */
  it("asks for an unconditional project write, never the sync's fill", async () => {
    installHappyPath();

    const result =
      await pullRequestArtifactLinkService.createPullRequestArtifact({
        body: makeBody(),
        createdById: "user-1",
        organizationId: "org-1",
      });

    expect(result.ok).toBe(true);
    expect(mockBranchService.upsertBranchArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "00000000-0000-0000-0000-000000000001",
      }),
      undefined
    );
    expect(
      mockBranchService.upsertBranchArtifact.mock.calls[0]?.[0]
    ).not.toHaveProperty("projectFillOnly");
  });

  it("uses fork-head authority for Branch identity while retaining base PR context", async () => {
    installHappyPath();
    const forkAuthority = repositoryAuthority({
      providerRepositoryId: "123",
      fullName: "contributor/repo",
    });
    mockGetSinglePullRequest.mockResolvedValue(
      makeLivePr({ headRepository: forkAuthority })
    );

    const result =
      await pullRequestArtifactLinkService.createPullRequestArtifact({
        body: makeBody(),
        createdById: "user-1",
        organizationId: "org-1",
      });

    expect(result.ok).toBe(true);
    expect(mockBranchService.upsertBranchArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: null,
        repositoryFullName: "contributor/repo",
        pullRequestRepositoryId: "repo-1",
        repositoryDefaultObservation: { authority: forkAuthority },
        pullRequest: expect.objectContaining({
          authorLogin: "alice",
          authorProviderUserId: "123",
          authorActorType: GitHubActorType.User,
        }),
      }),
      undefined
    );
  });

  it("fails closed when a fresh REST PR omits head-repository authority", async () => {
    installHappyPath();
    mockGetSinglePullRequest.mockResolvedValue(
      makeLivePr({ headRepository: undefined })
    );

    const result =
      await pullRequestArtifactLinkService.createPullRequestArtifact({
        body: makeBody(),
        createdById: "user-1",
        organizationId: "org-1",
      });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.metadata?.code).toBe(
        "pull_request_head_repository_unavailable"
      );
    }
    expect(mockBranchService.upsertBranchArtifact).not.toHaveBeenCalled();
  });

  // ISS-4764: the response used to be `{ id }`, so the dialog toast read the
  // same whether the labels landed or GitHub quietly refused them.
  it("reports the label sync outcome in the response", async () => {
    installHappyPath();
    mockSyncPullRequestLabelsFromArtifactTags.mockResolvedValue({
      status: PullRequestLabelSyncStatus.Failed,
      createdLabels: [],
      addedLabels: [],
      droppedLabels: [],
    });

    const result =
      await pullRequestArtifactLinkService.createPullRequestArtifact({
        body: makeBody({ sourceArtifactId: SOURCE_ARTIFACT_ID }),
        createdById: "user-1",
        organizationId: "org-1",
      });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.labelSync?.status).toBe(
        PullRequestLabelSyncStatus.Failed
      );
    }
  });

  it("omits labelSync entirely when propagation was not requested", async () => {
    installHappyPath();

    const result =
      await pullRequestArtifactLinkService.createPullRequestArtifact({
        body: makeBody(),
        createdById: "user-1",
        organizationId: "org-1",
      });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Absent, never `null` — an older client sees the exact previous shape.
      expect("labelSync" in result.value).toBe(false);
    }
  });

  // ISS-4759: the PRODUCES link must be written INSIDE the branch transaction,
  // not by a second client request that can simply never happen.
  it("passes the link owner into the branch transaction and echoes it back", async () => {
    installHappyPath();
    // ISS-10169: the echo now follows the WRITE's report, so the branch upsert
    // has to actually report the edge. Before this change the mock could return
    // no link at all and the echo appeared anyway, which is the defect.
    mockBranchService.upsertBranchArtifact.mockResolvedValue(
      Result.ok(branchUpsertValue({ linkedArtifacts: [WRITTEN_LINK] }))
    );

    const result =
      await pullRequestArtifactLinkService.createPullRequestArtifact({
        body: makeBody({
          sourceArtifactId: SOURCE_ARTIFACT_ID,
          linkSourceArtifactId: LINK_SOURCE_ARTIFACT_ID,
        }),
        createdById: "user-1",
        organizationId: "org-1",
      });

    expect(mockBranchService.upsertBranchArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ sourceArtifactId: LINK_SOURCE_ARTIFACT_ID }),
      undefined
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.linkedSourceArtifactId).toBe(LINK_SOURCE_ARTIFACT_ID);
      // The per-input result array is the half a caller can verify against.
      expect(result.value.linkedArtifacts).toEqual([WRITTEN_LINK]);
    }
  });

  it("makes no GitHub mutation when the branch transaction fails", async () => {
    installHappyPath();
    // A rejected link owner rolls the whole transaction back, so no
    // relationship is committed — and nothing may be written to GitHub.
    mockBranchService.upsertBranchArtifact.mockResolvedValue(
      Result.err(Status.Forbidden)
    );

    const result =
      await pullRequestArtifactLinkService.createPullRequestArtifact({
        body: makeBody({
          sourceArtifactId: SOURCE_ARTIFACT_ID,
          linkSourceArtifactId: LINK_SOURCE_ARTIFACT_ID,
        }),
        createdById: "user-1",
        organizationId: "org-1",
      });

    expect(result.ok).toBe(false);
    expect(mockSyncPullRequestLabelsFromArtifactTags).not.toHaveBeenCalled();
  });

  it("omits the link echo for an older client that sends no link owner", async () => {
    installHappyPath();

    const result =
      await pullRequestArtifactLinkService.createPullRequestArtifact({
        body: makeBody({ sourceArtifactId: SOURCE_ARTIFACT_ID }),
        createdById: "user-1",
        organizationId: "org-1",
      });

    expect(mockBranchService.upsertBranchArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ sourceArtifactId: null }),
      undefined
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // No echo tells that client it still has to write the link itself.
      expect("linkedSourceArtifactId" in result.value).toBe(false);
    }
  });

  it("still succeeds when label propagation fails", async () => {
    // The branch artifact is already committed by this point, so a GitHub or
    // tag-read failure must never turn a successful link into a 5xx.
    installHappyPath();
    mockSyncPullRequestLabelsFromArtifactTags.mockRejectedValue(
      new Error("github unavailable")
    );

    const result =
      await pullRequestArtifactLinkService.createPullRequestArtifact({
        body: makeBody({ sourceArtifactId: SOURCE_ARTIFACT_ID }),
        createdById: "user-1",
        organizationId: "org-1",
      });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe("branch-artifact-1");
    }
    expect(mockSyncPullRequestLabelsFromArtifactTags).toHaveBeenCalledTimes(1);
  });

  it("skips label propagation for an older client that omits sourceArtifactId", async () => {
    installHappyPath();

    const result =
      await pullRequestArtifactLinkService.createPullRequestArtifact({
        body: makeBody(),
        createdById: "user-1",
        organizationId: "org-1",
      });

    expect(result.ok).toBe(true);
    expect(mockSyncPullRequestLabelsFromArtifactTags).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ISS-10169 — the response reports the write, not the request
// ---------------------------------------------------------------------------

describe("pullRequestArtifactLinkService write reporting", () => {
  const LINK_SOURCE_ARTIFACT_ID = "00000000-0000-0000-0000-0000000000bb";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT echo a link the branch write did not report", async () => {
    installLinkReportingHappyPath();
    // A branch transaction that committed the branch but wrote no edge. This is
    // the exact shape the endpoint used to report as a success carrying
    // `linkedSourceArtifactId` — the caller's own request, handed back.
    mockBranchService.upsertBranchArtifact.mockResolvedValue(
      Result.ok(branchUpsertValue({ linkedArtifacts: [] }))
    );

    const result =
      await pullRequestArtifactLinkService.createPullRequestArtifact({
        body: makeBody({ linkSourceArtifactId: LINK_SOURCE_ARTIFACT_ID }),
        createdById: "user-1",
        organizationId: "org-1",
      });

    // Asserted on the OUTCOME, not on a mock: a write that linked zero rows
    // must not return success at all.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.metadata?.code).toBe(
        "pull_request_source_link_not_written"
      );
    }
  });

  it("omits the echo when the write reported an edge for a DIFFERENT owner", async () => {
    installLinkReportingHappyPath();
    // The discriminating case for where the echo comes FROM. The write reported
    // an edge, so the zero-link guard does not fire — but it is not the owner
    // this request asked for. An echo built from the request would still name
    // LINK_SOURCE_ARTIFACT_ID here and read as "committed"; one built from the
    // write cannot. Nothing else in this file can tell those two apart.
    mockBranchService.upsertBranchArtifact.mockResolvedValue(
      Result.ok(
        branchUpsertValue({
          linkedArtifacts: [
            {
              sourceArtifactId: "00000000-0000-0000-0000-0000000000dd",
              linkId: "00000000-0000-0000-0000-0000000000ee",
            },
          ],
        })
      )
    );

    const result =
      await pullRequestArtifactLinkService.createPullRequestArtifact({
        body: makeBody({ linkSourceArtifactId: LINK_SOURCE_ARTIFACT_ID }),
        createdById: "user-1",
        organizationId: "org-1",
      });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Absent, never null — an older client must see the previous shape.
      expect("linkedSourceArtifactId" in result.value).toBe(false);
      // And the edge that WAS written is still reported, truthfully.
      // One entry, carrying that id — asserted as the whole array rather than
      // by index, which pins the same two facts without indexing a field the
      // response type now declares optional for version skew (ISS-10169).
      expect(result.value.linkedArtifacts).toEqual([
        expect.objectContaining({
          sourceArtifactId: "00000000-0000-0000-0000-0000000000dd",
        }),
      ]);
    }
  });

  it("reports a REUSED branch artifact and the pull request it carries", async () => {
    installLinkReportingHappyPath();
    // The mode-6 shape: a branch that predates this pull request, returned by
    // the identity upsert. Legitimate, and indistinguishable from a fresh one
    // in the old `{ id }` response.
    mockBranchService.upsertBranchArtifact.mockResolvedValue(
      Result.ok(
        branchUpsertValue({
          created: false,
          pullRequest: {
            number: 42,
            htmlUrl: "https://github.com/acme/repo/pull/42",
          },
        })
      )
    );

    const result =
      await pullRequestArtifactLinkService.createPullRequestArtifact({
        body: makeBody(),
        createdById: "user-1",
        organizationId: "org-1",
      });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.branchArtifactCreated).toBe(false);
      // Number AND url: the identifying pair a caller can confirm the returned
      // entity against without a second request.
      expect(result.value.currentPullRequest).toEqual({
        number: 42,
        htmlUrl: "https://github.com/acme/repo/pull/42",
      });
      // Present and empty, never absent: the emptiness is the answer to "did
      // you link anything", and omitting it would restore the ambiguity.
      expect(result.value.linkedArtifacts).toEqual([]);
    }
  });

  it("names the project and the remedy when no primary repository is configured", async () => {
    mockWithDb.mockResolvedValueOnce({
      id: "project-1",
      name: "Observability 2.0",
      settings: {},
    });
    mockLoadProjectPrLinkRepositories.mockResolvedValue([]);

    const result =
      await pullRequestArtifactLinkService.createPullRequestArtifact({
        body: makeBody(),
        createdById: "user-1",
        organizationId: "org-1",
      });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The project, so a caller holding several knows WHICH one is
      // unconfigured, and the remedy, so the message can be acted on.
      expect(result.error.message).toContain("Observability 2.0");
      expect(result.error.message).toContain("project-1");
      expect(result.error.message).toContain("primary");
      expect(result.error.metadata?.code).toBe(
        "project_primary_repository_missing"
      );
    }
    expect(mockBranchService.upsertBranchArtifact).not.toHaveBeenCalled();
  });

  it("names the expected FORM of githubId when the assertion fails", async () => {
    installLinkReportingHappyPath();
    // A GraphQL node id where the numeric REST id is expected — the mismatch
    // two lanes hit, which used to come back as a bare "did not match".
    mockGetSinglePullRequest.mockResolvedValue(
      makeLivePr({ githubId: "2847113905" })
    );

    const result =
      await pullRequestArtifactLinkService.createPullRequestArtifact({
        body: makeBody({ githubId: "PR_kwDOAbCdEf6XyZ12" }),
        createdById: "user-1",
        organizationId: "org-1",
      });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.metadata?.details).toEqual({
        field: PullRequestAssertionField.GithubId,
      });
      // The actionable half: which field, and what it should have looked like.
      expect(result.error.message).toContain(
        PullRequestAssertionField.GithubId
      );
      expect(result.error.message).toContain("NUMERIC REST id");
    }
    expect(mockBranchService.upsertBranchArtifact).not.toHaveBeenCalled();
  });
});

/** The branch upsert's real return shape, with only the fields under test set. */
function branchUpsertValue(
  overrides: {
    created?: boolean;
    linkedArtifacts?: PullRequestArtifactLinkResult[];
    pullRequest?: { number: number; htmlUrl: string | null } | null;
  } = {}
) {
  return {
    id: "branch-artifact-1",
    created: overrides.created ?? true,
    linkedArtifacts: overrides.linkedArtifacts ?? [],
    pullRequest: overrides.pullRequest ?? null,
  };
}

/** The repository + live-PR path, for the ISS-10169 reporting cases. */
function installLinkReportingHappyPath() {
  const repositoryDb = {
    gitHubInstallationRepository: {
      findFirst: vi.fn().mockResolvedValue({
        id: "repo-1",
        githubRepoId: "123",
        fullName: "acme/repo",
        owner: "acme",
        name: "repo",
        installation: { installationId: "install-9" },
      }),
    },
  };
  mockWithDb
    .mockResolvedValueOnce({ id: "project-1", name: "Acme", settings: {} })
    .mockImplementationOnce((callback) => callback(repositoryDb));
  mockLoadProjectPrLinkRepositories.mockResolvedValue([
    { installationRepositoryId: "repo-1", fullName: "acme/repo" },
  ]);
  mockGetSinglePullRequest.mockResolvedValue(makeLivePr());
  mockBranchService.upsertBranchArtifact.mockResolvedValue(
    Result.ok(branchUpsertValue())
  );
}

/** The one edge the ISS-4759 happy path writes. */
const WRITTEN_LINK: PullRequestArtifactLinkResult = {
  sourceArtifactId: "00000000-0000-0000-0000-0000000000bb",
  linkId: "00000000-0000-0000-0000-0000000000cc",
};
