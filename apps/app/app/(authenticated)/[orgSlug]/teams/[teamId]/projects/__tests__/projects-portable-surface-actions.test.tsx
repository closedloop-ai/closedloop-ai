import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { ProjectStatus } from "@repo/api/src/types/project";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsPortableSurface } from "../components/projects-portable-surface";

/**
 * ISS-10476: the promoted surface replaces a table that offered archive,
 * unarchive and delete on every row, plus inline due-date, owner and priority
 * editing in the cells. Flipping the key must be a surface swap, not a
 * capability regression, so these drive the real controls and assert the HOST
 * handler each one reached — a prop that was never rendered, or a control wired
 * to nothing, would both survive a render-only assertion.
 */

const ARCHIVE_ITEM = /Archive project/;
const UNARCHIVE_ITEM = /Unarchive project/;
const DELETE_ITEM = /Delete project/;
const DELETE_CONFIRM = /^Delete$/;
const FAVORITE_ITEM = /Add to Favorites/;
const HIGH_PRIORITY_ITEM = /^High$/;
const TARGET_DAY_BUTTON = /September 17th, 2026/;

const toggleFavoriteMock = vi.fn();

const ORGANIZATION_USER = {
  avatarUrl: null,
  email: "ada@example.com",
  firstName: "Ada",
  id: "user-1",
  lastName: "Lovelace",
};

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => ({ data: [ORGANIZATION_USER] }),
}));

// cmdk (the Command list inside UserSelectPopover) needs ResizeObserver, which
// jsdom does not implement.
class MockResizeObserver {
  observe() {
    // no-op
  }
  unobserve() {
    // no-op
  }
  disconnect() {
    // no-op
  }
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useIsFavorite: () => false,
  useToggleFavorite: () => ({ mutate: toggleFavoriteMock, isPending: false }),
}));

const PROJECT: ProjectWithDetails = {
  id: "project-1",
  name: "Apollo",
  slug: "PRO-1",
  status: ProjectStatus.NotStarted,
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
} as unknown as ProjectWithDetails;

function renderSurface(overrides?: Partial<ProjectWithDetails>) {
  const onDelete = vi.fn().mockResolvedValue(true);
  const onUpdateStatus = vi.fn();
  const onUpdateAssignee = vi.fn();
  const onUpdatePriority = vi.fn();
  const onUpdateTargetDate = vi.fn();
  render(
    <ProjectsPortableSurface
      onCreateProject={vi.fn()}
      onDelete={onDelete}
      onUpdateAssignee={onUpdateAssignee}
      onUpdatePriority={onUpdatePriority}
      onUpdateStatus={onUpdateStatus}
      onUpdateTargetDate={onUpdateTargetDate}
      orgSlug="acme"
      projects={[{ ...PROJECT, ...overrides }]}
      teamId="team-1"
      viewStateKey={null}
    />
  );
  return {
    onDelete,
    onUpdateAssignee,
    onUpdatePriority,
    onUpdateStatus,
    onUpdateTargetDate,
  };
}

async function openRowMenu() {
  await userEvent.click(screen.getByRole("button", { name: "Open menu" }));
}

/**
 * The control inside ONE data cell of the project's own row. Scoped by the
 * grid's `data-column-id`, because the column HEADER buttons carry the same
 * names ("Owner", "Due Date") and an unscoped query finds both.
 */
function cellControl(columnId: string): HTMLElement {
  const row = screen.getByText("Apollo").closest('[role="row"]');
  if (!row) {
    throw new Error("the project row did not render");
  }
  const cell = row.querySelector(`[data-column-id="${columnId}"]`);
  if (!(cell instanceof HTMLElement)) {
    throw new Error(`the ${columnId} cell did not render`);
  }
  return within(cell).getByRole("button");
}

describe("ProjectsPortableSurface keeps the row's project management actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the prototype heading", () => {
    renderSurface();
    expect(
      screen.getByRole("heading", { name: "Projects", level: 1 })
    ).toBeInTheDocument();
  });

  it("keeps favorites and archive reachable after switching to Board", async () => {
    const { onUpdateStatus } = renderSurface();
    await userEvent.click(
      screen.getAllByRole("radio", { name: "Board view" })[0]
    );
    await openRowMenu();
    await userEvent.click(
      await screen.findByRole("menuitem", { name: FAVORITE_ITEM })
    );
    expect(toggleFavoriteMock).toHaveBeenCalledWith({
      projectId: "project-1",
      isFavorite: false,
    });
    await openRowMenu();
    await userEvent.click(
      await screen.findByRole("menuitem", { name: ARCHIVE_ITEM })
    );
    expect(onUpdateStatus).toHaveBeenCalledWith(
      "project-1",
      ProjectStatus.Archived,
      ProjectStatus.NotStarted
    );
  });

  it("archives through the host's status handler", async () => {
    const { onUpdateStatus } = renderSurface();
    await openRowMenu();
    await userEvent.click(
      await screen.findByRole("menuitem", { name: ARCHIVE_ITEM })
    );
    expect(onUpdateStatus).toHaveBeenCalledWith(
      "project-1",
      ProjectStatus.Archived,
      ProjectStatus.NotStarted
    );
  });

  it("offers Unarchive on an archived project", async () => {
    const { onUpdateStatus } = renderSurface({
      status: ProjectStatus.Archived,
    });
    await openRowMenu();
    await userEvent.click(
      await screen.findByRole("menuitem", { name: UNARCHIVE_ITEM })
    );
    expect(onUpdateStatus).toHaveBeenCalledWith(
      "project-1",
      ProjectStatus.NotStarted,
      ProjectStatus.Archived
    );
  });

  it("routes Delete through the confirmation dialog to the host handler", async () => {
    const { onDelete } = renderSurface();
    await openRowMenu();
    await userEvent.click(
      await screen.findByRole("menuitem", { name: DELETE_ITEM })
    );
    expect(onDelete).not.toHaveBeenCalled();
    await userEvent.click(
      await screen.findByRole("button", { name: DELETE_CONFIRM })
    );
    expect(onDelete).toHaveBeenCalledWith("project-1");
  });

  it("favorites through the shared mutation", async () => {
    renderSurface();
    await openRowMenu();
    await userEvent.click(
      await screen.findByRole("menuitem", { name: FAVORITE_ITEM })
    );
    expect(toggleFavoriteMock).toHaveBeenCalledWith({
      projectId: "project-1",
      isFavorite: false,
    });
  });

  it("writes a priority through the host's mutation", async () => {
    const { onUpdatePriority } = renderSurface();
    await userEvent.click(cellControl("priority"));
    await userEvent.click(
      await screen.findByRole("menuitem", { name: HIGH_PRIORITY_ITEM })
    );
    expect(onUpdatePriority).toHaveBeenCalledWith("project-1", "HIGH");
  });

  it("writes an owner through the host's mutation", async () => {
    const { onUpdateAssignee } = renderSurface();
    await userEvent.click(cellControl("owner"));
    await userEvent.click(await screen.findByText("Ada Lovelace"));
    expect(onUpdateAssignee).toHaveBeenCalledWith("project-1", "user-1");
  });

  it("writes a target date through the host's mutation", async () => {
    const { onUpdateTargetDate } = renderSurface({
      targetDate: new Date("2026-09-10T00:00:00.000Z"),
    } as Partial<ProjectWithDetails>);
    await userEvent.click(cellControl("dueDate"));
    // The picker opens on the row's own month, so the day cell below exists
    // only if the trigger carried the stored value into it.
    await userEvent.click(
      await screen.findByRole("button", { name: TARGET_DAY_BUTTON })
    );
    expect(onUpdateTargetDate).toHaveBeenCalledWith(
      "project-1",
      expect.any(Date)
    );
  });

  it("renders the row rather than crashing when the record has no updatedAt", () => {
    renderSurface({ updatedAt: undefined as unknown as Date });
    expect(screen.getByText("Apollo")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });
});
