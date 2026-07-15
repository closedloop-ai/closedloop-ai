/**
 * FEA-2923 follow-up: OwnerLabel Connect-GitHub CTA behavior.
 *
 * Owner attribution (git-identity → cloud user) requires GitHub. When a row is
 * unattributed the Owner column must NEVER render a bare blank:
 *  - GitHub NOT connected → the reused Connect-GitHub CTA
 *  - GitHub connected (or unknown) → a plain "—"
 *  - attributed owner → the owner UserPill (CTA never shown)
 */
import {
  type AgentComponent,
  AgentComponentKind,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { OwnerLabel } from "../component-meta";

function makeComponent(
  overrides: Partial<AgentComponent> = {}
): AgentComponent {
  return {
    id: "uuid-1",
    name: "My Skill",
    kind: AgentComponentKind.Skill,
    sourceType: SourceType.Repo,
    source: "repo-a",
    harness: Harness.Claude,
    invocations: 1,
    sessions: 1,
    klocPerDollar: null,
    trend: [],
    owner: null,
    collaborators: [],
    computeTargetIds: [],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

const CONNECT_GITHUB_RE = /connect github/i;

function renderWithProviders(ui: ReactNode) {
  return render(<AppCoreStoryProviders>{ui}</AppCoreStoryProviders>);
}

describe("OwnerLabel", () => {
  it("renders the Connect-GitHub CTA when owner is null AND GitHub is not connected", () => {
    renderWithProviders(
      <OwnerLabel
        component={makeComponent({ owner: null })}
        githubConnected={false}
        githubConnectHref="/api/integrations/github?returnTo=%2Fagents"
      />
    );

    // The reused ConnectGitHubIndicator surfaces a "Connect GitHub" affordance.
    expect(
      screen.getByRole("link", { name: CONNECT_GITHUB_RE })
    ).toBeInTheDocument();
  });

  it("renders a plain em dash (not the CTA, not blank) when owner is null but GitHub IS connected", () => {
    renderWithProviders(
      <OwnerLabel
        component={makeComponent({ owner: null })}
        githubConnected={true}
      />
    );

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: CONNECT_GITHUB_RE })
    ).not.toBeInTheDocument();
  });

  it("treats unknown connection state (undefined) as connected — em dash, never the CTA", () => {
    renderWithProviders(
      <OwnerLabel component={makeComponent({ owner: null })} />
    );

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: CONNECT_GITHUB_RE })
    ).not.toBeInTheDocument();
  });

  it("renders the owner UserPill (never the CTA) when the component is attributed", () => {
    renderWithProviders(
      <OwnerLabel
        component={makeComponent({ owner: "Ada Lovelace" })}
        githubConnected={false}
      />
    );

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: CONNECT_GITHUB_RE })
    ).not.toBeInTheDocument();
  });
});
