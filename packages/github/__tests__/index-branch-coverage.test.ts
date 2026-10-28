import type { Octokit } from "@octokit/rest";
import {
  GitHubBundledPullRequestsStopReason,
  GitHubProviderBudgetState,
} from "@repo/api/src/types/github-read-model";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { mockDeleteInstallation, mockQueryBundled } = vi.hoisted(() => ({
  mockDeleteInstallation: vi.fn(),
  mockQueryBundled: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    apps = { deleteInstallation: mockDeleteInstallation };
  },
}));

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../bundled-pull-requests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../bundled-pull-requests")>()),
  queryBundledPullRequestsWithProviderResult: mockQueryBundled,
}));

import {
  deleteInstallation,
  GitHubProviderResultStatus,
  getRepositoryPullRequestsWithMetadata,
  verifyBranchExists,
} from "../index";

const OWNER = "acme";
const REPO = "widgets";

const ENV_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_WEBHOOK_SECRET",
  "GITHUB_APP_DISPATCH_REPO",
  "WEBAPP_ENV",
] as const;

const mockGraphql = vi.fn();
const mockGetBranch = vi.fn();
const octokit = {
  graphql: mockGraphql,
  rest: { repos: { getBranch: mockGetBranch } },
} as unknown as Octokit;

beforeEach(() => {
  vi.clearAllMocks();
  mockGraphql.mockReset();
  mockQueryBundled.mockReset();
});

describe("deleteInstallation", () => {
  const previousEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const key of ENV_KEYS) {
      previousEnv.set(key, process.env[key]);
    }
    process.env.GITHUB_APP_ID = "1";
    process.env.GITHUB_APP_PRIVATE_KEY = "test-key";
    process.env.GITHUB_APP_WEBHOOK_SECRET = "test-secret";
    process.env.GITHUB_APP_DISPATCH_REPO = "owner/dispatch";
    process.env.WEBAPP_ENV = "stage";
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = previousEnv.get(key);
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

  it("returns the provider error message when the delete fails", async () => {
    mockDeleteInstallation.mockRejectedValueOnce(new Error("Not Found"));

    await expect(deleteInstallation("77")).resolves.toEqual({
      success: false,
      error: "Not Found",
    });
    expect(mockDeleteInstallation).toHaveBeenCalledWith({
      installation_id: 77,
    });
  });

  it("reports Unknown error when the delete rejects with a non-Error", async () => {
    mockDeleteInstallation.mockRejectedValueOnce("boom");

    await expect(deleteInstallation("77")).resolves.toEqual({
      success: false,
      error: "Unknown error",
    });
  });
});

describe("getRepositoryPullRequestsWithMetadata", () => {
  it("throws with the provider status when the bundled read is not a success", async () => {
    mockQueryBundled.mockResolvedValueOnce({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });

    await expect(
      getRepositoryPullRequestsWithMetadata(octokit, OWNER, REPO)
    ).rejects.toThrow(
      `Failed to fetch pull requests: ${GitHubProviderResultStatus.ProviderUnavailable}`
    );
  });

  it("reports Unknown error when the bundled read rejects with a non-Error", async () => {
    mockQueryBundled.mockRejectedValueOnce("boom");

    await expect(
      getRepositoryPullRequestsWithMetadata(octokit, OWNER, REPO)
    ).rejects.toThrow("Failed to fetch pull requests: Unknown error");
  });

  it("defaults pageInfo, stopReason, and missingTargetNumbers when the provider omits them", async () => {
    mockQueryBundled.mockResolvedValueOnce({
      status: GitHubProviderResultStatus.Success,
      value: {
        pullRequests: [],
        rateLimit: {
          cost: 1,
          remaining: 4999,
          resetAt: null,
          state: GitHubProviderBudgetState.Available,
        },
      },
    });

    await expect(
      getRepositoryPullRequestsWithMetadata(octokit, OWNER, REPO)
    ).resolves.toEqual({
      pullRequests: [],
      hasMore: false,
      truncated: false,
      pageInfo: { hasNextPage: false, endCursor: null },
      stopReason: GitHubBundledPullRequestsStopReason.Complete,
      missingTargetNumbers: [],
    });
  });
});

describe("verifyBranchExists", () => {
  it("reports Unknown error when a non-404 failure is not an Error", async () => {
    mockGetBranch.mockRejectedValueOnce({ status: 500 });

    await expect(
      verifyBranchExists(octokit, OWNER, REPO, "feature/x")
    ).rejects.toThrow(
      `Failed to verify branch "feature/x" in ${OWNER}/${REPO}: Unknown error`
    );
  });
});
