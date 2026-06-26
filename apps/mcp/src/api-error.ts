import type { JsonObject } from "@repo/api/src/types/common.js";

export type McpApiErrorOptions = {
  code?: string;
  details?: JsonObject;
  status?: number;
  timestamp?: string;
};

/**
 * Error shape used inside MCP tools to preserve API failure metadata while
 * still returning standard MCP text content to clients.
 */
export class McpApiError extends Error {
  readonly code?: string;
  readonly details?: JsonObject;
  readonly status?: number;
  readonly timestamp?: string;

  constructor(message: string, options: McpApiErrorOptions = {}) {
    super(message);
    this.name = "McpApiError";
    this.code = options.code;
    this.details = options.details;
    this.status = options.status;
    this.timestamp = options.timestamp;
  }
}
