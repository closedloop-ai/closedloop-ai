import type { ArtifactListProps } from "@repo/app/artifacts/components/artifact-list";
import { DocumentsIndexEmptyState } from "@repo/app/documents/components/documents-index-empty-state";
import { DocumentsStaleRefreshNotice } from "@repo/app/documents/components/documents-stale-refresh-notice";
import {
  countMatchingDocuments,
  DocumentsIndexState,
  hasActiveSearch,
  resolveDocumentsIndexState,
} from "@repo/app/documents/lib/documents-index-state";

/** Tests the web read adapter independently of the shared surface's query providers. */
export function DocumentsPrototypeHostProbe({
  observe,
  ...props
}: ArtifactListProps & {
  observe: (props: Record<string, unknown>) => void;
}) {
  const state = resolveDocumentsIndexState({
    isLoading: props.isLoading,
    isFetching: props.isFetching,
    isError: props.isError,
    rowCount: props.documents.length,
    matchCount: countMatchingDocuments(props.documents, props.filterText),
    hasSearch: hasActiveSearch(props.filterText),
    searchAppliedUpstream: props.searchAppliedUpstream,
  });
  const blocking =
    state === DocumentsIndexState.BlockingError ||
    state === DocumentsIndexState.FirstUseEmpty ||
    state === DocumentsIndexState.NoResults ||
    state === DocumentsIndexState.StaleNoResults;
  observe({ ...props, isLoading: state === DocumentsIndexState.Loading });
  return (
    <>
      <div data-testid="toolbar" />
      {blocking ? (
        <DocumentsIndexEmptyState onRetry={props.refetch} state={state} />
      ) : (
        <>
          {state === DocumentsIndexState.StaleAfterFailedRefresh ? (
            <DocumentsStaleRefreshNotice onRetry={props.refetch} />
          ) : null}
          <div ref={props.setScrollContainer}>
            <div data-testid="documents-view" />
            {state === DocumentsIndexState.Loading ? (
              <div data-testid="documents-view-loading" />
            ) : null}
          </div>
          {props.pagination}
        </>
      )}
    </>
  );
}
