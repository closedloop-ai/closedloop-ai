import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ orgSlug: "test-org" })),
  usePathname: vi.fn(() => "/test-org/my-tasks"),
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
}));

vi.mock(
  "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/[projectId]/components/create-document-modal",
  () => ({
    CreateDocumentModal: () => <div data-testid="create-document-modal" />,
  })
);

vi.mock(
  "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/[projectId]/components/create-feature-modal",
  () => ({
    CreateFeatureModal: () => <div data-testid="create-feature-modal" />,
  })
);

vi.mock("@/app/(authenticated)/[orgSlug]/teams/components/team-modal", () => ({
  TeamModal: ({ trigger }: { trigger: ReactNode }) => (
    <div data-testid="team-modal">{trigger}</div>
  ),
}));

// Import after mocks
import { makeProject } from "@repo/app/shared/test-fixtures/project";
import { MyTasksEmptyState } from "../my-tasks-empty-state";

describe("MyTasksEmptyState — no project context", () => {
  it("renders a 'Create a Team' action that opens the team modal", () => {
    render(<MyTasksEmptyState projects={[]} />);

    expect(screen.getByTestId("team-modal")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create a Team" })
    ).toBeInTheDocument();
  });

  it("does not link to the non-existent /teams route", () => {
    const { container } = render(<MyTasksEmptyState projects={[]} />);

    // The old empty state linked to /{orgSlug}/teams, which has no page and
    // 404s on RSC prefetch. The team-creation modal replaces that dead link.
    expect(
      container.querySelector('a[href$="/teams"]')
    ).not.toBeInTheDocument();
  });

  it("does not render the team-creation action when project context exists", () => {
    render(<MyTasksEmptyState projects={[makeProject()]} />);

    expect(screen.queryByTestId("team-modal")).not.toBeInTheDocument();
  });

  it("renders action cards when project context exists", () => {
    render(<MyTasksEmptyState projects={[makeProject()]} />);

    expect(screen.getByText("Write a Requirements Doc")).toBeInTheDocument();
    expect(screen.getByText("Create a Feature")).toBeInTheDocument();
  });
});
