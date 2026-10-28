import { ArtifactType } from "@repo/api/src/types/artifact";
import { batchItemApplied } from "@repo/api/src/types/batch-mutation-result";
import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { DocumentStatus } from "@repo/api/src/types/document";
import { TableBulkActionUndo } from "@repo/design-system/components/ui/table-bulk-actions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  artifact,
  currentProjectArtifactListView,
  firstId,
  mountProjectArtifactList,
  projectArtifactListMocks,
  resetProjectArtifactListMocks,
  secondId,
  tree,
} from "./support/project-artifact-list-live-harness";

const requests = vi.hoisted(() => ({ post: vi.fn() }));
const statusExecution = vi.hoisted(() => vi.fn());
const statusErrorMessage = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: toastError, success: vi.fn() },
}));
vi.mock("@repo/app/shared/api/use-api-client-optional", () => ({
  useApiClientOptional: () => ({ post: requests.post }),
}));
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: () => true,
}));
vi.mock("@repo/app/documents/components/table/bulk-status-picker", () => ({
  BULK_STATUS_ACTION_ID: "bulk-status",
  statusUpdateErrorMessage: statusErrorMessage,
  useBulkStatusAction: (_rows: unknown, rowIds: readonly string[]) => ({
    applicableIds: rowIds,
    icon: null,
    id: "bulk-status",
    kind: "picker",
    label: "Change Status",
    onSelect: vi.fn(),
    emptyLabel: "TEST ONLY: No statuses",
    executeForRegistry: statusExecution,
    options: [{ id: DocumentStatus.Draft, label: "Drafting" }],
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
      id: "bulk-tag",
      kind: "command",
      label: "Add Tag",
      onSelect: vi.fn(),
      undo: TableBulkActionUndo.NotImplemented,
    },
    {
      icon: null,
      id: "bulk-remove-tag",
      kind: "command",
      label: "Remove Tag",
      onSelect: vi.fn(),
      undo: TableBulkActionUndo.NotImplemented,
    },
  ],
}));

beforeEach(() => {
  resetProjectArtifactListMocks();
  requests.post.mockReset();
  statusExecution.mockReset();
  statusExecution.mockImplementation((rowIds: readonly string[]) =>
    Promise.resolve({ results: rowIds.map(batchItemApplied) })
  );
  statusErrorMessage.mockReset();
  statusErrorMessage.mockReturnValue("TEST ONLY: Status request was refused");
  toastError.mockReset();
  requests.post.mockImplementation((route: string, body: unknown) => {
    const ids =
      route === BatchMutationRoute.ArtifactsFavorites
        ? (body as { artifactIds: string[] }).artifactIds
        : (body as { documentIds: string[] }).documentIds;
    return Promise.resolve({
      results: ids.map(batchItemApplied),
      transactionId: "transaction-1",
    });
  });
});

describe("portable project list registry adoption", () => {
  it("takes the inner join for a mixed Issue and Branch selection", () => {
    mountProjectArtifactList("group=none", {
      ...tree,
      nodes: [
        tree.nodes[0]!,
        {
          root: {
            ...artifact(secondId, "Branch"),
            type: ArtifactType.Branch,
            subtype: null,
          },
          children: [],
        },
      ],
    });
    selectBoth();
    renderSelectionActions();
    expect(screen.getByRole("button", { name: "Favorite" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Move to project" })
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Add Tag" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove Tag" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Assign owner" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Change Status" })).toBeVisible();
  });

  it("sets every row to favorite for a mixed favorite selection", async () => {
    const user = userEvent.setup();
    projectArtifactListMocks().favoriteArtifactIds = [firstId];
    mountProjectArtifactList();
    selectBoth();
    renderSelectionActions();
    await user.click(screen.getByRole("button", { name: "Favorite" }));
    await vi.waitFor(() =>
      expect(requests.post).toHaveBeenCalledWith(
        BatchMutationRoute.ArtifactsFavorites,
        { artifactIds: [firstId, secondId], favorite: true }
      )
    );
  });

  it("keeps Priority, Merge, and Delete on the shared project artifact bar", () => {
    mountProjectArtifactList();
    selectBoth();
    renderSelectionActions();

    expect(
      screen.getByRole("button", { name: "Change Priority" })
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Merge" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete" })).toBeVisible();
  });

  it("uses the per-item owner route for two Issues", async () => {
    const user = userEvent.setup();
    mountProjectArtifactList();
    selectBoth();
    renderSelectionActions();
    await user.click(screen.getByRole("button", { name: "Assign owner" }));
    await user.click(screen.getByRole("button", { name: "Unassigned" }));
    await vi.waitFor(() =>
      expect(requests.post).toHaveBeenCalledWith(
        BatchMutationRoute.DocumentsUpdateAssignee,
        { documentIds: [firstId, secondId], assigneeId: null }
      )
    );
    expect(screen.getByRole("button", { name: "Change Status" })).toBeVisible();
  });

  it("executes project status through the existing status hook for applicable IDs", async () => {
    const user = userEvent.setup();
    mountProjectArtifactList();
    selectBoth();
    renderSelectionActions();

    await user.click(screen.getByRole("button", { name: "Change Status" }));
    await user.click(screen.getByRole("button", { name: "Drafting" }));

    await vi.waitFor(() =>
      expect(statusExecution).toHaveBeenCalledWith(
        [firstId, secondId],
        DocumentStatus.Draft
      )
    );
    expect(requests.post).not.toHaveBeenCalled();
  });

  it("uses the status-specific request error instead of outcome-unknown feedback", async () => {
    const user = userEvent.setup();
    const refusal = new Error("TEST ONLY: 400");
    statusExecution.mockRejectedValue(refusal);
    mountProjectArtifactList();
    selectBoth();
    renderSelectionActions();

    await user.click(screen.getByRole("button", { name: "Change Status" }));
    await user.click(screen.getByRole("button", { name: "Drafting" }));

    await vi.waitFor(() =>
      expect(statusErrorMessage).toHaveBeenCalledWith(refusal, 2, "Drafting")
    );
    expect(toastError).toHaveBeenCalledWith(
      "TEST ONLY: Status request was refused"
    );
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});

function selectBoth() {
  act(() =>
    currentProjectArtifactListView().controller.setSelectedArtifactIds(
      new Set([firstId, secondId])
    )
  );
}

function renderSelectionActions() {
  const actions = currentProjectArtifactListView().host.bulkActions;
  if (!isValidElement(actions)) {
    throw new Error("Expected project list action host");
  }
  return render(actions, { wrapper: queryWrapper });
}

function queryWrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}
