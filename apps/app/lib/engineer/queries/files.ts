import { queryOptions } from "@tanstack/react-query";
import type { DirectoryEntry } from "@/types/repos";
import { queryKeys } from "./keys";

/* ---------- Response types ---------- */

export type FileSearchResponse = {
  files: string[];
  truncated: boolean;
  error?: string;
};

export type DirectoriesResponse = {
  directories: DirectoryEntry[];
  error?: string;
};

/* ---------- Query option factories ---------- */

export function fileSearchOptions(
  ticketId: string,
  repoPath: string,
  query: string
) {
  return queryOptions<FileSearchResponse>({
    queryKey: queryKeys.fileSearch(ticketId, repoPath, query),
    queryFn: async () => {
      const params = new URLSearchParams({
        repo: repoPath,
        ticket: ticketId,
        query,
      });
      const response = await fetch(`/api/gateway/files/search?${params}`);
      return response.json();
    },
  });
}

export function fileSearchBaseOptions(repoPath: string, query: string) {
  return queryOptions<FileSearchResponse>({
    queryKey: queryKeys.fileSearchBase(repoPath, query),
    queryFn: async () => {
      const params = new URLSearchParams({
        repo: repoPath,
        query,
        base: "true",
      });
      const response = await fetch(`/api/gateway/files/search?${params}`);
      return response.json();
    },
  });
}

export function directoriesOptions(path: string) {
  return queryOptions<DirectoriesResponse>({
    queryKey: queryKeys.directories(path),
    queryFn: async () => {
      const params = new URLSearchParams({ path });
      const response = await fetch(`/api/gateway/directories?${params}`);
      return response.json();
    },
  });
}
