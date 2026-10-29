// @vitest-environment jsdom

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { Priority } from "@repo/api/src/types/common";
import { DocumentType, IssueStatus } from "@repo/api/src/types/document";
import type { ArtifactListProps } from "@repo/app/artifacts/components/artifact-list";
import type { CreateIssueModalProps } from "@repo/app/issues/components/create-issue-modal";
import { ArtifactKind } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IssuesIndexView } from "../issues-index-view";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  update: vi.fn(),
  captured: undefined as ArtifactListProps | undefined,
  modal: undefined as CreateIssueModalProps | undefined,
}));
vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useUpdateDocument: () => ({ mutate: mocks.update }),
}));
vi.mock("../../hooks/use-issues-index-read", () => ({
  useIssuesIndexRead: mocks.read,
}));
vi.mock("@repo/app/documents/components/documents-index-pagination", () => ({
  DocumentsIndexPaginationFooter: () => <div data-testid="pager" />,
}));
vi.mock("@repo/app/documents/hooks/use-delete-row-item", () => ({
  useDeleteRowItem: () => vi.fn(),
}));
vi.mock("@repo/app/users/hooks/use-org-users-as-popover-users", () => ({
  useOrgUsersAsPopoverUsers: () => [],
}));
vi.mock("@repo/app/shared/hooks/use-scroll-restore", () => ({
  useScrollRestore: () => undefined,
}));
vi.mock("@repo/app/shared/hooks/use-view-state-key", () => ({
  useViewStateKey: (key: string) => `org-1:${key}`,
}));
vi.mock("@repo/app/shared/hooks/use-view-state-persistence", () => ({
  useViewStatePersistence: () => ["", vi.fn()],
}));
vi.mock("@repo/app/artifacts/components/artifact-list", () => ({
  ArtifactList: (props: ArtifactListProps) => {
    mocks.captured = props;
    return props.creation;
  },
}));
vi.mock("../create-issue-modal", () => ({
  CreateIssueModal: (props: CreateIssueModalProps) => {
    mocks.modal = props;
    return <div>New Issue</div>;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.captured = undefined;
  mocks.modal = undefined;
  mocks.read.mockReturnValue({
    documents: [
      createMockDocument({
        type: DocumentType.Feature,
        status: IssueStatus.Backlog,
      }),
    ],
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
    isServerPaged: true,
    isSummaryUnsettled: false,
    searchAppliedUpstream: false,
    summaryParams: { types: [DocumentType.Feature] },
    pagination: PAGINATION,
  });
});
describe("shared organization Issues index host", () => {
  it("mounts the Documents parent as Issue over the server-paged org read", () => {
    render(<IssuesIndexView />);
    expect(mocks.read).toHaveBeenLastCalledWith({
      filterText: "",
      listRead: undefined,
      pageSizeStorageKey: "org-1:issues-index-page-size",
      recencyDays: undefined,
      scrollContainer: null,
    });
    expect(mocks.captured).toMatchObject({
      artifactKind: ArtifactKind.Issue,
      isServerPaged: true,
      isSummaryUnsettled: false,
      searchAppliedUpstream: false,
      searchParams: { types: [DocumentType.Feature] },
      storageKey: "org-1:issues-index",
    });
    render(<div>{mocks.captured?.pagination}</div>);
    expect(screen.getByTestId("pager")).toBeInTheDocument();
    act(() => mocks.captured?.onRecencyDaysChange?.(7));
    expect(mocks.read.mock.calls.at(-1)?.[0]).toMatchObject({
      recencyDays: 7,
    });
    const listRead = { completeRead: true, sortBy: "status", sortDir: "asc" };
    act(() => mocks.captured?.onListReadChange?.(listRead));
    expect(mocks.read.mock.calls.at(-1)?.[0]).toMatchObject({ listRead });
  });
  it("uses production inline writers and opens real issue creation", () => {
    render(<IssuesIndexView />);
    mocks.captured?.editHandlers.onUpdateStatus?.(
      "issue-1",
      IssueStatus.InProgress,
      ArtifactStatusEditSurface.InlineCell
    );
    mocks.captured?.editHandlers.onUpdatePriority?.("issue-1", Priority.High);
    mocks.captured?.editHandlers.onUpdateAssignee?.("issue-1", "user-2");
    expect(mocks.update).toHaveBeenCalledWith({
      id: "issue-1",
      status: IssueStatus.InProgress,
      surface: ArtifactStatusEditSurface.InlineCell,
    });
    expect(mocks.update).toHaveBeenCalledWith({
      id: "issue-1",
      priority: Priority.High,
      surface: ArtifactStatusEditSurface.InlineCell,
    });
    expect(mocks.update).toHaveBeenCalledWith({
      id: "issue-1",
      assigneeId: "user-2",
      surface: ArtifactStatusEditSurface.InlineCell,
    });
    fireEvent.click(screen.getByRole("button", { name: "Add issue" }));
    expect(screen.getByText("New Issue")).toBeInTheDocument();
  });
  it("hands the shell's document opener to the create modal, so its own navigation is the fallback", () => {
    const onOpenDocument = vi.fn();
    const { unmount } = render(
      <IssuesIndexView onOpenDocument={onOpenDocument} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Add issue" }));
    expect(mocks.modal?.onSuccess).toBe(onOpenDocument);
    unmount();
    render(<IssuesIndexView />);
    fireEvent.click(screen.getByRole("button", { name: "Add issue" }));
    expect(mocks.modal?.onSuccess).toBeUndefined();
  });
});

const PAGINATION = {
  page: 0,
  totalPages: 2,
  readout: null,
  disabled: false,
  onPageChange: () => undefined,
};
