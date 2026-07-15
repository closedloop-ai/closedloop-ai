import {
  type AgentComponentDetail,
  AgentComponentKind,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
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

// --- Shared detail hook: return a fixed component so the header renders. ---
const detail: AgentComponentDetail = {
  id: "uuid-1",
  name: "RTK Optimizer",
  kind: AgentComponentKind.Skill,
  sourceType: SourceType.Repo,
  source: "acme/repo",
  harness: Harness.Claude,
  invocations: 10,
  sessions: 3,
  klocPerDollar: 2,
  trend: [1, 2],
  owner: "alice",
  collaborators: [],
  computeTargetIds: ["t1"],
  firstSeenAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-06-01T00:00:00.000Z",
  properties: { path: "/skills/rtk.md", format: "md" },
  prompt: "Optimize tokens.",
  sessionsTab: [],
  branchesTab: [],
  provenance: [],
  usageSessions: [],
};

vi.mock("@repo/app/agents/hooks/use-agent-component-detail", () => ({
  useAgentComponentDetail: () => ({
    data: detail,
    isLoading: false,
    isError: false,
  }),
}));

// Token-trend chart hook: return empty so the chart renders its empty state.
vi.mock("@repo/app/agents/hooks/use-agent-component-token-trend", () => ({
  useAgentComponentTokenTrend: () => ({
    data: { slug: "skill::rtk", models: [], points: [] },
    isLoading: false,
    isError: false,
  }),
}));

const RE_PROMOTE = /promote/i;
const RE_DIALOG_TITLE = /promote to catalog/i;
const RE_TOKEN_TREND = /token trend by model/i;

function Wrapper({ children }: { children: ReactNode }) {
  return <AppCoreStoryProviders>{children}</AppCoreStoryProviders>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgentDetailWithPromote", () => {
  it("shows the Promote action for an org admin and opens the modal on click", async () => {
    mockUseOrganization.mockReturnValue({
      membership: { role: "org:admin" },
    });

    render(
      <Wrapper>
        <AgentDetailWithPromote slug="skill::rtk" />
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

  it("renders the web-only 'Token trend by model' analytics section", async () => {
    // Non-admin so only the analytics slot (not the Promote action) is asserted;
    // the section proves the shared AgentDetail `analytics` slot is wired on web.
    mockUseOrganization.mockReturnValue({
      membership: { role: "org:member" },
    });

    render(
      <Wrapper>
        <AgentDetailWithPromote slug="skill::rtk" />
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
        <AgentDetailWithPromote slug="skill::rtk" />
      </Wrapper>
    );

    // Component still renders (name visible) but no Promote button.
    expect(await screen.findByText("RTK Optimizer")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RE_PROMOTE })
    ).not.toBeInTheDocument();
  });
});
