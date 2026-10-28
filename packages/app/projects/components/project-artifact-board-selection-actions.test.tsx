import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import { IssueStatus } from "@repo/api/src/types/document";
import {
  ProjectStatus,
  type ProjectWithDetails,
} from "@repo/api/src/types/project";
import type { DetailedArtifact } from "@repo/api/src/types/project-tree";
import { BULK_TAG_ACTION_ID } from "@repo/app/tags/lib/bulk-tag-labels";
import { TableBulkActionUndo } from "@repo/design-system/components/ui/table-bulk-actions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectArtifactBoardSelectionActions } from "./project-artifact-board-selection-actions";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const ISSUE_ID = "00000000-0000-4000-8000-000000000002";
const BRANCH_ID = "00000000-0000-4000-8000-000000000003";
const DESTINATION_ID = "00000000-0000-4000-8000-000000000004";
const NOW = new Date("2026-10-19T00:00:00.000Z");

const mocks = vi.hoisted(() => ({ enabled: false, statusSelect: vi.fn() }));
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: () => mocks.enabled,
}));
vi.mock("@repo/app/documents/hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: () => ({ data: [] }),
}));
vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useBatchDeleteDocuments: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useMergeDocuments: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock("@repo/app/shared/api/use-api-client-optional", () => ({
  useApiClientOptional: () => ({ post: vi.fn() }),
}));
vi.mock("@repo/app/documents/components/table/bulk-status-picker", () => ({
  BULK_STATUS_ACTION_ID: "bulk-status",
  useBulkStatusAction: (rows: DetailedArtifact[]) => ({
    applicableIds: rows
      .filter((row) => row.statusMutation?.permissions?.bulk !== false)
      .map((row) => row.id),
    icon: null,
    id: "bulk-status",
    kind: "command",
    label: "Change Status",
    onSelect: mocks.statusSelect,
    undo: TableBulkActionUndo.NotImplemented,
  }),
}));
vi.mock("@repo/app/documents/components/table/bulk-priority-picker", () => ({
  BULK_PRIORITY_ACTION_ID: "bulk-priority",
  useBulkPriorityAction: () => ({
    emptyLabel: "No priorities available",
    icon: null,
    id: "bulk-priority",
    kind: "picker",
    label: "Change Priority",
    onSelect: vi.fn(),
    options: [{ id: "high", label: "High" }],
    undo: TableBulkActionUndo.NotImplemented,
  }),
}));
vi.mock("@repo/app/tags/components/bulk-tag-action", () => ({
  useBulkTagFamilyActions: () => [
    {
      icon: null,
      id: BULK_TAG_ACTION_ID,
      kind: "command",
      label: "Add Tag",
      onSelect: vi.fn(),
      undo: TableBulkActionUndo.NotImplemented,
    },
  ],
}));

const issue: DetailedArtifact = {
  assignee: null,
  assigneeId: null,
  createdAt: NOW,
  createdById: null,
  dueDate: null,
  externalUrl: null,
  id: ISSUE_ID,
  name: "Ship issue",
  organizationId: "org-1",
  priority: null,
  projectId: PROJECT_ID,
  slug: "ISS-724",
  sortOrder: 0,
  status: IssueStatus.Todo,
  subtype: ArtifactSubtype.Feature,
  type: ArtifactType.Document,
  updatedAt: NOW,
};
const branch: DetailedArtifact = {
  ...issue,
  id: BRANCH_ID,
  name: "Ship branch",
  slug: "BR-724",
  subtype: null,
  type: ArtifactType.Branch,
};
const destination: ProjectWithDetails = {
  assigneeId: null,
  codebaseSummary: null,
  completionPercentage: 0,
  createdAt: NOW,
  createdById: "creator-1",
  description: null,
  id: DESTINATION_ID,
  lastIndexedAt: null,
  name: "Beta",
  organizationId: "org-1",
  priority: null,
  settings: {},
  slug: "PRO-725",
  sortOrder: null,
  status: ProjectStatus.InProgress,
  targetDate: null,
  teams: [],
  updatedAt: NOW,
};

function renderActions(selectedArtifacts: DetailedArtifact[], pending = false) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ProjectArtifactBoardSelectionActions
        currentProjectId={PROJECT_ID}
        onClear={vi.fn()}
        onMoveToProject={vi.fn().mockResolvedValue(undefined)}
        onRetain={vi.fn()}
        pending={pending}
        project={{ id: PROJECT_ID, name: "Apollo" }}
        projects={[destination]}
        selectedArtifacts={selectedArtifacts}
        selectedCount={selectedArtifacts.length}
        users={[]}
      />
    </QueryClientProvider>
  );
}

describe("Project board selection registry adapter", () => {
  beforeEach(() => {
    mocks.enabled = false;
    mocks.statusSelect.mockReset();
  });

  it("retains the shipped flag-off Move and Clear rail", () => {
    renderActions([issue]);

    expect(
      screen.getByRole("button", { name: "Move to project" })
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Clear selection" })
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Favorite" })).toBeNull();
  });

  it("keeps page-supported owner and status visible for mixed Issue and Branch roots", () => {
    mocks.enabled = true;
    renderActions([issue, branch]);

    expect(screen.getByRole("button", { name: "Favorite" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Move to project" })
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Add Tag" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Assign owner" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Change Status" })).toBeVisible();
  });

  it("keeps page-supported owner and status visible for an all-Branch selection", () => {
    mocks.enabled = true;
    renderActions([branch]);

    expect(screen.getByRole("button", { name: "Assign owner" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Change Status" })).toBeVisible();
  });

  it("keeps Status visible but does not mutate a non-editable Document", () => {
    mocks.enabled = true;
    const restricted = {
      ...issue,
      statusMutation: {
        allowedStatuses: [IssueStatus.Todo],
        expectedStatusByIdField: "expectedStatusById" as const,
        expectedStatusField: "expectedStatus" as const,
        permissions: { bulk: false, single: true },
      },
    };
    renderActions([restricted]);

    const status = screen.getByRole("button", { name: "Change Status" });
    expect(status).toBeVisible();
    status.click();
    expect(mocks.statusSelect).not.toHaveBeenCalled();
  });

  it("offers owner and status for an Issue and blocks actions during placement", () => {
    mocks.enabled = true;
    const view = renderActions([issue]);
    expect(screen.getByRole("button", { name: "Assign owner" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Change Status" })).toBeVisible();

    view.unmount();
    renderActions([issue], true);
    expect(
      screen.getByRole("button", { name: "Move to project" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Clear selection" })
    ).toBeDisabled();
  });
});
