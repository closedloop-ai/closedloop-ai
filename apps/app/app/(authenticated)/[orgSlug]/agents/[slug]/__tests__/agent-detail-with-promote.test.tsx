import {
  type AgentComponentDetail,
  AgentComponentKind,
  ComponentResolvedState,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { ApiError } from "@repo/app/shared/api/api-error";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDetailWithPromote } from "../agent-detail-with-promote";

// --- Clerk org mock: drives the admin gate on the Promote action. ---
const mockUseOrganization = vi.fn();
vi.mock("@repo/auth/client", () => ({
  useOrganization: () => mockUseOrganization(),
}));

// --- Navigation mock (FEA-3557) ---
// AgentDetail's invocations tabs adopted `useTabParam`, which reads the
// navigation-port hooks (useNavigation/usePath/useSearchParamsValue). In
// `apps/app` tests those ports are shimmed to `next/navigation` by
// vitest.setup.ts, so — unlike the `packages/app` suites that wrap in a
// <NavigationProvider> — this suite must supply a `next/navigation` factory
// instead. Provide inert router/pathname/search-params so the detail header
// (and its tabs) render without a live App Router context.
vi.mock("next/navigation", () => ({
  usePathname: () => "/agents/skill::rtk",
  useParams: () => ({ orgSlug: "org-test" }),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

// --- Shared detail hook: return a fixed component so the header renders. ---
const detail: AgentComponentDetail = {
  id: "uuid-1",
  slug: "skill::rtk-optimizer",
  name: "RTK Optimizer",
  kind: AgentComponentKind.Skill,
  sourceType: SourceType.Repo,
  source: "acme/repo",
  harness: Harness.Claude,
  invocations: 10,
  sessions: 3,
  locPerDollar: 2,
  trend: [1, 2],
  collaborators: [],
  computeTargetIds: ["t1"],
  firstSeenAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-06-01T00:00:00.000Z",
  properties: { path: "/skills/rtk.md", format: "md" },
  prompt: "Optimize tokens.",
  versions: [],
  resolvedState: ComponentResolvedState.Unresolved,
  sessionsTab: [],
  sessionsTabTruncated: false,
  branchesTab: [],
  branchesTabTruncated: false,
  provenance: [],
  usageSessions: [],
  // CohortDeliveryMetrics (mixed into AgentComponentDetail) — null when no
  // baseline is computable, matching the service's honest-null contract.
  locDelta: null,
  successRate: null,
  successDelta: null,
  tokenEfficiencyDelta: null,
  efficiencyTrend: [],
  mergedPrs: null,
  qualityScore: null,
  qualityDelta: null,
};

// Mutable so a not-found test can flip the shared hook to its error branch and
// prove the web wrapper threads the org-scoped `backHref` into the not-found
// "Back to Agents" link (the default is a settled successful read).
let detailResult: {
  data: AgentComponentDetail | undefined;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
} = { data: detail, isLoading: false, isError: false };

vi.mock("@repo/app/agents/hooks/use-agent-component-detail", () => ({
  useAgentComponentDetail: () => detailResult,
}));

// Token-trend chart hook: return empty so the chart renders its empty state.
vi.mock("@repo/app/agents/hooks/use-agent-component-token-trend", () => ({
  useAgentComponentTokenTrend: () => ({
    data: { slug: "skill::rtk", models: [], points: [] },
    isLoading: false,
    isError: false,
  }),
}));

// --- Compute-targets hook (FEA-4017): drives the Install modal's target list.
// Captures the options arg so the `enabled: open` gating can be asserted. ---
const mockUseComputeTargets = vi.fn();
const computeTargetsOptions: Array<{ enabled?: boolean } | undefined> = [];
vi.mock("@/hooks/queries/use-compute-targets", () => ({
  useComputeTargets: (options?: { enabled?: boolean }) => {
    computeTargetsOptions.push(options);
    return mockUseComputeTargets();
  },
}));

const RE_PROMOTE = /promote/i;
const RE_PROMOTE_EXACT = /^promote$/i;
const RE_INSTALL = /^install$/i;
const RE_GO_TO_SETTINGS = /go to settings/i;
const RE_DIALOG_TITLE = /promote to catalog/i;
const RE_TOKEN_TREND = /^usage over time$/i;
const RE_TARGETS_LOAD_ERROR = /couldn't load your compute targets/i;
const RE_SELECT_TARGET_CONTROL = /select .* compute target/i;
const RE_DARWIN_ONLINE = /darwin · Online/i;
const RE_NOT_FOUND = /component not found/i;
const RE_BACK_TO_AGENTS = /back to agents/i;

function onlineTargetFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "ct-1",
    machineName: "My MacBook",
    isOnline: true,
    platform: "darwin",
    ownerName: null,
    ...overrides,
  };
}

function Wrapper({ children }: { children: ReactNode }) {
  return <AppCoreStoryProviders>{children}</AppCoreStoryProviders>;
}

beforeEach(() => {
  vi.clearAllMocks();
  computeTargetsOptions.length = 0;
  // Default: a settled successful read. Not-found tests opt into the error branch.
  detailResult = { data: detail, isLoading: false, isError: false };
  // Default: one own online local target.
  mockUseComputeTargets.mockReturnValue({
    data: [onlineTargetFixture()],
    isLoading: false,
    isError: false,
  });
  // Default fixture is repo-sourced (not installable); installable tests opt in.
  detail.sourceType = SourceType.Repo;
  detail.source = "acme/repo";
});

describe("AgentDetailWithPromote", () => {
  it("shows the Promote action for an org admin and opens the modal on click", async () => {
    mockUseOrganization.mockReturnValue({
      membership: { role: "org:admin" },
    });

    render(
      <Wrapper>
        <AgentDetailWithPromote orgSlug="org-test" slug="skill::rtk" />
      </Wrapper>
    );

    // Header renders → the admin Promote button is present.
    const promoteButton = await screen.findByRole("button", {
      name: RE_PROMOTE,
    });
    expect(promoteButton).toBeInTheDocument();

    // The modal is not mounted until the action is triggered.
    expect(screen.queryByText(RE_DIALOG_TITLE)).not.toBeInTheDocument();

    fireEvent.click(promoteButton);

    await waitFor(() => {
      expect(screen.getByText(RE_DIALOG_TITLE)).toBeInTheDocument();
    });
    // Modal is pre-filled with the component name.
    expect(screen.getByDisplayValue("RTK Optimizer")).toBeInTheDocument();
  });

  // FEA-3987: on a 404 the web wrapper's not-found state must give the user a
  // way back, and the "Back to Agents" link must point at the org-scoped Agents
  // list (matching the breadcrumb crumb) — proving the wrapper supplies the
  // right backHref, not just that AgentDetail renders whatever it's handed.
  it("renders a not-found state with an org-scoped 'Back to Agents' link on a 404", async () => {
    mockUseOrganization.mockReturnValue({
      membership: { role: "org:member" },
    });
    detailResult = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiError("Not Found", 404),
    };

    render(
      <Wrapper>
        <AgentDetailWithPromote orgSlug="org-test" slug="missing" />
      </Wrapper>
    );

    expect(await screen.findByText(RE_NOT_FOUND)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: RE_BACK_TO_AGENTS })
    ).toHaveAttribute("href", "/org-test/agents");
  });

  it("renders the web-only 'Usage over time' analytics section", async () => {
    // Non-admin so only the analytics slot (not the Promote action) is asserted;
    // the section proves the shared AgentDetail `analytics` slot is wired on web.
    mockUseOrganization.mockReturnValue({
      membership: { role: "org:member" },
    });

    render(
      <Wrapper>
        <AgentDetailWithPromote orgSlug="org-test" slug="skill::rtk" />
      </Wrapper>
    );

    expect(await screen.findByText(RE_TOKEN_TREND)).toBeInTheDocument();
  });

  it("does NOT render the Promote action for a non-admin member", async () => {
    mockUseOrganization.mockReturnValue({
      membership: { role: "org:member" },
    });

    render(
      <Wrapper>
        <AgentDetailWithPromote orgSlug="org-test" slug="skill::rtk" />
      </Wrapper>
    );

    // Component still renders (name visible) but no Promote button.
    expect(await screen.findByText("RTK Optimizer")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RE_PROMOTE })
    ).not.toBeInTheDocument();
  });

  // Bug fix: the Sessions-tab session name looked like a link (hover underline)
  // but did not navigate because the web mount never injected `getSessionHref`.
  // It now threads an org-scoped session-detail route down to the shared
  // AgentDetail → DetailSessionsTab.
  it("renders the Sessions-tab name as a link to the org-scoped session route", async () => {
    mockUseOrganization.mockReturnValue({
      membership: { role: "org:member" },
    });

    detail.sessionsTab = [
      createAgentSessionListItemFixture({
        id: "session-42",
        name: "linked-session",
      }),
    ];

    render(
      <Wrapper>
        <AgentDetailWithPromote orgSlug="org-test" slug="skill::rtk" />
      </Wrapper>
    );

    const link = await screen.findByRole("link", { name: "linked-session" });
    expect(link).toHaveAttribute("href", "/org-test/sessions/session-42");

    // Reset so other tests keep the empty sessionsTab.
    detail.sessionsTab = [];
  });

  it("states the true session total through the web wrapper mount (ISS-5464)", async () => {
    // Cross-surface parity (review thread PRRT_kwDOQ4gDpM6Xdq2O): the corrected
    // notice must behave identically whether the shared detail is mounted by
    // this web wrapper or by the desktop AgentDetailView. The desktop half of
    // this pair lives in
    // `apps/desktop/src/renderer/components/agents/__tests__/agent-detail-view.test.tsx`.
    mockUseOrganization.mockReturnValue({
      membership: { role: "org:member" },
    });

    detail.sessions = 1218;
    detail.sessionsTab = [
      createAgentSessionListItemFixture({
        id: "session-1",
        name: "bounded-session",
      }),
    ];
    detail.sessionsTabTruncated = true;

    render(
      <Wrapper>
        <AgentDetailWithPromote orgSlug="org-test" slug="skill::rtk" />
      </Wrapper>
    );

    expect(
      await screen.findByText("Showing 1 of 1,218 sessions")
    ).toBeInTheDocument();

    detail.sessions = 3;
    detail.sessionsTab = [];
    detail.sessionsTabTruncated = false;
  });

  // ---- FEA-4017: Install Locally (any member) --------------------------------

  it("shows an enabled Install action to a non-admin member for a pack-sourced component", async () => {
    mockUseOrganization.mockReturnValue({
      membership: { role: "org:member" },
    });
    detail.sourceType = SourceType.Pack;
    detail.source = "rtk";

    render(
      <Wrapper>
        <AgentDetailWithPromote orgSlug="org-test" slug="skill::rtk" />
      </Wrapper>
    );

    const installButton = await screen.findByRole("button", {
      name: RE_INSTALL,
    });
    expect(installButton).toBeInTheDocument();
    expect(installButton).toBeEnabled();
    // Non-admin still gets NO Promote action.
    expect(
      screen.queryByRole("button", { name: RE_PROMOTE_EXACT })
    ).not.toBeInTheDocument();
  });

  it("gates the compute-targets query on the modal being open (enabled: open)", async () => {
    mockUseOrganization.mockReturnValue({
      membership: { role: "org:member" },
    });
    detail.sourceType = SourceType.Pack;
    detail.source = "rtk";

    render(
      <Wrapper>
        <AgentDetailWithPromote orgSlug="org-test" slug="skill::rtk" />
      </Wrapper>
    );

    await screen.findByRole("button", { name: RE_INSTALL });
    // Closed: every call so far passed enabled:false (the query stays idle).
    expect(computeTargetsOptions.length).toBeGreaterThan(0);
    expect(computeTargetsOptions.every((o) => o?.enabled === false)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: RE_INSTALL }));

    // Opening flips the gate on.
    await waitFor(() => {
      expect(computeTargetsOptions.at(-1)?.enabled).toBe(true);
    });
  });

  it("lists the member's own online target read-only with platform + status when Install is clicked", async () => {
    mockUseOrganization.mockReturnValue({
      membership: { role: "org:member" },
    });
    detail.sourceType = SourceType.Pack;
    detail.source = "rtk";

    render(
      <Wrapper>
        <AgentDetailWithPromote orgSlug="org-test" slug="skill::rtk" />
      </Wrapper>
    );

    fireEvent.click(await screen.findByRole("button", { name: RE_INSTALL }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("My MacBook")).toBeInTheDocument();
    expect(screen.getByText(RE_DARWIN_ONLINE)).toBeInTheDocument();
    // The list is informational, not a picker — no per-target control.
    expect(
      screen.queryByRole("button", { name: RE_SELECT_TARGET_CONTROL })
    ).not.toBeInTheDocument();
  });

  it("hides teammate-owned org-shared targets (only the member's own machines)", async () => {
    mockUseOrganization.mockReturnValue({
      membership: { role: "org:member" },
    });
    mockUseComputeTargets.mockReturnValue({
      data: [
        onlineTargetFixture(),
        onlineTargetFixture({
          id: "ct-2",
          machineName: "Teammate Box",
          ownerName: "Bob",
        }),
      ],
      isLoading: false,
      isError: false,
    });
    detail.sourceType = SourceType.Pack;
    detail.source = "rtk";

    render(
      <Wrapper>
        <AgentDetailWithPromote orgSlug="org-test" slug="skill::rtk" />
      </Wrapper>
    );

    fireEvent.click(await screen.findByRole("button", { name: RE_INSTALL }));

    expect(await screen.findByText("My MacBook")).toBeInTheDocument();
    expect(screen.queryByText("Teammate Box")).not.toBeInTheDocument();
  });

  it("surfaces an error state (not an empty list) when the targets query fails", async () => {
    mockUseOrganization.mockReturnValue({
      membership: { role: "org:member" },
    });
    mockUseComputeTargets.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    detail.sourceType = SourceType.Pack;
    detail.source = "rtk";

    render(
      <Wrapper>
        <AgentDetailWithPromote orgSlug="org-test" slug="skill::rtk" />
      </Wrapper>
    );

    fireEvent.click(await screen.findByRole("button", { name: RE_INSTALL }));

    expect(await screen.findByText(RE_TARGETS_LOAD_ERROR)).toBeInTheDocument();
    // Must NOT fall through to the "no target registered" empty state.
    expect(
      screen.queryByRole("link", { name: RE_GO_TO_SETTINGS })
    ).not.toBeInTheDocument();
  });

  it("shows a Settings empty state when the member has no local target", async () => {
    mockUseOrganization.mockReturnValue({
      membership: { role: "org:member" },
    });
    mockUseComputeTargets.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    });
    detail.sourceType = SourceType.Pack;
    detail.source = "rtk";

    render(
      <Wrapper>
        <AgentDetailWithPromote orgSlug="org-test" slug="skill::rtk" />
      </Wrapper>
    );

    fireEvent.click(await screen.findByRole("button", { name: RE_INSTALL }));

    const settingsLink = await screen.findByRole("link", {
      name: RE_GO_TO_SETTINGS,
    });
    expect(settingsLink).toHaveAttribute(
      "href",
      "/org-test/settings?tab=integrations"
    );
  });

  it("does NOT show Install for a non-pack (non-installable) source", async () => {
    mockUseOrganization.mockReturnValue({
      membership: { role: "org:member" },
    });
    detail.sourceType = SourceType.Repo;

    render(
      <Wrapper>
        <AgentDetailWithPromote orgSlug="org-test" slug="skill::rtk" />
      </Wrapper>
    );

    expect(await screen.findByText("RTK Optimizer")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RE_INSTALL })
    ).not.toBeInTheDocument();
  });

  it("shows both Install and Promote to an admin for a pack-sourced promotable component", async () => {
    mockUseOrganization.mockReturnValue({
      membership: { role: "org:admin" },
    });
    detail.sourceType = SourceType.Pack;
    detail.source = "rtk";

    render(
      <Wrapper>
        <AgentDetailWithPromote orgSlug="org-test" slug="skill::rtk" />
      </Wrapper>
    );

    expect(
      await screen.findByRole("button", { name: RE_INSTALL })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: RE_PROMOTE_EXACT })
    ).toBeInTheDocument();
  });
});
