import { queryOptions } from "@tanstack/react-query";
import type { DeploymentConfig } from "@/types/repos";
import { queryKeys } from "./keys";

/* ---------- Response types ---------- */

export type DeployStatusResponse = {
  status: "running" | "completed" | "failed" | "not-started";
  logs?: string;
  pid?: number | null;
  deployedUrl?: string;
  serviceId?: string;
  error?: string;
};

export type DeployHealthResponse = {
  alive: boolean;
  statusCode?: number | null;
};

/* ---------- Query option factories ---------- */

export function deployStatusOptions(
  ticketId: string,
  repoPath: string | null,
  pid?: number
) {
  return queryOptions<DeployStatusResponse>({
    queryKey: queryKeys.deployStatus(ticketId, repoPath),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (repoPath) {
        params.set("repo", repoPath);
      }
      if (pid) {
        params.set("pid", String(pid));
      }
      const response = await fetch(
        `/api/deploy/status/${encodeURIComponent(ticketId)}?${params.toString()}`
      );
      if (!response.ok) {
        throw new Error("Failed to fetch deploy status");
      }
      return response.json();
    },
    enabled: !!repoPath,
  });
}

export function deployHealthOptions(ticketId: string, url: string | undefined) {
  return queryOptions<DeployHealthResponse>({
    queryKey: queryKeys.deployHealth(ticketId),
    queryFn: async () => {
      const response = await fetch("/api/engineer/deploy/health", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!response.ok) {
        throw new Error("Failed to health check");
      }
      return response.json();
    },
    enabled: !!url,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/* ---------- Mutation helpers ---------- */

export async function triggerDeployDetect(
  repoPath: string
): Promise<{ detected: boolean; config?: DeploymentConfig }> {
  const response = await fetch("/api/engineer/deploy/detect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoPath }),
  });
  if (!response.ok) {
    throw new Error("Detection failed");
  }
  return response.json();
}
