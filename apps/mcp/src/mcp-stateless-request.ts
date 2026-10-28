import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  McpCapacityRefusalReason,
  refuseMcpSessionForCapacity,
  releaseMcpSessionCapacity,
  reserveMcpSessionCapacity,
} from "./mcp-session-store.js";
import { connectWithToolCallEvidence } from "./mcp-transport-connect.js";

/**
 * Serve one MCP request without retaining a session, under the same count bound
 * an admitted session is held to.
 *
 * The server built here is the same 49-tool `McpServer` a session holds, so it
 * claims the same slot (ISS-8394). Before that claim existed this path
 * allocated outside the bound entirely, and every route into it is a route a
 * healthy client takes routinely — a task restart, a TTL expiry, an eviction, a
 * non-sticky load balancer — so the cap described only the sessions it happened
 * to admit, not the servers actually resident.
 *
 * The claim is released rather than admitted: nothing is retained past the
 * response, so the slot is held only for as long as the server exists.
 *
 * That span includes `handleRequest`, so a rebuild running a slow `tools/call`
 * holds its slot for the whole call. Node's `requestTimeout` bounds receiving a
 * request, not a handler already running, so `MCP_MAX_SESSIONS` doubles as a
 * concurrency ceiling on stateless tool calls: MAX slow rebuilds refuse every
 * arrival — `initialize` included — until they drain. Holding it is deliberate,
 * the heap is genuinely committed for that whole span, but it means the setting
 * is sized against two axes and the README says so.
 *
 * `createServer` is injected because the entrypoint owning `createMcpServer`
 * imports this module.
 */
export async function handleMcpStatelessRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody: unknown,
  createServer: () => Promise<McpServer>
): Promise<void> {
  const reservation = reserveMcpSessionCapacity();
  if (!reservation) {
    refuseMcpSessionForCapacity(
      res,
      req.method,
      McpCapacityRefusalReason.StatelessRebuild
    );
    return;
  }

  try {
    const server = await createServer();
    const transport = new StreamableHTTPServerTransport({
      // Stateless fallback avoids hard session affinity requirements across ECS tasks.
      sessionIdGenerator: undefined,
    });
    try {
      await connectWithToolCallEvidence(server, transport);
      await transport.handleRequest(req, res, parsedBody);
    } finally {
      await server.close();
    }
  } finally {
    releaseMcpSessionCapacity(reservation);
  }
}
