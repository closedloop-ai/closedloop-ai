"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  type DocumentWithProject,
  IssueStatus,
} from "@repo/api/src/types/document";
import {
  ArtifactList,
  type ArtifactListReadState,
} from "@repo/app/artifacts/components/artifact-list";
import { ArtifactListBulkActions } from "@repo/app/artifacts/components/artifact-list-bulk-actions";
import { DocumentsIndexPaginationFooter } from "@repo/app/documents/components/documents-index-pagination";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import { useUpdateDocument } from "@repo/app/documents/hooks/use-documents";
import { genericArtifactStatusFromRaw } from "@repo/app/shared/components/generic-artifact-surface/generic-artifact-status";
import {
  ArtifactKind,
  type GenericArtifact,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { HeaderPrimaryAction } from "@repo/app/shared/components/header-primary-action";
import { useScrollRestore } from "@repo/app/shared/hooks/use-scroll-restore";
import { useViewStateKey } from "@repo/app/shared/hooks/use-view-state-key";
import { useViewStatePersistence } from "@repo/app/shared/hooks/use-view-state-persistence";
import { useOrgUsersAsPopoverUsers } from "@repo/app/users/hooks/use-org-users-as-popover-users";
import { type ReactNode, useMemo, useState } from "react";
import { useIssuesIndexRead } from "../hooks/use-issues-index-read";
import { CreateIssueModal } from "./create-issue-modal";

export type IssuesIndexViewProps = {
  renderHeader?: (action: ReactNode) => ReactNode;
  artifactHref?: (document: DocumentWithProject) => string | undefined;
  onOpenDocument?: (document: DocumentWithProject) => void;
};

/** Both shells mount the Documents listing parent with Issue-owned data. */
export function IssuesIndexView({
  renderHeader,
  artifactHref,
  onOpenDocument,
}: IssuesIndexViewProps) {
  const storageKey = useViewStateKey("issues-index");
  const searchKey = useViewStateKey("issues-index-search");
  const sortKey = useViewStateKey("issues-index-sort");
  const scrollKey = useViewStateKey("issues-index-scroll");
  const pageSizeKey = useViewStateKey("issues-index-page-size");
  const [filterText, setFilterText] = useViewStatePersistence(searchKey, "");
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(
    null
  );
  useScrollRestore(scrollKey, scrollContainer);
  const [recencyDays, setRecencyDays] = useState<number | undefined>();
  const [listRead, setListRead] = useState<ArtifactListReadState>();
  const read = useIssuesIndexRead({
    filterText,
    listRead,
    pageSizeStorageKey: pageSizeKey,
    recencyDays,
    scrollContainer,
  });
  const update = useUpdateDocument();
  const teamMembers = useOrgUsersAsPopoverUsers();
  const editHandlers = useMemo<RowEditHandlers>(
    () => ({
      teamMembers,
      onUpdateAssignee: (id, assigneeId) =>
        update.mutate({
          id,
          assigneeId,
          surface: ArtifactStatusEditSurface.InlineCell,
        }),
      onUpdatePriority: (id, priority) =>
        update.mutate({
          id,
          priority,
          surface: ArtifactStatusEditSurface.InlineCell,
        }),
      onUpdateStatus: (id, status, surface) =>
        update.mutate({
          id,
          status,
          surface,
        }),
    }),
    [teamMembers, update.mutate]
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [initialStatus, setInitialStatus] = useState<IssueStatus | undefined>();
  const requestCreate = (status?: GenericArtifact["status"]) => {
    setInitialStatus(
      Object.values(IssueStatus).find(
        (raw) =>
          genericArtifactStatusFromRaw(ArtifactKind.Issue, raw) === status
      )
    );
    setCreateOpen(true);
  };
  const action = (
    <HeaderPrimaryAction label="Add issue" onClick={() => requestCreate()} />
  );
  return (
    <>
      {renderHeader ? (
        renderHeader(action)
      ) : (
        <div className="flex justify-end px-4 py-3">{action}</div>
      )}
      <ArtifactList
        artifactHref={artifactHref}
        artifactKind={ArtifactKind.Issue}
        creation={
          createOpen ? (
            <CreateIssueModal
              initialStatus={initialStatus}
              onOpenChange={setCreateOpen}
              onSuccess={onOpenDocument}
              open
            />
          ) : null
        }
        documents={read.documents}
        editHandlers={editHandlers}
        filterText={filterText}
        isError={read.isError}
        isFetching={read.isFetching}
        isLoading={read.isLoading}
        isServerPaged={read.isServerPaged}
        isSummaryUnsettled={read.isSummaryUnsettled}
        onFilterTextChange={setFilterText}
        onListReadChange={setListRead}
        onOpenDocument={onOpenDocument}
        onRecencyDaysChange={setRecencyDays}
        onRequestCreate={requestCreate}
        pagination={
          read.pagination ? (
            <DocumentsIndexPaginationFooter pagination={read.pagination} />
          ) : undefined
        }
        refetch={read.refetch}
        renderBulkActions={(documents, onClear, onRetain) => (
          <ArtifactListBulkActions
            documents={documents}
            onClear={onClear}
            onRetain={onRetain}
            users={teamMembers}
          />
        )}
        searchAppliedUpstream={read.searchAppliedUpstream}
        searchParams={read.summaryParams}
        setScrollContainer={setScrollContainer}
        sortPersistenceKey={sortKey}
        storageKey={storageKey}
      />
    </>
  );
}
