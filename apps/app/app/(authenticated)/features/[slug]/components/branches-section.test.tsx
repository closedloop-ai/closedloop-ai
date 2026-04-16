import type { LinkedEntity } from "@repo/api/src/types/entity-link";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import { ExternalLinkType } from "@repo/api/src/types/external-link";
import { GitHubPRState } from "@repo/api/src/types/github";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BranchRow } from "./branches-section";

// OverflowMenu uses Radix DropdownMenu — mock to keep tests simple
vi.mock("./overflow-menu", () => ({
  OverflowMenu: () => <div data-testid="overflow-menu" />,
}));

function makePrLinkedEntity(
  state: GitHubPRState | null,
  overrides?: { title?: string }
): LinkedEntity {
  const metadata =
    state !== null
      ? {
          number: 42,
          headBranch: "feature-branch",
          baseBranch: "main",
          state,
        }
      : null;

  return {
    id: "link-1",
    organizationId: "org-1",
    sourceId: "feature-1",
    sourceType: EntityType.Feature,
    sourceVersion: null,
    targetId: "ext-1",
    targetType: EntityType.ExternalLink,
    targetVersion: null,
    linkType: LinkType.Produces,
    metadata: null,
    createdAt: new Date("2024-01-01"),
    resolvedEntity: {
      type: EntityType.ExternalLink,
      entity: {
        id: "ext-1",
        organizationId: "org-1",
        workstreamId: null,
        projectId: "proj-1",
        type: ExternalLinkType.PullRequest,
        title: overrides?.title ?? "My pull request",
        externalUrl: "https://github.com/org/repo/pull/42",
        metadata,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      },
    },
  };
}

describe("BranchRow — PrStateBadge states", () => {
  it("renders Unknown badge (gray) when state is null (metadata absent)", () => {
    render(<BranchRow linked={makePrLinkedEntity(null)} onUnlink={vi.fn()} />);

    const badge = screen.getByText("Unknown");
    expect(badge.className).toContain("text-gray-500");
  });

  it("renders Open badge (green) when state is OPEN", () => {
    render(
      <BranchRow
        linked={makePrLinkedEntity(GitHubPRState.Open)}
        onUnlink={vi.fn()}
      />
    );

    const badge = screen.getByText("Open");
    expect(badge.className).toContain("text-green-700");
  });

  it("renders Merged badge (purple) when state is MERGED", () => {
    render(
      <BranchRow
        linked={makePrLinkedEntity(GitHubPRState.Merged)}
        onUnlink={vi.fn()}
      />
    );

    const badge = screen.getByText("Merged");
    expect(badge.className).toContain("text-purple-700");
  });

  it("renders Closed badge (red) when state is CLOSED", () => {
    render(
      <BranchRow
        linked={makePrLinkedEntity(GitHubPRState.Closed)}
        onUnlink={vi.fn()}
      />
    );

    const badge = screen.getByText("Closed");
    expect(badge.className).toContain("text-red-700");
  });
});

describe("BranchRow — PrStateIcon states", () => {
  it("renders unknown icon (gray) when state is null", () => {
    render(<BranchRow linked={makePrLinkedEntity(null)} onUnlink={vi.fn()} />);

    const icon = screen.getByTestId("pr-state-icon-unknown");
    expect(icon).toBeDefined();
    expect(icon.getAttribute("class")).toContain("text-gray-400");
  });

  it("renders merged icon when state is MERGED", () => {
    render(
      <BranchRow
        linked={makePrLinkedEntity(GitHubPRState.Merged)}
        onUnlink={vi.fn()}
      />
    );

    expect(screen.getByTestId("pr-state-icon-merged")).toBeDefined();
  });

  it("renders open icon when state is OPEN", () => {
    render(
      <BranchRow
        linked={makePrLinkedEntity(GitHubPRState.Open)}
        onUnlink={vi.fn()}
      />
    );

    expect(screen.getByTestId("pr-state-icon-open")).toBeDefined();
  });

  it("renders closed icon when state is CLOSED", () => {
    render(
      <BranchRow
        linked={makePrLinkedEntity(GitHubPRState.Closed)}
        onUnlink={vi.fn()}
      />
    );

    expect(screen.getByTestId("pr-state-icon-closed")).toBeDefined();
  });

  it("renders the PR title as a link", () => {
    render(
      <BranchRow
        linked={makePrLinkedEntity(GitHubPRState.Open, {
          title: "feat: add new feature",
        })}
        onUnlink={vi.fn()}
      />
    );

    expect(screen.getByText("feat: add new feature")).toBeDefined();
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/build/ext-1");
  });

  it("renders null when resolvedEntity is not an ExternalLink type", () => {
    const linked: LinkedEntity = {
      id: "link-2",
      organizationId: "org-1",
      sourceId: "feature-1",
      sourceType: EntityType.Feature,
      sourceVersion: null,
      targetId: "artifact-1",
      targetType: EntityType.Artifact,
      targetVersion: null,
      linkType: LinkType.Produces,
      metadata: null,
      createdAt: new Date("2024-01-01"),
      resolvedEntity: null,
    };

    const { container } = render(
      <BranchRow linked={linked} onUnlink={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });
});
