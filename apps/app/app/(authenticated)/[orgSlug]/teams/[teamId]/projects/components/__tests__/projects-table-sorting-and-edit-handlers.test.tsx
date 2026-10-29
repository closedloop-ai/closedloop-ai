/**
 * Covers `ProjectsTable` branches the sibling suites in this directory don't
 * reach: the priority/assignee sort comparators, the `orgUsers` memo, the
 * `editHandlers` memo's optional-callback ternaries, and the `onDelete`
 * default fallback.
 *
 * `DocumentRow` is mocked (via `importOriginal` so the header's shared
 * `getDocumentRowGridTemplateColumns`/`getDocumentTableColumnCount` stay real)
 * so a render captures the exact `item`/`editHandlers` props `ProjectsTable`
 * computes without needing the full row's tooltip/ARIA/container-width tree.
 * `ProjectRowActions` and `DeleteConfirmationDialog` are mocked the same way
 * so the delete flow can be driven by calling the captured `requestDelete`/
 * `onConfirm` callbacks directly (real `act()`-wrapped state updates) instead
 * of fighting jsdom's lack of Radix pointer-capture support.
 */

import { Priority } from "@repo/api/src/types/common";
import {
  ProjectStatus,
  type ProjectWithDetails,
} from "@repo/api/src/types/project";
import { PROJECTS_FILTER_SORT_MODEL_FLAG_KEY } from "@repo/api/src/types/projects-filter-sort-model-flag";
import { ApproverRole, type User } from "@repo/api/src/types/user";
import { PriorityCell } from "@repo/app/documents/components/table/cells/edit-cells";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import {
  RowEditContext,
  type RowEditHandlers,
} from "@repo/app/documents/components/table/row-edit-context";
import { ARTIFACT_PRIORITY_UNSET_FLAG_KEY } from "@repo/app/documents/lib/artifact-priority-unset-flag";
import { NO_PRIORITY_LABEL } from "@repo/app/documents/lib/group-by";
import { PRIORITY_LABELS } from "@repo/app/shared/lib/priority-constants";
import { TableBulkActionUndo } from "@repo/design-system/components/ui/table-bulk-actions";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsTable } from "../projects-table";

const {
  replaceMock,
  searchParamsMock,
  testState,
  useFeatureFlagEnabledOptionalMock,
  useOrganizationUsersMock,
} = vi.hoisted(() => {
  const searchParamsFn = vi.fn(() => new URLSearchParams());
  // Mirrors what a real navigation would do: setting a new sort column
  // updates the URL that `useSearchParamsValue` next reads. `useSortParams`
  // also fires a real `useState` update on every `setSort` call (the
  // memory-mode branch of `useViewStatePersistence`, since this table
  // passes no `persistenceKey`), which is what actually triggers the
  // re-render that reads this updated value — no manual `rerender()` needed.
  const replaceFn = vi.fn((href: string) => {
    const queryIndex = href.indexOf("?");
    const query = queryIndex >= 0 ? href.slice(queryIndex + 1) : "";
    searchParamsFn.mockReturnValue(new URLSearchParams(query));
  });
  return {
    replaceMock: replaceFn,
    searchParamsMock: searchParamsFn,
    testState: {
      renderedRows: [] as { id: string; name: string }[],
      renderedItems: [] as DocumentRowItem[],
      latestEditHandlers: undefined as RowEditHandlers | undefined,
      latestOnSelectionChange: undefined as
        | ((id: string, checked: boolean) => void)
        | undefined,
      latestShowCheckbox: undefined as boolean | undefined,
      requestDelete: undefined as (() => void) | undefined,
      confirmDelete: undefined as (() => Promise<boolean>) | undefined,
      dialogOpen: false,
    },
    useFeatureFlagEnabledOptionalMock: vi.fn(),
    useOrganizationUsersMock: vi.fn(),
  };
});

vi.mock(
  "@repo/app/shared/feature-flags/use-feature-flag-enabled",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/app/shared/feature-flags/use-feature-flag-enabled")
    >()),
    useFeatureFlagEnabledOptional: (key: string) =>
      useFeatureFlagEnabledOptionalMock(key),
  })
);

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => searchParamsMock(),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({
    back: vi.fn(),
    navigate: vi.fn(),
    refresh: vi.fn(),
    replace: replaceMock,
  }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/acme/teams/team-1/projects",
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => useOrganizationUsersMock(),
}));

vi.mock(
  "@repo/app/documents/components/table/document-row",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@repo/app/documents/components/table/document-row")
      >();
    return {
      ...actual,
      DocumentRow: (props: {
        item: DocumentRowItem;
        editHandlers?: RowEditHandlers;
        moreMenuContent?: ReactNode;
        onSelectionChange?: (id: string, checked: boolean) => void;
        showCheckbox?: boolean;
      }) => {
        if (props.item.kind === "project") {
          testState.renderedRows.push({
            id: props.item.data.id,
            name: props.item.data.name,
          });
          testState.renderedItems.push(props.item);
          testState.latestEditHandlers = props.editHandlers;
          testState.latestOnSelectionChange = props.onSelectionChange;
          testState.latestShowCheckbox = props.showCheckbox;
        }
        return <div data-testid="document-row">{props.moreMenuContent}</div>;
      },
    };
  }
);

vi.mock("../project-row-actions", () => ({
  ProjectRowActions: (props: { onDelete: () => void }) => {
    testState.requestDelete = props.onDelete;
    return null;
  },
}));

vi.mock("@repo/app/shared/components/delete-confirmation-dialog", () => ({
  DeleteConfirmationDialog: (props: {
    open: boolean;
    onConfirm: () => Promise<boolean>;
  }) => {
    testState.dialogOpen = props.open;
    testState.confirmDelete = props.onConfirm;
    return null;
  },
}));

function makeProject(
  overrides?: Partial<ProjectWithDetails>
): ProjectWithDetails {
  return {
    id: "01PROJECT000000000000000",
    organizationId: "org-1",
    name: "Test Project",
    description: null,
    priority: Priority.Medium,
    assigneeId: null,
    createdById: "user-1",
    slug: null,
    targetDate: null,
    codebaseSummary: null,
    lastIndexedAt: null,
    settings: {},
    sortOrder: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-02"),
    status: ProjectStatus.InProgress,
    completionPercentage: 0,
    teams: [],
    ...overrides,
  };
}

function makeUser(overrides: Partial<User> & Pick<User, "id">): User {
  return {
    clerkId: `clerk-${overrides.id}`,
    organizationId: "org-1",
    email: "user@example.com",
    firstName: null,
    lastName: null,
    avatarUrl: null,
    phoneNumber: null,
    role: ApproverRole.Engineer,
    linearId: null,
    slackId: null,
    githubUsername: null,
    active: true,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  testState.renderedRows.length = 0;
  testState.renderedItems.length = 0;
  testState.latestEditHandlers = undefined;
  testState.latestOnSelectionChange = undefined;
  testState.latestShowCheckbox = undefined;
  testState.requestDelete = undefined;
  testState.confirmDelete = undefined;
  testState.dialogOpen = false;
  searchParamsMock.mockReturnValue(new URLSearchParams());
  useOrganizationUsersMock.mockReturnValue({ data: [] });
  useFeatureFlagEnabledOptionalMock.mockReturnValue(false);
});

/**
 * ISS-9346: the second flag read — the one selecting between the two whole
 * `SortConfig` tables. Without a case that opens it, deleting that read entirely
 * leaves the deterministic tie-break unreachable in production and every suite
 * green.
 */
function enableDeterministicSort() {
  useFeatureFlagEnabledOptionalMock.mockImplementation(
    (key: string) => key === PROJECTS_FILTER_SORT_MODEL_FLAG_KEY
  );
}

function enableUnsetPriority() {
  useFeatureFlagEnabledOptionalMock.mockImplementation(
    (key: string) => key === ARTIFACT_PRIORITY_UNSET_FLAG_KEY
  );
}

/** The row model the table last handed the real row for this project. */
function lastRenderedItem(projectId: string): DocumentRowItem {
  const item = [...testState.renderedItems]
    .reverse()
    .find((candidate) => candidate.data.id === projectId);
  if (!item) {
    throw new Error(`ProjectsTable rendered no row for ${projectId}`);
  }
  return item;
}

describe("ProjectsTable — unset priority (artifact-priority-unset)", () => {
  // ISS-9441: the fold is asserted on the ROW MODEL the table hands its rows,
  // then that exact item is painted by the real `PriorityCell`, so the value
  // the sort reads and the value the cell shows are proven to be one value.
  it("flag off: folds an unset project priority to Medium, so the cell renders Medium", () => {
    render(
      <ProjectsTable
        projects={[makeProject({ id: "proj-unset", priority: null })]}
        teamId="team-1"
      />
    );

    const item = lastRenderedItem("proj-unset");
    expect(item.data.priority).toBe(Priority.Medium);

    const { container } = render(<PriorityCell item={item} />);
    expect(
      within(container).getByText(PRIORITY_LABELS[Priority.Medium])
    ).toBeInTheDocument();
  });

  it("flag on: passes the unset priority through, so the cell renders the dash", () => {
    enableUnsetPriority();

    render(
      <ProjectsTable
        projects={[makeProject({ id: "proj-unset", priority: null })]}
        teamId="team-1"
      />
    );

    const item = lastRenderedItem("proj-unset");
    expect(item.data.priority).toBeNull();

    const { container } = render(<PriorityCell item={item} />);
    expect(within(container).getByText("—")).toBeInTheDocument();
    expect(
      within(container).queryByText(PRIORITY_LABELS[Priority.Medium])
    ).not.toBeInTheDocument();
  });

  it("flag on: sorting by priority keeps the unset project last in both directions", async () => {
    enableUnsetPriority();
    const user = userEvent.setup();
    const projects = [
      makeProject({ id: "proj-unset", name: "Unset Project", priority: null }),
      makeProject({
        id: "proj-low",
        name: "Low Project",
        priority: Priority.Low,
      }),
      makeProject({
        id: "proj-urgent",
        name: "Urgent Project",
        priority: Priority.Urgent,
      }),
    ];

    render(<ProjectsTable projects={projects} teamId="team-1" />);

    // First click on an inactive column sorts descending.
    testState.renderedRows.length = 0;
    await user.click(screen.getByRole("button", { name: "Priority" }));
    expect(
      testState.renderedRows.slice(-projects.length).map((row) => row.name)
    ).toEqual(["Low Project", "Urgent Project", "Unset Project"]);

    // Second click flips it ascending; the unset row must not follow the flip.
    testState.renderedRows.length = 0;
    await user.click(screen.getByRole("button", { name: "Priority" }));
    expect(
      testState.renderedRows.slice(-projects.length).map((row) => row.name)
    ).toEqual(["Urgent Project", "Low Project", "Unset Project"]);
  });
});

describe("ProjectsTable — shared bulk action host", () => {
  it("keeps row selection and the action band", () => {
    const projects = [
      makeProject({ id: "project-1" }),
      makeProject({ id: "project-2" }),
    ];
    const onChange = vi.fn();
    render(
      <ProjectsTable
        bulkSelection={{
          actions: [
            {
              icon: null,
              id: "favorite",
              kind: "command",
              label: "Favorite",
              onSelect: vi.fn(),
              undo: TableBulkActionUndo.NotImplemented,
            },
          ],
          enabled: true,
          onChange,
          selectedIds: new Set(projects.map((project) => project.id)),
        }}
        projects={projects}
        teamId="team-1"
      />
    );

    expect(screen.getByRole("button", { name: "Favorite" })).toBeVisible();
    expect(testState.latestShowCheckbox).toBe(true);

    testState.latestOnSelectionChange?.("project-2", false);
    expect(onChange).toHaveBeenCalledWith(new Set(["project-1"]));
  });

  it("ISS-13007 follow-up: the header select-all selects every row and, once all are selected, clears them", () => {
    const projects = [
      makeProject({ id: "project-1" }),
      makeProject({ id: "project-2" }),
    ];
    const onChange = vi.fn();
    const renderTable = (selectedIds: Set<string>) => (
      <ProjectsTable
        bulkSelection={{
          actions: [],
          enabled: true,
          onChange,
          selectedIds,
        }}
        projects={projects}
        teamId="team-1"
      />
    );
    const { rerender } = render(renderTable(new Set()));

    fireEvent.click(screen.getByRole("checkbox", { name: SELECT_ALL_NAME }));
    expect(onChange).toHaveBeenLastCalledWith(
      new Set(["project-1", "project-2"])
    );

    rerender(renderTable(new Set(["project-1", "project-2"])));
    fireEvent.click(screen.getByRole("checkbox", { name: DESELECT_ALL_NAME }));
    expect(onChange).toHaveBeenLastCalledWith(new Set());
  });

  it("ISS-13007 follow-up: no header select-all renders while bulk selection is off", () => {
    render(
      <ProjectsTable
        projects={[makeProject({ id: "project-1" })]}
        teamId="team-1"
      />
    );

    expect(
      screen.queryAllByRole("checkbox", { name: HEADER_SELECT_ALL_NAME })
    ).toHaveLength(0);
  });
});

const SELECT_ALL_NAME = /^select all$/i;
const DESELECT_ALL_NAME = /^deselect all$/i;
const HEADER_SELECT_ALL_NAME = /^(select|deselect) all$/i;

describe("ProjectsTable — priority sort comparator", () => {
  it("sorts rows by priority, sending an unknown priority value to the bottom via the ?? 99 fallback", async () => {
    const user = userEvent.setup();
    const projects = [
      makeProject({
        id: "proj-low",
        name: "Low Priority Project",
        priority: Priority.Low,
      }),
      makeProject({
        id: "proj-urgent",
        name: "Urgent Priority Project",
        priority: Priority.Urgent,
      }),
      // pins current behavior: a priority value outside the four known
      // Priority members (legacy/unrecognized data) falls back to sort order
      // 99 on both sides of the comparator, so it lands after every real
      // priority rather than crashing or sorting arbitrarily.
      makeProject({
        id: "proj-legacy",
        name: "Legacy Priority Project",
        priority: "LEGACY_UNKNOWN" as Priority,
      }),
    ];

    render(<ProjectsTable projects={projects} teamId="team-1" />);
    testState.renderedRows.length = 0;

    // First click on an inactive sortable column always goes descending
    // (`getNextSortDirection`), so this exercises the priority column's
    // highest-order-value-first (least urgent + unknown) ordering.
    await user.click(screen.getByRole("button", { name: "Priority" }));

    expect(
      testState.renderedRows.slice(-projects.length).map((row) => row.name)
    ).toEqual([
      "Legacy Priority Project",
      "Low Priority Project",
      "Urgent Priority Project",
    ]);
  });
});

describe("ProjectsTable — assignee sort comparator", () => {
  it("sorts rows by assignee display name, placing unassigned rows using the empty-string fallback", async () => {
    const user = userEvent.setup();
    const projects = [
      makeProject({
        id: "proj-none-1",
        name: "Unassigned Project One",
        assignee: undefined,
      }),
      makeProject({
        id: "proj-none-2",
        name: "Unassigned Project Two",
        assignee: undefined,
      }),
      makeProject({
        id: "proj-alice",
        name: "Alice's Project",
        assignee: {
          id: "user-alice",
          email: "alice@example.com",
          firstName: "Alice",
          lastName: "Adams",
          avatarUrl: null,
        },
      }),
      makeProject({
        id: "proj-bob",
        name: "Bob's Project",
        assignee: {
          id: "user-bob",
          email: "bob@example.com",
          firstName: "Bob",
          lastName: "Bailey",
          avatarUrl: null,
        },
      }),
    ];

    render(<ProjectsTable projects={projects} teamId="team-1" />);
    testState.renderedRows.length = 0;

    await user.click(screen.getByRole("button", { name: "Assignee" }));

    // Descending by display name: "Bob Bailey" sorts before "Alice Adams",
    // and both assigned rows sort before the unassigned ones (whose
    // comparator side falls back to ""). The two unassigned rows are a tie
    // (both ""), so Array.sort's stability keeps their original relative
    // order — pinning that the fallback participates in the comparator like
    // any other name rather than being treated as equal-and-unordered.
    expect(
      testState.renderedRows.slice(-projects.length).map((row) => row.name)
    ).toEqual([
      "Bob's Project",
      "Alice's Project",
      "Unassigned Project One",
      "Unassigned Project Two",
    ]);
  });
});

describe("ProjectsTable — orgUsers memo", () => {
  it("passes no team members while the organization users query has not resolved", () => {
    useOrganizationUsersMock.mockReturnValue({ data: undefined });

    render(
      <ProjectsTable
        projects={[makeProject({ id: "proj-1" })]}
        teamId="team-1"
      />
    );

    expect(testState.latestEditHandlers?.teamMembers).toEqual([]);
  });

  it("maps resolved organization users into popover users, defaulting a missing avatarUrl to undefined", () => {
    useOrganizationUsersMock.mockReturnValue({
      data: [
        makeUser({
          id: "user-ada",
          email: "ada@example.com",
          firstName: "Ada",
          lastName: "Lovelace",
          avatarUrl: "https://example.com/ada.png",
        }),
        makeUser({
          id: "user-grace",
          email: "grace@example.com",
          firstName: "Grace",
          lastName: "Hopper",
          avatarUrl: null,
        }),
      ],
    });

    render(
      <ProjectsTable
        projects={[makeProject({ id: "proj-1" })]}
        teamId="team-1"
      />
    );

    expect(testState.latestEditHandlers?.teamMembers).toEqual([
      {
        id: "user-ada",
        name: "Ada Lovelace",
        email: "ada@example.com",
        avatarUrl: "https://example.com/ada.png",
        initials: "A",
      },
      {
        id: "user-grace",
        name: "Grace Hopper",
        email: "grace@example.com",
        avatarUrl: undefined,
        initials: "G",
      },
    ]);
  });
});

describe("ProjectsTable — clearing a project priority from the grid", () => {
  /**
   * The row model and the `editHandlers` the table computes, painted by the real
   * `PriorityCell` — so what is driven here is the shipped
   * `ARTIFACT_PRIORITY_SUPPORT[Project]` declaration and the table's own
   * priority wiring, not a boolean or a handler this test chose. Reverting
   * `allowsUnset` to false takes the item away, and a table that drops a `null`
   * before the caller sees it never reaches `onUpdatePriority`; either fails the
   * flag-on case.
   */
  function renderCell(onUpdatePriority: RowEditHandlers["onUpdatePriority"]) {
    render(
      <ProjectsTable
        onUpdatePriority={onUpdatePriority}
        projects={[makeProject({ id: "proj-unset", priority: null })]}
        teamId="team-1"
      />
    );
    const editHandlers = testState.latestEditHandlers;
    if (!editHandlers) {
      throw new Error("ProjectsTable handed its rows no editHandlers");
    }
    return render(
      <RowEditContext.Provider value={editHandlers}>
        <PriorityCell item={lastRenderedItem("proj-unset")} />
      </RowEditContext.Provider>
    );
  }

  it("flag on: offers No priority and commits null for this row", async () => {
    enableUnsetPriority();
    const user = userEvent.setup();
    const onUpdatePriority = vi.fn();

    const { container } = renderCell(onUpdatePriority);
    await user.click(within(container).getByRole("button"));
    await user.click(
      await screen.findByRole("menuitem", { name: NO_PRIORITY_LABEL })
    );

    // `null`, not a sentinel string: it is what PUT /projects/[id] reads as the
    // clear, and what `useUpdateProjectPriority` now forwards.
    expect(onUpdatePriority).toHaveBeenCalledWith("proj-unset", null);
  });

  it("flag off: offers the four members and no clear", async () => {
    const user = userEvent.setup();

    const { container } = renderCell(vi.fn());
    await user.click(within(container).getByRole("button"));

    expect(
      screen.queryByRole("menuitem", { name: NO_PRIORITY_LABEL })
    ).toBeNull();
    // The positive sibling, so the assertion above is about the clear item and
    // not about a menu that never opened.
    expect(
      await screen.findByRole("menuitem", {
        name: PRIORITY_LABELS[Priority.Urgent],
      })
    ).toBeInTheDocument();
  });
});

describe("ProjectsTable — editHandlers optional callbacks", () => {
  it("wires the supplied optional callbacks into the row edit context", async () => {
    const onUpdateAssignee = vi.fn();
    const onUpdatePriority = vi.fn();
    const dueDateSettlement = Promise.resolve({ updated: true });
    const onUpdateTargetDate = vi.fn(() => dueDateSettlement);

    render(
      <ProjectsTable
        onUpdateAssignee={onUpdateAssignee}
        onUpdatePriority={onUpdatePriority}
        onUpdateTargetDate={onUpdateTargetDate}
        projects={[makeProject({ id: "proj-1" })]}
        teamId="team-1"
      />
    );

    testState.latestEditHandlers?.onUpdateAssignee?.("proj-1", "user-9");
    expect(onUpdateAssignee).toHaveBeenCalledWith("proj-1", "user-9");

    const dueDate = new Date("2026-02-01");
    const returnedSettlement = testState.latestEditHandlers?.onUpdateDueDate?.(
      "proj-1",
      dueDate
    );
    expect(onUpdateTargetDate).toHaveBeenCalledWith(
      "proj-1",
      dueDate,
      undefined
    );
    expect(returnedSettlement).toBe(dueDateSettlement);
    await expect(returnedSettlement).resolves.toEqual({ updated: true });

    testState.latestEditHandlers?.onUpdatePriority?.("proj-1", Priority.High);
    expect(onUpdatePriority).toHaveBeenCalledWith("proj-1", Priority.High);
  });

  it("omits the optional callbacks from the row edit context when the corresponding props are not supplied", () => {
    render(
      <ProjectsTable
        projects={[makeProject({ id: "proj-1" })]}
        teamId="team-1"
      />
    );

    expect(testState.latestEditHandlers?.onUpdateAssignee).toBeUndefined();
    expect(testState.latestEditHandlers?.onUpdatePriority).toBeUndefined();
    expect(testState.latestEditHandlers?.onUpdateDueDate).toBeUndefined();
  });
});

describe("ProjectsTable — onDelete default fallback", () => {
  it("forwards a confirmed delete to the supplied onDelete callback", async () => {
    const onDelete = vi.fn().mockResolvedValue(true);

    render(
      <ProjectsTable
        onDelete={onDelete}
        projects={[makeProject({ id: "proj-1" })]}
        teamId="team-1"
      />
    );

    act(() => {
      testState.requestDelete?.();
    });
    expect(testState.dialogOpen).toBe(true);

    let result: boolean | undefined;
    await act(async () => {
      result = await testState.confirmDelete?.();
    });

    expect(onDelete).toHaveBeenCalledWith("proj-1");
    expect(result).toBe(true);
  });

  it("resolves a confirmed delete to false via the default fallback when onDelete is omitted", async () => {
    render(
      <ProjectsTable
        projects={[makeProject({ id: "proj-1" })]}
        teamId="team-1"
      />
    );

    act(() => {
      testState.requestDelete?.();
    });
    expect(testState.dialogOpen).toBe(true);

    // pins current behavior: with no `onDelete` prop, the table's internal
    // `onDelete ?? (async () => false)` fallback resolves cleanly to false
    // instead of throwing (which is what would happen if the fallback were
    // removed and the confirmation dialog called `onDelete` directly).
    let result: boolean | undefined;
    await act(async () => {
      result = await testState.confirmDelete?.();
    });

    expect(result).toBe(false);
  });
});

describe("ProjectsTable — empty state", () => {
  it("renders custom empty-state copy and invokes the supplied create-project action", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn();

    render(
      <ProjectsTable
        emptyStateDescription="Kick off your first project to get going."
        emptyStateTitle="No custom projects"
        onCreateProject={onCreateProject}
        projects={[]}
        teamId="team-1"
      />
    );

    expect(screen.getByText("No custom projects")).toBeInTheDocument();
    expect(
      screen.getByText("Kick off your first project to get going.")
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create Project" }));

    expect(onCreateProject).toHaveBeenCalledTimes(1);
  });
});

/**
 * ISS-9346 — the rollout's ordering half, asserted through the TABLE rather
 * than by calling `sortTableData` with the config table directly. Three rows tie
 * on priority and arrive in a non-alphabetical order, so the closed branch hands
 * that order straight back and the open branch must not.
 */
describe("ProjectsTable — deterministic tie-break (projects-filter-sort-model)", () => {
  const TIED = [
    makeProject({ id: "p3", name: "Carol", priority: Priority.High }),
    makeProject({ id: "p1", name: "Alice", priority: Priority.High }),
    makeProject({ id: "p2", name: "Bob", priority: Priority.High }),
  ];

  async function sortByPriority(direction: "asc" | "desc"): Promise<string[]> {
    const user = userEvent.setup();
    render(<ProjectsTable projects={TIED} teamId="team-1" />);
    await user.click(screen.getByRole("button", { name: "Priority" }));
    if (direction === "desc") {
      await user.click(screen.getByRole("button", { name: "Priority" }));
    }
    testState.renderedRows.length = 0;
    await user.click(screen.getByRole("button", { name: "Priority" }));
    await user.click(screen.getByRole("button", { name: "Priority" }));
    return testState.renderedRows.slice(-TIED.length).map((row) => row.name);
  }

  it("leaves a tie in the order the rows arrived when the key is closed", async () => {
    expect(await sortByPriority("asc")).toEqual(["Carol", "Alice", "Bob"]);
  });

  it("orders a tie by name when the key is open", async () => {
    enableDeterministicSort();

    expect(await sortByPriority("asc")).toEqual(["Alice", "Bob", "Carol"]);
  });

  /** The tie-break is not negated, so both directions agree inside a tie. */
  it("keeps that order descending", async () => {
    enableDeterministicSort();

    expect(await sortByPriority("desc")).toEqual(["Alice", "Bob", "Carol"]);
  });
});
