/**
 * ISS-12552: a server with one write tool shaped like a real one, so a receipt
 * can reach the tool's JSON body only through the tool-call evidence wrapper,
 * never by echoing the API response. Shared by the connect-path tests.
 * Modules load lazily so a caller's `vi.resetModules()` and env take effect.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { vi } from "vitest";
import { z } from "zod";

export function stubCreateDocumentApi(receipt: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: { id: "d1", operationReceipt: receipt },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export async function createDocumentTestServer(): Promise<McpServer> {
  const { createApiClient } = await import("../../api-client.js");
  const apiClient = createApiClient(
    { userId: "u1", organizationId: "o1", scopes: ["write"] },
    "sk_live_test"
  );
  const server = new McpServer({ name: "test", version: "0.0.0" });
  server.registerTool(
    "create-document",
    { inputSchema: { title: z.string() } },
    async (args) => {
      const created = await apiClient.post<{ id: string }>("/documents", args);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ id: created.id }) },
        ],
      };
    }
  );
  return server;
}
