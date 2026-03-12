"use client";

import { useQuery } from "@tanstack/react-query";

export const engineerSessionKeys = {
  all: ["engineer-sessions"] as const,
  unreadCount: () => [...engineerSessionKeys.all, "unread-count"] as const,
};

export function useUnreadSessionCount() {
  const isLocalhost =
    typeof globalThis.window !== "undefined" &&
    (globalThis.location.hostname === "localhost" ||
      globalThis.location.hostname === "127.0.0.1" ||
      globalThis.location.hostname === "::1");

  const { data: count = 0 } = useQuery({
    queryKey: engineerSessionKeys.unreadCount(),
    queryFn: async () => {
      const res = await fetch("/api/engineer/symphony/sessions/unread-count");
      if (!res.ok) {
        return 0;
      }
      const data: { count?: number } = await res.json();
      return data.count ?? 0;
    },
    staleTime: 30_000,
    refetchInterval: (query) =>
      (query.state.data as number) > 0 ? 30_000 : 120_000,
    retry: false,
    enabled: isLocalhost,
  });

  return count;
}
