"use client";

import {
  type ArtifactStatus,
  type CreateDocumentInput,
  type Document,
  type DocumentDetail,
  type DocumentListPage,
  type DocumentListPageParams,
  type DocumentWithProject,
  type FindDocumentsOptions,
  type GenerationStatus,
  isActiveGenerationStatus,
  type MergeDocumentsInput,
  normalizeDocumentListResponse,
  type PullRequestInfo,
  type UpdateDocumentInput,
} from "@repo/api/src/types/document";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { projectKeys } from "@repo/app/projects/hooks/project-keys";
import { projectTreeKeys } from "@repo/app/projects/hooks/use-project-tree";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import {
  type QueryClient,
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { invalidateArtifactLinkQueries } from "./use-artifact-links";

/**
 * Serialize `FindDocumentsOptions` into the `GET /documents` query string.
 * Shared by the bare-array and paged readers so the two cannot drift on how a
 * filter is spelled (a drifted spelling would silently widen one of them).
 */
function buildDocumentListSearchParams(
  searchParams: FindDocumentsOptions | DocumentListPageParams
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== undefined) {
      params.set(key, value.toString());
    }
  }
  return params.toString();
}

// Queries
export function useDocuments(
  searchParams: FindDocumentsOptions,
  options?: Omit<UseQueryOptions<DocumentWithProject[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: documentKeys.list(searchParams),
    queryFn: () =>
      apiClient.get<DocumentWithProject[]>(
        `/documents?${buildDocumentListSearchParams(searchParams)}`
      ),
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
    queryKey: version
      ? [...documentKeys.bySlug(slug), version]
      : documentKeys.bySlug(slug),
    queryFn: () => {
      const versionParam = version ? `?version=${version}` : "";
      return apiClient.get<DocumentDetail>(
        `/documents/by-slug/${slug}${versionParam}`
      );
    },
    enabled: !!slug,
    ...options,
  });
}

const GENERATION_POLL_INTERVAL = 5000;

export function useDocumentGenerationStatus(
  documentId: string,
  options?: Omit<UseQueryOptions<GenerationStatus>, "queryKey" | "queryFn"> & {
    polling?: boolean;
  }
) {
  const { polling, ...queryOptions } = options ?? {};
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return {
    ...useQuery<GenerationStatus>({
      queryKey: documentKeys.generationStatus(documentId),
      queryFn: () =>
        apiClient.get<GenerationStatus>(
          `/documents/${documentId}/generation-status`
        ),
      enabled: !!documentId,
      refetchInterval: polling
        ? (query) => {
            const status = query.state.data?.status;
            if (
              status &&
              (isActiveGenerationStatus(status) || status === "FAILURE")
            ) {
              return GENERATION_POLL_INTERVAL;
            }
            return false;
          }
        : undefined,
      ...queryOptions,
    }),
    invalidateCache: () => {
      queryClient.invalidateQueries({
        queryKey: documentKeys.detail(documentId),
      });
      queryClient.invalidateQueries({
        queryKey: documentKeys.versions(documentId),
      });
      // Invalidate all bySlug queries. We only have the artifact ID, not the slug.
      queryClient.invalidateQueries({
        queryKey: documentKeys.bySlugs(),
      });
    },
  };
}

// Mutations
export function useCreateDocument() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
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
    mutationFn: (input: UpdateDocumentInput) => {
      const { id, ...body } = input;
      return apiClient.put<Document>(`/documents/${id}`, body);
    },
    onSuccess: (data, input) => {
      queryClient.invalidateQueries({
        queryKey: documentKeys.detail(input.id),
      });
      queryClient.invalidateQueries({
        queryKey: documentKeys.bySlug(data.slug),
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

export function useBatchUpdateStatus() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({
      documentIds,
      status,
    }: {
      documentIds: string[];
      status: ArtifactStatus;
    }) =>
      apiClient.post<string[]>("/documents/batch-update-status", {
        documentIds,
        status,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: documentKeys.all });
      invalidateArtifactCaches(queryClient, {});
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: documentKeys.all });
      invalidateArtifactCaches(queryClient, {});
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
      apiClient.post<Document>("/documents/merge", {
        primaryDocumentId,
        secondaryDocumentId,
      }),
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
  } else if (projectId) {
    queryClient.invalidateQueries({
      queryKey: projectTreeKeys.detail(projectId),
    });
  } else {
    queryClient.invalidateQueries({ queryKey: projectTreeKeys.all });
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
  const pageParams = buildDocumentsPageParams(searchParams);

  return useQuery({
    queryKey: documentsPageQueryKey(searchParams),
    // Read the raw body and normalize it rather than trusting the envelope
    // shape (shafty023 review): an older API that predates `includeTotal` strips
    // the unknown param and returns the legacy bare `DocumentWithProject[]`. Read
    // as an envelope that would find no `.items`/`.total` and render an empty
    // queue; `normalizeDocumentListResponse` folds that array into an honest
    // one-page envelope (and a malformed body into a safe empty page) so the
    // old-server/new-client path degrades gracefully instead of blanking.
    queryFn: async () => {
      const response = await apiClient.get<unknown>(
        `/documents?${buildDocumentListSearchParams(pageParams)}`
      );
      return normalizeDocumentListResponse(response);
    },
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
