"use client";

import type { SessionMeshInsights } from "@repo/api/src/types/session-mesh";
import { useQuery } from "@tanstack/react-query";
import { useInsightsDataSource } from "../data/insights-data-source";

/** Per-user Mesh measurements; the server defaults to the signed-in user. */
export function useSessionMeshInsights(
  enabled: boolean,
  scope: "me" | "org",
  period: "7" | "30" | "90" | "all",
  userId?: string
) {
  const source = useInsightsDataSource();
  return useQuery<SessionMeshInsights>({
    queryKey: [
      "session-mesh",
      "insights",
      scope,
      period,
      userId ?? "current-user",
    ],
    queryFn: () => {
      if (!source.getSessionMeshInsights) {
        throw new Error("Session Mesh insights unavailable");
      }
      return source.getSessionMeshInsights(scope, period, userId);
    },
    enabled: enabled && Boolean(source.getSessionMeshInsights),
    staleTime: 30_000,
  });
}
