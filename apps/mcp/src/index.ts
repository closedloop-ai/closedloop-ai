import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { VerifiedApiKeyContext } from "@repo/api/src/types/api-key";
import {
  checkApiReachable,
  createApiClient,
  verifyApiKey,
} from "./api-client.js";
import { registerBatchCreateArtifacts } from "./tools/batch-create-artifacts.js";
import { registerCreateArtifact } from "./tools/create-artifact.js";
import { registerCreateArtifactVersion } from "./tools/create-artifact-version.js";
import { registerCreateEntityLink } from "./tools/create-entity-link.js";
import { registerCreateExternalLink } from "./tools/create-external-link.js";
import { registerCreateIssue } from "./tools/create-issue.js";
import { registerCreateProject } from "./tools/create-project.js";
import { registerCreateWorkstream } from "./tools/create-workstream.js";
import { registerGeneratePlans } from "./tools/generate-plans.js";
import { registerGetArtifact } from "./tools/get-artifact.js";
import { registerGetDashboardStats } from "./tools/get-dashboard-stats.js";
import { registerGetGithubStatus } from "./tools/get-github-status.js";
import { registerGetGoogleStatus } from "./tools/get-google-status.js";
import { registerGetIssue } from "./tools/get-issue.js";
import { registerGetLinearStatus } from "./tools/get-linear-status.js";
import { registerGetLoop } from "./tools/get-loop.js";
import { registerGetProject } from "./tools/get-project.js";
import { registerGetProjectStatus } from "./tools/get-project-status.js";
import { registerGetRelatedArtifacts } from "./tools/get-related-artifacts.js";
import { registerGetWorkstream } from "./tools/get-workstream.js";
import { registerListArtifactVersions } from "./tools/list-artifact-versions.js";
import { registerListArtifacts } from "./tools/list-artifacts.js";
import { registerListEntityLinks } from "./tools/list-entity-links.js";
import { registerListExternalLinks } from "./tools/list-external-links.js";
import { registerListIssues } from "./tools/list-issues.js";
import { registerListLoops } from "./tools/list-loops.js";
import { registerListProjects } from "./tools/list-projects.js";
import { registerListTemplates } from "./tools/list-templates.js";
import { registerListUsers } from "./tools/list-users.js";
import { registerListWorkstreams } from "./tools/list-workstreams.js";
import { registerUpdateArtifact } from "./tools/update-artifact.js";
import { registerUpdateIssue } from "./tools/update-issue.js";
import { registerUpdateProject } from "./tools/update-project.js";
import { registerUpdateWorkstream } from "./tools/update-workstream.js";

const BEARER_API_KEY_REGEX = /^Bearer\s+(sk_live_\S+)$/;
const PORT = Number(process.env.MCP_PORT ?? 3010);
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26"];
const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? `http://localhost:${PORT}`;

/**
 * Tool manifest for /.well-known/mcp.json Server Card.
 * Built once at startup from the tool registration list.
 */
const TOOL_NAMES = [
  "ping",
  "list-projects",
  "get-project",
  "create-project",
  "update-project",
  "get-project-status",
  "list-artifacts",
  "get-artifact",
  "create-artifact",
  "update-artifact",
  "batch-create-artifacts",
  "create-artifact-version",
  "list-artifact-versions",
  "get-related-artifacts",
  "list-issues",
  "get-issue",
  "create-issue",
  "update-issue",
  "list-workstreams",
  "get-workstream",
  "create-workstream",
  "update-workstream",
  "list-loops",
  "get-loop",
  "list-users",
  "get-dashboard-stats",
  "list-entity-links",
  "create-entity-link",
  "list-external-links",
  "create-external-link",
  "list-templates",
  "get-github-status",
  "get-linear-status",
  "get-google-status",
  "generate-plans",
];

/**
 * Create a new MCP server instance with all tools registered.
 * Each session gets its own McpServer bound to a verified API key context.
 */
function createMcpServer(
  context: VerifiedApiKeyContext,
  plaintextKey: string
): McpServer {
  const server = new McpServer({
    name: "closedloop",
    version: "0.0.1",
  });

  const apiClient = createApiClient(context, plaintextKey);

  // Connectivity check
  server.tool("ping", "Check MCP server connectivity", {}, () => {
    return Promise.resolve({
      content: [{ type: "text" as const, text: "pong" }],
    });
  });

  // Projects
  registerListProjects(server, apiClient);
  registerGetProject(server, apiClient);
  registerCreateProject(server, apiClient);
  registerUpdateProject(server, apiClient);
  registerGetProjectStatus(server, apiClient);

  // Artifacts
  registerListArtifacts(server, apiClient);
  registerGetArtifact(server, apiClient);
  registerCreateArtifact(server, apiClient);
  registerUpdateArtifact(server, apiClient);
  registerBatchCreateArtifacts(server, apiClient);
  registerCreateArtifactVersion(server, apiClient);
  registerListArtifactVersions(server, apiClient);
  registerGetRelatedArtifacts(server, apiClient);

  // Issues
  registerListIssues(server, apiClient);
  registerGetIssue(server, apiClient);
  registerCreateIssue(server, apiClient);
  registerUpdateIssue(server, apiClient);

  // Workstreams
  registerListWorkstreams(server, apiClient);
  registerGetWorkstream(server, apiClient);
  registerCreateWorkstream(server, apiClient);
  registerUpdateWorkstream(server, apiClient);

  // Loops
  registerListLoops(server, apiClient);
  registerGetLoop(server, apiClient);

  // Users
  registerListUsers(server, apiClient);

  // Dashboard
  registerGetDashboardStats(server, apiClient);

  // Entity links
  registerListEntityLinks(server, apiClient);
  registerCreateEntityLink(server, apiClient);

  // External links
  registerListExternalLinks(server, apiClient);
  registerCreateExternalLink(server, apiClient);

  // Templates
  registerListTemplates(server, apiClient);

  // Integrations
  registerGetGithubStatus(server, apiClient);
  registerGetLinearStatus(server, apiClient);
  registerGetGoogleStatus(server, apiClient);

  // Plans
  registerGeneratePlans(server, apiClient);

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

function sendJson(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

async function handleReady(
  res: import("node:http").ServerResponse
): Promise<void> {
  const apiReachable = await checkApiReachable();
  sendJson(res, apiReachable ? 200 : 503, {
    status: apiReachable ? "ready" : "not_ready",
    checks: { api: apiReachable ? "reachable" : "unreachable" },
    timestamp: new Date().toISOString(),
  });
}

async function handleMcp(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" }, { Allow: "POST" });
    return;
  }

  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) {
    sendJson(res, 415, {
      error: "Unsupported Media Type. Expected: application/json",
    });
    return;
  }

  // Validate MCP-Protocol-Version header (spec requirement)
  const protocolVersion = req.headers["mcp-protocol-version"] as
    | string
    | undefined;
  if (
    protocolVersion &&
    !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)
  ) {
    sendJson(res, 400, {
      error: `Unsupported MCP protocol version: ${protocolVersion}. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
    });
    return;
  }

  const plaintextKey = extractApiKey(req.headers.authorization ?? null);
  if (!plaintextKey) {
    sendJson(res, 401, {
      error:
        "Missing or invalid Authorization header. Expected: Bearer sk_live_...",
    });
    return;
  }

  const context = await verifyApiKey(plaintextKey);
  if (!context) {
    sendJson(res, 401, { error: "Invalid or expired API key" });
    return;
  }

  const mcpServer = createMcpServer(context, plaintextKey);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res);
}

const httpServer = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, {
        status: "ok",
        version: "0.0.1",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (req.method === "GET" && req.url === "/ready") {
      await handleReady(res);
      return;
    }

    // OAuth 2.1 Protected Resource Metadata (RFC 9470)
    // Tells MCP clients how to obtain tokens for this server
    if (
      req.method === "GET" &&
      req.url === "/.well-known/oauth-protected-resource"
    ) {
      sendJson(res, 200, {
        resource: MCP_SERVER_URL,
        authorization_servers: [
          `${MCP_SERVER_URL}/.well-known/oauth-authorization-server`,
        ],
        bearer_methods_supported: ["header"],
        resource_documentation: "https://docs.closedloop.ai/mcp",
      });
      return;
    }

    // OAuth 2.1 Authorization Server Metadata (placeholder)
    // Currently API-key-only; this advertises the future OAuth flow
    if (
      req.method === "GET" &&
      req.url === "/.well-known/oauth-authorization-server"
    ) {
      sendJson(res, 200, {
        issuer: MCP_SERVER_URL,
        token_endpoint: `${MCP_SERVER_URL}/oauth/token`,
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        grant_types_supported: ["client_credentials"],
        response_types_supported: ["token"],
        code_challenge_methods_supported: ["S256"],
        // Indicates API keys are used until full OAuth is implemented
        _note: "OAuth 2.1 not yet implemented. Use Bearer sk_live_* API keys.",
      });
      return;
    }

    // MCP Server Card — capability discovery without a session
    if (req.method === "GET" && req.url === "/.well-known/mcp.json") {
      sendJson(res, 200, {
        name: "closedloop",
        version: "0.0.1",
        description: "ClosedLoop AI software delivery platform — MCP server",
        url: `${MCP_SERVER_URL}/mcp`,
        transport: { type: "streamable-http" },
        authentication: { type: "bearer", format: "sk_live_*" },
        protocol_versions: SUPPORTED_PROTOCOL_VERSIONS,
        capabilities: { tools: true },
        tools: TOOL_NAMES,
      });
      return;
    }

    if (req.url === "/mcp") {
      await handleMcp(req, res);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("MCP server error:", error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal server error" });
    }
  }
});

httpServer.listen(PORT, () => {
  console.log(`ClosedLoop MCP server running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Ready:  http://localhost:${PORT}/ready`);
});

httpServer.on("error", (error) => {
  console.error("HTTP server error:", error);
  process.exit(1);
});
