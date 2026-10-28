"use client";

import {
  PROJECT_ARTIFACT_BOARD_PAGE_DEFAULT_SIZE,
  type ProjectArtifactBoardFilters,
  type ProjectArtifactBoardGroup,
  type ProjectArtifactBoardLanePage,
  ProjectArtifactBoardPageError,
  type ProjectArtifactBoardPageResponse,
  type ProjectArtifactBoardSort,
  type ProjectArtifactBoardSortDirection,
  projectArtifactBoardPagePath,
  projectArtifactBoardPageResponseValidator,
} from "@repo/api/src/types/project-artifact-board-page";
import { ApiError } from "@repo/app/shared/api/api-error";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

export const projectArtifactBoardPageKeys = {
  all: ["project-artifact-board-page"] as const,
  project: (projectId: string) =>
    [...projectArtifactBoardPageKeys.all, projectId] as const,
  detail: (
    projectId: string,
    groupBy: ProjectArtifactBoardGroup,
    filters?: ProjectArtifactBoardFilters,
    sort?: ProjectArtifactBoardPageSort
  ) =>
    [
      ...projectArtifactBoardPageKeys.project(projectId),
      groupBy,
      filters ?? null,
      sort ?? null,
    ] as const,
};

type BoardCursor = string | null;

/** A board column sort, as the route reads it. */
export type ProjectArtifactBoardPageSort = {
  by: ProjectArtifactBoardSort;
  direction: ProjectArtifactBoardSortDirection;
};

/** Cross-surface infinite query for deterministic per-lane Project board pages. */
export function useProjectArtifactBoardPage(
  projectId: string,
  groupBy: ProjectArtifactBoardGroup,
  options?: {
    enabled?: boolean;
    /** ISS-12929 (724-F5): applied by the server, page by page. */
    filters?: ProjectArtifactBoardFilters;
    pageSize?: number;
    /** ISS-12929 (724-F5): the page's column sort; omitted is stack rank. */
    sort?: ProjectArtifactBoardPageSort;
  }
) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const filters = options?.filters;
  const sort = options?.sort;
  const queryKey = projectArtifactBoardPageKeys.detail(
    projectId,
    groupBy,
    filters,
    sort
  );
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }: { pageParam: BoardCursor }) => {
      return apiClient
        .get<ProjectArtifactBoardPageResponse>(
          projectArtifactBoardPagePath(projectId, {
            ...(pageParam ? { cursor: pageParam } : {}),
            ...(filters ? { filters } : {}),
            ...(sort ? { sortBy: sort.by, sortDir: sort.direction } : {}),
            groupBy,
            pageSize:
              options?.pageSize ?? PROJECT_ARTIFACT_BOARD_PAGE_DEFAULT_SIZE,
          })
        )
        .then((response) =>
          projectArtifactBoardPageResponseValidator.parse(response)
        );
    },
    enabled: options?.enabled ?? Boolean(projectId),
    getNextPageParam: (lastPage): BoardCursor => lastPage.nextCursor ?? null,
    initialPageParam: null as BoardCursor,
    select: (data) => mergeProjectArtifactBoardPages(data.pages),
    staleTime: 30_000,
  });
  const restartedError = useRef<Error | null>(null);
  useEffect(() => {
    const error = query.error;
    if (
      error instanceof ApiError &&
      error.code === ProjectArtifactBoardPageError.StaleRevision &&
      restartedError.current !== error
    ) {
      restartedError.current = error;
      queryClient.resetQueries({ exact: true, queryKey });
    }
  }, [query.error, queryClient, queryKey]);
  return query;
}

export function mergeProjectArtifactBoardPages(
  pages: readonly ProjectArtifactBoardPageResponse[]
) {
  const first = pages[0];
  const revision = first?.populationRevision ?? "";
  const laneById = new Map<string, ProjectArtifactBoardLanePage>();
  for (const page of pages) {
    if (page.populationRevision !== revision) {
      continue;
    }
    for (const lane of page.lanes) {
      const current = laneById.get(lane.id);
      laneById.set(lane.id, {
        ...lane,
        cards: dedupeCards([...(current?.cards ?? []), ...lane.cards]),
      });
    }
  }
  return {
    ...(first?.lanePolicy ? { lanePolicy: first.lanePolicy } : {}),
    lanes: [...laneById.values()],
    populationRevision: revision,
    ...(first?.projectVersion ? { projectVersion: first.projectVersion } : {}),
    rootIds: [...new Set(pages.flatMap((page) => page.rootIds))],
  };
}

function dedupeCards(
  cards: readonly ProjectArtifactBoardLanePage["cards"][number][]
) {
  return [...new Map(cards.map((card) => [card.artifact.id, card])).values()];
}
