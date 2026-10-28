import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { withToolCallEvidence } from "./tool-call-receipts.js";

// Connect a freshly-created (not yet session-registered) server/transport and
// handle the request. On failure, close the server before rethrowing: init
// failed before the session was registered in mcpSessions, so
// cleanupExpiredMcpSessions can never reap it; closing here avoids leaking one
// McpServer + transport per error.
export async function connectMcpTransportOrCleanup(
  server: McpServer,
  transport: StreamableHTTPServerTransport,
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody: unknown
): Promise<void> {
  try {
    await connectWithToolCallEvidence(server, transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (error) {
    try {
      await server.close();
    } catch {
      // best-effort cleanup; the original error is more important
    }
    throw error;
  }
}

/**
 * ISS-12552: connect a server so each tool call carries its harness call id to
 * the API and returns its write receipt in the JSON body. Every connect path,
 * the session-initialize one and the stateless fallback alike, goes through
 * here, so no route serves tool calls without their evidence.
 */
export async function connectWithToolCallEvidence(
  server: McpServer,
  transport: StreamableHTTPServerTransport
): Promise<void> {
  await server.connect(transport);
  withToolCallEvidence(transport);
}
