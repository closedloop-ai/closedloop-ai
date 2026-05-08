import { Priority } from "@repo/api/src/types/common";
import type { DocumentWithWorkstream } from "@repo/api/src/types/document";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
  usePathname: vi.fn(() => "/"),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  useParams: vi.fn(() => ({})),
}));

vi.mock("@/hooks/queries/use-judges", () => ({
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

import type {
  DocumentRowItem,
  RowEditHandlers,
} from "@/components/document-table/document-row";
import { DocumentRow } from "@/components/document-table/document-row";
import {
  DocumentColumn as Col,
  type DocumentColumn,
} from "@/hooks/use-column-visibility";

const TEST_ASSIGNEE = {
  id: "user-1",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  avatarUrl: null,
};

function makeArtifact(
  overrides?: Partial<DocumentWithWorkstream>
): DocumentWithWorkstream {
  return {
    id: "artifact-1",
    organizationId: "org-1",
    workstreamId: null,
    projectId: "project-1",
    type: DocumentType.Prd,
    title: "Test PRD",
    slug: "PRD-1",
    fileName: null,
    status: DocumentStatus.Draft,
    priority: Priority.Medium,
    latestVersion: 1,
    createdById: "user-1",
    assigneeId: TEST_ASSIGNEE.id,
    assignee: TEST_ASSIGNEE,
    approverId: null,
    approver: null,
    tokenUsage: null,
    targetRepo: null,
    targetBranch: null,
    templateForType: null,
    sortOrder: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-02"),
    project: {
      id: "project-1",
      name: "Project Hyperion",
      teams: [{ id: "team-1", name: "Core Team" }],
    },
    ...overrides,
  };
}

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
    const item: DocumentRowItem = { kind: "artifact", data: makeArtifact() };

    renderRow(item, { visibleColumns: [Col.Project] });

    expect(screen.getAllByText("Project Hyperion").length).toBeGreaterThan(0);
    expect(hasTooltipText("Project Hyperion")).toBe(true);
  });

  it("shows the full parent title in the parent cell tooltip", () => {
    const item: DocumentRowItem = { kind: "artifact", data: makeArtifact() };

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
    const item: DocumentRowItem = { kind: "artifact", data: makeArtifact() };

    renderRow(item, { visibleColumns: [Col.Assignee] });

    expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThan(0);
    expect(hasTooltipText("Ada Lovelace")).toBe(true);
  });

  it("shows the assignee tooltip even when the assignee cell is editable", () => {
    const item: DocumentRowItem = { kind: "artifact", data: makeArtifact() };

    renderRow(item, {
      visibleColumns: [Col.Assignee],
      editHandlers: {
        onUpdateAssignee: vi.fn(),
        teamMembers: [
          {
            id: TEST_ASSIGNEE.id,
            name: "Ada Lovelace",
            email: TEST_ASSIGNEE.email,
          },
        ],
      },
    });

    expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThan(0);
    expect(hasTooltipText("Ada Lovelace")).toBe(true);
  });
});
