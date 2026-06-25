import {
  type ArtifactLinkWithEndpoints,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { BranchRow } from "../branches-section";

// OverflowMenu uses Radix DropdownMenu — mock to keep tests simple
vi.mock("../overflow-menu", () => ({
  OverflowMenu: () => <div data-testid="overflow-menu" />,
}));

/**
 * Renders inside the memory navigation adapter so `BranchRow`'s `useOrgPath`
 * builder resolves; the org slug drives the expected `/test-org/build/...`
 * href.
 */
function renderWithNav(ui: ReactElement) {
  const nav = createMemoryNavigation({ orgSlug: "test-org" });
  return render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
    ),
  });
}

function makePrArtifactLink(overrides?: {
  name?: string;
  externalUrl?: string | null;
}): ArtifactLinkWithEndpoints {
  return {
    id: "link-1",
    organizationId: "org-1",
    sourceId: "feature-1",
    targetId: "ext-1",
    linkType: LinkType.Produces,
    metadata: null,
    createdAt: new Date("2024-01-01"),
    source: {
      id: "feature-1",
      type: ArtifactType.Document,
      subtype: null,
      name: "Feature",
      slug: "feature-1",
      externalUrl: null,
      organizationId: "org-1",
      projectId: "project-1",
      status: "ACTIVE",
      priority: null,
      assigneeId: null,
      createdById: "user-1",
      updatedAt: new Date("2024-01-01"),
      dueDate: null,
      sortOrder: null,
      createdAt: new Date("2024-01-01"),
    },
    target: {
      id: "ext-1",
      type: ArtifactType.Branch,
      subtype: null,
      name: overrides?.name ?? "My pull request",
      slug: null,
      externalUrl:
        overrides?.externalUrl ?? "https://github.com/org/repo/pull/42",
      organizationId: "org-1",
      projectId: "project-1",
      status: "ACTIVE",
      priority: null,
      assigneeId: null,
      createdById: "user-1",
      updatedAt: new Date("2024-01-01"),
      dueDate: null,
      sortOrder: null,
      createdAt: new Date("2024-01-01"),
    },
  };
}

describe("BranchRow", () => {
  it("renders the PR name as a link to /build/:id", () => {
    renderWithNav(
      <BranchRow
        link={makePrArtifactLink({ name: "feat: add new feature" })}
        onUnlink={vi.fn()}
      />
    );

    expect(screen.getByText("feat: add new feature")).toBeDefined();
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/test-org/build/ext-1");
  });

  it("renders null when the target endpoint is not a pull request", () => {
    const link: ArtifactLinkWithEndpoints = {
      ...makePrArtifactLink(),
      target: {
        id: "doc-1",
        type: ArtifactType.Document,
        subtype: null,
        name: "Doc",
        slug: "doc-1",
        externalUrl: null,
        organizationId: "org-1",
        projectId: "project-1",
        status: "ACTIVE",
        priority: null,
        assigneeId: null,
        createdById: "user-1",
        updatedAt: new Date("2024-01-01"),
        dueDate: null,
        sortOrder: null,
        createdAt: new Date("2024-01-01"),
      },
    };

    const { container } = renderWithNav(
      <BranchRow link={link} onUnlink={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });
});
