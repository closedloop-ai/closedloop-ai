import { detectMcpAvailability, type McpProvider } from "./mcp-detection.js";

const ENGINEER_CHAT_BASE_TOOLS = [
  "Bash",
  "Grep",
  "Glob",
  "Read",
  "Edit",
  "Write",
  "Task",
  "TodoWrite",
  "WebSearch",
  "WebFetch",
];

const READONLY_CODEBASE_BASE_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
];

const WEB_ONLY_BASE_TOOLS = ["WebSearch", "WebFetch"];

export const ENGINEER_CHAT_TOOLS = ENGINEER_CHAT_BASE_TOOLS.join(",");
export const READONLY_CODEBASE_TOOLS = READONLY_CODEBASE_BASE_TOOLS.join(",");
export const WEB_ONLY_TOOLS = WEB_ONLY_BASE_TOOLS.join(",");

export function buildMcpToolPattern(serverName: string): string {
  return `mcp__${serverName}__*`;
}

export function withResolvedMcpTools(
  tools: string,
  serverName: string | null | undefined
): string {
  const baseTools = tools
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  if (!serverName) {
    return baseTools.join(",");
  }
  return [...baseTools, buildMcpToolPattern(serverName)].join(",");
}

async function resolveMcpServerName(
  expectedMcpUrl: string | undefined,
  provider: McpProvider
): Promise<string | null> {
  const detection = await detectMcpAvailability(provider, expectedMcpUrl);
  return detection.serverName;
}

export async function getReadonlyCodebaseTools(
  expectedMcpUrl?: string,
  provider: McpProvider = "claude"
): Promise<string> {
  return withResolvedMcpTools(
    READONLY_CODEBASE_TOOLS,
    await resolveMcpServerName(expectedMcpUrl, provider)
  );
}

export async function getWebOnlyTools(
  expectedMcpUrl?: string,
  provider: McpProvider = "claude"
): Promise<string> {
  return withResolvedMcpTools(
    WEB_ONLY_TOOLS,
    await resolveMcpServerName(expectedMcpUrl, provider)
  );
}

export async function withMcpTools(
  tools: string,
  expectedMcpUrl?: string,
  provider: McpProvider = "claude"
): Promise<string> {
  return withResolvedMcpTools(
    tools,
    await resolveMcpServerName(expectedMcpUrl, provider)
  );
}
