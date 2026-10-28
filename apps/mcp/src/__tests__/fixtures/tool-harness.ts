/**
 * Shared single-tool harness for MCP tool suites.
 *
 * Six suites each inlined the same registerTool vi.fn / handler-capture pattern.
 * This fixture extracts that shared scaffolding into one place.
 *
 * `createToolHarness(register, apiClient)` — returns only the handler.
 * `createToolHarnessWithMock(register, apiClient)` — returns the handler AND
 *   the registerTool mock, for suites that need to assert on the tool's
 *   inputSchema, outputSchema, or registered name.
 * `parseToolPayload(result)` — throws on isError, parses the JSON text body.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { vi } from "vitest";
import { type ZodRawShape, type ZodType, z } from "zod";
import type { ApiClient } from "../../api-client.js";
import {
  createUrlBuilder,
  type McpUrlBuilder,
} from "../../tools/tool-utils.js";

export type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
}>;

/**
 * The first argument to every MCP register* function is the McpServer (or a
 * compatible shape). Using `never` lets any concrete server type be assigned
 * here thanks to TypeScript's contravariant parameter rule: `never` is the
 * bottom type and is assignable to every type, so a function
 * `(server: McpServer) => void` is assignable to `(server: never) => void`.
 * Register functions that predate the per-session `urls` builder simply
 * declare fewer parameters and ignore it.
 */
export type RegisterToolFn = (
  server: never,
  apiClient: ApiClient,
  urls: McpUrlBuilder
) => void;

function buildHarness(
  register: RegisterToolFn,
  apiClient: ApiClient,
  urls: McpUrlBuilder
) {
  let handler: ToolHandler | undefined;
  const registerTool = vi.fn(
    (_name: string, _config: unknown, callback: ToolHandler): void => {
      handler = callback;
    }
  );

  register({ registerTool } as never, apiClient, urls);

  if (!handler) {
    throw new Error("Tool handler was not registered");
  }

  return { handler, registerTool };
}

export function createToolHarness(
  register: RegisterToolFn,
  apiClient: ApiClient,
  urls: McpUrlBuilder = createUrlBuilder(() => null)
): ToolHandler {
  return buildHarness(register, apiClient, urls).handler;
}

export function createToolHarnessWithMock(
  register: RegisterToolFn,
  apiClient: ApiClient,
  urls: McpUrlBuilder = createUrlBuilder(() => null)
) {
  return buildHarness(register, apiClient, urls);
}

export function parseToolPayload(result: {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}): unknown {
  if (result.isError) {
    throw new Error(result.content[0]?.text ?? "Tool returned an error");
  }
  return JSON.parse(result.content[0]?.text ?? "null");
}

/**
 * The arguments a tool registration was actually called with.
 *
 * The presence check is what turns "the register function never registered
 * anything" into that sentence, instead of a `Cannot read properties of
 * undefined` from whichever reader below got there first.
 */
function registeredCall(registerTool: { mock: { calls: unknown[][] } }) {
  const call = registerTool.mock.calls[0];
  if (!call) {
    throw new Error("No tool was registered");
  }
  return call;
}

/**
 * The zod object a tool actually registered, for asserting on input rules.
 *
 * `buildHarness` hands back the raw callback, so the MCP SDK never applies
 * `inputSchema` — driving the handler to prove "input X is rejected" passes off
 * an unconfigured mock and stays green with the rule deleted. Read the schema
 * here instead. The cast is needed because the registered config is `unknown`.
 */
export function registeredInputSchema(registerTool: {
  mock: { calls: unknown[][] };
}) {
  const config = registeredCall(registerTool)[1] as {
    inputSchema: ZodRawShape;
  };
  return z.object(config.inputSchema);
}

/**
 * The name and config a tool actually registered, for asserting on its
 * description and per-field input rules. The casts are needed because the
 * registered name and config arrive as `unknown` through the mock.
 */
export function registeredToolName(registerTool: {
  mock: { calls: unknown[][] };
}) {
  return registeredCall(registerTool)[0] as string;
}

export function registeredToolConfig(registerTool: {
  mock: { calls: unknown[][] };
}) {
  return registeredCall(registerTool)[1] as {
    description: string;
    inputSchema: Record<string, ZodType>;
  };
}

/**
 * The first issue a schema raises for a value it must reject.
 *
 * Throws when the schema ACCEPTS the value, so a bound deleted from the schema
 * fails here loudly instead of reading as "no issue was raised".
 */
export function firstIssue(schema: ZodType, value: unknown) {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    throw new Error("Expected the schema to reject this value");
  }
  return parsed.error.issues[0];
}

/** The envelope `buildPaginatedPayload` returns to a client-side paging tool. */
export type PaginatedPayload = {
  total: number;
  offset: number;
  limit: number;
  returned: number;
  hasMore: boolean;
  nextOffset: number | null;
  items: Record<string, unknown>[];
};

/**
 * Calls one tool through a real `McpServer` and `Client`, so the SDK applies
 * the registered `inputSchema` the way a connected client meets it. The
 * harnesses above hand back the raw callback, which never validates.
 */
export async function callToolThroughServer(
  register: RegisterToolFn,
  apiClient: ApiClient,
  call: { name: string; arguments: Record<string, unknown> }
): Promise<{ isError: boolean | undefined; text: string | undefined }> {
  const server = new McpServer({ name: "tool-harness", version: "0.0.0" });
  register(
    server as never,
    apiClient,
    createUrlBuilder(() => null)
  );
  const client = new Client({ name: "tool-harness", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = CallToolResultSchema.parse(await client.callTool(call));
    const textBlock = result.content.find((item) => item.type === "text");
    return {
      isError: result.isError,
      text: textBlock?.type === "text" ? textBlock.text : undefined,
    };
  } finally {
    await client.close();
    await server.close();
  }
}
