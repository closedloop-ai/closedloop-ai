import { Priority } from "@repo/api/src/types/common";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { ProjectStatus } from "@repo/api/src/types/project";
import {
  type ColumnVisibility,
  DocumentColumn,
} from "@repo/app/shared/hooks/use-column-visibility";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROJECTS_FILTERED_EMPTY_TITLE,
  ProjectsFilteredSurface,
} from "../projects-filtered-surface";

/**
 * ISS-9346 — the PRODUCTION WIRING, not the predicate.
 *
 * `project-filter-sort-model.test.ts` calls `filterProjects` directly, so it
 * stays green if the surface computes the filtered rows and then hands the
 * table the UNFILTERED ones. These mount the real surface with the real
 * `useProjectListFilters` and assert the row set the table actually receives,
 * which is the only thing that fails under that mutation.
 *
 * Only the data hooks are mocked; the controller, the predicate and the chip
 * strip are the shipped ones.
 */

/**
 * The surface's filter state round-trips through the list URL (ISS-9346), so
 * these mounts need a search-params snapshot. Nothing here asserts the URL —
 * `projects-filter-url-state.test.tsx` owns that — this is the harness these
 * cases need to keep exercising what they already assert.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/teams/team-1/projects",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({
    replace: vi.fn(),
    push: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  useParams: () => ({ orgSlug: "acme", teamId: "team-1" }),
}));

const receivedProjects: ProjectWithDetails[][] = [];
/** The create handler the surface hands down, which is what the inherited
 * empty-state action is wired to. */
let receivedOnCreateProject: (() => void) | undefined;

vi.mock("../projects-table", () => ({
  ProjectsTable: (props: {
    projects: ProjectWithDetails[];
    onCreateProject?: () => void;
    emptyStateTitle?: string;
  }) => {
    receivedProjects.push(props.projects);
    receivedOnCreateProject = props.onCreateProject;
    return (
      <div data-testid="projects-table">
        <span data-testid="row-ids">
          {props.projects.map((row) => row.id).join(",")}
        </span>
        <span data-testid="empty-title">{props.emptyStateTitle ?? ""}</span>
      </div>
    );
  },
}));

vi.mock("@repo/app/documents/components/table/table-view-menu", () => ({
  TableViewMenu: () => <div data-testid="table-view-menu" />,
}));

/**
 * The design-system menu is stood in for by a double that drives the SAME
 * controller the real popover is handed — Radix submenus are not reachable in
 * jsdom, and what is under test here is our wiring, not their menu. The
 * controller, the predicate and the chip strip are all the shipped ones.
 */
vi.mock("@repo/design-system/components/ui/filter-popover", () => ({
  FilterPopover: ({
    controller,
    viewModel,
  }: {
    controller: {
      togglePriority: (priority: string) => void;
      clearAllFilters: () => void;
    };
    viewModel: {
      teamMembers: { id: string }[];
      teamMembersLoading?: boolean;
      teamMembersError?: string | null;
    };
  }) => (
    <div>
      <button
        onClick={() => controller.togglePriority(Priority.Urgent)}
        type="button"
      >
        toggle-urgent
      </button>
      <button
        onClick={() => controller.togglePriority(Priority.High)}
        type="button"
      >
        toggle-high
      </button>
      <span data-testid="members">
        {viewModel.teamMembers.map((member) => member.id).join(",")}
      </span>
      <span data-testid="members-loading">
        {String(viewModel.teamMembersLoading ?? false)}
      </span>
      <span data-testid="members-error">
        {viewModel.teamMembersError ?? ""}
      </span>
    </div>
  ),
}));

vi.mock("@repo/design-system/components/ui/active-filters-bar", () => ({
  ActiveFiltersBar: ({
    controller,
  }: {
    controller: { activeChips: { label: string }[] };
  }) => (
    <div data-testid="chips">
      {controller.activeChips.map((chip) => chip.label).join("|")}
    </div>
  ),
}));

/** The `/users` query result the surface is rendered against, per case. */
let organizationUsersResult: {
  data?: { id: string; name: string }[];
  error?: Error;
  isLoading?: boolean;
} = {};

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: () => ({ data: { id: "me", name: "Me" } }),
  useOrganizationUsers: () => organizationUsersResult,
}));

const LOADED_USERS = {
  data: [
    { id: "ada", name: "Ada" },
    { id: "me", name: "Me" },
  ],
};

function project(
  id: string,
  overrides: Partial<ProjectWithDetails> = {}
): ProjectWithDetails {
  return {
    id,
    name: id,
    status: ProjectStatus.InProgress,
    priority: Priority.Medium,
    updatedAt: new Date(),
    ...overrides,
  } as ProjectWithDetails;
}

const PROJECTS = [
  project("urgent-1", { priority: Priority.Urgent }),
  project("low-1", { priority: Priority.Low }),
  project("urgent-2", { priority: Priority.Urgent }),
];

/** Every column hidden; these cases assert the rows, not the column menu. */
const HIDDEN_COLUMNS: ColumnVisibility = {
  [DocumentColumn.Type]: false,
  [DocumentColumn.Parent]: false,
  [DocumentColumn.DueDate]: false,
  [DocumentColumn.Assignee]: false,
  [DocumentColumn.Priority]: false,
  [DocumentColumn.Tags]: false,
  [DocumentColumn.Updated]: false,
  [DocumentColumn.Project]: false,
};

function renderSurface() {
  return render(
    <ProjectsFilteredSurface
      onCreateProject={vi.fn()}
      onDelete={() => Promise.resolve(true)}
      onToggleColumn={vi.fn()}
      onUpdateAssignee={vi.fn()}
      onUpdatePriority={vi.fn()}
      onUpdateStatus={vi.fn()}
      onUpdateTargetDate={vi.fn()}
      projects={PROJECTS}
      teamId="team-1"
      visibility={HIDDEN_COLUMNS}
      visibleColumns={[]}
    />
  );
}

function clickToggle(name: string) {
  fireEvent.click(screen.getByText(name));
}

describe("ProjectsFilteredSurface", () => {
  beforeEach(() => {
    receivedProjects.length = 0;
    receivedOnCreateProject = undefined;
    organizationUsersResult = LOADED_USERS;
  });

  it("hands the table every project before anything is selected", () => {
    renderSurface();

    expect(screen.getByTestId("row-ids")).toHaveTextContent(
      "urgent-1,low-1,urgent-2"
    );
  });

  /**
   * The mutation this exists for: rendering `projects` instead of
   * `visibleProjects` leaves the filter running and its result unused, and every
   * other test in this change stays green.
   */
  it("hands the table only the rows the selection admits", async () => {
    renderSurface();

    clickToggle("toggle-urgent");

    expect(await screen.findByTestId("row-ids")).toHaveTextContent(
      "urgent-1,urgent-2"
    );
    expect(screen.getByTestId("row-ids")).not.toHaveTextContent("low-1");
  });

  it("names the active filter in the chip strip", () => {
    renderSurface();

    clickToggle("toggle-urgent");

    expect(screen.getByTestId("chips")).toHaveTextContent("Priority: 1");
  });

  /**
   * The filtered-empty state, asserted WITHOUT pinning the action's words.
   *
   * Which action belongs on a filtered-empty Projects list is a product
   * decision this surface does not own, so the gated path renders the INHERITED
   * default rather than one invented here. What this pins is that the surface
   * still hands `onCreateProject` down — the handler that default action is
   * wired to — so the empty state keeps whatever action `ProjectsTable` renders
   * for it. Locating it through the handler rather than through the button's
   * text means rewording that button cannot make this case vacuous.
   */
  it("reaches the filtered-empty state with the inherited action still wired", () => {
    renderSurface();

    clickToggle("toggle-high");

    expect(screen.getByTestId("empty-title")).toHaveTextContent(
      PROJECTS_FILTERED_EMPTY_TITLE
    );
    expect(screen.getByTestId("row-ids")).toHaveTextContent("");
    expect(receivedOnCreateProject).toBeInstanceOf(Function);
  });

  /**
   * An empty member list is a CLAIM — "this team has nobody" — and a still-
   * arriving or failed `/users` must not make it (ISS-9346 review, whitlockk).
   * `FilterPopover` renders a loading row and an error row from these two
   * fields; substituting `[]` and saying nothing reads as a team with no
   * members, which is the distinction-collapse this pins.
   *
   * Asserted on the view model the shipped hook builds, so dropping either
   * passthrough fails here rather than only in the menu nobody mounts in jsdom.
   */
  it("says the members are still arriving rather than showing none", () => {
    organizationUsersResult = { isLoading: true };
    renderSurface();

    expect(screen.getByTestId("members")).toHaveTextContent("");
    expect(screen.getByTestId("members-loading")).toHaveTextContent("true");
    expect(screen.getByTestId("members-error")).toHaveTextContent("");
  });

  it("surfaces a failed member load rather than showing none", () => {
    organizationUsersResult = { error: new Error("users unavailable") };
    renderSurface();

    expect(screen.getByTestId("members")).toHaveTextContent("");
    expect(screen.getByTestId("members-error")).toHaveTextContent(
      "users unavailable"
    );
    expect(screen.getByTestId("members-loading")).toHaveTextContent("false");
  });
});
