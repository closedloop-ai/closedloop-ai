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
  "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/[projectId]/components/create-issue-modal",
  () => ({
    CreateIssueModal: () => <div data-testid="create-issue-modal" />,
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

// Raw Tailwind palette classes. Everything on this surface must come from the
// theme tokens instead, so any match is a regression.
const RAW_PALETTE_CLASS =
  /\b(?:bg|text|border)-(?:blue|amber|red|green|purple|pink|indigo|orange|teal|cyan)-\d{2,3}\b/;

// The two doors the old copy promised on a branch that renders neither.
const OPEN_AN_ISSUE_COPY = /open an issue/i;
const DESCRIBE_WHAT_YOU_WANT_BUILT_COPY = /describe what you want built/i;

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

  it("renders both create paths as buttons in the empty-state action slot", () => {
    const { container } = render(
      <MyTasksEmptyState projects={[makeProject()]} />
    );

    // The nouns match the toggle group above ("PRDs"/"Issues") and the project
    // page's create menu, rather than inventing a third name for a PRD.
    expect(
      screen.getByRole("button", { name: "Create PRD" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create Issue" })
    ).toBeInTheDocument();
    // Both live inside the design-system action slot rather than in
    // hand-rolled clickable cards.
    expect(
      container.querySelector('[data-slot="empty-content"]')
    ).toContainElement(screen.getByRole("button", { name: "Create Issue" }));
  });

  it("does not promise create paths the no-team branch has no button for", () => {
    render(<MyTasksEmptyState projects={[]} />);

    // The only action here is team creation, so the copy must not tell the
    // user to describe what they want built or open an issue.
    expect(
      screen.getByText("Create a team to start assigning work.")
    ).toBeInTheDocument();
    expect(screen.queryByText(OPEN_AN_ISSUE_COPY)).not.toBeInTheDocument();
    expect(
      screen.queryByText(DESCRIBE_WHAT_YOU_WANT_BUILT_COPY)
    ).not.toBeInTheDocument();
  });

  it("does not repeat the button labels in the description", () => {
    render(<MyTasksEmptyState projects={[makeProject()]} />);

    // The two buttons underneath already name both paths.
    expect(
      screen.getByText("Ready to start something new?")
    ).toBeInTheDocument();
  });

  it("renders the shared design-system empty state, not hand-rolled markup", () => {
    const { container } = render(
      <MyTasksEmptyState projects={[makeProject()]} />
    );

    // Both of this page's views render this component, so this markup is what
    // the list view AND the card board land on.
    expect(container.querySelector('[data-slot="empty"]')).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="empty-icon"]')
    ).toBeInTheDocument();
  });

  it("renders the recency branch on the same design-system empty state", () => {
    const { container } = render(
      <MyTasksEmptyState
        projects={[makeProject()]}
        recencyWindow={{ onShowAll: () => undefined }}
      />
    );

    // Both branches of this one zero-state slot must be the same component, or
    // removing/re-adding the recency chip moves the state and changes its type
    // scale and icon.
    expect(container.querySelector('[data-slot="empty"]')).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="empty-icon"]')
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="empty-content"]')
    ).toContainElement(screen.getByRole("button", { name: "Show all time" }));
  });

  it.each([
    ["queue clear", undefined],
    ["no team", undefined],
    ["recency window", { onShowAll: () => undefined }],
  ] as const)("uses theme tokens, never raw Tailwind palette colors (%s)", (label, recencyWindow) => {
    const { container } = render(
      <MyTasksEmptyState
        projects={label === "no team" ? [] : [makeProject()]}
        recencyWindow={recencyWindow}
      />
    );

    // Regression guard: the icons used to sit in raw-palette tinted chips
    // (bg-blue-500/10 + text-blue-500, bg-amber-500/10 + text-amber-500),
    // which ignore the theme tokens every other surface reads from.
    for (const element of container.querySelectorAll("[class]")) {
      expect(element.getAttribute("class")).not.toMatch(RAW_PALETTE_CLASS);
    }
  });
});
