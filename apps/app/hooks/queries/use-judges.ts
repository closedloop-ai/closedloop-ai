"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import type {
  BatchJudgeScoresResponse,
  JudgeFeedbackItem,
  JudgesFeedbackResponse,
} from "@repo/api/src/types/evaluation";
import {
  type UseQueryOptions,
  type UseQueryResult,
  useQueries,
  useQuery,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const judgesKeys = {
  all: ["judges"] as const,
  detail: (id: string) => [...judgesKeys.all, "detail", id] as const,
  prdDetail: (id: string) => [...judgesKeys.all, "prd-detail", id] as const,
  codeDetail: (id: string) => [...judgesKeys.all, "code-detail", id] as const,
  byProject: (projectId: string) =>
    [...judgesKeys.all, "by-project", projectId] as const,
};

function makeJudgesFeedbackHook(
  getEndpoint: (id: string) => string,
  keyFn: (id: string) => readonly unknown[]
) {
  return (artifactId: string): UseQueryResult<JudgeFeedbackItem[] | null> => {
    const apiClient = useApiClient();
    return useQuery({
      queryKey: keyFn(artifactId),
      queryFn: async () => {
        const response = await apiClient.get<JudgesFeedbackResponse>(
          getEndpoint(artifactId)
        );
        return response.status === "success" ? response.data : null;
      },
      enabled: !!artifactId,
      staleTime: 10 * 60 * 1000,
    });
  };
}

export const useJudgesFeedback = makeJudgesFeedbackHook(
  (id) => `/artifacts/${id}/plan-judges`,
  judgesKeys.detail
);

export const usePrdJudgesFeedback = makeJudgesFeedbackHook(
  (id) => `/artifacts/${id}/prd-judges`,
  judgesKeys.prdDetail
);

export const useCodeJudgesFeedback = makeJudgesFeedbackHook(
  (id) => `/artifacts/${id}/code-judges`,
  judgesKeys.codeDetail
);

export function useProjectJudgeScores(
  projectId: string,
  options?: Omit<
    UseQueryOptions<BatchJudgeScoresResponse>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    ...makeProjectJudgeScoresQueryOptions(apiClient, projectId),
    enabled: !!projectId,
    ...options,
  });
}

/**
 * Fetches judge scores for artifacts across multiple projects.
 * @param artifacts Must originate from an org-scoped query hook such as `useArtifactsByTeam`.
 */
export function useTeamArtifactJudgeScores(
  artifacts: ArtifactWithWorkstream[]
): BatchJudgeScoresResponse {
  const apiClient = useApiClient();

  const projectIds = useMemo(() => {
    const seen = new Set<string>();
    for (const artifact of artifacts) {
      if (artifact.project?.id) {
        seen.add(artifact.project.id);
      }
    }
    return [...seen];
  }, [artifacts]);

  const results = useQueries({
    queries: projectIds.map((id) =>
      makeProjectJudgeScoresQueryOptions(apiClient, id)
    ),
  });

  const judgeScoresMergeKey = results.map((r) => r.dataUpdatedAt).join(",");

  // Safe merge relies on artifactIds being globally unique UUIDs
  // biome-ignore lint/correctness/useExhaustiveDependencies: judgeScoresMergeKey tracks all query dataUpdatedAt values; useQueries result array identity is not stable enough to list alone
  return useMemo(
    () => Object.assign({}, ...results.map((r) => r.data ?? {})),
    [judgeScoresMergeKey]
  );
}

function makeProjectJudgeScoresQueryOptions(
  apiClient: ReturnType<typeof useApiClient>,
  projectId: string
) {
  return {
    queryKey: judgesKeys.byProject(projectId),
    queryFn: () =>
      apiClient.get<BatchJudgeScoresResponse>(
        `/artifacts/judge-scores?projectId=${encodeURIComponent(projectId)}`
      ),
    staleTime: 60_000,
  };
}
