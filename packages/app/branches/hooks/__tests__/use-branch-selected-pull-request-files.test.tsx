import {
  type BranchSelectedPullRequestDiffResponse,
  type BranchSelectedPullRequestFilesResponse,
  BranchSelectedPullRequestReadAvailability,
  BranchSelectedPullRequestUnavailableSource,
} from "@repo/api/src/types/branch-selected-pull-request-files";
import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LONG_RUNNING_API_TIMEOUT_MS } from "../../../shared/api/api-timeout";

const mocks = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: mocks.apiGet }),
}));

import { branchSelectedPullRequestQueryKeys } from "../branch-query-keys";
import {
  type BranchSelectedPullRequestDiffHookInput,
  useBranchSelectedPullRequestDiff,
  useBranchSelectedPullRequestFiles,
} from "../use-branch-selected-pull-request-files";

const BRANCH_ID = "11111111-1111-4111-8111-111111111111";
const REPOSITORY_FULL_NAME = "closedloop-ai/symphony-alpha";
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

describe("selected pull request query keys", () => {
  it("binds source, cache, PR, file, and immutable revision identity", () => {
    const identity = { cacheScope: "org:acme" };
    expect(
      branchSelectedPullRequestQueryKeys.files(
        "http",
        identity,
        BRANCH_ID,
        REPOSITORY_FULL_NAME,
        4471
      )
    ).toEqual([
      "branches",
      "selected-pull-request",
      "files",
      "http",
      "org:acme",
      BRANCH_ID,
      REPOSITORY_FULL_NAME,
      4471,
    ]);
    expect(
      branchSelectedPullRequestQueryKeys.diff(
        "http",
        identity,
        BRANCH_ID,
        REPOSITORY_FULL_NAME,
        4471,
        "a file.ts",
        BASE_SHA,
        HEAD_SHA
      )
    ).toEqual([
      "branches",
      "selected-pull-request",
      "diff",
      "http",
      "org:acme",
      BRANCH_ID,
      REPOSITORY_FULL_NAME,
      4471,
      "a file.ts",
      BASE_SHA,
      HEAD_SHA,
    ]);
  });
});

describe("selected pull request files and diff hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiGet.mockResolvedValue(unavailableFiles());
  });

  it("encodes the exact files identity and forwards the query signal", async () => {
    const { wrapper } = queryWrapper();
    const { result } = renderHook(
      () =>
        useBranchSelectedPullRequestFiles(
          {
            branchId: BRANCH_ID,
            repositoryFullName: "ClosedLoop-AI/Symphony-Alpha.git",
            pullRequestNumber: 4471,
          },
          undefined,
          { cacheScope: "org:acme" }
        ),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.apiGet).toHaveBeenCalledTimes(1);
    const [path, options] = mocks.apiGet.mock.calls[0] ?? [];
    expect(path).toBe(
      `/branches/${BRANCH_ID}/selected-pull-request/files?repositoryFullName=closedloop-ai%2Fsymphony-alpha&pullRequestNumber=4471`
    );
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.timeoutMs).toBe(LONG_RUNNING_API_TIMEOUT_MS);
  });

  it("keeps incomplete identities disabled even when caller options enable them", () => {
    const { wrapper } = queryWrapper();
    const { result } = renderHook(
      () =>
        useBranchSelectedPullRequestDiff(
          {
            ...diffInput(),
            path: "",
          },
          { enabled: true }
        ),
      { wrapper }
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(mocks.apiGet).not.toHaveBeenCalled();
  });

  it("encodes the exact revision-pinned diff identity and forwards the signal", async () => {
    mocks.apiGet.mockResolvedValueOnce(
      unavailableDiff(GitHubAccessDenialReason.NotConnected)
    );
    const { wrapper } = queryWrapper();
    const { result } = renderHook(
      () =>
        useBranchSelectedPullRequestDiff({
          ...diffInput(),
          repositoryFullName: "ClosedLoop-AI/Symphony-Alpha.git",
          path: "apps/api/a file&copy.ts",
          baseSha: BASE_SHA.toUpperCase(),
          headSha: HEAD_SHA.toUpperCase(),
        }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.apiGet).toHaveBeenCalledTimes(1);
    const [path, options] = mocks.apiGet.mock.calls[0] ?? [];
    expect(path).toBe(
      `/branches/${BRANCH_ID}/selected-pull-request/diff?repositoryFullName=closedloop-ai%2Fsymphony-alpha&pullRequestNumber=4471&path=apps%2Fapi%2Fa+file%26copy.ts&baseSha=${BASE_SHA}&headSha=${HEAD_SHA}`
    );
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.timeoutMs).toBe(LONG_RUNNING_API_TIMEOUT_MS);
  });

  it("aborts a superseded revision and ignores its out-of-order result", async () => {
    const pending: DeferredRequest[] = [];
    mocks.apiGet.mockImplementation(
      (_path: string, options: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          pending.push({ signal: options.signal, resolve });
        })
    );
    const { client, wrapper } = queryWrapper();
    const first = diffInput();
    const second = { ...first, path: "second.ts", headSha: "c".repeat(40) };
    const { result, rerender } = renderHook(
      ({ input }: { input: BranchSelectedPullRequestDiffHookInput }) =>
        useBranchSelectedPullRequestDiff(input, undefined, {
          cacheScope: "org:acme",
        }),
      { initialProps: { input: first }, wrapper }
    );

    await waitFor(() => expect(pending).toHaveLength(1));
    const firstRequest = pending[0];
    if (!firstRequest) {
      throw new Error("Expected the first request");
    }
    rerender({ input: second });
    await waitFor(() => {
      expect(firstRequest.signal.aborted).toBe(true);
      expect(pending).toHaveLength(2);
    });
    const secondRequest = pending[1];
    if (!secondRequest) {
      throw new Error("Expected the second request");
    }

    act(() => {
      secondRequest.resolve(
        unavailableDiff(GitHubAccessDenialReason.Unavailable)
      );
    });
    await waitFor(() =>
      expect(result.current.data).toEqual(
        unavailableDiff(GitHubAccessDenialReason.Unavailable)
      )
    );

    act(() => {
      firstRequest.resolve(
        unavailableDiff(GitHubAccessDenialReason.NotConnected)
      );
    });
    await waitFor(() =>
      expect(result.current.data).toEqual(
        unavailableDiff(GitHubAccessDenialReason.Unavailable)
      )
    );
    expect(
      client.getQueryData(
        branchSelectedPullRequestQueryKeys.diff(
          "http",
          { cacheScope: "org:acme" },
          BRANCH_ID,
          REPOSITORY_FULL_NAME,
          4471,
          second.path,
          BASE_SHA,
          second.headSha
        )
      )
    ).toEqual(unavailableDiff(GitHubAccessDenialReason.Unavailable));
  });
});

type DeferredRequest = {
  signal: AbortSignal;
  resolve: (value: BranchSelectedPullRequestDiffResponse) => void;
};

function queryWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    client,
    wrapper: ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

function diffInput(): BranchSelectedPullRequestDiffHookInput {
  return {
    branchId: BRANCH_ID,
    repositoryFullName: REPOSITORY_FULL_NAME,
    pullRequestNumber: 4471,
    path: "file.ts",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
  };
}

function unavailableFiles(): BranchSelectedPullRequestFilesResponse {
  return {
    status: BranchSelectedPullRequestReadAvailability.Unavailable,
    source: BranchSelectedPullRequestUnavailableSource.Access,
    reason: GitHubAccessDenialReason.NotConnected,
  };
}

function unavailableDiff(
  reason: GitHubAccessDenialReason
): BranchSelectedPullRequestDiffResponse {
  return {
    status: BranchSelectedPullRequestReadAvailability.Unavailable,
    source: BranchSelectedPullRequestUnavailableSource.Access,
    reason,
  };
}
