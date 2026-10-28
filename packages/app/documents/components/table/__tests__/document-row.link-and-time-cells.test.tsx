/**
 * Behaviour contract for the document-table cells that had a rendering but no
 * assertion of their own (ISS-6386):
 *
 * - `ParentCell` / `ProjectCell` become links only when they have a route to
 *   link to, so a missing parent route or a project with no team renders as
 *   plain text rather than a link to nowhere.
 * - `UpdatedCell` renders the row's `updatedAt` through the canonical
 *   relative-time formatter, and is the cell the Updated column routes to.
 * - `DueDateCell` / `AssigneeCell` render no control at all when the surface
 *   supplied no edit handler — a dead button that swallows the row click is the
 *   failure mode those branches exist to avoid.
 *
 * The cells are mounted directly rather than through a whole `DocumentRow`
 * because the row's own name cell contributes a link and a menu button that
 * would satisfy a row-scoped role query regardless of what the cell rendered.
 */

import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

import { ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import {
  AssigneeCell,
  DueDateCell,
  PriorityCell,
} from "@repo/app/documents/components/table/cells/edit-cells";
import {
  ParentCell,
  ProjectCell,
  UpdatedCell,
} from "@repo/app/documents/components/table/cells/static-cells";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { DocumentRow } from "@repo/app/documents/components/table/document-row";
import {
  RowEditContext,
  type RowEditHandlers,
} from "@repo/app/documents/components/table/row-edit-context";
import { DocumentColumn as Col } from "@repo/app/shared/hooks/use-column-visibility";
import { PRIORITY_LABELS } from "@repo/app/shared/lib/priority-constants";
import {
  makeArtifact,
  makeRawArtifact,
} from "@repo/app/shared/test-fixtures/documents";
import { makeProject } from "@repo/app/shared/test-fixtures/project";

const PARENT_TITLE = "Parent PRD";
const PARENT_HREF = "/test-org/artifacts/parent-prd";
const PROJECT_NAME = "Apollo";
const UPDATED_AT = new Date("2026-08-10T12:00:00.000Z");
const NOW = new Date("2026-08-13T12:00:00.000Z");

const ARTIFACT_ROW: DocumentRowItem = {
  kind: "document",
  data: makeArtifact({ updatedAt: UPDATED_AT }),
};

function renderWithHandlers(ui: React.ReactElement, handlers: RowEditHandlers) {
  return render(
    <RowEditContext.Provider value={handlers}>{ui}</RowEditContext.Provider>
  );
}

function renderProject(teams: { id: string; name: string }[]) {
  return render(
    <ProjectCell
      item={{
        kind: "project",
        data: makeProject({ name: PROJECT_NAME, teams }),
      }}
    />
  );
}

afterEach(() => {
  cleanup();
});

describe("ParentCell — link only when there is a route", () => {
  it("links the parent title to the supplied parent route", () => {
    renderWithHandlers(<ParentCell item={ARTIFACT_ROW} />, {
      parentHref: PARENT_HREF,
      parentTitle: PARENT_TITLE,
    });

    expect(screen.getByRole("link", { name: PARENT_TITLE })).toHaveAttribute(
      "href",
      PARENT_HREF
    );
  });

  it("renders the parent title as plain text when the row has no parent route", () => {
    renderWithHandlers(<ParentCell item={ARTIFACT_ROW} />, {
      parentHref: null,
      parentTitle: PARENT_TITLE,
    });

    // Asserted on the anchor element, not the `link` role: an `<a>` with no
    // href has no role, so a cell that wrongly kept the anchor and dropped the
    // href would still satisfy a role query.
    expect(screen.getByText(PARENT_TITLE).closest("a")).toBeNull();
  });

  it("renders the shared dash when the row has neither a parent title nor a route", () => {
    renderWithHandlers(<ParentCell item={ARTIFACT_ROW} />, {});

    expect(screen.getByText("—").closest("a")).toBeNull();
  });
});

describe("ProjectCell — link only when the project has a team to route through", () => {
  it("links the project name to its team-scoped project route", () => {
    renderProject([{ id: "team-1", name: "Team One" }]);

    expect(screen.getByRole("link", { name: PROJECT_NAME })).toHaveAttribute(
      "href",
      "/test-org/teams/team-1/projects/project-1"
    );
  });

  it("renders the project name as plain text when the project has no team", () => {
    renderProject([]);

    expect(screen.getByText(PROJECT_NAME).closest("a")).toBeNull();
  });
});

describe("UpdatedCell — canonical relative time", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("renders the row's updatedAt as a relative label", () => {
    render(<UpdatedCell item={ARTIFACT_ROW} />);

    expect(screen.getByText("3 days ago")).toBeInTheDocument();
  });

  it("is the cell the Updated column routes to", () => {
    render(<DocumentRow item={ARTIFACT_ROW} visibleColumns={[Col.Updated]} />);

    expect(screen.getByText("3 days ago")).toBeInTheDocument();
  });
});

describe("ProjectCell — a document row routes through its own project", () => {
  it("links a document row to the project route built from that project's team", () => {
    render(
      <ProjectCell
        item={{
          kind: "document",
          data: makeArtifact({
            project: {
              id: "project-9",
              name: PROJECT_NAME,
              teams: [{ id: "team-9", name: "Team Nine" }],
            },
          }),
        }}
      />
    );

    expect(screen.getByRole("link", { name: PROJECT_NAME })).toHaveAttribute(
      "href",
      "/test-org/teams/team-9/projects/project-9"
    );
  });
});

describe("edit cells — a row its registry marks uneditable gets no editor", () => {
  // Branch and session rows are `editable: false` in the row-type registry, and
  // the three edit cells short-circuit to a bare dash for them — before they
  // ever look at the surface's handlers. Handing them the full editable context
  // is the point: only the row type can suppress the editor here.
  const BRANCH_ROW: DocumentRowItem = {
    kind: "branch",
    data: makeRawArtifact(ArtifactType.Branch),
  };
  const SESSION_ROW: DocumentRowItem = {
    kind: "session",
    data: makeRawArtifact(ArtifactType.Session),
  };
  const FULLY_EDITABLE: RowEditHandlers = {
    onUpdateDueDate: vi.fn(),
    onUpdateAssignee: vi.fn(),
    onUpdatePriority: vi.fn(),
    teamMembers: [],
  };

  const CASES: ReadonlyArray<readonly [string, DocumentRowItem]> = [
    ["branch", BRANCH_ROW],
    ["session", SESSION_ROW],
  ];

  for (const [kind, item] of CASES) {
    it(`renders a bare dash for every edit cell on a ${kind} row`, () => {
      const { container } = renderWithHandlers(
        <>
          <DueDateCell item={item} />
          <AssigneeCell item={item} />
          <PriorityCell item={item} />
        </>,
        FULLY_EDITABLE
      );

      expect(screen.getAllByText("—")).toHaveLength(3);
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      // The dash is the whole cell — no calendar, no avatar, no priority glyph.
      expect(container.querySelector("svg")).toBeNull();
    });
  }
});

describe("PriorityCell — the editor commits the picked value for its own row", () => {
  it("calls the surface's handler with this row's id and the chosen priority", async () => {
    const onUpdatePriority = vi.fn();
    const user = userEvent.setup();
    renderWithHandlers(<PriorityCell item={ARTIFACT_ROW} />, {
      onUpdatePriority,
    });

    await user.click(screen.getByRole("button"));
    await user.click(
      await screen.findByRole("menuitem", { name: PRIORITY_LABELS.URGENT })
    );

    expect(onUpdatePriority).toHaveBeenCalledWith(
      ARTIFACT_ROW.data.id,
      Priority.Urgent
    );
  });

  it("names the trigger for the action when the row has no priority set", () => {
    renderWithHandlers(
      <PriorityCell
        item={{
          kind: "document",
          data: makeArtifact({ id: "artifact-unset", priority: undefined }),
        }}
      />,
      { onUpdatePriority: vi.fn() }
    );

    expect(
      screen.getByRole("button", { name: "Set priority" })
    ).toBeInTheDocument();
  });
});

describe("DueDateCell — a project row reads its target date", () => {
  it("shows the project's targetDate, not its updatedAt", () => {
    renderWithHandlers(
      <DueDateCell
        item={{
          kind: "project",
          // Local-component dates: `formatDateCompact` renders in the viewer's
          // zone, so a UTC instant would land on the previous day west of it.
          data: makeProject({
            targetDate: new Date(2026, 2, 4),
            updatedAt: new Date(2026, 7, 10),
          }),
        }}
      />,
      {}
    );

    expect(screen.getByText("3/4/26")).toBeInTheDocument();
  });
});

describe("DueDateCell — no control without an edit handler", () => {
  it("renders no button when the surface supplies no handler", () => {
    renderWithHandlers(<DueDateCell item={ARTIFACT_ROW} />, {});

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders a button once a handler is supplied", () => {
    renderWithHandlers(<DueDateCell item={ARTIFACT_ROW} />, {
      onUpdateDueDate: vi.fn(),
    });

    expect(screen.getByRole("button")).toBeInTheDocument();
  });
});

describe("AssigneeCell — no control without both a handler and team members", () => {
  it("renders no button when the surface supplies team members but no handler", () => {
    renderWithHandlers(<AssigneeCell item={ARTIFACT_ROW} />, {
      teamMembers: [],
    });

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders no button when the surface supplies a handler but no team members", () => {
    renderWithHandlers(<AssigneeCell item={ARTIFACT_ROW} />, {
      onUpdateAssignee: vi.fn(),
    });

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders a button once both a handler and team members are supplied", () => {
    renderWithHandlers(<AssigneeCell item={ARTIFACT_ROW} />, {
      onUpdateAssignee: vi.fn(),
      teamMembers: [],
    });

    expect(screen.getByRole("button")).toBeInTheDocument();
  });
});
