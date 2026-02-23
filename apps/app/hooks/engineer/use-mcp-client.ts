"use client";

import {
  auth,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserOAuthClientProvider } from "use-mcp";

// ---------------------------------------------------------------------------
// MCP response types (engineer-local, not shared API types)
// ---------------------------------------------------------------------------

export type McpUser = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  avatarUrl: string | null;
};

export type McpIssue = {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  status: string;
  priority: string;
  projectId: string | null;
  workstreamId: string | null;
  assigneeId: string | null;
  createdAt: string;
  updatedAt: string;
  assignee: {
    id: string | null;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
  } | null;
  project: { name: string | null } | null;
  workstream: { title: string | null } | null;
};

export type McpArtifact = {
  id: string;
  title: string;
  slug: string;
  type: string;
  status: string;
  snippet: string | null;
  projectId: string | null;
  workstreamId: string | null;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
  owner: {
    id: string | null;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
  } | null;
  project: { name: string | null } | null;
  workstream: { title: string | null } | null;
};

type PaginatedResponse<T> = {
  total: number;
  offset: number;
  limit: number;
  returned: number;
  hasMore: boolean;
  nextOffset: number | null;
  items: T[];
};

export type McpConnectionState =
  | "discovering"
  | "pending_auth"
  | "authenticating"
  | "connecting"
  | "loading"
  | "ready"
  | "failed";

// ---------------------------------------------------------------------------
// Error class for scope-gated writes
// ---------------------------------------------------------------------------

export class McpScopeError extends Error {
  constructor(toolName: string) {
    super(
      `Tool "${toolName}" is not available — your API key may be read-only.`
    );
    this.name = "McpScopeError";
  }
}

// ---------------------------------------------------------------------------
// Parse MCP tool result
// ---------------------------------------------------------------------------

type McpCallToolResult = Awaited<ReturnType<Client["callTool"]>>;

function parseMcpResult<T>(result: McpCallToolResult): T {
  if ("toolResult" in result) {
    const value = result.toolResult;
    if (typeof value === "string") {
      return JSON.parse(value) as T;
    }
    return value as T;
  }

  if ("isError" in result && result.isError) {
    const errText =
      result.content.find(
        (c): c is { type: "text"; text: string } =>
          c.type === "text" && typeof c.text === "string"
      )?.text ?? "MCP tool error";
    throw new Error(errText);
  }

  const textContent = result.content.find(
    (content): content is { type: "text"; text: string } =>
      content.type === "text" && typeof content.text === "string"
  );
  if (!textContent) {
    throw new Error("Empty MCP tool result");
  }
  return JSON.parse(textContent.text) as T;
}

// ---------------------------------------------------------------------------
// MCP URL
// ---------------------------------------------------------------------------

const MCP_SERVER_URL =
  process.env.NEXT_PUBLIC_MCP_SERVER_URL ?? "https://mcp.closedloop.ai/mcp";

const CLOSEDLOOP_API_KEY = process.env.NEXT_PUBLIC_CLOSEDLOOP_API_KEY ?? "";
const RECONNECT_DELAY_MS = 5000;

function isExpectedAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const name = error.name.toLowerCase();
  const message = error.message.toLowerCase();
  return (
    name.includes("abort") ||
    message.includes("abort") ||
    message.includes("signal is aborted")
  );
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export type McpClient = {
  // Connection state
  state: McpConnectionState;
  error?: string;
  isReady: boolean;
  hasWriteScope: boolean;

  // Actions
  retry: () => void;
  authenticate: () => void;
  disconnect: () => void;

  // Typed API methods
  getMe: () => Promise<McpUser>;
  listIssues: (params?: {
    assigneeId?: string;
  }) => Promise<PaginatedResponse<McpIssue>>;
  listArtifacts: (params?: {
    ownerId?: string;
  }) => Promise<PaginatedResponse<McpArtifact>>;
  getIssue: (issueId: string) => Promise<McpIssue>;
  updateIssue: (
    issueId: string,
    updates: Record<string, unknown>
  ) => Promise<unknown>;
  createIssueComment: (issueId: string, body: string) => Promise<unknown>;
};

export function useMcpClient(): McpClient {
  const [state, setState] = useState<McpConnectionState>("discovering");
  const [error, setError] = useState<string>();
  const [tools, setTools] = useState<Tool[]>([]);

  const clientRef = useRef<Client | null>(null);
  const transportRef = useRef<StreamableHTTPClientTransport | null>(null);
  const authProviderRef = useRef<BrowserOAuthClientProvider | null>(null);
  const connectingRef = useRef(false);
  const closingRef = useRef(false);
  const isMountedRef = useRef(true);
  const stateRef = useRef<McpConnectionState>("discovering");
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setStateAndRef = useCallback((s: McpConnectionState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const failConnection = useCallback(
    (message: string) => {
      if (!isMountedRef.current) {
        return;
      }
      setError(message);
      setStateAndRef("failed");
      connectingRef.current = false;
    },
    [setError, setStateAndRef]
  );

  const disconnectInternal = useCallback(
    async (quiet = false) => {
      clearReconnectTimer();
      connectingRef.current = false;
      closingRef.current = true;

      const transport = transportRef.current;
      clientRef.current = null;
      transportRef.current = null;

      if (transport) {
        try {
          await transport.close();
        } catch {
          // Ignore transport close failures on teardown.
        }
      }

      if (isMountedRef.current && !quiet) {
        setStateAndRef("discovering");
        setTools([]);
        setError(undefined);
      }
    },
    [clearReconnectTimer, setStateAndRef]
  );

  const connect = useCallback(async () => {
    if (!isMountedRef.current || connectingRef.current) {
      return;
    }

    connectingRef.current = true;
    closingRef.current = false;
    clearReconnectTimer();
    setError(undefined);
    setStateAndRef("connecting");

    const previousTransport = transportRef.current;
    if (previousTransport) {
      try {
        await previousTransport.close();
      } catch {
        // Ignore close errors when replacing a stale transport.
      }
    }
    transportRef.current = null;
    clientRef.current = null;

    let targetUrl: URL;
    try {
      targetUrl = new URL(MCP_SERVER_URL);
    } catch (urlError) {
      failConnection(`Invalid MCP server URL: ${toErrorMessage(urlError)}`);
      return;
    }

    const authProvider = CLOSEDLOOP_API_KEY
      ? null
      : new BrowserOAuthClientProvider(MCP_SERVER_URL, {
          clientName: "symphony-engineer",
          callbackUrl:
            globalThis.window !== undefined
              ? `${globalThis.location.origin}/oauth/callback`
              : "/oauth/callback",
        });
    authProviderRef.current = authProvider;

    const transport = new StreamableHTTPClientTransport(targetUrl, {
      authProvider: authProvider ?? undefined,
      requestInit: {
        headers: {
          Accept: "application/json, text/event-stream",
          ...(CLOSEDLOOP_API_KEY
            ? { Authorization: `Bearer ${CLOSEDLOOP_API_KEY}` }
            : {}),
        },
      },
    });

    transport.onerror = (transportError) => {
      if (
        closingRef.current ||
        !isMountedRef.current ||
        isExpectedAbortError(transportError)
      ) {
        return;
      }
      failConnection(
        `Transport error (HTTP): ${toErrorMessage(transportError)}`
      );
    };

    transport.onclose = () => {
      if (
        !isMountedRef.current ||
        closingRef.current ||
        connectingRef.current
      ) {
        return;
      }

      if (stateRef.current === "ready") {
        setStateAndRef("connecting");
        reconnectTimerRef.current = setTimeout(() => {
          if (isMountedRef.current) {
            connect().catch(console.error);
          }
        }, RECONNECT_DELAY_MS);
        return;
      }

      if (
        stateRef.current !== "failed" &&
        stateRef.current !== "authenticating" &&
        stateRef.current !== "pending_auth"
      ) {
        failConnection("Connection closed unexpectedly.");
      }
    };

    transportRef.current = transport;
    const client = new Client(
      { name: "symphony-engineer", version: "0.1.0" },
      { capabilities: {} }
    );
    clientRef.current = client;

    try {
      await client.connect(transport);
      if (!isMountedRef.current || closingRef.current) {
        return;
      }

      setStateAndRef("loading");
      const toolsResponse = await client.listTools();
      if (!isMountedRef.current || closingRef.current) {
        return;
      }

      setTools(toolsResponse.tools);
      setStateAndRef("ready");
    } catch (connectError) {
      if (
        closingRef.current ||
        !isMountedRef.current ||
        isExpectedAbortError(connectError)
      ) {
        return;
      }

      if (connectError instanceof UnauthorizedError) {
        const attemptedUrl = authProviderRef.current?.getLastAttemptedAuthUrl();
        setStateAndRef(attemptedUrl ? "pending_auth" : "authenticating");
        setError("Authentication required.");
        return;
      }

      failConnection(
        `Failed to connect via HTTP: ${toErrorMessage(connectError)}`
      );
    } finally {
      connectingRef.current = false;
    }
  }, [clearReconnectTimer, failConnection, setStateAndRef]);

  const callTool = useCallback(
    (name: string, args: Record<string, unknown> = {}) => {
      const client = clientRef.current;
      if (!client || stateRef.current !== "ready") {
        throw new Error(
          `MCP client is not ready (current state: ${stateRef.current}). Cannot call tool "${name}".`
        );
      }
      return client.callTool({ name, arguments: args });
    },
    []
  );

  const retry = useCallback(() => {
    if (stateRef.current === "failed") {
      connect().catch(console.error);
    }
  }, [connect]);

  const authenticate = useCallback(async () => {
    if (CLOSEDLOOP_API_KEY) {
      connect().catch(console.error);
      return;
    }

    let authProvider = authProviderRef.current;
    if (!authProvider) {
      authProvider = new BrowserOAuthClientProvider(MCP_SERVER_URL, {
        clientName: "symphony-engineer",
        callbackUrl:
          typeof window !== "undefined"
            ? `${window.location.origin}/oauth/callback`
            : "/oauth/callback",
      });
      authProviderRef.current = authProvider;
    }

    setStateAndRef("authenticating");
    setError(undefined);

    try {
      const result = await auth(authProvider, { serverUrl: MCP_SERVER_URL });
      if (!isMountedRef.current) {
        return;
      }
      if (result === "AUTHORIZED") {
        connect().catch(console.error);
      }
    } catch (authError) {
      if (!isMountedRef.current || isExpectedAbortError(authError)) {
        return;
      }
      failConnection(
        `Manual authentication failed: ${toErrorMessage(authError)}`
      );
    }
  }, [connect, failConnection, setStateAndRef]);

  const disconnect = useCallback(() => {
    disconnectInternal().catch(console.error);
  }, [disconnectInternal]);

  useEffect(() => {
    isMountedRef.current = true;
    connect().catch(console.error);

    return () => {
      isMountedRef.current = false;
      disconnectInternal(true).catch(console.error);
    };
  }, [connect, disconnectInternal]);

  const isReady = state === "ready";
  const hasWriteScope = tools.some((tool) => tool.name === "update-issue");

  const client = useMemo<McpClient>(() => {
    function requireTool(name: string): void {
      if (!tools.some((tool) => tool.name === name)) {
        throw new McpScopeError(name);
      }
    }

    return {
      state,
      error,
      isReady,
      hasWriteScope,
      retry,
      authenticate,
      disconnect,

      getMe: async () => {
        const result = await callTool("get-me", {});
        const parsed = parseMcpResult<{ data: McpUser } | McpUser>(result);
        if ("data" in parsed && parsed.data) {
          return parsed.data;
        }
        return parsed as McpUser;
      },

      listIssues: async (params) => {
        const args: Record<string, unknown> = {};
        if (params?.assigneeId) {
          args.assigneeId = params.assigneeId;
        }
        const result = await callTool("list-issues", args);
        return parseMcpResult<PaginatedResponse<McpIssue>>(result);
      },

      listArtifacts: async (params) => {
        const args: Record<string, unknown> = {};
        if (params?.ownerId) {
          args.ownerId = params.ownerId;
        }
        const result = await callTool("list-artifacts", args);
        return parseMcpResult<PaginatedResponse<McpArtifact>>(result);
      },

      getIssue: async (issueId) => {
        const result = await callTool("get-issue", { issueId });
        const parsed = parseMcpResult<{ data: McpIssue } | McpIssue>(result);
        if ("data" in parsed && parsed.data) {
          return parsed.data;
        }
        return parsed as McpIssue;
      },

      updateIssue: async (issueId, updates) => {
        requireTool("update-issue");
        const result = await callTool("update-issue", { issueId, ...updates });
        return parseMcpResult<unknown>(result);
      },

      createIssueComment: async (issueId, body) => {
        requireTool("create-issue-comment");
        const result = await callTool("create-issue-comment", {
          issueId,
          body,
        });
        return parseMcpResult<unknown>(result);
      },
    };
  }, [
    state,
    error,
    isReady,
    hasWriteScope,
    tools,
    callTool,
    retry,
    authenticate,
    disconnect,
  ]);

  return client;
}
