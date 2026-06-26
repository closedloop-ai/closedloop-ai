import { screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "./render-with-nav";

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

vi.mock("@repo/app/judges-analytics/hooks/use-judges", () => ({
  useFeatureJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  usePlanJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  usePrdJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
}));

vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { DocumentRow } from "@repo/app/documents/components/table/document-row";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import {
  DocumentColumn as Col,
  type DocumentColumn,
} from "@repo/app/shared/hooks/use-column-visibility";
import {
  makeArtifact,
  TEST_USER,
} from "@repo/app/shared/test-fixtures/documents";

const TEST_PROJECT = {
  id: "project-1",
  name: "Project Hyperion",
  teams: [{ id: "team-1", name: "Core Team" }],
};

function renderRow(
  item: DocumentRowItem,
  {
    visibleColumns,
    editHandlers,
    parentTitle,
    parentHref,
  }: {
    visibleColumns: DocumentColumn[];
    editHandlers?: RowEditHandlers;
    parentTitle?: string;
    parentHref?: string | null;
  }
) {
  return render(
    <DocumentRow
      editHandlers={editHandlers}
      item={item}
      parentHref={parentHref}
      parentTitle={parentTitle}
      visibleColumns={visibleColumns}
    />
  );
}

function hasTooltipText(text: string): boolean {
  return screen
    .getAllByTestId("tooltip-content")
    .some((node) => node.textContent?.includes(text));
}

describe("DocumentRow shared cell tooltips", () => {
  it("shows the full project name in the project cell tooltip", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ project: TEST_PROJECT }),
    };

    renderRow(item, { visibleColumns: [Col.Project] });

    expect(screen.getAllByText("Project Hyperion").length).toBeGreaterThan(0);
    expect(hasTooltipText("Project Hyperion")).toBe(true);
  });

  it("shows the full parent title in the parent cell tooltip", () => {
    const item: DocumentRowItem = { kind: "document", data: makeArtifact() };

    renderRow(item, {
      visibleColumns: [Col.Parent],
      parentHref: "/features/FEAT-9",
      parentTitle: "Parent Feature With A Very Long Name",
    });

    expect(
      screen.getAllByText("Parent Feature With A Very Long Name").length
    ).toBeGreaterThan(0);
    expect(hasTooltipText("Parent Feature With A Very Long Name")).toBe(true);
  });

  it("shows the assignee name in the read-only assignee cell tooltip", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({
        assigneeId: TEST_USER.id,
        assignee: TEST_USER,
      }),
    };

    renderRow(item, { visibleColumns: [Col.Assignee] });

    expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThan(0);
    expect(hasTooltipText("Ada Lovelace")).toBe(true);
  });

  it("shows the assignee tooltip even when the assignee cell is editable", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({
        assigneeId: TEST_USER.id,
        assignee: TEST_USER,
      }),
    };

    renderRow(item, {
      visibleColumns: [Col.Assignee],
      editHandlers: {
        onUpdateAssignee: vi.fn(),
        teamMembers: [
          {
            id: TEST_USER.id,
            name: "Ada Lovelace",
            email: TEST_USER.email,
          },
        ],
      },
    });

    expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThan(0);
    expect(hasTooltipText("Ada Lovelace")).toBe(true);
  });
});
