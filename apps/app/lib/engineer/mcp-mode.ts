import { appEnvironment } from "@/lib/environment";

/**
 * MCP is local-only. Hosted environments (stage/prod) must bypass MCP entirely.
 */
export const isEngineerMcpEnabled = appEnvironment === "local";
