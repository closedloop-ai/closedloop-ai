import { ProjectStatus } from "@repo/api/src/types/project";
import { makeProject } from "@repo/app/shared/test-fixtures/project";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectDetailHeader } from "../project-detail-header";

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: ({
    afterBreadcrumbs,
    children,
    moreMenu,
  }: {
    afterBreadcrumbs?: React.ReactNode;
    children?: React.ReactNode;
    moreMenu?: React.ReactNode;
  }) => (
    <header>
      {afterBreadcrumbs}
      {moreMenu}
      {children}
    </header>
  ),
}));

// ISS-13007 R-HEADER-HEIGHT, shipped for everyone (ISS-13035): the legacy
// Project Detail header renders with no feature flag mounted at all.
describe("legacy Project Detail header sizing", () => {
  function mount() {
    return render(
      <ProjectDetailHeader
        favoritesDisabled={false}
        isFavorite={false}
        onCreateArtifact={vi.fn()}
        onCreateFeature={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        onToggleFavorite={vi.fn()}
        onUpdateStatus={vi.fn()}
        orgSlug="org"
        project={makeProject({ status: ProjectStatus.InProgress })}
        statusPending={false}
        teamId="team"
        teamName="Team"
      />
    );
  }

  it("HEADER-1 draws the star and the more menu 32px square", () => {
    mount();
    const [star, more] = screen.getAllByRole("button");
    for (const icon of [star, more]) {
      expect(icon?.className).toContain("size-8");
      expect(icon?.className).not.toContain("h-6");
    }
  });

  it("HEADER-2 draws the Actions button at the small header size", () => {
    mount();
    const actions = screen.getAllByRole("button").at(-1);
    expect(actions).toHaveTextContent("Actions");
    expect(actions?.className).toContain("h-8");
    expect(actions?.className).not.toContain("h-9");
  });
});
