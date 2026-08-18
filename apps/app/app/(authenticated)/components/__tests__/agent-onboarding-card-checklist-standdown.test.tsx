// @vitest-environment jsdom

import { ChecklistItemId } from "@repo/api/src/types/onboarding";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabledFlags: new Set<string>(),
  status: null as unknown,
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: (key: string) => ({ enabled: mocks.enabledFlags.has(key) }),
}));
vi.mock("@repo/app/onboarding/hooks/use-onboarding", () => ({
  useOnboardingStatus: () => ({ data: mocks.status }),
}));
vi.mock("@/hooks/queries/use-agent-onboarding", () => ({
  useAgentOnboarding: () => ({
    shouldShow: true,
    hasGitHub: false,
    hasElectron: false,
    bootstrapInProgress: false,
    dismiss: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-org-slug", () => ({ useOrgSlug: () => "acme" }));
vi.mock("@/lib/integration-connect-urls", () => ({
  getGitHubConnectUrl: () => "/api/integrations/github?install=true",
}));
vi.mock("@repo/navigation/link", () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/">{children}</a>
  ),
}));

import { AgentOnboardingCard } from "../agent-onboarding-card";

const AGENT_CARD_TITLE = "Set up AI agents for your team";

function setChecklist({
  allComplete = false,
  wizardCompleted = true,
}: {
  allComplete?: boolean;
  wizardCompleted?: boolean;
} = {}) {
  mocks.status = {
    wizardCompleted,
    checklistDismissed: false,
    checklist: [
      {
        id: ChecklistItemId.InviteMembers,
        label: "Invite team members",
        description: "Add colleagues",
        completed: allComplete,
      },
    ],
  };
}

describe("AgentOnboardingCard — checklist stand-down", () => {
  beforeEach(() => {
    mocks.enabledFlags.clear();
    setChecklist();
  });

  it("stands down while the setup checklist is up", () => {
    // Both cards ask for GitHub and for Desktop, off different signals, so
    // stacking them lets one screen contradict itself about the same fact.
    render(<AgentOnboardingCard />);

    expect(screen.queryByText(AGENT_CARD_TITLE)).toBeNull();
  });

  it("comes back once the checklist has nothing left to ask for", () => {
    setChecklist({ allComplete: true });

    render(<AgentOnboardingCard />);

    expect(screen.getByText(AGENT_CARD_TITLE)).toBeTruthy();
  });

  it("renders for a user who never reached the checklist", () => {
    // Wizard unfinished: the checklist does not render at all, so there is
    // nothing for this card to contradict.
    setChecklist({ wizardCompleted: false });

    render(<AgentOnboardingCard />);

    expect(screen.getByText(AGENT_CARD_TITLE)).toBeTruthy();
  });
});
