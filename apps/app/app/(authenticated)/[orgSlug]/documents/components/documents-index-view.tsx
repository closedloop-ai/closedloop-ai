"use client";

import type { Priority } from "@repo/api/src/types/common";
import { DocumentType } from "@repo/api/src/types/document";
import { DocumentTableToolbar } from "@repo/app/documents/components/table/document-table-toolbar";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import { useDeleteRowItem } from "@repo/app/documents/hooks/use-delete-row-item";
import {
  useDocuments,
  useUpdateDocument,
} from "@repo/app/documents/hooks/use-documents";
import {
  DocumentColumn,
  useColumnVisibility,
} from "@repo/app/shared/hooks/use-column-visibility";
import { useScrollRestore } from "@repo/app/shared/hooks/use-scroll-restore";
import { useViewStatePersistence } from "@repo/app/shared/hooks/use-view-state-persistence";
import { useOrgUsersAsPopoverUsers } from "@repo/app/users/hooks/use-org-users-as-popover-users";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { FileTextIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { DocumentsView } from "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/[projectId]/components/documents-view";

/**
 * Org-level Documents index (FEA-4140). Lists project-less DOC artifacts —
 * the org-scoped evergreen documents that are not attached to any project — at
 * org scope, reusing the shared document table pipeline (`DocumentsView` +
 * `DocumentTableToolbar`) exactly as the project page and My Tasks do. There
 * is no project chrome (no per-type tabs, no branches/features), so the view
 * renders a single flat DOC list.
 */

const COLUMN_VISIBILITY_KEY = "table:columns:documents-index";
const COLUMN_ORDER_KEY = "table:column-order:documents-index";
const STORAGE_KEY = "documents-index-artifacts";
const SEARCH_KEY = "table:search:documents-index";
const SORT_KEY = "table:sort:documents-index";
const SCROLL_KEY = "table:scroll:documents-index";

// The index is hard-filtered to a single type (DocumentType.Doc), so a Type
// column would be a column of identical "Doc" values — dropped here (the
// project page hides it the same way when a filter pins one type). These
// evergreen docs carry no project, priority, or due date by convention, so the
// remaining columns are the ones that describe a standalone doc: its last
// editor/assignee and freshness.
const DOCUMENTS_INDEX_COLUMNS: DocumentColumn[] = [
  DocumentColumn.Assignee,
  DocumentColumn.Updated,
];

export function DocumentsIndexView() {
  const [filterText, setFilterText] = useViewStatePersistence<string>(
    SEARCH_KEY,
    ""
  );
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(
    null
  );
  useScrollRestore(SCROLL_KEY, scrollContainer);

  const listParams = useMemo(
    () => ({ type: DocumentType.Doc, unassignedProject: true }),
    []
  );
  const {
    data: documents = [],
    isLoading,
    isFetching,
    isError,
    refetch,
  } = useDocuments(listParams);

  const { visibility, toggleColumn, visibleColumns, reorderColumns } =
    useColumnVisibility({
      storageKey: COLUMN_VISIBILITY_KEY,
      orderStorageKey: COLUMN_ORDER_KEY,
      defaults: {},
      columns: DOCUMENTS_INDEX_COLUMNS,
    });

  const updateDocument = useUpdateDocument();
  const handleDelete = useDeleteRowItem();
  const orgUsers = useOrgUsersAsPopoverUsers();

  // No loop-summary fetch here — and none on any artifact table now. The Loop
  // column was the only consumer, and it is gone, so every surface (this index,
  // My Tasks, and the project page) would be doing reflexive on-mount polling
  // for data nothing displays. `/loops/summaries` itself is retained as a
  // server-side contract (route + service in `apps/api/app/loops/summaries/`);
  // it simply has no frontend caller.
  const editHandlers: RowEditHandlers = useMemo(
    () => ({
      teamMembers: orgUsers,
      onUpdateAssignee: (id, assigneeId) =>
        updateDocument.mutate({ id, assigneeId }),
      onUpdatePriority: (id, priority: Priority) =>
        updateDocument.mutate({ id, priority }),
      onUpdateStatus: (id, status) => updateDocument.mutate({ id, status }),
    }),
    [orgUsers, updateDocument.mutate]
  );

  const hasAnyDocuments = documents.length > 0;
  const isListLoading = isLoading || (!hasAnyDocuments && isFetching);
  // Only block the whole surface when the read failed AND there are no cached
  // rows to show. TanStack Query keeps the last successful data through a failed
  // background refetch, so a transient refetch error must not replace a
  // populated table with a full error state — the usable rows stay rendered.
  const isBlockingError = isError && !hasAnyDocuments;
  // Own the truly-empty state so the surface reads as a Documents index, not
  // the shared table's project-flavored "Create a PRD, issue, or plan" copy
  // (which would misdirect here). A no-match-under-active-search is left to
  // DocumentsView, whose "No matching artifacts / adjust your filter" copy is
  // already right.
  const isEmpty =
    !(isBlockingError || isListLoading || hasAnyDocuments) &&
    filterText.trim() === "";
  const showTable = !(isBlockingError || isEmpty);

  return (
    <>
      <div className="border-b">
        <DocumentTableToolbar
          filterText={filterText}
          onFilterTextChange={setFilterText}
          tableViewMenuProps={{
            columns: DOCUMENTS_INDEX_COLUMNS,
            onToggle: toggleColumn,
            visibility,
          }}
        />
      </div>
      {/* Error, empty, and table are conditional siblings BELOW the toolbar so a
          failed read keeps the search box and column menu in place instead of
          collapsing the whole page to a bare retry block (matches My Tasks,
          Sessions, and Branches). */}
      {isBlockingError && (
        <div className="p-4">
          <EmptyState
            action={
              <Button onClick={() => refetch()} variant="outline">
                Try again
              </Button>
            }
            description="We couldn't load your documents. Check your connection and try again."
            icon={TriangleAlertIcon}
            title="Couldn't load documents"
          />
        </div>
      )}
      {isEmpty && (
        <div className="p-4">
          <EmptyState
            description="Create one with New Document above. Documents your agent sessions produce show up here too."
            icon={FileTextIcon}
            title="No documents yet"
          />
        </div>
      )}
      {/* plain <div>, not <main>: the shell's SidebarInset owns the page's single main landmark (no-nested-main-landmark gate). */}
      {showTable && (
        <div className="flex-1 overflow-auto" ref={setScrollContainer}>
          <DocumentsView
            documents={documents}
            editHandlers={editHandlers}
            filterCategory="all"
            filterText={filterText}
            isLoading={isListLoading}
            loadingLabel="Loading documents…"
            onDelete={handleDelete}
            onReorderColumns={reorderColumns}
            sortPersistenceKey={SORT_KEY}
            storageKey={STORAGE_KEY}
            treeData={null}
            visibleColumns={visibleColumns}
          />
        </div>
      )}
    </>
  );
}
