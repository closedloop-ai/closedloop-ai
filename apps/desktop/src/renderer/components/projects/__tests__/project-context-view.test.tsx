import {
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
  PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectContextView } from "../project-context-view";

const projectIndexPage = vi.hoisted(() => vi.fn());
const enabledFlags = vi.hoisted(() => new Set<string>());

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: (key: string) => enabledFlags.has(key),
}));

vi.mock("@repo/app/projects/components/project-index-page", () => ({
  ProjectIndexPage: (props: { archived: boolean; teamId: string }) => {
    projectIndexPage(props);
    return <div data-testid="desktop-project-index" />;
  },
}));

vi.mock("@repo/app/projects/components/project-detail-page", () => ({
  ProjectDetailPage: () => <div data-testid="desktop-project-detail" />,
}));

describe("Desktop Project index host", () => {
  beforeEach(() => {
    enabledFlags.clear();
    enabledFlags.add(PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY);
  });

  it("mounts the shared ProjectIndexPage that owns registry-backed bulk actions", () => {
    render(<ProjectContextView archived={false} teamId="team-1" />);

    expect(screen.getByTestId("desktop-project-index")).toBeTruthy();
    expect(projectIndexPage).toHaveBeenCalledWith({
      archived: false,
      teamId: "team-1",
    });
  });

  it("renders nothing for the index or a project while projects-portable-surface is off, even with gridview-adoption on (ISS-13035)", () => {
    enabledFlags.clear();
    enabledFlags.add(GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY);

    const index = render(
      <ProjectContextView archived={false} teamId="team-1" />
    );
    expect(index.container.firstChild).toBeNull();
    index.unmount();
    const detail = render(
      <ProjectContextView
        archived={false}
        projectId="project-1"
        teamId="team-1"
      />
    );
    expect(detail.container.firstChild).toBeNull();
  });
});
