import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import { afterEach, expect, it, vi } from "vitest";

const { getRepositoryPullRequestsWithMetadataMock } = vi.hoisted(() => ({
  getRepositoryPullRequestsWithMetadataMock: vi.fn(),
}));

vi.mock("@repo/github", () => ({
  getRepositoryPullRequestsWithMetadata:
    getRepositoryPullRequestsWithMetadataMock,
}));

vi.mock("uuid", () => ({ v7: () => "attempt-1" }));

const { readRepositoryPullRequestsWithAuthority } = await import(
  "./pull-request-list-read"
);

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("supplies one orderable live GraphQL authority context", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
  getRepositoryPullRequestsWithMetadataMock.mockResolvedValue({
    pullRequests: [],
  });
  const octokit = {} as Parameters<
    typeof readRepositoryPullRequestsWithAuthority
  >[0];

  await readRepositoryPullRequestsWithAuthority(
    octokit,
    "base-owner",
    "widget",
    { state: "all", limit: 30 },
    undefined
  );

  expect(getRepositoryPullRequestsWithMetadataMock).toHaveBeenCalledWith(
    octokit,
    "base-owner",
    "widget",
    { state: "all", limit: 30 },
    undefined,
    {
      mechanism: GitHubFetchMechanism.Graphql,
      trigger: GitHubFetchTrigger.SurfaceOpen,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey: "pull_request_graphql:attempt-1",
      observedAt: "2026-08-11T12:00:00.000Z",
    }
  );
});
