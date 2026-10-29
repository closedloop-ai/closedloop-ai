/**
 * @file artifact-ref-mcp-slugs.ts
 * @description ClosedLoop MCP tool detection and slug extraction, split from
 * artifact-ref-extractor.ts (a shrink-only grandfathered file). The extractor's
 * highest-confidence pass reads these to mint `mcp_tool_call` refs.
 */
import { buildSlugPrefixAlternation } from "@repo/api/src/types/slug-prefix";
import type { NormalizedToolUse } from "../types.js";
import { flattenTextValues } from "./parser-utils.js";

// The accepted prefix alphabet is driven from the single
// REFERENCEABLE_SLUG_PREFIXES SSOT in @repo/api (the same derivation feeds the
// extractor's URL regex, the cloud sync-schema validator, and the branch-name
// parser), so a future prefix never has to be added in six places.
export const CLOSEDLOOP_SLUG_RE = new RegExp(
  String.raw`\b(${buildSlugPrefixAlternation()})-(\d+)\b`,
  "g"
);

/**
 * True when a tool call targets the ClosedLoop MCP server. Checks BOTH
 * conventions: the Claude-style `mcp__closedloop__` name prefix AND Codex's
 * separate `mcpServer === "closedloop"` field (Codex tool names carry no `mcp__`
 * prefix). The SSOT for this discrimination — a bare name-prefix check silently
 * misses every Codex ClosedLoop call.
 */
export function isClosedloopMcpTool(tu: NormalizedToolUse): boolean {
  return (
    tu.name.startsWith("mcp__closedloop__") || tu.mcpServer === "closedloop"
  );
}

export function extractMcpToolInputSlugs(input: unknown): string[] {
  if (!input || typeof input !== "object") {
    return [];
  }
  const obj = input as Record<string, unknown>;
  const slugs: string[] = [];
  for (const key of [
    "documentId",
    "slug",
    "projectId",
    "loopId",
    "artifactId",
    "sourceId",
    "targetId",
  ]) {
    const val = obj[key];
    if (typeof val === "string") {
      const m = val.match(CLOSEDLOOP_SLUG_RE);
      CLOSEDLOOP_SLUG_RE.lastIndex = 0;
      if (m) {
        slugs.push(m[0]);
      }
    }
  }
  return slugs;
}

export function extractMcpToolOutputSlugs(output: unknown): string[] {
  if (!output) {
    return [];
  }
  const texts = flattenTextValues(output);
  const slugs: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(CLOSEDLOOP_SLUG_RE)) {
      const slug = m[0];
      if (!seen.has(slug)) {
        seen.add(slug);
        slugs.push(slug);
      }
    }
  }
  return slugs;
}
