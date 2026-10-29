import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  BatchItemFailureCode,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus } from "@repo/api/src/types/document";
import { TagEntityType } from "@repo/api/src/types/tag";
import { QueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { agentSessionKeys } from "../../../agents/hooks/agent-session-keys";
import { branchRowQueryKeys } from "../../../branches/hooks/branch-query-keys";
import { projectKeys } from "../../../projects/hooks/project-keys";
import { projectTreeKeys } from "../../../projects/hooks/project-tree-keys";
import { createWrapperWithClient } from "../../../shared/test-utils";
import { useBatchApplyTag } from "../../../tags/hooks/use-tags";
import { artifactFavoriteKeys } from "../artifact-favorite-keys";
import { documentKeys } from "../document-keys";
import { artifactLinkKeys } from "../use-artifact-links";
import { useBatchMoveArtifacts } from "../use-batch-move-artifacts";
import {
  useBatchDeleteDocuments,
  useBatchUpdatePriority,
  useBatchUpdateStatus,
} from "../use-documents";

const COMMITTED_ID = "doc-committed";
const REFUSED_ID = "doc-refused";
const SCOPE = "cloud";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
};

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

/**
 * One cached query per surface the acceptance criterion names, so a removed
 * invalidation shows up as a surface that kept serving its pre-mutation answer
 * rather than as a missing spy call. A spy on `invalidateQueries` would stay
 * green against a key that matches nothing in the cache.
 */
const SURFACES: readonly (readonly [string, readonly unknown[]])[] = [
  ["list", documentKeys.list({ projectId: "p1" })],
  ["board", projectTreeKeys.detail("p1")],
  ["detail", documentKeys.detail(COMMITTED_ID)],
  ["sessions list", agentSessionKeys.list(SCOPE, {})],
  ["branch list", [...branchRowQueryKeys.lists, SCOPE]],
  ["favorites summary", artifactFavoriteKeys.list()],
  ["project completion summary", projectKeys.list({ teamId: "t1" })],
  ["sessions analytics summary", agentSessionKeys.analytics(SCOPE, {})],
  ["sessions usage summary", agentSessionKeys.usage(SCOPE, {})],
];

function seededClient(): QueryClient {
  const queryClient = new QueryClient();
  for (const [, queryKey] of SURFACES) {
    queryClient.setQueryData(queryKey, []);
  }
  return queryClient;
}

function isInvalidated(
  queryClient: QueryClient,
  queryKey: readonly unknown[]
): boolean {
  return queryClient.getQueryState(queryKey)?.isInvalidated === true;
}

/** A resolved lineage view whose cached rows name `artifactId` as an endpoint. */
function seedResolvedLinkView(
  queryClient: QueryClient,
  artifactId: string
): readonly unknown[] {
  const queryKey = artifactLinkKeys.list({ artifactId, resolved: true });
  queryClient.setQueryData(queryKey, [
    { sourceId: artifactId, targetId: "other" },
  ]);
  return queryKey;
}

/**
 * The families a tag write cannot move: `AgentSessionQueryFilters` has no tag
 * facet and neither Sessions aggregate projects one, and favorites are a
 * separate join (ISS-9578 review, marisolashgrove).
 */
const SURFACES_A_TAG_WRITE_LEAVES_ALONE = [
  "favorites summary",
  "sessions analytics summary",
  "sessions usage summary",
];

function staleSurfaces(queryClient: QueryClient): string[] {
  return SURFACES.filter(
    ([, queryKey]) =>
      queryClient.getQueryState(queryKey)?.isInvalidated !== true
  ).map(([name]) => name);
}

describe("bulk artifact mutations invalidate every view of what committed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("useBatchUpdateStatus leaves no surface serving its pre-mutation answer", async () => {
    mockApiClient.post.mockResolvedValueOnce(
      successfulBatchResponse([COMMITTED_ID])
    );
    const queryClient = seededClient();

    const { result } = renderHook(() => useBatchUpdateStatus(), {
      wrapper: createWrapperWithClient(queryClient),
    });
    result.current.mutate({
      documentIds: [COMMITTED_ID],
      status: DocumentStatus.Approved,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(staleSurfaces(queryClient)).toEqual([]);
  });

  test("useBatchUpdatePriority leaves no surface serving its pre-mutation answer", async () => {
    mockApiClient.post.mockResolvedValueOnce(
      successfulBatchResponse([COMMITTED_ID])
    );
    const queryClient = seededClient();

    const { result } = renderHook(() => useBatchUpdatePriority(), {
      wrapper: createWrapperWithClient(queryClient),
    });
    result.current.mutate({
      documentIds: [COMMITTED_ID],
      priority: Priority.High,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(staleSurfaces(queryClient)).toEqual([]);
  });

  test("useBatchDeleteDocuments refreshes on the deleted ids, not the requested ones", async () => {
    mockApiClient.post.mockResolvedValueOnce({
      deletedIds: [COMMITTED_ID],
      failedIds: [REFUSED_ID],
    });
    const queryClient = seededClient();
    const deletedLinkKey = seedResolvedLinkView(queryClient, COMMITTED_ID);
    const missingLinkKey = seedResolvedLinkView(queryClient, REFUSED_ID);

    const { result } = renderHook(() => useBatchDeleteDocuments(), {
      wrapper: createWrapperWithClient(queryClient),
    });
    result.current.mutate([COMMITTED_ID, REFUSED_ID]);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(staleSurfaces(queryClient)).toEqual([]);
    // Both lineage views refresh. `failedIds` on this route is
    // requested-minus-found, so a refused id says the org no longer holds that
    // artifact — the cached row showing it is wrong, which is the case the
    // list is MOST stale in, not least (ISS-9578 review, marisolashgrove).
    expect(isInvalidated(queryClient, deletedLinkKey)).toBe(true);
    expect(isInvalidated(queryClient, missingLinkKey)).toBe(true);
  });

  // The whole batch refused, every id reported not-found: the click still
  // proves the table is rendering rows the org does not have.
  test("useBatchDeleteDocuments refreshes when every requested id was already gone", async () => {
    mockApiClient.post.mockResolvedValueOnce({
      deletedIds: [],
      failedIds: [REFUSED_ID],
    });
    const queryClient = seededClient();

    const { result } = renderHook(() => useBatchDeleteDocuments(), {
      wrapper: createWrapperWithClient(queryClient),
    });
    result.current.mutate([REFUSED_ID]);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(staleSurfaces(queryClient)).toEqual([]);
  });

  test("useBatchApplyTag refreshes every surface a tag write can move", async () => {
    mockApiClient.post.mockResolvedValueOnce({ appliedCount: 1 });
    const queryClient = seededClient();

    const { result } = renderHook(() => useBatchApplyTag(), {
      wrapper: createWrapperWithClient(queryClient),
    });
    result.current.mutate({
      tagId: "tag-1",
      entityType: TagEntityType.Artifact,
      entityIds: [COMMITTED_ID],
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(staleSurfaces(queryClient)).toEqual(
      SURFACES_A_TAG_WRITE_LEAVES_ALONE
    );
  });

  // R2/R11 (DOC-36): a batch can resolve every id and still commit none. A
  // refetch there reports a change the server did not make.
  test("a receipt that committed nothing invalidates nothing", async () => {
    mockApiClient.post.mockResolvedValueOnce({
      results: [
        batchItemFailed(REFUSED_ID, BatchItemFailureCode.ArtifactsNotFound),
      ],
    });
    const queryClient = seededClient();

    const { result } = renderHook(() => useBatchUpdateStatus(), {
      wrapper: createWrapperWithClient(queryClient),
    });
    result.current.mutate({
      documentIds: [REFUSED_ID],
      status: DocumentStatus.Approved,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(staleSurfaces(queryClient)).toEqual(SURFACES.map(([name]) => name));
  });

  // `createManyAndReturn` with `skipDuplicates` reports zero rows written when
  // a concurrent request inserted the tag after this cache was read, so a zero
  // says the SERVER already agrees, never that the screen does. The tag path
  // is therefore ungated (ISS-9578 review, whitlockk) — without this the mutation
  // succeeds, the selection clears, and the row still renders untagged.
  test("useBatchApplyTag still refreshes when the server wrote no rows", async () => {
    mockApiClient.post.mockResolvedValueOnce({ appliedCount: 0 });
    const queryClient = seededClient();

    const { result } = renderHook(() => useBatchApplyTag(), {
      wrapper: createWrapperWithClient(queryClient),
    });
    result.current.mutate({
      tagId: "tag-1",
      entityType: TagEntityType.Artifact,
      entityIds: [COMMITTED_ID],
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(staleSurfaces(queryClient)).toEqual(
      SURFACES_A_TAG_WRITE_LEAVES_ALONE
    );
  });

  // A lineage view for an artifact with no links yet caches an EMPTY array, so
  // matching on cached endpoints alone never reached it — and neither did a
  // view still in flight, which has no array at all (ISS-9578 review, whitlockk).
  // The key names its subject, so that is what decides.
  test("a lineage view of a committed artifact refreshes even with nothing cached in it", async () => {
    mockApiClient.post.mockResolvedValueOnce(
      successfulBatchResponse([COMMITTED_ID])
    );
    const queryClient = seededClient();
    const emptyLineageKey = artifactLinkKeys.list({
      artifactId: COMMITTED_ID,
      resolved: true,
    });
    queryClient.setQueryData(emptyLineageKey, []);

    const { result } = renderHook(() => useBatchUpdatePriority(), {
      wrapper: createWrapperWithClient(queryClient),
    });
    result.current.mutate({
      documentIds: [COMMITTED_ID],
      priority: Priority.High,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(isInvalidated(queryClient, emptyLineageKey)).toBe(true);
  });

  // ISS-9632: the status write clears dependents off BLOCKED server-side, and
  // the v1 receipt never names them. Narrowing link views to the receipt would
  // leave a dependent's lineage rendering its old BLOCKED endpoint.
  test("useBatchUpdateStatus refreshes a lineage view the receipt does not name", async () => {
    mockApiClient.post.mockResolvedValueOnce(
      successfulBatchResponse([COMMITTED_ID])
    );
    const queryClient = seededClient();
    const dependentLinkKey = seedResolvedLinkView(queryClient, "doc-dependent");

    const { result } = renderHook(() => useBatchUpdateStatus(), {
      wrapper: createWrapperWithClient(queryClient),
    });
    result.current.mutate({
      documentIds: [COMMITTED_ID],
      status: DocumentStatus.Approved,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(isInvalidated(queryClient, dependentLinkKey)).toBe(true);
  });

  // The fourth bulk path (ISS-9578 review, marisolashgrove): it carried its own
  // four-key list and ignored the receipt it was already being handed.
  test("useBatchMoveArtifacts drives the shared set from movedArtifacts", async () => {
    mockApiClient.post.mockResolvedValueOnce({
      movedArtifacts: [{ id: COMMITTED_ID, type: ArtifactType.Document }],
    });
    const queryClient = seededClient();
    // A move re-parents links whose endpoints are not in the request, so the
    // views it refreshes cannot be narrowed to the moved ids.
    const bystanderLinkKey = seedResolvedLinkView(queryClient, "doc-bystander");

    const { result } = renderHook(() => useBatchMoveArtifacts(), {
      wrapper: createWrapperWithClient(queryClient),
    });
    result.current.mutate({
      artifactId: COMMITTED_ID,
      includeDownstream: false,
      targetProjectId: "p2",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(staleSurfaces(queryClient)).toEqual([]);
    expect(isInvalidated(queryClient, bystanderLinkKey)).toBe(true);
  });
});

function successfulBatchResponse(ids: readonly string[]) {
  return { results: ids.map(batchItemApplied) };
}
