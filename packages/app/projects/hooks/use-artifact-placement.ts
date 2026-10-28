"use client";

import {
  PROJECT_ARTIFACT_BOARD_NO_PRIORITY_LANE_ID,
  PROJECT_ARTIFACT_BOARD_UNASSIGNED_LANE_ID,
} from "@repo/api/src/types/project-artifact-board-move";
import {
  ProjectArtifactBoardGroup,
  type ProjectArtifactBoardPageResponse,
} from "@repo/api/src/types/project-artifact-board-page";
import {
  type ProjectArtifactLanePolicy,
  projectArtifactLanePolicyReasonLabel,
} from "@repo/api/src/types/project-artifact-lane-policy";
import type {
  PlaceProjectArtifactsRequest,
  ProjectArtifactPlacementIntent,
  ProjectArtifactPlacementResponse,
  ProjectArtifactPlacementStateResponse,
} from "@repo/api/src/types/project-artifact-placement";
import {
  ProjectArtifactPlacementSource as PlacementSource,
  ProjectArtifactPlacementGroupField,
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
} from "@repo/api/src/types/project-artifact-placement";
import {
  applyPlacementAcrossProjectTrees,
  applyPlacementToProjectTree,
} from "@repo/api/src/types/project-artifact-placement-tree";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import {
  ARTIFACT_PLACEMENT_FAILED_MESSAGE,
  ARTIFACT_PLACEMENT_MOVED_MESSAGE,
  ARTIFACT_PLACEMENT_UNDO_LABEL,
} from "@repo/app/projects/lib/artifact-placement-copy";
import { useApiClientOptional } from "@repo/app/shared/api/use-api-client-optional";
import type { ArtifactBoardItem } from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board-model";
import { currentQueryCacheScope } from "@repo/app/shared/query/query-client";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  type InfiniteData,
  QueryClient,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { useManualArtifactOrderingEnabled } from "../../shared/feature-flags/use-manual-artifact-ordering";
import { projectBoardLanePolicyResult } from "../components/project-artifact-board-model";
import { invalidateArtifactPlacementViews } from "../lib/artifact-placement-invalidation";
import { projectTreeKeys } from "./project-tree-keys";
import { projectArtifactBoardPageKeys } from "./use-project-artifact-board-page";

export type ArtifactPlacementIntent = ProjectArtifactPlacementIntent & {
  /** Versions from the rendered trees or board pages the user acted on. */
  expectedProjectVersions?: Readonly<Record<string, string>>;
};

/** Resolve the server-owned placement permission before exposing write controls. */
export function useArtifactPlacementCapability(projectId: string): boolean {
  const manualOrderingEnabled = useManualArtifactOrderingEnabled();
  const apiClient = useApiClientOptional();
  const capability = useQuery({
    queryKey: projectArtifactPlacementCapabilityKey(projectId),
    queryFn: () =>
      apiClient?.get<ProjectArtifactPlacementStateResponse>(
        placementPath(projectId)
      ),
    enabled: Boolean(manualOrderingEnabled && projectId && apiClient),
    retry: false,
  });
  return capability.isSuccess && capability.data?.canPlaceArtifacts === true;
}

type PlacementContext = {
  boardUpdateCounts: (number | undefined)[];
  optimisticBoards: BoardPageSnapshot[];
  previous: [QueryKey, ProjectTreeResponse | undefined][];
  previousBoards: BoardPageSnapshot[];
  optimistic: [QueryKey, ProjectTreeResponse | undefined][];
  updateCounts: (number | undefined)[];
  scopeAtCall: string;
};

type BoardPageData = InfiniteData<
  ProjectArtifactBoardPageResponse,
  string | null
>;
type BoardPageSnapshot = [QueryKey, BoardPageData | undefined];

/** Own the production placement request, bounded preview, rollback, and undo receipt. */
export function useArtifactPlacement(
  projectId: string,
  canPlaceArtifacts = true,
  _options?: {
    board?: {
      items: readonly ArtifactBoardItem[];
      policy: ProjectArtifactLanePolicy | null | undefined;
    };
  }
) {
  const apiClient = useApiClientOptional();
  const fallbackQueryClient = useMemo(() => new QueryClient(), []);
  const queryClient = useQueryClient(
    canPlaceArtifacts ? undefined : fallbackQueryClient
  );

  const undoMutation = useMutation(
    {
      mutationFn: (response: ProjectArtifactPlacementResponse) => {
        if (!apiClient) {
          throw new Error("Artifact placement requires an API adapter");
        }
        return apiClient.post<ProjectArtifactPlacementResponse>(
          placementPath(projectId),
          {
            kind: ProjectArtifactPlacementKind.Undo,
            undoOfTransactionId: response.transactionId,
            expectedProjectVersions: response.projectVersions,
            idempotencyKey: globalThis.crypto.randomUUID(),
            source: PlacementSource.Undo,
          }
        );
      },
      onSettled: (data, _error, response) => {
        invalidateArtifactPlacementViews(queryClient, {
          affectedArtifactIds: (data ?? response).affectedArtifactIds,
          affectedProjectIds: (data ?? response).affectedProjectIds,
        });
      },
      onError: () => {
        toast.error(ARTIFACT_PLACEMENT_FAILED_MESSAGE);
      },
    },
    queryClient
  );

  const placementMutation = useMutation<
    ProjectArtifactPlacementResponse,
    Error,
    ArtifactPlacementIntent,
    PlacementContext
  >(
    {
      mutationFn: async (intent) => {
        if (!apiClient) {
          throw new Error("Artifact placement requires an API adapter");
        }
        const expectedProjectVersions = await readProjectVersions(
          queryClient,
          [projectId, intent.destinationProjectId],
          intent.expectedProjectVersions,
          (destinationProjectId) =>
            apiClient.get<ProjectArtifactPlacementStateResponse>(
              placementPath(destinationProjectId)
            )
        );
        const request: PlaceProjectArtifactsRequest = {
          ...intent,
          kind: ProjectArtifactPlacementKind.Place,
          expectedProjectVersions,
          idempotencyKey: globalThis.crypto.randomUUID(),
        };
        return apiClient.post<ProjectArtifactPlacementResponse>(
          placementPath(projectId),
          request
        );
      },
      onMutate: async (intent) => {
        if (_options?.board && intent.lanePatch) {
          const policyResult = projectBoardLanePolicyResult({
            expectedPolicyRevision: intent.lanePatch.expectedPolicyRevision,
            items: _options.board.items,
            policy: _options.board.policy,
            rootIds: intent.sourceArtifactIds,
            targetLaneId:
              intent.lanePatch.value ??
              (intent.lanePatch.field ===
              ProjectArtifactPlacementGroupField.AssigneeId
                ? PROJECT_ARTIFACT_BOARD_UNASSIGNED_LANE_ID
                : PROJECT_ARTIFACT_BOARD_NO_PRIORITY_LANE_ID),
            targetLaneIdsByRootId: intent.lanePatch.valuesByRootId,
          });
          if (!policyResult.allowed) {
            throw new Error(
              projectArtifactLanePolicyReasonLabel(policyResult.reason)
            );
          }
        }
        const scopeAtCall = currentQueryCacheScope(queryClient);
        await queryClient.cancelQueries({
          queryKey: projectTreeKeys.detail(projectId),
        });
        await queryClient.cancelQueries({
          queryKey: projectArtifactBoardPageKeys.project(projectId),
        });
        if (intent.destinationProjectId !== projectId) {
          await queryClient.cancelQueries({
            queryKey: projectTreeKeys.detail(intent.destinationProjectId),
          });
          await queryClient.cancelQueries({
            queryKey: projectArtifactBoardPageKeys.project(
              intent.destinationProjectId
            ),
          });
        }
        if (currentQueryCacheScope(queryClient) !== scopeAtCall) {
          return {
            boardUpdateCounts: [],
            optimisticBoards: [],
            previous: [],
            previousBoards: [],
            optimistic: [],
            updateCounts: [],
            scopeAtCall,
          };
        }
        const previous = readPlacementCaches(
          queryClient,
          projectId,
          intent.destinationProjectId
        );
        const previousBoards = readPlacementBoardCaches(
          queryClient,
          projectId,
          intent.destinationProjectId
        );
        const optimistic = applyOptimisticPlacement(
          queryClient,
          projectId,
          intent,
          previous
        );
        applyOptimisticBoardPlacement(
          queryClient,
          projectId,
          intent,
          previousBoards
        );
        const optimisticBoards = readPlacementBoardCaches(
          queryClient,
          projectId,
          intent.destinationProjectId
        );
        const updateCounts = optimistic.map(
          ([queryKey]) => queryClient.getQueryState(queryKey)?.dataUpdateCount
        );
        const boardUpdateCounts = optimisticBoards.map(
          ([queryKey]) => queryClient.getQueryState(queryKey)?.dataUpdateCount
        );
        return {
          boardUpdateCounts,
          optimisticBoards,
          previous,
          previousBoards,
          optimistic,
          updateCounts,
          scopeAtCall,
        };
      },
      onError: (_error, _intent, context) => {
        restorePlacementPreview(queryClient, context);
        toast.error(ARTIFACT_PLACEMENT_FAILED_MESSAGE);
      },
      onSuccess: (response) => {
        if (!response.undoAvailable) {
          toast.success(ARTIFACT_PLACEMENT_MOVED_MESSAGE);
          return;
        }
        toast.success(ARTIFACT_PLACEMENT_MOVED_MESSAGE, {
          action: {
            label: ARTIFACT_PLACEMENT_UNDO_LABEL,
            onClick: () => undoMutation.mutate(response),
          },
        });
      },
      onSettled: (response) => {
        if (response) {
          invalidateArtifactPlacementViews(queryClient, response);
        } else {
          invalidateAffectedProjects(queryClient, [projectId]);
        }
      },
    },
    queryClient
  );

  return Object.assign(placementMutation, {
    undo: (response: ProjectArtifactPlacementResponse) =>
      undoMutation.mutate(response),
    undoMutation,
  });
}

function readPlacementCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  sourceProjectId: string,
  destinationProjectId: string
): [QueryKey, ProjectTreeResponse][] {
  const readTrees = (projectId: string): [QueryKey, ProjectTreeResponse][] =>
    queryClient
      .getQueriesData<unknown>({ queryKey: projectTreeKeys.detail(projectId) })
      .filter((entry): entry is [QueryKey, ProjectTreeResponse] =>
        isProjectTreeCacheValue(entry[1])
      );
  const source = readTrees(sourceProjectId);
  if (destinationProjectId === sourceProjectId) {
    return source;
  }
  return source.concat(readTrees(destinationProjectId));
}

function isProjectTreeCacheValue(value: unknown): value is ProjectTreeResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "nodes" in value &&
    Array.isArray(value.nodes) &&
    "projectVersion" in value &&
    typeof value.projectVersion === "string"
  );
}

function readPlacementBoardCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  sourceProjectId: string,
  destinationProjectId: string
): BoardPageSnapshot[] {
  const source = queryClient.getQueriesData<BoardPageData>({
    queryKey: projectArtifactBoardPageKeys.project(sourceProjectId),
  });
  return destinationProjectId === sourceProjectId
    ? source
    : source.concat(
        queryClient.getQueriesData<BoardPageData>({
          queryKey: projectArtifactBoardPageKeys.project(destinationProjectId),
        })
      );
}

function applyOptimisticBoardPlacement(
  queryClient: ReturnType<typeof useQueryClient>,
  sourceProjectId: string,
  intent: ArtifactPlacementIntent,
  snapshots: readonly BoardPageSnapshot[]
) {
  const movingCards = collectMovingBoardCards(
    snapshots,
    sourceProjectId,
    intent.sourceArtifactIds
  );
  for (const [queryKey, current] of snapshots) {
    const targetProjectId = boardProjectIdFromKey(queryKey);
    const groupBy = boardGroupFromKey(queryKey);
    if (!(current && targetProjectId && groupBy)) {
      continue;
    }
    queryClient.setQueryData(
      queryKey,
      optimisticBoardPages({
        current,
        destinationProjectId: intent.destinationProjectId,
        groupBy,
        intent,
        movingCards,
        sourceProjectId,
        targetProjectId,
      })
    );
  }
}

function collectMovingBoardCards(
  snapshots: readonly BoardPageSnapshot[],
  sourceProjectId: string,
  artifactIds: readonly string[]
) {
  const cardsById = new Map(
    snapshots
      .filter(
        ([queryKey]) => boardProjectIdFromKey(queryKey) === sourceProjectId
      )
      .flatMap(
        ([, data]) =>
          data?.pages.flatMap((page) =>
            page.lanes.flatMap((lane) => lane.cards)
          ) ?? []
      )
      .map((card) => [card.artifact.id, card] as const)
  );
  return artifactIds.flatMap((artifactId) => {
    const card = cardsById.get(artifactId);
    return card ? [card] : [];
  });
}

function optimisticBoardPages(input: {
  current: BoardPageData;
  destinationProjectId: string;
  groupBy: ProjectArtifactBoardGroup;
  intent: ArtifactPlacementIntent;
  movingCards: ReturnType<typeof collectMovingBoardCards>;
  sourceProjectId: string;
  targetProjectId: string;
}): BoardPageData {
  const movingIds = new Set(input.intent.sourceArtifactIds);
  const insertionPageIndex =
    input.targetProjectId === input.destinationProjectId
      ? boardInsertionPageIndex(input.current.pages, input)
      : null;
  if (
    input.targetProjectId === input.destinationProjectId &&
    insertionPageIndex === null &&
    input.intent.position !== ProjectArtifactPlacementPosition.Inside
  ) {
    return input.current;
  }
  const laneCountDeltas = optimisticLaneCountDeltas(input, insertionPageIndex);
  const pages = input.current.pages.map((page) => {
    const lanes = removeCardsFromOptimisticLanes(
      page.lanes,
      movingIds,
      laneCountDeltas
    );
    const rootIds = page.rootIds.filter((id) => !movingIds.has(id));
    return lanes === page.lanes && rootIds.length === page.rootIds.length
      ? page
      : { ...page, lanes, rootIds };
  });
  const movingCards = input.movingCards.map((card) => ({
    ...card,
    artifact: {
      ...card.artifact,
      projectId: input.destinationProjectId,
    },
  }));
  const optimisticPages = pages.map((page, pageIndex) => {
    if (pageIndex !== insertionPageIndex) {
      return page;
    }
    const rootIds = insertBoardRootIds(
      page.rootIds,
      input.intent.sourceArtifactIds,
      input.intent
    );
    return {
      ...page,
      lanes: addCardsToOptimisticLanes(
        page.lanes,
        input.intent,
        movingCards,
        input.groupBy,
        rootIds
      ),
      rootIds,
    };
  });
  return optimisticPages.every(
    (page, index) => page === input.current.pages[index]
  )
    ? input.current
    : { ...input.current, pages: optimisticPages };
}

function removeCardsFromOptimisticLanes(
  lanes: ProjectArtifactBoardPageResponse["lanes"],
  movingIds: ReadonlySet<string>,
  laneCountDeltas: ReadonlyMap<string, number>
) {
  let changed = false;
  const next = lanes.map((lane) => {
    const cards = lane.cards.filter((card) => !movingIds.has(card.artifact.id));
    const countDelta = laneCountDeltas.get(lane.id) ?? 0;
    if (cards.length === lane.cards.length && countDelta === 0) {
      return lane;
    }
    changed = true;
    return {
      ...lane,
      cards,
      count: Math.max(0, lane.count + countDelta),
    };
  });
  return changed ? next : lanes;
}

function addCardsToOptimisticLanes(
  lanes: ProjectArtifactBoardPageResponse["lanes"],
  intent: ArtifactPlacementIntent,
  cards: ReturnType<typeof collectMovingBoardCards>,
  groupBy: ProjectArtifactBoardGroup,
  rootIds: readonly string[]
) {
  const additions = new Map<string, typeof cards>();
  for (const card of cards) {
    const laneId = optimisticLaneId(card, intent, groupBy);
    const targetStatus = intent.lanePatch?.valuesByRootId?.[card.artifact.id];
    const updatedCard = targetStatus
      ? { ...card, artifact: { ...card.artifact, status: targetStatus } }
      : card;
    additions.set(laneId, [...(additions.get(laneId) ?? []), updatedCard]);
  }
  return lanes.map((lane) => {
    const added = additions.get(lane.id) ?? [];
    return added.length === 0
      ? lane
      : {
          ...lane,
          cards: orderBoardCards([...lane.cards, ...added], rootIds),
        };
  });
}

function optimisticLaneCountDeltas(
  input: {
    destinationProjectId: string;
    groupBy: ProjectArtifactBoardGroup;
    intent: ArtifactPlacementIntent;
    movingCards: ReturnType<typeof collectMovingBoardCards>;
    sourceProjectId: string;
    targetProjectId: string;
  },
  insertionPageIndex: number | null
) {
  const deltas = new Map<string, number>();
  if (input.targetProjectId === input.sourceProjectId) {
    for (const card of input.movingCards) {
      addLaneCountDelta(deltas, boardCardLaneId(card, input.groupBy), -1);
    }
  }
  if (
    input.targetProjectId === input.destinationProjectId &&
    insertionPageIndex !== null
  ) {
    for (const card of input.movingCards) {
      addLaneCountDelta(
        deltas,
        optimisticLaneId(card, input.intent, input.groupBy),
        1
      );
    }
  }
  return deltas;
}

function addLaneCountDelta(
  deltas: Map<string, number>,
  laneId: string,
  delta: number
) {
  const next = (deltas.get(laneId) ?? 0) + delta;
  if (next === 0) {
    deltas.delete(laneId);
  } else {
    deltas.set(laneId, next);
  }
}

function orderBoardCards(
  cards: ProjectArtifactBoardPageResponse["lanes"][number]["cards"],
  rootIds: readonly string[]
) {
  const orderById = new Map(rootIds.map((id, index) => [id, index]));
  return cards
    .map((card, index) => ({ card, index }))
    .sort((left, right) => {
      const leftOrder = orderById.get(left.card.artifact.id);
      const rightOrder = orderById.get(right.card.artifact.id);
      if (leftOrder === undefined || rightOrder === undefined) {
        return left.index - right.index;
      }
      return leftOrder - rightOrder;
    })
    .map(({ card }) => card);
}

function optimisticLaneId(
  card: ProjectArtifactBoardPageResponse["lanes"][number]["cards"][number],
  intent: ArtifactPlacementIntent,
  groupBy: ProjectArtifactBoardGroup
) {
  const patch = intent.lanePatch;
  if (
    patch &&
    ((groupBy === ProjectArtifactBoardGroup.Status &&
      patch.field === ProjectArtifactPlacementGroupField.Status) ||
      (groupBy === ProjectArtifactBoardGroup.Priority &&
        patch.field === ProjectArtifactPlacementGroupField.Priority) ||
      (groupBy === ProjectArtifactBoardGroup.Assignee &&
        patch.field === ProjectArtifactPlacementGroupField.AssigneeId))
  ) {
    const perRootStatus = patch.valuesByRootId?.[card.artifact.id];
    return (
      perRootStatus ??
      patch.value ??
      (patch.field === ProjectArtifactPlacementGroupField.AssigneeId
        ? PROJECT_ARTIFACT_BOARD_UNASSIGNED_LANE_ID
        : PROJECT_ARTIFACT_BOARD_NO_PRIORITY_LANE_ID)
    );
  }
  return boardCardLaneId(card, groupBy);
}

function boardCardLaneId(
  card: ProjectArtifactBoardPageResponse["lanes"][number]["cards"][number],
  groupBy: ProjectArtifactBoardGroup
) {
  switch (groupBy) {
    case ProjectArtifactBoardGroup.Status:
      return card.artifact.status;
    case ProjectArtifactBoardGroup.Priority:
      return (
        card.artifact.priority ?? PROJECT_ARTIFACT_BOARD_NO_PRIORITY_LANE_ID
      );
    case ProjectArtifactBoardGroup.Assignee:
      return (
        card.artifact.assigneeId ?? PROJECT_ARTIFACT_BOARD_UNASSIGNED_LANE_ID
      );
    case ProjectArtifactBoardGroup.None:
      return "all";
    default: {
      const exhaustive: never = groupBy;
      return exhaustive;
    }
  }
}

/** Locate the loaded page that owns the server-normalized stable target. */
function boardInsertionPageIndex(
  pages: readonly ProjectArtifactBoardPageResponse[],
  input: {
    groupBy: ProjectArtifactBoardGroup;
    intent: ArtifactPlacementIntent;
    movingCards: ReturnType<typeof collectMovingBoardCards>;
  }
): number | null {
  const { intent } = input;
  if (intent.position === ProjectArtifactPlacementPosition.Inside) {
    return null;
  }
  if (intent.position === ProjectArtifactPlacementPosition.Root) {
    return rootInsertionPageIndex(pages, input);
  }
  const targetArtifactId = intent.targetArtifactId;
  const targetPageIndex = targetArtifactId
    ? pages.findIndex((page) => page.rootIds.includes(targetArtifactId))
    : -1;
  return targetPageIndex >= 0 ? targetPageIndex : null;
}

/** Insert one ordered source block without flattening per-page root boundaries. */
function insertBoardRootIds(
  retained: readonly string[],
  sourceArtifactIds: readonly string[],
  intent: ArtifactPlacementIntent
): string[] {
  if (intent.position === ProjectArtifactPlacementPosition.Root) {
    return [...retained, ...sourceArtifactIds];
  }
  const targetIndex = intent.targetArtifactId
    ? retained.indexOf(intent.targetArtifactId)
    : -1;
  if (targetIndex < 0) {
    return [...retained];
  }
  const insertionIndex =
    intent.position === ProjectArtifactPlacementPosition.After
      ? targetIndex + 1
      : targetIndex;
  return [
    ...retained.slice(0, insertionIndex),
    ...sourceArtifactIds,
    ...retained.slice(insertionIndex),
  ];
}

function boardProjectIdFromKey(queryKey: QueryKey): string | null {
  const projectId = queryKey[1];
  return typeof projectId === "string" ? projectId : null;
}

function boardGroupFromKey(
  queryKey: QueryKey
): ProjectArtifactBoardGroup | null {
  const groupBy = queryKey[2];
  return (
    Object.values(ProjectArtifactBoardGroup).find(
      (candidate) => candidate === groupBy
    ) ?? null
  );
}

function applyOptimisticPlacement(
  queryClient: ReturnType<typeof useQueryClient>,
  sourceProjectId: string,
  intent: ArtifactPlacementIntent,
  previous: [QueryKey, ProjectTreeResponse][]
): [QueryKey, ProjectTreeResponse | undefined][] {
  if (intent.destinationProjectId === sourceProjectId) {
    return previous.map(
      ([queryKey, tree]): [QueryKey, ProjectTreeResponse | undefined] => [
        queryKey,
        queryClient.setQueryData<ProjectTreeResponse>(
          queryKey,
          applyPlacementToProjectTree(tree, intent, sourceProjectId)
        ),
      ]
    );
  }
  const sourceTree = previous.find(([queryKey]) =>
    queryKeyMatchesProject(queryKey, sourceProjectId)
  )?.[1];
  const destinationTree = previous.find(([queryKey]) =>
    queryKeyMatchesProject(queryKey, intent.destinationProjectId)
  )?.[1];
  if (!(sourceTree && destinationTree)) {
    return [];
  }
  const next = applyPlacementAcrossProjectTrees(
    sourceTree,
    destinationTree,
    intent
  );
  const sourceUpdates = previous
    .filter(([queryKey]) => queryKeyMatchesProject(queryKey, sourceProjectId))
    .map(([queryKey]): [QueryKey, ProjectTreeResponse | undefined] => [
      queryKey,
      queryClient.setQueryData<ProjectTreeResponse>(queryKey, next.source),
    ]);
  return sourceUpdates.concat(
    previous
      .filter(([queryKey]) =>
        queryKeyMatchesProject(queryKey, intent.destinationProjectId)
      )
      .map(([queryKey]): [QueryKey, ProjectTreeResponse | undefined] => [
        queryKey,
        queryClient.setQueryData<ProjectTreeResponse>(
          queryKey,
          next.destination
        ),
      ])
  );
}

function queryKeyMatchesProject(
  queryKey: QueryKey,
  projectId: string
): boolean {
  return queryKey.includes(projectId);
}

function placementPath(projectId: string): string {
  return `/projects/${projectId}/artifacts/placement`;
}

/**
 * The versions a board move sends: the rendered board page's own, and for any
 * project the board did not render (a move-to-project destination, or every
 * project when an older API omitted the page version) its current version.
 * A failed read is left out, so the placement hook refuses the move instead of
 * guessing a version.
 */
export async function resolveBoardPlacementVersions(
  get: (<T>(path: string) => Promise<T>) | undefined,
  projectIds: readonly string[],
  rendered: Readonly<Record<string, string>> | undefined
): Promise<Record<string, string>> {
  const versions: Record<string, string> = { ...rendered };
  const missing = [...new Set(projectIds)].filter((id) => !versions[id]);
  if (!get) {
    return versions;
  }
  const reads = await Promise.allSettled(
    missing.map((id) => readProjectPlacementVersion(get, id))
  );
  for (const [index, read] of reads.entries()) {
    const projectId = missing[index];
    if (projectId && read.status === "fulfilled") {
      versions[projectId] = read.value;
    }
  }
  return versions;
}

/**
 * Read a project's current placement version for a destination the user did
 * not render, such as the target of a board's move-to-project action.
 */
export async function readProjectPlacementVersion(
  get: <T>(path: string) => Promise<T>,
  projectId: string
): Promise<string> {
  const state = await get<ProjectArtifactPlacementStateResponse>(
    placementPath(projectId)
  );
  return state.projectVersion;
}

async function readProjectVersions(
  queryClient: ReturnType<typeof useQueryClient>,
  projectIds: string[],
  actedOnVersions: Readonly<Record<string, string>> | undefined,
  fetchState: (
    projectId: string
  ) => Promise<ProjectArtifactPlacementStateResponse>
): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};
  for (const projectId of new Set(projectIds)) {
    const actedOnVersion = actedOnVersions?.[projectId];
    if (actedOnVersion) {
      versions[projectId] = actedOnVersion;
      continue;
    }
    const cached = queryClient
      .getQueriesData<ProjectTreeResponse>({
        queryKey: projectTreeKeys.detail(projectId),
      })
      .map(([, tree]) => tree?.projectVersion)
      .find((version): version is string => Boolean(version));
    if (projectId === projectIds[0]) {
      if (!cached) {
        throw new Error(
          "Artifact placement requires the rendered project tree"
        );
      }
      versions[projectId] = cached;
    } else {
      const state = await fetchState(projectId);
      if (state.projectId !== projectId || !state.projectVersion) {
        throw new Error("Destination project version is unavailable");
      }
      versions[projectId] = state.projectVersion;
    }
  }
  return versions;
}

function restorePlacementPreview(
  queryClient: ReturnType<typeof useQueryClient>,
  context: PlacementContext | undefined
): void {
  if (!context || currentQueryCacheScope(queryClient) !== context.scopeAtCall) {
    return;
  }
  for (const [index, [queryKey, data]] of context.previous.entries()) {
    if (
      queryClient.getQueryData(queryKey) === context.optimistic[index]?.[1] &&
      queryClient.getQueryState(queryKey)?.dataUpdateCount ===
        context.updateCounts[index]
    ) {
      queryClient.setQueryData(queryKey, data);
    }
  }
  for (const [index, [queryKey, data]] of context.previousBoards.entries()) {
    if (
      queryClient.getQueryData(queryKey) ===
        context.optimisticBoards[index]?.[1] &&
      queryClient.getQueryState(queryKey)?.dataUpdateCount ===
        context.boardUpdateCounts[index]
    ) {
      queryClient.setQueryData(queryKey, data);
    }
  }
}

function invalidateAffectedProjects(
  queryClient: ReturnType<typeof useQueryClient>,
  projectIds: string[]
): void {
  for (const affectedProjectId of new Set(projectIds)) {
    queryClient.invalidateQueries({
      queryKey: projectTreeKeys.detail(affectedProjectId),
    });
    queryClient.invalidateQueries({
      queryKey: projectArtifactBoardPageKeys.project(affectedProjectId),
    });
  }
}

/** Stable cache key for the permission-bearing placement state read. */
export function projectArtifactPlacementCapabilityKey(projectId: string) {
  return ["project-artifact-placement", projectId, "capability"] as const;
}

/**
 * Root appends to the end of the project's root order on the server, so it
 * previews on the last loaded page, and only once every destination lane is
 * complete there; while a lane still has pages to load the end is not loaded.
 */
function rootInsertionPageIndex(
  pages: readonly ProjectArtifactBoardPageResponse[],
  input: {
    groupBy: ProjectArtifactBoardGroup;
    intent: ArtifactPlacementIntent;
    movingCards: ReturnType<typeof collectMovingBoardCards>;
  }
): number | null {
  const lastIndex = pages.length - 1;
  const lastPage = pages[lastIndex];
  if (!lastPage) {
    return null;
  }
  const laneComplete = new Map(
    lastPage.lanes.map((lane) => [lane.id, lane.complete])
  );
  const destinationLanesComplete = input.movingCards.every(
    (card) =>
      laneComplete.get(optimisticLaneId(card, input.intent, input.groupBy)) ===
      true
  );
  return destinationLanesComplete ? lastIndex : null;
}
