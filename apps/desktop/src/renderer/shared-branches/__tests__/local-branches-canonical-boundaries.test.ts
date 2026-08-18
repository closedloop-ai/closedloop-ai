import {
  type BranchAnalytics,
  type BranchListResponse,
  type BranchPageDetail,
  type BranchUsageSummary,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import { GitHubDirtyScopeKind } from "@repo/api/src/types/github-dirty-scope-constants";
import { canonicalBranchDetailResponseFixture } from "@repo/app/branches/test-fixtures/canonical-branch-projection";
import { ApiError } from "@repo/app/shared/api/api-error";
import { describe, expect, it, vi } from "vitest";
import { SHARED_BRANCHES_NOT_FOUND_CODE } from "../../../shared/shared-branches-contract";
import type { DesktopApi } from "../../types/desktop-api";
import { createLocalBranchesDataSource } from "../local-branches-data-source";

const branchId = canonicalBranchDetailResponseFixture.id;

describe("local Branch canonical boundary fallbacks", () => {
  it("keeps an explicitly unavailable exact cohort unavailable", async () => {
    const source = createLocalBranchesDataSource(
      fakeDesktopApi({ cohortAnalytics: vi.fn(async () => null) })
    );

    await expect(
      source.cohortAnalytics?.({ branchIds: [branchId] })
    ).resolves.toBeNull();
  });

  it("reports a missing comments subject as not found", async () => {
    const source = createLocalBranchesDataSource(
      fakeDesktopApi({ detail: vi.fn(async () => null) })
    );

    const error = await source.comments?.(branchId).catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 404,
      code: SHARED_BRANCHES_NOT_FOUND_CODE,
    });
  });

  it("does not invoke trace IPC after the caller aborts", async () => {
    const trace = vi.fn(async () => []);
    const source = createLocalBranchesDataSource(fakeDesktopApi({ trace }));
    const controller = new AbortController();
    controller.abort();

    await expect(
      source.trace(branchId, { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(trace).not.toHaveBeenCalled();
  });

  it("withholds mismatched PR evidence without fabricating canonical metrics", async () => {
    const detail = {
      ...canonicalBranchDetailResponseFixture,
      canonicalMetrics: undefined,
    } as BranchPageDetail;
    const source = createLocalBranchesDataSource(
      fakeDesktopApi({ detail: vi.fn(async () => detail) })
    );

    const result = await source.detail(branchId, {
      repositoryFullName: "owner/other",
      pullRequestNumber: 999,
    });

    expect(result.selectedPullRequest).toBeNull();
    expect(result.canonicalMetrics).toBeUndefined();
  });

  it("fails broad on malformed or non-Branch GitHub refresh events", () => {
    const onGitHubResyncNudge = vi.fn(
      (_callback: GitHubResyncNudgeCallback) => () => undefined
    );
    const source = createLocalBranchesDataSource(
      fakeDesktopApi({}, onGitHubResyncNudge)
    );
    const onChange = vi.fn();
    source.subscribe?.(onChange);
    const forward = onGitHubResyncNudge.mock.calls[0]?.[0];

    if (forward) {
      Reflect.apply(forward, undefined, [null]);
    }
    forward?.({ body: {} });
    forward?.({
      body: { scopes: [{ kind: GitHubDirtyScopeKind.Generic }] },
    });
    forward?.({ body: { scopes: [null] } });

    expect(onChange).toHaveBeenCalledTimes(4);
    expect(onChange).toHaveBeenNthCalledWith(1, {});
    expect(onChange).toHaveBeenNthCalledWith(2, {});
    expect(onChange).toHaveBeenNthCalledWith(3, {});
    expect(onChange).toHaveBeenNthCalledWith(4, {});
  });
});

function fakeDesktopApi(
  overrides: Partial<DesktopApi["branchesApi"]> = {},
  onGitHubResyncNudge?: DesktopApi["onGitHubResyncNudge"]
): Parameters<typeof createLocalBranchesDataSource>[0] {
  return {
    branchesApi: {
      list: vi.fn(async () => emptyList()),
      detail: vi.fn(async () => canonicalBranchDetailResponseFixture),
      trace: vi.fn(async () => []),
      usage: vi.fn(async () => ({}) as BranchUsageSummary),
      analytics: vi.fn(async () => ({}) as BranchAnalytics),
      pageData: vi.fn(async () => ({
        list: emptyList(),
        analytics: {} as BranchAnalytics,
      })),
      ...overrides,
    },
    onGitHubResyncNudge,
  };
}

function emptyList(): BranchListResponse {
  return {
    items: [],
    total: 0,
    viewerScope: BranchViewerScope.Self,
  };
}

type GitHubResyncNudgeCallback = Parameters<
  NonNullable<DesktopApi["onGitHubResyncNudge"]>
>[0];
