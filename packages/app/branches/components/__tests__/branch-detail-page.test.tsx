import {
  type BranchPageDetail,
  type BranchSession,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BranchDetailPage,
  type BranchDetailPageProps,
} from "../branch-detail-page";

const BACK_TO_BRANCHES_RE = /back to branches/i;
const SESSIONS_TIMELINE_TAB_RE = /sessions & timeline/i;

// The Epic F overlays (files-changed, PR status, refresh) issue gateway reads
// through window.fetch — stub it so they degrade to the not-connected fallback
// rather than hitting the network in unit tests.
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: false,
    status: 404,
    json: () => Promise.resolve({}),
  } as Response);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The not-found state renders the navigation-port <Link> (needs a
// <NavigationProvider>); the Epic F overlays need a React Query client.
function render(ui: ReactElement) {
  const nav = createMemoryNavigation({ orgSlug: "test-org" });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return rtlRender(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <NavigationProvider adapter={nav.adapter}>
          {children}
        </NavigationProvider>
      </QueryClientProvider>
    ),
  });
}

function makeSession(): BranchSession {
  return {
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
  };
}

function makeDetail(
  overrides: Partial<BranchPageDetail> = {}
): BranchPageDetail {
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
    prBody: "PR body",
    prBodyHtmlUrl: "https://github.com/owner/repo/pull/42",
    headSha: null,
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    openedAt: null,
    commits: [],
    sessions: [makeSession()],
    mergedTrace: [{ type: "end", sessionId: "s1", text: "done" }],
    linkedPrNumbers: [42],
    linkedArtifacts: [],
    ...overrides,
  };
}

function baseProps(
  overrides: Partial<BranchDetailPageProps> = {}
): BranchDetailPageProps {
  return {
    branchId: "b-1",
    isLoading: false,
    isError: false,
    backHref: "/branches",
    ...overrides,
  };
}

describe("BranchDetailPage", () => {
  it("shows a skeleton while the first detail read is pending", () => {
    const { container } = render(
      <BranchDetailPage {...baseProps({ isLoading: true })} />
    );
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });

  it("renders the not-found state with a Back to Branches link on error", () => {
    render(<BranchDetailPage {...baseProps({ isError: true })} />);
    expect(screen.getByText("Branch not found")).toBeInTheDocument();
    const back = screen.getByRole("link", { name: BACK_TO_BRANCHES_RE });
    expect(back).toHaveAttribute("href", "/branches");
  });

  it("renders the no-sessions invite CTA when the branch has no sessions", () => {
    render(
      <BranchDetailPage
        {...baseProps({ detail: makeDetail({ sessions: [] }) })}
      />
    );
    expect(
      screen.getByText("No sessions on this branch yet")
    ).toBeInTheDocument();
    // No tab chrome in the empty state — just the invite CTA.
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("renders both tabs with Branch details active by default", () => {
    render(<BranchDetailPage {...baseProps({ detail: makeDetail() })} />);
    const branchTab = screen.getByRole("tab", { name: "Branch details" });
    const sessionsTab = screen.getByRole("tab", {
      name: SESSIONS_TIMELINE_TAB_RE,
    });
    expect(branchTab).toHaveAttribute("aria-selected", "true");
    expect(sessionsTab).toHaveAttribute("aria-selected", "false");
    // Branch-details panels (Epic D) are shown; the sessions-tab slots are not
    // yet mounted (deferred to Epic E). Properties sits above the tabs. The
    // fixture is unmerged, so the cost panel heads "Cost to date".
    expect(screen.getByText("Cost to date")).toBeInTheDocument();
    expect(screen.getByText("Properties")).toBeInTheDocument();
    expect(screen.queryByText("Contributing sessions")).not.toBeInTheDocument();
  });

  it("switches to the Sessions & timeline tab", async () => {
    const user = userEvent.setup();
    render(<BranchDetailPage {...baseProps({ detail: makeDetail() })} />);

    // Radix Tabs activate on mousedown/focus, so drive the switch through
    // user-event rather than fireEvent.click.
    await user.click(
      screen.getByRole("tab", { name: SESSIONS_TIMELINE_TAB_RE })
    );

    // Epic E renders the real Sessions & timeline content — the merged-trace
    // reader shows the fixture's terminal "done" row; the Branch-details cost
    // panel is no longer mounted on this tab.
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.queryByText("Cost to date")).not.toBeInTheDocument();
  });

  it("does not render the descoped conversation rail", () => {
    render(<BranchDetailPage {...baseProps({ detail: makeDetail() })} />);
    expect(screen.queryByText("Conversation")).not.toBeInTheDocument();
  });
});
