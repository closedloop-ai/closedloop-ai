import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { VerifiedApiKeyContext } from "@repo/api/src/types/api-key";
import { createApiClient, verifyApiKey } from "./api-client.js";
import { registerBatchCreateArtifacts } from "./tools/batch-create-artifacts.js";
import { registerCreateArtifact } from "./tools/create-artifact.js";
import { registerGeneratePlans } from "./tools/generate-plans.js";
import { registerGetArtifact } from "./tools/get-artifact.js";
import { registerGetProjectStatus } from "./tools/get-project-status.js";
import { registerListArtifacts } from "./tools/list-artifacts.js";
import { registerListProjects } from "./tools/list-projects.js";

const BEARER_API_KEY_REGEX = /^Bearer\s+(sk_live_\S+)$/;
const PORT = Number(process.env.MCP_PORT ?? 3010);

/**
 * Create a new MCP server instance with all tools registered.
 * Each session gets its own McpServer bound to a verified API key context.
 */
function createMcpServer(
  context: VerifiedApiKeyContext,
  plaintextKey: string
): McpServer {
  const server = new McpServer({
    name: "symphony",
    version: "0.0.1",
  });

  const apiClient = createApiClient(context, plaintextKey);

  // Connectivity check
  server.tool("ping", "Check MCP server connectivity", {}, () => {
    return Promise.resolve({
      content: [{ type: "text" as const, text: "pong" }],
    });
  });

  // T-4.3: List projects
  registerListProjects(server, apiClient);

  // T-4.4: List artifacts
  registerListArtifacts(server, apiClient);

  // T-4.5: Create artifact
  registerCreateArtifact(server, apiClient);

  // T-4.6: Batch create artifacts
  registerBatchCreateArtifacts(server, apiClient);

  // T-4.7: Generate plans
  registerGeneratePlans(server, apiClient);

  // T-4.8: Get project status
  registerGetProjectStatus(server, apiClient);

  // T-4.9: Get artifact
  registerGetArtifact(server, apiClient);

  return server;
}

/**
 * Extract the API key from the Authorization header.
 * Accepts "Bearer sk_live_..." format.
 */
function extractApiKey(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }
  const match = BEARER_API_KEY_REGEX.exec(authHeader);
  return match ? match[1] : null;
}

const httpServer = createServer(async (req, res) => {
  try {
    // Only handle POST to /mcp endpoint
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // Verify API key from Authorization header
    const authHeader = req.headers.authorization ?? null;
    const plaintextKey = extractApiKey(authHeader);

    if (!plaintextKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error:
            "Missing or invalid Authorization header. Expected: Bearer sk_live_...",
        })
      );
      return;
    }

    const context = await verifyApiKey(plaintextKey);
    if (!context) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or expired API key" }));
      return;
    }

    // Create a per-request MCP server and transport
    const mcpServer = createMcpServer(context, plaintextKey);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("MCP server error:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }
});

httpServer.listen(PORT, () => {
  console.log(`Symphony MCP server running on port ${PORT}`);
  console.log(`Endpoint: http://localhost:${PORT}/mcp`);
});

httpServer.on("error", (error) => {
  console.error("HTTP server error:", error);
  process.exit(1);
});
