import {
  type BranchPageDetail,
  BranchStatus,
} from "@repo/api/src/types/branch";
import type { ApiAdapter } from "@repo/app/shared/api/api-adapter";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchDetailView } from "../branch-detail-view";

const BACK_TO_BRANCHES_RE = /back to branches/i;

const inertApiAdapter: ApiAdapter = {
  resolveApiOrigin: () => "http://test.local",
  fetch: () => Promise.reject(new Error("no remote REST API in tests")),
};

function makeDetail(): BranchPageDetail {
  return {
    id: "b-1",
    branchName: "feature/x",
    baseBranch: "main",
    repoFullName: "owner/repo",
    owner: "alice",
    status: BranchStatus.Open,
    prNumber: 42,
    prTitle: "Add x",
    prState: "OPEN",
    prUrl: "https://github.com/owner/repo/pull/42",
    multiPrWarning: false,
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
    reviewDecision: null,
    ahead: null,
    behind: null,
    additions: null,
    deletions: null,
    filesChanged: null,
    estimatedCostUsd: null,
    lastActivityAt: "2026-06-17T12:00:00.000Z",
    sessionIds: ["s1"],
    prBody: "Body",
    prBodyHtmlUrl: "https://github.com/owner/repo/pull/42",
    headSha: null,
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    openedAt: null,
    commits: [],
    sessions: [
      {
        sessionId: "s1",
        slug: null,
        name: "Session one",
        harness: "claude",
        startedAt: "2026-06-17T10:00:00.000Z",
        endedAt: "2026-06-17T11:00:00.000Z",
        isPrimary: true,
        estimatedCostUsd: 1.23,
        inputTokens: 100,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ],
    mergedTrace: [{ type: "end", sessionId: "s1", text: "done" }],
    linkedPrNumbers: [42],
    linkedArtifacts: [],
  };
}

function installDesktopApi(detail: () => Promise<BranchPageDetail | null>): {
  detail: ReturnType<typeof vi.fn>;
} {
  const detailMock = vi.fn(detail);
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      branchesApi: {
        list: vi.fn(() =>
          Promise.resolve({ items: [], total: 0, viewerScope: "self" })
        ),
        detail: detailMock,
        usage: vi.fn(() => Promise.resolve({})),
        analytics: vi.fn(() => Promise.resolve({})),
      },
    },
  });
  return { detail: detailMock };
}

function renderView() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const flagAdapter = createStaticFeatureFlagAdapter({ enabledFlags: [] });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
        <ApiAdapterProvider adapter={inertApiAdapter}>
          <FeatureFlagAdapterProvider adapter={flagAdapter}>
            <BranchDetailView backHref="/branches" branchId="b-1" />
          </FeatureFlagAdapterProvider>
        </ApiAdapterProvider>
      </AuthAdapterProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BranchDetailView", () => {
  it("mounts the data-source ancestry and renders the populated page", async () => {
    const { detail } = installDesktopApi(() => Promise.resolve(makeDetail()));
    renderView();

    expect(
      await screen.findByRole("tab", { name: "Branch details" })
    ).toBeDefined();
    expect(
      screen.getByRole("link", { name: BACK_TO_BRANCHES_RE })
    ).toBeDefined();
    await waitFor(() => expect(detail).toHaveBeenCalledWith("b-1"));
  });

  it("shows a skeleton while the detail read is pending", async () => {
    // A never-resolving detail keeps useBranchDetail in its loading state.
    installDesktopApi(() => new Promise<BranchPageDetail>(() => undefined));
    const { container } = renderView();

    await waitFor(() =>
      expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull()
    );
  });
});
