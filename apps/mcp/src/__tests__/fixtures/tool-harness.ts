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

import { vi } from "vitest";
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
 * Deliberately self-contained (no `createUrlBuilder` dependency): the suites
 * that need this stub `vi.mock` the whole tool-utils module, so the fixture's
 * real-module default would resolve to undefined in their module graph.
 */
export const stubLoopUrls = {
  buildLoopUrl: (loopId: string) => `https://app.example/loops/${loopId}`,
};
