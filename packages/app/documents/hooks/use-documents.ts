"use client";

import {
  BATCH_ITEM_APPLIED_STATUS,
  type BatchMutationResponse,
} from "@repo/api/src/types/batch-mutation-result";
import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import type {
  CreateDocumentInput,
  Document,
  DocumentDetail,
  DocumentListPage,
  DocumentListPageParams,
  DocumentWithProject,
  FindDocumentsOptions,
  MergeDocumentsInput,
  PullRequestInfo,
  UpdateDocumentInput,
} from "@repo/api/src/types/document";
import { LONG_RUNNING_API_TIMEOUT_MS } from "@repo/api/src/types/long-running-api-timeout";
import {
  bulkReceiptFromCommittedIds,
  invalidateForBulkArtifactMutation,
} from "@repo/app/documents/hooks/bulk-artifact-invalidation";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import {
  type BatchUpdatePriorityInput,
  type BatchUpdateStatusInput,
  withBatchExpectedPriorityGuard,
  withBatchExpectedStatusGuard,
  withExpectedValueGuards,
} from "@repo/app/documents/hooks/expected-value-guards";
import { projectKeys } from "@repo/app/projects/hooks/project-keys";
import { projectTreeKeys } from "@repo/app/projects/hooks/project-tree-keys";
import { projectArtifactBoardPageKeys } from "@repo/app/projects/hooks/use-project-artifact-board-page";
import type { ApiClient } from "@repo/app/shared/api/create-api-client";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import {
  type MutationToastOptions,
  mutationToastMeta,
  toastMutationError,
} from "@repo/app/shared/query/query-client";
import {
  type QueryClient,
  queryOptions,
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  readDocumentPageWithSubtypeUnion,
  readDocumentsWithSubtypeUnion,
} from "../lib/document-union-read";
import { invalidateArtifactLinkQueries } from "./use-artifact-links";

// Queries
export function useDocuments(
  searchParams: FindDocumentsOptions,
  options?: Omit<UseQueryOptions<DocumentWithProject[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: documentKeys.list(searchParams),
    queryFn: () => readDocumentsWithSubtypeUnion(apiClient, searchParams),
    ...options,
  });
}

export function useDocumentsByProject(
  projectId: string,
  options?: Omit<UseQueryOptions<DocumentWithProject[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: documentKeys.list({ projectId }),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("projectId", projectId);
      return apiClient.get<DocumentWithProject[]>(
        `/documents?${params.toString()}`
      );
    },
    ...options,
  });
}

/**
 * Fetch a single artifact by ID, including its content via currentVersion.
 * Pass an optional version number to fetch a specific version's content;
 * omit to get the latest version.
 */
export function useDocument(
  id: string | null,
  version?: number,
  options?: Omit<UseQueryOptions<DocumentDetail>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: version
      ? documentKeys.version(id!, version)
      : documentKeys.detail(id!),
    queryFn: () => {
      const versionParam = version ? `?version=${version}` : "";
      return apiClient.get<DocumentDetail>(`/documents/${id}${versionParam}`);
    },
    enabled: !!id,
    ...options,
  });
}

/**
 * Fetch a single artifact by slug, including its content via currentVersion.
 * Pass an optional version number to fetch a specific version's content;
 * omit to get the latest version.
 */
export function useDocumentBySlug(
  slug: string,
  version?: number,
  options?: Omit<UseQueryOptions<DocumentDetail>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    ...documentBySlugQueryOptions(apiClient, slug, version),
    enabled: !!slug,
    ...options,
  });
}

// Mutations
export function useCreateDocument(options?: Readonly<MutationToastOptions>) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    // Opt-in, never baked in (ISS-8938). The shared QueryClient toast is the
    // ONLY failure message most callers of this mutation have, so suppressing
    // it here for everyone would trade a duplicate for a silent failure. The
    // one caller that renders its own account of the rejection asks for it.
    meta: mutationToastMeta(options),
    mutationFn: (input: CreateDocumentInput) =>
      apiClient.post<Document>("/documents", input),
    onSuccess: (_, input) => {
      invalidateArtifactCaches(queryClient, { projectId: input.projectId });
    },
  });
}

export function useUpdateDocument() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UpdateDocumentMutationInput) => {
      const {
        id,
        recoverableErrorOwner: _recoverableErrorOwner,
        ...body
      } = input;
      return apiClient.put<Document>(
        `/documents/${id}`,
        withExpectedValueGuards(queryClient, id, body)
      );
    },
    // A hook-level `onError` replaces the shared QueryClient default, so this
    // toasts exactly as that default does, unless the field that sent this
    // attempt still renders its own adjacent feedback for it (PRD-722).
    onError: (error, input) => {
      if (input.recoverableErrorOwner?.() !== true) {
        toastMutationError(error);
      }
    },
    // ISS-9667: `onSettled`, not `onSuccess`. Callers of this mutation render
    // optimistically — `useDocumentMetadata` puts the new status on screen the
    // instant it is picked — and invalidating only on success meant a REFUSED
    // write left every cache entry untouched. Nothing then refetched, so the
    // surface kept showing a value the server had rejected, and it kept showing
    // it indefinitely: the artifact's cached status never changed, so the
    // consumer effect that re-syncs from server state never re-ran either.
    // Re-reading on failure is what puts the true value back.
    //
    onSettled: (data, _error, input) => {
      queryClient.invalidateQueries({
        queryKey: documentKeys.detail(input.id),
      });
      // A rejected write has no response to read a slug from, so every by-slug
      // entry is re-read: detail pages read the document through one, and a
      // stale guard's 409 is resolved only by handing the field the value that
      // won (ISS-11198).
      queryClient.invalidateQueries({
        queryKey: data
          ? documentKeys.bySlug(data.slug)
          : documentKeys.bySlugs(),
      });
      invalidateArtifactCaches(queryClient, { artifactId: input.id });
    },
  });
}

export function useDeleteDocument() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/documents/${id}`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: documentKeys.all });
      invalidateArtifactCaches(queryClient, { artifactId: id });
    },
  });
}

/**
 * Invalidate every query that can shift when a document's content/version
 * changes: the detail (by id), the by-slug view, the versions list, and any
 * mounted list views. Shared between the publish mutation and the
 * room-event listener that reacts to other users publishing.
 */
export function invalidateDocumentDetailCaches(
  queryClient: QueryClient,
  documentId: string,
  slug: string
) {
  queryClient.invalidateQueries({ queryKey: documentKeys.detail(documentId) });
  queryClient.invalidateQueries({ queryKey: documentKeys.bySlug(slug) });
  queryClient.invalidateQueries({
    queryKey: documentKeys.versions(documentId),
  });
  queryClient.invalidateQueries({ queryKey: documentKeys.lists() });
  // ISS-8936: the summary band counts over the same population these lists show,
  // and `updatedAt` — which an update bumps — is the anchor one of its four cards
  // measures. `summaries()` is a SIBLING of `lists()`, so it does not come along
  // for free; without this line an inline status edit on the Documents index
  // refreshes the row and leaves the band's counts stated as current.
  queryClient.invalidateQueries({ queryKey: documentKeys.summaries() });
  // The project page's table renders document rows from the tree query
  // (PLN-874), so a publish must refresh it too — org-wide, since the
  // document can appear in other projects' trees as an external parent.
  queryClient.invalidateQueries({ queryKey: projectTreeKeys.all });
}

/** Create a new version for an artifact via the versions endpoint. */
export function useCreateDocumentVersion(documentId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      content,
      resetRoom,
    }: {
      content: string;
      resetRoom?: boolean;
    }) => {
      const params = new URLSearchParams();
      if (resetRoom !== undefined) {
        params.set("reset-room", resetRoom.toString());
      }
      return apiClient.post<DocumentDetail>(
        `/documents/${documentId}/versions?${params.toString()}`,
        {
          content,
        }
      );
    },
    onSuccess: (result) => {
      invalidateDocumentDetailCaches(queryClient, documentId, result.slug);
    },
  });
}

/**
 * Fetch the pull requests associated with an artifact.
 */
export function useDocumentPullRequest(
  documentId: string,
  options?: Omit<UseQueryOptions<PullRequestInfo[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: [...documentKeys.detail(documentId), "pull-request"] as const,
    queryFn: () =>
      apiClient.get<PullRequestInfo[]>(`/documents/${documentId}/pull-request`),
    enabled: !!documentId,
    ...options,
  });
}

export function useBatchUpdateStatus(options?: Readonly<MutationToastOptions>) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    meta: mutationToastMeta(options),
    mutationFn: (input: BatchUpdateStatusInput) =>
      apiClient.post<BatchMutationResponse>(
        `${BatchMutationRoute.DocumentsUpdateStatus}/v2`,
        withBatchExpectedStatusGuard(queryClient, input)
      ),
    // `allLinkViews` because the write unblocks dependents this receipt never
    // names (ISS-9632): a cached lineage view for one of them would otherwise
    // keep rendering its BLOCKED endpoint.
    onSuccess: (response) => {
      invalidateForBulkArtifactMutation(
        queryClient,
        bulkReceiptFromCommittedIds(appliedBatchIds(response)),
        { allLinkViews: true }
      );
    },
  });
}

export function useBatchUpdatePriority(
  options?: Readonly<MutationToastOptions>
) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    // The bulk bar names the priority it failed to set, so it asks to silence
    // the generic toast rather than stack two messages on one click. Left
    // opt-in: on a surface with no message of its own the default toast is the
    // only report a failure gets.
    meta: mutationToastMeta(options),
    mutationFn: (input: BatchUpdatePriorityInput) =>
      apiClient.post<BatchMutationResponse>(
        `${BatchMutationRoute.DocumentsUpdatePriority}/v2`,
        withBatchExpectedPriorityGuard(queryClient, input)
      ),
    onSuccess: (response) => {
      invalidateForBulkArtifactMutation(
        queryClient,
        bulkReceiptFromCommittedIds(appliedBatchIds(response))
      );
    },
  });
}

export function useBatchDeleteDocuments() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (documentIds: string[]) =>
      apiClient.post<{ deletedIds: string[]; failedIds: string[] }>(
        "/documents/batch-delete",
        { documentIds }
      ),
    // A `failedId` on this route is an id the org no longer holds
    // (`documentService.batchDelete` returns requested-minus-found), so it is
    // itself evidence that the cached row is wrong — the case where the list
    // is most stale, not least. It joins the committed ids rather than
    // gating them out (ISS-9578 review).
    onSuccess: ({ deletedIds, failedIds }) => {
      invalidateForBulkArtifactMutation(
        queryClient,
        bulkReceiptFromCommittedIds([...deletedIds, ...failedIds])
      );
    },
  });
}

/**
 * Merge two artifacts into one, keeping the primary and deleting the secondary.
 */
export function useMergeDocuments() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      primaryDocumentId,
      secondaryDocumentId,
    }: MergeDocumentsInput) =>
      // Long-running by design (ISS-6774): the route awaits a full Anthropic
      // merge generation before it commits, so it declares `maxDuration = 300`
      // and bounds that generation at `MERGE_REQUEST_TIMEOUT_MS`. Under the
      // default 60s deadline the client would abandon a merge the server then
      // goes on to commit — the version lands and the secondary artifact is
      // deleted while the user is shown a failure. Wait for the ceiling the
      // route actually runs under so the server's stated outcome is the one
      // the surface reports.
      apiClient.post<Document>(
        "/documents/merge",
        {
          primaryDocumentId,
          secondaryDocumentId,
        },
        { timeoutMs: LONG_RUNNING_API_TIMEOUT_MS }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: documentKeys.all });
      invalidateArtifactCaches(queryClient, { artifactId: data.id });
    },
  });
}

/**
 * Invalidate every query that renders a project's artifacts after a mutation:
 * document list views, the project tree (the documents table's hierarchy
 * source — `projectTreeKeys.detail` prefix-matches every variant of the tree
 * query), and resolved artifact-link views that include the artifact.
 *
 * Tree scoping is deliberate per argument shape:
 * - `artifactId` (update/delete/merge): invalidates artifact-link views and
 *   EVERY project tree via `invalidateArtifactLinkQueries`. A mutated
 *   artifact can surface in other projects' trees as a cross-project
 *   external parent (`ProjectTreeResponse.externalParents`), so scoping to
 *   its own project would leave those trees stale.
 * - `projectId` only (create): scopes to that project's tree — a brand-new
 *   artifact cannot appear in any other tree yet.
 * - neither (batch mutations): invalidates every project tree, since the
 *   affected projects aren't known on the client.
 */
export function invalidateArtifactCaches(
  queryClient: QueryClient,
  { artifactId, projectId }: { artifactId?: string; projectId?: string | null }
): void {
  queryClient.invalidateQueries({ queryKey: documentKeys.lists() });
  // ISS-8936: same reason as in `invalidateDocumentDetailCaches` — the summary
  // band counts over the population these lists show, and `summaries()` is a
  // SIBLING of `lists()`, so it does not come along for free. Without this an
  // inline status edit on the Documents index refreshes the row and leaves the
  // band's counts stated as current.
  queryClient.invalidateQueries({ queryKey: documentKeys.summaries() });
  // Creating the first document or deleting the last one flips a project's
  // completion population between empty and non-empty (ISS-4679), and any
  // create/delete/update shifts its completionPercentage. The team project
  // list carries that number with a 60s stale time, so it must be invalidated
  // on every artifact mutation or the ring stays stale after the transition
  // (org-wide: `projectKeys.all`, since an artifact can belong to any project
  // and the client does not always know which).
  queryClient.invalidateQueries({ queryKey: projectKeys.all });
  if (artifactId) {
    // Also invalidates projectTreeKeys.all — see the doc comment above.
    invalidateArtifactLinkQueries(queryClient, artifactId);
    queryClient.invalidateQueries({
      queryKey: projectArtifactBoardPageKeys.all,
    });
  } else if (projectId) {
    queryClient.invalidateQueries({
      queryKey: projectTreeKeys.detail(projectId),
    });
    queryClient.invalidateQueries({
      queryKey: projectArtifactBoardPageKeys.project(projectId),
    });
  } else {
    queryClient.invalidateQueries({ queryKey: projectTreeKeys.all });
    queryClient.invalidateQueries({
      queryKey: projectArtifactBoardPageKeys.all,
    });
  }
}

/**
 * Read ONE page of `GET /documents` together with the real server-side total
 * (ISS-4576).
 *
 * `useDocuments` collapses the response to an array, which is fine for an
 * unbounded read but hides truncation the moment a caller passes `limit`: the
 * array cannot say how many rows it did not include, and a UI that counts it
 * reports a total that silently caps at the page size. This hook keeps the
 * envelope's `total`/`hasMore` in its own contract so a paging surface states a
 * total the server actually returned. `includeTotal` is forced on rather than
 * left to the caller — the envelope IS this hook's contract, and a caller that
 * passed `false` would get an array back and break the return type.
 */
export function useDocumentsPage(
  searchParams: FindDocumentsOptions,
  options?: Omit<UseQueryOptions<DocumentListPage>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: documentsPageQueryKey(searchParams),
    // Read the raw body and normalize it rather than trusting the envelope
    // shape (davetho review): an older API that predates `includeTotal` strips
    // the unknown param and returns the legacy bare `DocumentWithProject[]`. Read
    // as an envelope that would find no `.items`/`.total` and render an empty
    // queue; `normalizeDocumentListResponse` folds that array into an honest
    // one-page envelope (and a malformed body into a safe empty page) so the
    // old-server/new-client path degrades gracefully instead of blanking.
    queryFn: () => readDocumentPageWithSubtypeUnion(apiClient, searchParams),
    ...options,
  });
}

/**
 * The exact params {@link useDocumentsPage} sends for a given filter set — the
 * caller's filters plus the `includeTotal` discriminator the hook forces on.
 * Returns the dedicated {@link DocumentListPageParams} shape, not
 * `FindDocumentsOptions`: the flag lives on the paged params type, not the filter
 * type, so only the paged reader can select the envelope response.
 */
function buildDocumentsPageParams(
  searchParams: FindDocumentsOptions
): DocumentListPageParams {
  return { ...searchParams, includeTotal: true };
}

/**
 * The cache key {@link useDocumentsPage} registers for a given filter set.
 *
 * Exported because a caller that writes optimistically into the paged cache (the
 * My Tasks kanban's drag handler) must target the SAME entry the hook populates.
 * `documentKeys.list` hashes the filters object verbatim, so a key rebuilt from
 * the caller's own params — which do not carry `includeTotal` — is a DIFFERENT
 * entry: the write lands on a stray key nothing is subscribed to and the
 * optimistic update silently does nothing until a refetch. Deriving both from
 * one function is what stops that drift.
 */
export function documentsPageQueryKey(searchParams: FindDocumentsOptions) {
  return documentKeys.list(buildDocumentsPageParams(searchParams));
}

/**
 * Returns a function that resolves once a {@link useDocumentBySlug} entry is in
 * the cache, fetching it only when it is missing. A caller can then switch to
 * that version without ever rendering a loading or failed state for it.
 */
export function useEnsureDocumentBySlug() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  return (slug: string, version?: number) =>
    queryClient.ensureQueryData(
      documentBySlugQueryOptions(apiClient, slug, version)
    );
}

function documentBySlugQueryOptions(
  apiClient: ApiClient,
  slug: string,
  version?: number
) {
  return queryOptions<DocumentDetail>({
    queryKey: version
      ? [...documentKeys.bySlug(slug), version]
      : documentKeys.bySlug(slug),
    queryFn: () => {
      const versionParam = version ? `?version=${version}` : "";
      return apiClient.get<DocumentDetail>(
        `/documents/by-slug/${slug}${versionParam}`
      );
    },
  });
}

type UpdateDocumentMutationInput = UpdateDocumentInput & {
  /** Whether the adjacent inline error can still render for this attempt. */
  recoverableErrorOwner?: () => boolean;
};

function appliedBatchIds(response: BatchMutationResponse): string[] {
  return response.results.flatMap((result) =>
    result.status === BATCH_ITEM_APPLIED_STATUS ? [result.id] : []
  );
}
