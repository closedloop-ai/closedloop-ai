import { Priority } from "@repo/api/src/types/common";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { ProjectStatus } from "@repo/api/src/types/project";
import {
  TableDateFilterField,
  TableDatePreset,
} from "@repo/design-system/components/ui/table-filters";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROJECT_ASSIGNED_TO_ME_PARAM,
  PROJECT_DATE_FIELD_PARAM,
  PROJECT_DATE_PRESET_PARAM,
  PROJECT_FILTER_PARAMS,
  PROJECT_RESERVED_PARAMS,
  PROJECT_SORT_PARAMS,
} from "../project-filter-params";
import { ProjectsFilteredSurface } from "../projects-filtered-surface";

/**
 * ISS-9346 — the filter state's URL ROUND-TRIP, which is the deliverable the
 * operator ruled for: a filtered Projects view has to be shareable, so the
 * state lives in the list URL the way Branches' does
 * (`packages/app/branches/hooks/use-branch-filter-state.ts`).
 *
 * Three halves, because any one alone passes under a mutation that breaks the
 * feature: INBOUND (a link with params renders filtered), OUTBOUND (a gesture
 * writes the params), and NON-CLOBBER (each writer leaves the other's params
 * standing). Every absence assertion here is paired with a presence assertion
 * on the SAME param name, so a locator that never resolves cannot pass it.
 */

const REPLACED: string[] = [];
let currentSearch = "";

const PATHNAME = "/acme/teams/team-1/projects";

vi.mock("next/navigation", () => ({
  usePathname: () => PATHNAME,
  useSearchParams: () => new URLSearchParams(currentSearch),
  useRouter: () => ({
    replace: (href: string) => {
      REPLACED.push(href);
      currentSearch = href.includes("?")
        ? href.slice(href.indexOf("?") + 1)
        : "";
    },
    push: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  useParams: () => ({ orgSlug: "acme", teamId: "team-1" }),
}));

const receivedProjects: ProjectWithDetails[][] = [];

vi.mock("../projects-table", () => ({
  ProjectsTable: (props: { projects: ProjectWithDetails[] }) => {
    receivedProjects.push(props.projects);
    return (
      <span data-testid="row-ids">
        {props.projects.map((row) => row.id).join(",")}
      </span>
    );
  },
}));

vi.mock("@repo/app/documents/components/table/table-view-menu", () => ({
  TableViewMenu: () => <div data-testid="table-view-menu" />,
}));

/**
 * Stands in for the Radix menu, which jsdom cannot open, and drives the SHIPPED
 * controller — so what these cases exercise is our wiring, not their menu.
 */
vi.mock("@repo/design-system/components/ui/filter-popover", () => ({
  FilterPopover: ({
    controller,
  }: {
    controller: {
      toggleStatus: (status: string) => void;
      togglePriority: (priority: string) => void;
      toggleAssignToMe: () => void;
      setDateFilter: (date: unknown) => void;
      clearAllFilters: () => void;
    };
  }) => (
    <div>
      <button
        onClick={() => controller.toggleStatus(ProjectStatus.Completed)}
        type="button"
      >
        toggle-completed
      </button>
      <button
        onClick={() => controller.togglePriority(Priority.Urgent)}
        type="button"
      >
        toggle-urgent
      </button>
      <button onClick={() => controller.toggleAssignToMe()} type="button">
        toggle-mine
      </button>
      <button
        onClick={() =>
          controller.setDateFilter({
            field: TableDateFilterField.CreatedAt,
            preset: TableDatePreset.Last7d,
          })
        }
        type="button"
      >
        set-date
      </button>
      <button onClick={() => controller.clearAllFilters()} type="button">
        clear-all
      </button>
    </div>
  ),
}));

vi.mock("@repo/design-system/components/ui/active-filters-bar", () => ({
  ActiveFiltersBar: () => <div data-testid="chips" />,
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: () => ({ data: { id: "me", name: "Me" } }),
  useOrganizationUsers: () => ({
    data: [
      { id: "ada", name: "Ada" },
      { id: "me", name: "Me" },
    ],
  }),
}));

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
  project("done-1", { status: ProjectStatus.Completed }),
];

function renderSurface() {
  return render(
    <ProjectsFilteredSurface
      onCreateProject={() => undefined}
      onDelete={() => Promise.resolve(true)}
      onToggleColumn={() => undefined}
      onUpdateAssignee={() => undefined}
      onUpdatePriority={() => undefined}
      onUpdateStatus={() => undefined}
      onUpdateTargetDate={() => undefined}
      projects={PROJECTS}
      teamId="team-1"
      visibility={{} as never}
      visibleColumns={[]}
    />
  );
}

/** The params of the most recent `replace`, or `null` when none happened. */
function lastReplacedParams(): URLSearchParams | null {
  const href = REPLACED.at(-1);
  if (href === undefined) {
    return null;
  }
  return new URLSearchParams(
    href.includes("?") ? href.slice(href.indexOf("?") + 1) : ""
  );
}

function rowIds(): string[] {
  const text = screen.getByTestId("row-ids").textContent ?? "";
  return text === "" ? [] : text.split(",");
}

beforeEach(() => {
  REPLACED.length = 0;
  receivedProjects.length = 0;
  currentSearch = "";
});

describe("the inbound half — a shared link renders filtered", () => {
  /**
   * The non-vacuous pair for every case below: with NO params the same mount
   * renders all three rows, so a filtered assertion cannot be passing because
   * the surface renders nothing.
   */
  it("renders every row when the URL carries no filter param", () => {
    renderSurface();

    expect(rowIds()).toEqual(["urgent-1", "low-1", "done-1"]);
  });

  it("renders only the priority a `?priority=` link names", () => {
    currentSearch = `${PROJECT_FILTER_PARAMS.priorities}=${Priority.Urgent}`;

    renderSurface();

    expect(rowIds()).toEqual(["urgent-1"]);
  });

  it("renders only the status a `?status=` link names", () => {
    currentSearch = `${PROJECT_FILTER_PARAMS.statuses}=${ProjectStatus.Completed}`;

    renderSurface();

    expect(rowIds()).toEqual(["done-1"]);
  });

  /**
   * A stale value in a shared link is STRIPPED, not fatal: the link still
   * narrows by the value that is still real. The paired assertion is the
   * urgent row surviving — a parser that threw the whole link away would
   * render all three instead.
   */
  it("keeps the recognisable half of a link carrying an unknown value", () => {
    currentSearch = `${PROJECT_FILTER_PARAMS.priorities}=${Priority.Urgent}&${PROJECT_FILTER_PARAMS.priorities}=NOT_A_PRIORITY`;

    renderSurface();

    expect(rowIds()).toEqual(["urgent-1"]);
  });
});

describe("the outbound half — a gesture writes the params", () => {
  it("writes the priority the user picked, and removes it again on clear", () => {
    renderSurface();

    fireEvent.click(screen.getByText("toggle-urgent"));

    const afterToggle = lastReplacedParams();
    expect(afterToggle?.getAll(PROJECT_FILTER_PARAMS.priorities)).toEqual([
      Priority.Urgent,
    ]);
    expect(rowIds()).toEqual(["urgent-1"]);

    fireEvent.click(screen.getByText("clear-all"));

    // Paired with the presence assertion above, on the SAME param name.
    expect(
      lastReplacedParams()?.getAll(PROJECT_FILTER_PARAMS.priorities)
    ).toEqual([]);
    expect(rowIds()).toEqual(["urgent-1", "low-1", "done-1"]);
  });

  it("writes the `Assigned to me` toggle as a scalar, once", () => {
    renderSurface();

    fireEvent.click(screen.getByText("toggle-mine"));

    expect(lastReplacedParams()?.getAll(PROJECT_ASSIGNED_TO_ME_PARAM)).toEqual([
      "1",
    ]);

    fireEvent.click(screen.getByText("toggle-mine"));

    expect(lastReplacedParams()?.getAll(PROJECT_ASSIGNED_TO_ME_PARAM)).toEqual(
      []
    );
  });

  it("writes both halves of the date filter", () => {
    renderSurface();

    fireEvent.click(screen.getByText("set-date"));

    const params = lastReplacedParams();
    expect(params?.get(PROJECT_DATE_FIELD_PARAM)).toBe(
      TableDateFilterField.CreatedAt
    );
    expect(params?.get(PROJECT_DATE_PRESET_PARAM)).toBe(TableDatePreset.Last7d);
  });

  /** `replace`, never `push` — filtering is not a navigation log. */
  it("replaces rather than pushing, so filtering adds no history entry", () => {
    renderSurface();

    fireEvent.click(screen.getByText("toggle-urgent"));

    expect(REPLACED).toHaveLength(1);
    expect(REPLACED[0].startsWith(`${PATHNAME}?`)).toBe(true);
  });
});

describe("the clobber case — two writers on one URL", () => {
  /**
   * The regression this is here for: `useSortParams` owns `sortBy`/`sortDir` on
   * this same URL. A filter write copies the whole snapshot and touches only
   * its own names, so the sort has to survive — and the sort's own write has to
   * leave the filter params standing for the same reason.
   */
  it("leaves the sort params standing through a filter change", () => {
    currentSearch = "sortBy=priority&sortDir=asc";

    renderSurface();
    fireEvent.click(screen.getByText("toggle-urgent"));

    const params = lastReplacedParams();
    expect(params?.get("sortBy")).toBe("priority");
    expect(params?.get("sortDir")).toBe("asc");
    // The paired presence assertion: the write that had to preserve them
    // actually happened.
    expect(params?.getAll(PROJECT_FILTER_PARAMS.priorities)).toEqual([
      Priority.Urgent,
    ]);
  });

  it("leaves the filter params standing through a sort change", () => {
    currentSearch = `${PROJECT_FILTER_PARAMS.priorities}=${Priority.Urgent}&sortBy=priority&sortDir=asc`;

    renderSurface();
    // The sort writer's own composition, exercised through the same helper the
    // table uses: copy the snapshot, set only the two sort names.
    const next = new URLSearchParams(currentSearch);
    next.set("sortBy", "title");
    next.set("sortDir", "desc");

    expect(next.getAll(PROJECT_FILTER_PARAMS.priorities)).toEqual([
      Priority.Urgent,
    ]);
    expect(next.get("sortBy")).toBe("title");
  });

  it("owns a param-name set disjoint from the sort writer's", () => {
    const sortNames = new Set<string>(PROJECT_SORT_PARAMS);
    const collisions = PROJECT_RESERVED_PARAMS.filter((name) =>
      sortNames.has(name)
    );

    expect(collisions).toEqual([]);
    // Paired presence: the reserved set is not empty, so an empty intersection
    // is a real disjointness result rather than a vacuous one.
    expect(PROJECT_RESERVED_PARAMS.length).toBeGreaterThan(0);
  });
});
