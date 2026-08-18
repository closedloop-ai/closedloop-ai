/**
 * Shared, pure builders for `AgentComponentProperties` (the detail-page
 * Properties panel + per-kind rows). SSOT for BOTH the cloud service
 * (`apps/api/app/agent-components/service.ts`) and the desktop local IPC source
 * (`apps/desktop/src/main/shared-agent-components-api.ts`) so the two surfaces
 * cannot drift (a recurring class of bug — see AGENTS.md "Cross-surface
 * consistency"). No runtime/server-only dependencies — safe to import anywhere.
 *
 * The inputs are the small, surface-neutral shape both row types can adapt to
 * (kind + definition path + parsed metadata), NOT a Prisma or SQLite row.
 */

import type { AgentComponentProperties } from "./agent-component.js";

/**
 * Infer the definition file's source format. Prefers the real file extension
 * from `path`; otherwise falls back to the conventional format for the kind
 * (mcp→json, workflow→yml, hook→bash, everything else→md). Mirrors the
 * prototype's `DEFAULT_FORMAT` map (`apps/prototypes/app/p/agents`).
 */
export function inferComponentFormat(
  kind: string,
  path: string | null | undefined
): string {
  const p = path ?? "";
  const dot = p.lastIndexOf(".");
  // `dot > 0` (not `!== -1`) so a leading-dot dotfile like ".mcp" is NOT read as
  // an extension "mcp" — it has no real extension and falls back to the kind.
  if (dot > 0 && dot < p.length - 1) {
    return p.slice(dot + 1).toLowerCase();
  }
  switch (kind) {
    case "mcp":
      return "json";
    case "workflow":
      return "yml";
    case "hook":
      return "bash";
    default:
      return "md";
  }
}

function asStringArray(value: unknown): readonly string[] | undefined {
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value as readonly string[];
  }
  return undefined;
}

function asServerInfo(
  value: unknown
): AgentComponentProperties["server"] | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.url === "string" &&
    typeof v.auth === "string" &&
    typeof v.health === "string"
  ) {
    return { url: v.url, auth: v.auth, health: v.health };
  }
  return undefined;
}

/**
 * Build the Properties DTO from a component's definition path + parsed
 * metadata. Per-kind extras (model, allowedTools, MCP server info, workflow
 * orchestration) are read defensively from `metadata` — each is set only when
 * the metadata carries a well-typed value, so a component with no parsed
 * definition still yields an honest `{ path, format }` (never faked fields).
 */
export function buildComponentProperties(input: {
  kind: string;
  path: string;
  metadata?: Record<string, unknown> | null;
}): AgentComponentProperties {
  const properties: AgentComponentProperties = {
    path: input.path,
    format: inferComponentFormat(input.kind, input.path),
  };

  const md = input.metadata;
  if (!md) {
    return properties;
  }

  if (typeof md.model === "string") {
    properties.model = md.model;
  }
  const allowedTools = asStringArray(md.allowedTools);
  if (allowedTools) {
    properties.allowedTools = allowedTools;
  }
  if (input.kind === "mcp") {
    const server = asServerInfo(md.server);
    if (server) {
      properties.server = server;
    }
  }
  if (typeof md.maxConcurrency === "number") {
    properties.maxConcurrency = md.maxConcurrency;
  }
  const orchestrates = asStringArray(md.orchestrates);
  if (orchestrates) {
    properties.orchestrates = orchestrates;
  }
  return properties;
}
