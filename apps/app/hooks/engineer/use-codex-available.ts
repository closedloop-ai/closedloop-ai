import { useQuery } from "@tanstack/react-query";

type CodexAvailableResponse = {
  available: boolean;
  version?: string;
};

export function useCodexAvailable() {
  return useQuery({
    queryKey: ["codex-available"],
    queryFn: async (): Promise<CodexAvailableResponse> => {
      const res = await fetch("/api/gateway/codex/available");
      return res.json();
    },
    staleTime: Number.POSITIVE_INFINITY, // Check once per session
    retry: false,
  });
}
