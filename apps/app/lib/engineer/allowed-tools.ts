/** Wildcard pattern allowing all ClosedLoop MCP tools. */
const MCP_TOOLS = "mcp__closedloop__*";

/** Full read-write toolset for interactive engineer chats. */
export const ENGINEER_CHAT_TOOLS = [
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
  MCP_TOOLS,
].join(",");

/** Read-only codebase access + web tools. */
export const READONLY_CODEBASE_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
  MCP_TOOLS,
].join(",");

/** Web-only tools (no codebase access). */
export const WEB_ONLY_TOOLS = ["WebSearch", "WebFetch", MCP_TOOLS].join(",");

/** Append MCP tools to a custom tool string. */
export function withMcpTools(tools: string): string {
  return `${tools},${MCP_TOOLS}`;
}
