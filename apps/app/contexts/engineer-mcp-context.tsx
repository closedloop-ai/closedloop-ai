"use client";

import { createContext, useContext, useEffect, useRef } from "react";
import { type McpClient, useMcpClient } from "@/hooks/engineer/use-mcp-client";

const EngineerMcpContext = createContext<McpClient | null>(null);

/** Max automatic retries before giving up (user can still retry manually). */
const MAX_AUTO_RETRIES = 3;

export function EngineerMcpProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const client = useMcpClient();
  const autoRetryCountRef = useRef(0);

  // Auto-retry transient startup failures.
  // The local SDK hook auto-reconnects once connected ("ready" -> onclose),
  // but initial connection errors transition to "failed" and need explicit retry.
  useEffect(() => {
    if (
      client.state === "failed" &&
      autoRetryCountRef.current < MAX_AUTO_RETRIES
    ) {
      const timer = setTimeout(() => {
        autoRetryCountRef.current += 1;
        client.retry();
      }, 2000);
      return () => clearTimeout(timer);
    }
    if (client.state === "ready") {
      autoRetryCountRef.current = 0;
    }
  }, [client.state, client.retry]);

  return (
    <EngineerMcpContext.Provider value={client}>
      {children}
    </EngineerMcpContext.Provider>
  );
}

export function useEngineerMcp(): McpClient {
  const ctx = useContext(EngineerMcpContext);
  if (!ctx) {
    throw new Error("useEngineerMcp must be used within EngineerMcpProvider");
  }
  return ctx;
}

export function useOptionalEngineerMcp(): McpClient | null {
  return useContext(EngineerMcpContext);
}
